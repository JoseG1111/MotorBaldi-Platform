import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  buildIdempotencyScope,
  commitIdempotentCommand,
  maxIdempotencyResponseBytes,
  readReplay,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const accountId = "018f0000-0000-7000-8000-000000000901";
const scope = buildIdempotencyScope({
  accountId,
  operation: "organization.create",
});
let personId: string;

beforeAll(async () => {
  for (const migration of [foundation, phase1, closeout]) {
    await db.exec(migration.replace(/\n/g, " "));
  }
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,?,?,1,1)",
    )
    .bind(accountId, "Atomic Command", "atomic-command@example.test")
    .run();
  personId = (
    await ensureMotorBaldiAccount(db, accountId, "atomic-command-provision")
  ).personId;
});

function organizationInsert(id: string, countryCode = "US") {
  return db
    .prepare(
      `INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id)
    VALUES(?,'WORKSHOP','Atomic Workshop','Atomic Workshop',?,?)`,
    )
    .bind(id, countryCode, personId);
}

function prepared(id: string): PreparedCommand<{ organizationId: string }> {
  return {
    statements: [organizationInsert(id)],
    response: { organizationId: id },
  };
}

async function counts(id: string, key: string, requestId: string) {
  const business = await db
    .prepare("SELECT count(*) AS n FROM org_organizations WHERE id=?")
    .bind(id)
    .first<{ n: number }>();
  const replay = await db
    .prepare(
      "SELECT count(*) AS n FROM governance_idempotency_records WHERE scope=? AND key=?",
    )
    .bind(scope.scope, key)
    .first<{ n: number }>();
  const receipt = await db
    .prepare(
      "SELECT count(*) AS n FROM governance_audit_events WHERE action='command.accepted' AND request_id=?",
    )
    .bind(requestId)
    .first<{ n: number }>();
  return { business: business?.n, replay: replay?.n, receipt: receipt?.n };
}

