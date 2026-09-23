import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type pg from "pg";
import { transaction } from "@motorbaldi/db";
import {
  outbox,
  recoverDeadLetter,
  type EventRegistry,
} from "@motorbaldi/db/outbox";
import {
  claimEvent,
  acknowledgeEvent,
  processEvent,
  recoverExpiredLeases,
  relayOutbox,
  HandlerFailure,
  queueFoundation,
  type Handler,
} from "@motorbaldi/messaging/queue";
import {
  foundationDatabase,
  testConfig,
  eventually,
} from "@motorbaldi/testing";
import { newId } from "@motorbaldi/shared";
let db: Awaited<ReturnType<typeof foundationDatabase>>;
let pool: pg.Pool;
const fixtureIds: string[] = [];
const registry: EventRegistry = new Map([
  [
    "fixture.idempotent:1",
    {
      aggregateType: "fixture",
      version: 1,
      payload: z.object({}),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "fixture.reconcile:1",
    {
      aggregateType: "fixture",
      version: 1,
      payload: z.object({}),
      externalEffect: "RECONCILE",
    },
  ],
]);
before(async () => {
  db = await foundationDatabase();
  pool = db.pool;
});
after(async () => {
  await db?.close();
});
afterEach(async () => {
  if (!pool) return;
  await pool.query(
    "UPDATE integration.outbox_events SET status='DEAD',processing_token=NULL,lease_until=NULL WHERE id=ANY($1::uuid[]) AND status IN ('PENDING','PROCESSING')",
    [fixtureIds],
  );
});
const enqueue = async (policy: "IDEMPOTENT" | "RECONCILE" = "IDEMPOTENT") => {
  const id = await transaction(pool, (tx) =>
    outbox(
      tx,
      {
        event_type:
          policy === "IDEMPOTENT" ? "fixture.idempotent" : "fixture.reconcile",
        aggregate_type: "fixture",
        aggregate_id: newId(),
        event_version: 1,
        external_effect_policy: policy,
        payload: {},
        request_id: newId(),
      },
      registry,
    ),
  );
  fixtureIds.push(id);
  return id;
};
const state = async (id: string) =>
  (
    await pool.query("SELECT * FROM integration.outbox_events WHERE id=$1", [
      id,
    ])
  ).rows[0];
const handlers = (handler: Handler) =>
  new Map([
    ["fixture.idempotent", handler],
    ["fixture.reconcile", handler],
  ]);
const expire = async (id: string) => {
  await pool.query(
    "UPDATE integration.outbox_events SET lease_until=now()-interval '1 second' WHERE id=$1",
    [id],
  );
};
test("contracts reject unknown fields/version before persistence", async () => {
  await assert.rejects(
    () =>
      transaction(pool, (tx) =>
        outbox(
          tx,
          {
            event_type: "fixture.idempotent",
            aggregate_type: "fixture",
            aggregate_id: newId(),
            event_version: 1,
            external_effect_policy: "IDEMPOTENT",
            payload: { role: "admin" },
            request_id: newId(),
          },
          registry,
        ),
      ),
    /INVALID_EVENT_PAYLOAD/,
  );
});
test("Redis unavailable and lost wakeup remain recoverable; no relay transaction during I/O", async () => {
  const id = await enqueue();
  await relayOutbox(
    pool,
    {
      enqueue: async () => {
        throw new Error("Redis unavailable");
      },
    },
    0,
  );
  assert.equal((await state(id)).status, "PENDING");
  assert.equal((await state(id)).last_enqueued_at, null);
  let deliveries = 0;
  const transport = {
    enqueue: async () => {
      const sessions = await db.owner.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
      );
      assert.equal(sessions.rowCount, 0);
      deliveries++;
    },
  };
  await relayOutbox(pool, transport, 0);
  const before = deliveries;
  await relayOutbox(pool, transport, 0);
  assert.ok(deliveries > before, "lost jobs are re-enqueued from PostgreSQL");
});
test("two concurrent workers acquire exactly one lease; duplicate delivery ignored", async () => {
  const id = await enqueue();
  let calls = 0;
  const h = handlers(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
  });
  await Promise.all([
    processEvent(pool, id, h, registry),
    processEvent(pool, id, h, registry),
  ]);
  await processEvent(pool, id, h, registry);
  assert.equal(calls, 1);
  assert.equal((await state(id)).status, "PROCESSED");
});
test("slow provider has no held database transaction", async () => {
  const id = await enqueue();
  await processEvent(
    pool,
    id,
    handlers(async () => {
      await new Promise((r) => setTimeout(r, 30));
      const sessions = await db.owner.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
      );
      assert.equal(sessions.rowCount, 0);
    }),
    registry,
  );
});
test("RETRYABLE uses PostgreSQL delay and attempts; PERMANENT goes directly DEAD", async () => {
  const id = await enqueue();
  assert.equal(
    await processEvent(
      pool,
      id,
      handlers(async () => {
        throw new HandlerFailure("RETRYABLE");
      }),
      registry,
      { backoffMs: 10 },
    ),
    "retry",
  );
  assert.equal((await state(id)).attempts, 1);
  await pool.query(
    "UPDATE integration.outbox_events SET available_at=now() WHERE id=$1",
    [id],
  );
  assert.equal(
    await processEvent(
      pool,
      id,
      handlers(async () => {}),
      registry,
    ),
    "processed",
  );
  const permanent = await enqueue();
  assert.equal(
    await processEvent(
      pool,
      permanent,
      handlers(async () => {
        throw new HandlerFailure("PERMANENT");
      }),
      registry,
    ),
    "dead",
  );
  assert.equal((await state(permanent)).attempts, 1);
});
test("unknown external outcome is quarantined until explicit reconciliation", async () => {
  const id = await enqueue("RECONCILE");
  let calls = 0;
  const h = handlers(async () => {
    calls++;
    throw new HandlerFailure("UNKNOWN_EXTERNAL_OUTCOME");
  });
  await processEvent(pool, id, h, registry);
  await processEvent(pool, id, h, registry);
  assert.equal(calls, 1);
  assert.equal((await state(id)).status, "DEAD");
  const dead = (
    await pool.query(
      "SELECT id FROM integration.dead_letters WHERE outbox_id=$1",
      [id],
    )
  ).rows[0];
  await assert.rejects(
    () =>
      recoverDeadLetter(
        pool,
        dead.id,
        newId(),
        "Verified reconciliation request",
        newId(),
      ),
    /RECONCILIATION_REQUIRED/,
  );
  await recoverDeadLetter(
    pool,
    dead.id,
    newId(),
    "Provider confirmed safe retry",
    newId(),
    { outcome: "SAFE_TO_RETRY", reference: "fixture-confirmed-not-applied" },
  );
  assert.equal(
    await processEvent(
      pool,
      id,
      handlers(async () => {}),
      registry,
    ),
    "processed",
  );
});
test("timeout is unknown outcome and aborts signal; no blind non-idempotent retry", async () => {
  const id = await enqueue("RECONCILE");
  let signal: AbortSignal | undefined;
  await processEvent(
    pool,
    id,
    handlers(async (_event, ctx) => {
      signal = ctx.signal;
      await new Promise(() => {});
    }),
    registry,
    { timeoutMs: 10, leaseMs: 100 },
  );
  assert.equal(signal?.aborted, true);
  assert.equal((await state(id)).status, "DEAD");
});
test("crash after claim recovers lease; fencing rejects stale acknowledgment", async () => {
  const id = await enqueue();
  const old = await claimEvent(pool, id, 10);
  assert.ok(old);
  await expire(id);
  await recoverExpiredLeases(pool);
  const fresh = await claimEvent(pool, id);
  assert.ok(fresh);
  assert.notEqual(old.processing_token, fresh.processing_token);
  assert.equal(await acknowledgeEvent(pool, old), false);
  assert.equal(await acknowledgeEvent(pool, fresh), true);
  const uncertain = await enqueue("RECONCILE");
  await claimEvent(pool, uncertain);
  await expire(uncertain);
  await recoverExpiredLeases(pool);
  assert.equal((await state(uncertain)).status, "DEAD");
});
test("provider success then crash uses same deterministic key and one external effect", async () => {
  const id = await enqueue();
  const effects = new Set<string>();
  const requests: string[] = [];
  const provider = async (key: string) => {
    requests.push(key);
    effects.add(key);
  };
  const first = await claimEvent(pool, id);
  assert.ok(first);
  await provider(first.id); // process dies before acknowledgment
  await expire(id);
  await recoverExpiredLeases(pool);
  await processEvent(
    pool,
    id,
    handlers(async (_event, ctx) => {
      await provider(ctx.idempotencyKey);
    }),
    registry,
  );
  assert.deepEqual(requests, [id, id]);
  assert.equal(effects.size, 1);
  assert.equal((await state(id)).status, "PROCESSED");
});
test("unknown event type fails closed to DLQ", async () => {
  const id = await enqueue();
  await processEvent(pool, id, new Map(), registry);
  assert.equal((await state(id)).last_error_code, "UNKNOWN_EVENT_TYPE");
});
test("real BullMQ duplicate wakeups and PostgreSQL retry are safe", async () => {
  const id = await enqueue();
  let calls = 0;
  const q = queueFoundation(
    pool,
    testConfig().REDIS_URL,
    "hardening-" + newId(),
    handlers(async () => {
      calls++;
      if (calls === 1) throw new HandlerFailure("RETRYABLE");
    }),
    2,
    registry,
    { backoffMs: 10 },
  );
  try {
    await q.worker.waitUntilReady();
    await q.queue.add("fixture", { eventId: id }, { jobId: newId() });
    await q.queue.add("fixture", { eventId: id }, { jobId: newId() });
    await eventually(async () => {
      await q.dispatch();
      return (await state(id)).status === "PROCESSED";
    });
    assert.equal(calls, 2);
  } finally {
    await q.close();
  }
});
