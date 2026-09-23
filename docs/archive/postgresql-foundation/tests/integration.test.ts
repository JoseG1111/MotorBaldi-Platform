import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { database, transaction } from "@motorbaldi/db";
import { migrationDatabase } from "@motorbaldi/db/migration-pool";
import { migrate } from "@motorbaldi/db/migrate";
import { audit } from "@motorbaldi/db/audit";
import {
  outbox,
  receiveInbound,
  type EventRegistry,
} from "@motorbaldi/db/outbox";
import {
  buildIdempotencyScope,
  cleanupExpiredIdempotencyRecords,
  idempotent,
} from "@motorbaldi/db/idempotency";
import { newId } from "@motorbaldi/shared";
import {
  ensureTestRuntimeRole,
  testMigrationDatabaseUrl,
  testConfig,
  eventually,
} from "@motorbaldi/testing";
import { queueFoundation, type Handler } from "@motorbaldi/messaging/queue";
import {
  files,
  unavailableScanner,
  type ObjectStorage,
} from "@motorbaldi/storage";
import { createApp, dependencies } from "@motorbaldi/api/app";
const c = testConfig();
const { pool } = database(c);
const ownerPool = migrationDatabase(testMigrationDatabaseUrl);
const requestId = newId();
const owner = newId();
const eventRegistry: EventRegistry = new Map(
  ["test.atomic", "test.retry", "test.fail"].map((eventType) => [
    eventType + ":1",
    {
      aggregateType: "fixture",
      version: 1,
      payload: z.object({}),
      externalEffect: "IDEMPOTENT" as const,
    },
  ]),
);
before(async () => {
  await ensureTestRuntimeRole(ownerPool);
  await migrate(ownerPool, undefined, {
    environment: "test",
    initializeEnvironment: true,
    runtimeRole: "motorbaldi_runtime",
  });
  await ownerPool.query(
    'INSERT INTO iam.auth_users(id,name,email,"emailVerified") VALUES ($1,$2,$3,true) ON CONFLICT (id) DO NOTHING',
    [owner, "Fixture", owner + "@example.test"],
  );
});
after(async () => {
  await pool.end();
  await ownerPool.end();
});
test("audit append succeeds; runtime cannot mutate, truncate, own or bypass trigger", async () => {
  const client = await pool.connect();
  try {
    await client.query("SET ROLE motorbaldi_runtime");
    await audit(client, {
      actorId: owner,
      action: "test",
      resourceType: "fixture",
      resourceId: owner,
      requestId,
    });
    for (const sql of [
      "UPDATE governance.audit_events SET action='tampered'",
      "DELETE FROM governance.audit_events",
      "TRUNCATE governance.audit_events",
      "ALTER TABLE governance.audit_events DISABLE TRIGGER ALL",
    ])
      await assert.rejects(() => client.query(sql));
  } finally {
    await client.query("RESET ROLE");
    client.release();
  }
});
test("outbox commit and rollback are atomic", async () => {
  const committed = newId();
  const rolled = newId();
  const write = async (id: string, fail: boolean) =>
    transaction(pool, async (tx) => {
      await tx.query(
        "INSERT INTO governance.feature_flags(id,key,environment) VALUES ($1,$2,$3)",
        [id, id, "test"],
      );
      await outbox(
        tx,
        {
          event_type: "test.atomic",
          aggregate_type: "fixture",
          aggregate_id: id,
          event_version: 1,
          external_effect_policy: "IDEMPOTENT",
          payload: {},
          request_id: requestId,
        },
        eventRegistry,
      );
      if (fail) throw new Error("rollback");
    });
  await write(committed, false);
  await assert.rejects(() => write(rolled, true));
  assert.equal(
    (
      await pool.query("SELECT id FROM governance.feature_flags WHERE id=$1", [
        rolled,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM integration.outbox_events WHERE aggregate_id=$1",
        [rolled],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM integration.outbox_events WHERE aggregate_id=$1",
        [committed],
      )
    ).rowCount,
    1,
  );
});
test("idempotency concurrent, mismatch, scope isolation and failed-operation retry", async () => {
  const key = newId();
  let calls = 0;
  const operation = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { id: newId() };
  };
  const values = await Promise.all(
    Array.from({ length: 12 }, () =>
      idempotent(
        pool,
        buildIdempotencyScope({
          accountId: owner,
          operation: "foundation.test",
        }),
        key,
        { amount: 100 },
        operation,
      ),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(new Set(values.map((v) => v.id)).size, 1);
  await assert.rejects(
    () =>
      idempotent(
        pool,
        buildIdempotencyScope({
          accountId: owner,
          operation: "foundation.test",
        }),
        key,
        { amount: 200 },
        operation,
      ),
    { status: 409 },
  );
  await idempotent(
    pool,
    buildIdempotencyScope({
      accountId: newId(),
      operation: "foundation.test",
    }),
    key,
    { amount: 100 },
    operation,
  );
  assert.equal(calls, 2);
  await idempotent(
    pool,
    buildIdempotencyScope({ accountId: owner, operation: "auth.session" }),
    key,
    { amount: 100 },
    operation,
  );
  assert.equal(calls, 3);
  await idempotent(
    pool,
    buildIdempotencyScope({
      accountId: owner,
      organizationId: newId(),
      operation: "foundation.test",
    }),
    key,
    { amount: 100 },
    operation,
  );
  assert.equal(calls, 4);
  const failed = newId();
  await assert.rejects(() =>
    idempotent(
      pool,
      buildIdempotencyScope({ accountId: owner, operation: "foundation.test" }),
      failed,
      {},
      async () => {
        throw new Error("abort");
      },
    ),
  );
  assert.deepEqual(
    await idempotent(
      pool,
      buildIdempotencyScope({ accountId: owner, operation: "foundation.test" }),
      failed,
      {},
      async () => ({ ok: true }),
    ),
    { ok: true },
  );
  const cleanupKey = newId();
  await idempotent(
    pool,
    buildIdempotencyScope({ accountId: owner, operation: "foundation.test" }),
    cleanupKey,
    {},
    async () => ({ ok: true }),
  );
  await ownerPool.query(
    "UPDATE governance.idempotency_records SET expires_at=now()-interval '1 second' WHERE key=$1",
    [cleanupKey],
  );
  assert.equal(await cleanupExpiredIdempotencyRecords(pool, 10), 1);
  await assert.rejects(
    () =>
      idempotent(
        pool,
        buildIdempotencyScope({
          accountId: owner,
          operation: "foundation.test",
        }),
        newId(),
        {},
        async () => ({ body: "x".repeat(9000) }),
      ),
    { status: 500 },
  );
});
test("authenticated inbound event dedup persists exactly once", async () => {
  const id = newId();
  await transaction(pool, async (tx) => {
    await receiveInbound(tx, "fixture", id, {}, requestId);
    await receiveInbound(tx, "fixture", id, {}, requestId);
  });
  assert.equal(
    (
      await pool.query(
        "SELECT id FROM integration.inbound_events WHERE provider_event_id=$1",
        [id],
      )
    ).rowCount,
    1,
  );
});
test("queue consumes, retries, deduplicates, persists dead-letter, recovers queue loss", async () => {
  await pool.query(
    "UPDATE integration.outbox_events SET status='DEAD',processing_token=NULL,lease_until=NULL WHERE event_type IN ('test.retry','test.fail') AND status IN ('PENDING','PROCESSING')",
  );
  let attempts = 0;
  let effects = 0;
  const handlers = new Map<string, Handler>([
    [
      "test.retry",
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        effects++;
      },
    ],
    [
      "test.fail",
      async () => {
        throw new Error("provider secret MUST NOT persist");
      },
    ],
  ]);
  const q = queueFoundation(
    pool,
    c.REDIS_URL,
    "test-" + newId(),
    handlers,
    2,
    eventRegistry,
    { backoffMs: 1 },
  );
  try {
    await q.worker.waitUntilReady();
    const enqueue = (type: string) =>
      transaction(pool, (tx) =>
        outbox(
          tx,
          {
            event_type: type,
            aggregate_type: "fixture",
            aggregate_id: newId(),
            event_version: 1,
            external_effect_policy: "IDEMPOTENT",
            payload: {},
            request_id: requestId,
          },
          eventRegistry,
        ),
      );
    const retry = await enqueue("test.retry");
    const fail = await enqueue("test.fail");
    await q.dispatch();
    await q.dispatch();
    await eventually(async () => {
      await q.dispatch();
      return (
        (
          await pool.query(
            "SELECT status FROM integration.outbox_events WHERE id=$1",
            [retry],
          )
        ).rows[0].status === "PROCESSED"
      );
    });
    assert.equal(attempts, 3);
    assert.equal(effects, 1);
    await eventually(async () => {
      await q.dispatch();
      return (
        (
          await pool.query(
            "SELECT status FROM integration.outbox_events WHERE id=$1",
            [fail],
          )
        ).rows[0].status === "DEAD"
      );
    }, 30000);
    const dead = (
      await pool.query(
        "SELECT * FROM integration.dead_letters WHERE outbox_id=$1",
        [fail],
      )
    ).rows[0];
    assert.equal(dead.attempts, 5);
    assert.equal(dead.error_code, "UNKNOWN_EXTERNAL_OUTCOME");
    assert.equal(dead.request_id, requestId);
    await q.queue.add(
      "test.retry",
      { eventId: retry, requestId },
      { jobId: newId() },
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(effects, 1);
    const lost = await enqueue("test.retry");
    await pool.query(
      "UPDATE integration.outbox_events SET last_enqueued_at=NULL WHERE id=$1",
      [lost],
    );
    await q.dispatch();
    await eventually(
      async () =>
        (
          await pool.query(
            "SELECT status FROM integration.outbox_events WHERE id=$1",
            [lost],
          )
        ).rows[0].status === "PROCESSED",
    );
  } finally {
    await q.close();
  }
});
test("private file lifecycle, MIME verification, fail-closed scanner and cross-account denial", async () => {
  const objects = new Map<string, Uint8Array>();
  const bytes = Buffer.from("%PDF-1.7\nfixture content");
  const store: ObjectStorage = {
    health: async () => {},
    signUpload: async (key) => "https://private/" + key,
    signRead: async (key) => "https://private/" + key,
    read: async (key) => {
      const b = objects.get(key);
      if (!b) throw new Error("missing");
      return b;
    },
    put: async (key, body) => {
      objects.set(key, body);
    },
  };
  const quarantined = files(pool, store, unavailableScanner);
  const f = await quarantined.requestUpload(
    owner,
    "application/pdf",
    bytes.length,
    requestId,
  );
  objects.set("quarantine/" + f.id, bytes);
  assert.equal(await quarantined.scan(f.id, requestId), "QUARANTINED");
  await assert.rejects(() => quarantined.download(f.id, owner, requestId), {
    status: 404,
  });
  const clean = files(
    pool,
    store,
    { scan: async () => "CLEAN" },
    { authorizeDownload: async (accountId) => accountId === owner },
  );
  assert.equal(await clean.scan(f.id, requestId), "ACTIVE");
  await assert.rejects(() => clean.download(f.id, newId(), requestId), {
    status: 404,
  });
  const url = await clean.download(f.id, owner, requestId);
  assert.match(url, /active/);
  objects.set("quarantine/" + f.id, Buffer.from("malicious replacement"));
  assert.deepEqual(objects.get(url.replace("https://private/", "")), bytes);
  const bad = await clean.requestUpload(
    owner,
    "image/png",
    bytes.length,
    requestId,
  );
  objects.set("quarantine/" + bad.id, bytes);
  assert.equal(await clean.scan(bad.id, requestId), "REJECTED");
});
test("HTTP E2E: health, anonymous 401, real session login/revoke, CSRF, headers, request ID and readiness outage", async () => {
  const deps = dependencies(c);
  await eventually(async () => {
    try {
      return (await deps.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  });
  await deps.redis.flushdb();
  deps.storage.health = async () => {};
  const server = await createApp(c, deps);
  try {
    await eventually(async () => {
      try {
        return (await deps.redis.ping()) === "PONG";
      } catch {
        return false;
      }
    });
    const live = await server.fastify.inject({
      url: "/health/live",
      headers: { "x-request-id": "attacker" },
    });
    assert.equal(live.statusCode, 200);
    assert.notEqual(live.headers["x-request-id"], "attacker");
    assert.ok(live.headers["content-security-policy"]);
    assert.equal(
      (await server.fastify.inject("/health/ready")).statusCode,
      200,
    );
    const anonymous = await server.fastify.inject("/api/v1/principal");
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().requestId, anonymous.headers["x-request-id"]);
    const email = owner + "@example.test";
    await ownerPool.query(
      'INSERT INTO iam.auth_credentials(id,"userId","accountId","providerId",password) VALUES ($1,$2::uuid,$2::text,$3,$4) ON CONFLICT DO NOTHING',
      [
        newId(),
        owner,
        "credential",
        await hashPassword("fixture-password-123"),
      ],
    );
    const denied = await server.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/sign-in/email",
      payload: { email, password: "fixture-password-123" },
    });
    assert.equal(denied.statusCode, 403);
    const login = await server.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/sign-in/email",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: "fixture-password-123" },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.map((v) => v.name + "=" + v.value).join("; ");
    assert.ok(cookie);
    const principal = await server.fastify.inject({
      url: "/api/v1/principal",
      headers: { cookie },
    });
    assert.equal(principal.statusCode, 200, principal.body);
    assert.equal(principal.json().personId, null);
    assert.equal(principal.json().accountId, owner);
    assert.equal(
      (
        await server.fastify.inject({
          method: "POST",
          url: "/api/v1/auth/sign-out",
          headers: { origin: "http://localhost:5173", cookie },
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await server.fastify.inject({
          url: "/api/v1/principal",
          headers: { cookie },
        })
      ).statusCode,
      401,
    );
    deps.storage.health = async () => {
      throw new Error("private endpoint");
    };
    const unavailable = await server.fastify.inject("/health/ready");
    assert.equal(unavailable.statusCode, 200);
    assert.equal(unavailable.json().status, "degraded");
    assert.ok(!unavailable.body.includes("private"));
    const missing = await server.fastify.inject("/api/v1/does-not-exist");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().requestId, missing.headers["x-request-id"]);
    const oversized = await server.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/sign-in/email",
      headers: { origin: "http://localhost:5173" },
      payload: { email, password: "x".repeat(20000) },
    });
    assert.equal(oversized.statusCode, 413);
    for (let i = 0; i < 12; i++) {
      const limited = await server.fastify.inject({
        url: "/api/v1/auth/get-session",
      });
      if (i === 11) {
        assert.equal(limited.statusCode, 429);
        assert.equal(limited.json().code, "RATE_LIMITED");
      }
    }
  } finally {
    await server.close();
  }
});
test("readiness reports ready, degraded and unavailable by dependency", async () => {
  let db = true;
  let redis = true;
  let storage = true;
  const deps = {
    pool: {
      totalCount: 0,
      query: async () => {
        if (!db) throw new Error("db internal");
        return { rows: [{ "?column?": 1 }] };
      },
      end: async () => {},
    },
    redis: {
      ping: async () => {
        if (!redis) throw new Error("redis internal");
        return "PONG";
      },
      eval: async () => 1,
      quit: async () => {},
      on: () => {},
    },
    storage: {
      health: async () => {
        if (!storage) throw new Error("storage internal");
      },
    },
    authentication: {
      principal: async () => null,
      auth: {
        handler: async () => new Response("{}", { status: 200 }),
        api: {
          generateOpenAPISchema: async () => ({ paths: {}, components: {} }),
        },
      },
    },
  };
  const server = await createApp(c, deps as never);
  try {
    let response = await server.fastify.inject("/health/ready");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ready");
    storage = false;
    response = await server.fastify.inject("/health/ready");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "degraded");
    assert.equal(response.json().dependencies.storage, "unavailable");
    assert.ok(!response.body.includes("storage internal"));
    storage = true;
    redis = false;
    response = await server.fastify.inject("/health/ready");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "degraded");
    assert.equal(response.json().dependencies.redis, "unavailable");
    redis = true;
    db = false;
    response = await server.fastify.inject("/health/ready");
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, "unavailable");
    assert.equal(response.json().dependencies.database, "unavailable");
    assert.ok(!response.body.includes("db internal"));
  } finally {
    await server.close();
  }
});