describe("generic idempotent command D1 atomicity", () => {
  it("rolls back replay, receipt and earlier domain effects after a domain constraint fails", async () => {
    const id = newId();
    const key = newId();
    const requestId = newId();
    await expect(
      commitIdempotentCommand(
        db,
        scope,
        key,
        { name: "domain failure" },
        requestId,
        {
          statements: [
            organizationInsert(id),
            organizationInsert(newId(), "invalid"),
          ],
          response: { organizationId: id },
        },
      ),
    ).rejects.toBeTruthy();
    expect(await counts(id, key, requestId)).toEqual({
      business: 0,
      replay: 0,
      receipt: 0,
    });
  });

  it("prevents another business effect when an unexpired replay key collides", async () => {
    const originalId = newId();
    const duplicateId = newId();
    const key = newId();
    const originalRequestId = newId();
    const duplicateRequestId = newId();
    const request = { name: "collision" };
    await commitIdempotentCommand(
      db,
      scope,
      key,
      request,
      originalRequestId,
      prepared(originalId),
    );
    await expect(
      commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        duplicateRequestId,
        prepared(duplicateId),
      ),
    ).rejects.toBeTruthy();
    expect(await counts(originalId, key, originalRequestId)).toEqual({
      business: 1,
      replay: 1,
      receipt: 1,
    });
    expect(await counts(duplicateId, key, duplicateRequestId)).toEqual({
      business: 0,
      replay: 1,
      receipt: 0,
    });
    expect(await readReplay(db, scope, key, request)).toEqual({
      response: { organizationId: originalId },
      replayed: true,
    });
  });

  it("rolls back replay and prevents domain effects when the governance receipt fails", async () => {
    const id = newId();
    const key = newId();
    const requestId = "reject-atomic-command-receipt";
    await db.exec(
      "CREATE TRIGGER test_reject_atomic_receipt BEFORE INSERT ON governance_audit_events WHEN NEW.action='command.accepted' AND NEW.request_id='reject-atomic-command-receipt' BEGIN SELECT RAISE(ABORT,'test receipt rejected'); END;",
    );
    try {
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          key,
          { name: "receipt failure" },
          requestId,
          prepared(id),
        ),
      ).rejects.toBeTruthy();
      expect(await counts(id, key, requestId)).toEqual({
        business: 0,
        replay: 0,
        receipt: 0,
      });
    } finally {
      await db.exec("DROP TRIGGER test_reject_atomic_receipt");
    }
  });

  it("rejects oversized stored responses before committing any effects", async () => {
    const id = newId();
    const key = newId();
    const requestId = newId();
    await expect(
      commitIdempotentCommand(db, scope, key, { name: "oversize" }, requestId, {
        ...prepared(id),
        storedResponse: { data: "x".repeat(maxIdempotencyResponseBytes + 1) },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_RESPONSE_TOO_LARGE" });
    expect(await counts(id, key, requestId)).toEqual({
      business: 0,
      replay: 0,
      receipt: 0,
    });
  });

  it("retries a rolled-back command and replays a lost success response with exactly one effect", async () => {
    const id = newId();
    const key = newId();
    const failedRequestId = newId();
    const successfulRequestId = newId();
    const request = { name: "safe retry" };
    await expect(
      commitIdempotentCommand(db, scope, key, request, failedRequestId, {
        ...prepared(id),
        statements: [
          organizationInsert(id),
          organizationInsert(newId(), "bad"),
        ],
      }),
    ).rejects.toBeTruthy();
    expect(await readReplay(db, scope, key, request)).toBeNull();
    expect(
      await commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        successfulRequestId,
        prepared(id),
      ),
    ).toEqual({ organizationId: id });
    // Simulate a client losing the returned success, then taking the coordinator's replay path.
    expect(await readReplay(db, scope, key, request)).toEqual({
      response: { organizationId: id },
      replayed: true,
    });
    expect(await readReplay(db, scope, key, request)).toEqual({
      response: { organizationId: id },
      replayed: true,
    });
    expect(await counts(id, key, successfulRequestId)).toEqual({
      business: 1,
      replay: 1,
      receipt: 1,
    });
    expect((await counts(id, key, failedRequestId)).receipt).toBe(0);
  });

  it("returns a one-time token but persists and replays only the sanitized stored response", async () => {
    const id = newId();
    const key = newId();
    const requestId = newId();
    const request = { name: "token redaction" };
    const response = {
      organizationId: id,
      token: "synthetic-one-time-test-token",
    };
    expect(
      await commitIdempotentCommand(db, scope, key, request, requestId, {
        statements: [organizationInsert(id)],
        response,
        storedResponse: { organizationId: id },
      }),
    ).toEqual(response);
    expect(await readReplay(db, scope, key, request)).toEqual({
      response: { organizationId: id },
      replayed: true,
    });
    const stored = await db
      .prepare(
        "SELECT response_json FROM governance_idempotency_records WHERE scope=? AND key=?",
      )
      .bind(scope.scope, key)
      .first<{ response_json: string }>();
    expect(stored?.response_json).not.toContain("token");
    expect(await counts(id, key, requestId)).toEqual({
      business: 1,
      replay: 1,
      receipt: 1,
    });
  });

  it("preserves domain CAS conflict translation and rolls back the accepted receipt and replay", async () => {
    const id = newId();
    const key = newId();
    const requestId = newId();
    await organizationInsert(id).run();
    await expect(
      commitIdempotentCommand(db, scope, key, { version: 99 }, requestId, {
        statements: [
          db
            .prepare(
              "UPDATE org_organizations SET display_name='Should not persist',version=version+1 WHERE id=? AND version=99",
            )
            .bind(id),
          db
            .prepare(
              "INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id) VALUES(?,CASE WHEN changes()=1 THEN 'organization.updated' ELSE NULL END,'organization',?,?)",
            )
            .bind(newId(), id, requestId),
        ],
        response: { organizationId: id },
        guard: {
          table: "governance_audit_events",
          column: "action",
          code: "ORGANIZATION_VERSION_CONFLICT",
          message: "Organization changed",
        },
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_VERSION_CONFLICT" });
    expect(await counts(id, key, requestId)).toEqual({
      business: 1,
      replay: 0,
      receipt: 0,
    });
    expect(
      await db
        .prepare(
          "SELECT display_name,version FROM org_organizations WHERE id=?",
        )
        .bind(id)
        .first(),
    ).toMatchObject({ display_name: "Atomic Workshop", version: 1 });
  });
});
