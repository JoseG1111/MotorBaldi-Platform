import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import migration from "../../migrations/0001_foundation.sql?raw";
import phase1Migration from "../../migrations/0002_phase1.sql?raw";
import closeoutMigration from "../../migrations/0003_phase1_closeout.sql?raw";

const bindings = env as unknown as ApiBindings;

beforeAll(async () => {
  await bindings.DB.exec(migration.replace(/\n/g, " "));
  await bindings.DB.exec(phase1Migration.replace(/\n/g, " "));
  await bindings.DB.exec(closeoutMigration.replace(/\n/g, " "));
  await bindings.DB.prepare(
    "INSERT INTO governance_environment_metadata(singleton, environment) VALUES (1, 'production')",
  ).run();
});

describe("Durable Object database identity", () => {
  it("rejects idempotency before any Foundation mutation", async () => {
    const id = bindings.IDEMPOTENCY_COORDINATOR.idFromName(
      "environment-mismatch",
    );
    const response = await bindings.IDEMPOTENCY_COORDINATOR.get(id).fetch(
      new Request("https://coordinator.internal/run", {
        method: "POST",
        body: JSON.stringify({
          key: "mismatch-key",
          scope: {
            accountId: "018f0000-0000-7000-8000-000000000001",
            operation: "foundation.test",
            scope: "mismatch",
            ttlSeconds: 3600,
          },
          request: { value: "test" },
          requestId: "mismatch-request",
        }),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "DATABASE_ENVIRONMENT_MISMATCH",
      message: "Database unavailable",
    });
    const row = await bindings.DB.prepare(
      "SELECT COUNT(*) AS count FROM governance_idempotency_records",
    ).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("rejects outbox relay before changing event state", async () => {
    await bindings.DB.prepare(
      "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES('mismatch-event','foundation','one','foundation.event',1,'{}','mismatch-request','IDEMPOTENT')",
    ).run();
    const id = bindings.OUTBOX_COORDINATOR.idFromName("environment-mismatch");
    const response = await bindings.OUTBOX_COORDINATOR.get(id).fetch(
      "https://coordinator.internal/relay",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "DATABASE_ENVIRONMENT_MISMATCH",
      message: "Database unavailable",
    });
    const row = await bindings.DB.prepare(
      "SELECT status FROM integration_outbox_events WHERE id = 'mismatch-event'",
    ).first<{ status: string }>();
    expect(row?.status).toBe("PENDING");
  });
});
