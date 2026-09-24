import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  deterministicTestScanner,
  files,
  unavailableScanner,
} from "@motorbaldi/storage";
import { receiveInbound, type EventRegistry } from "@motorbaldi/db/outbox";
import {
  processEvent,
  recoverExpiredLeases,
  relayOutbox,
} from "@motorbaldi/messaging/queue";
import { HandlerFailure } from "@motorbaldi/messaging/handler";
import { z } from "zod";
import migration from "../../migrations/0001_foundation.sql?raw";

const e = env as unknown as ApiBindings;
const user = "018f0000-0000-7000-8000-000000000099";
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

beforeAll(async () => {
  await e.DB.exec(migration.replace(/\n/g, " "));
  await e.DB.prepare(
    "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
  ).run();
  await e.DB.prepare(
    "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
  )
    .bind(user, "Storage", "storage@example.test")
    .run();
});

describe("R2 storage state machine", () => {
  it("requires quarantine upload and validates size/MIME", async () => {
    const service = files(e.DB, e.PRIVATE_BUCKET, {
      scanner: deterministicTestScanner,
    });
    const pending = await service.requestUpload(
      user,
      "image/png",
      png.length,
      "storage-1",
    );
    await expect(service.scan(pending.id, "storage-1")).rejects.toMatchObject({
      code: "FILE_STATE",
    });
    await expect(
      service.putQuarantineObject(pending.id, png, "image/jpeg"),
    ).rejects.toMatchObject({ code: "FILE_STATE" });
    await service.putQuarantineObject(pending.id, png, "image/png");
    expect(await service.scan(pending.id, "storage-1")).toBe("ACTIVE");
    await expect(service.download(pending.id, user)).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it("rejects infected content and safely handles scanner unavailability", async () => {
    const infected = new TextEncoder().encode("%PDF-1.4\nEICAR fixture\n%%EOF");
    const scanner = files(e.DB, e.PRIVATE_BUCKET, {
      scanner: deterministicTestScanner,
    });
    const upload = await scanner.requestUpload(
      user,
      "application/pdf",
      infected.length,
      "storage-2",
    );
    await scanner.putQuarantineObject(upload.id, infected, "application/pdf");
    expect(await scanner.scan(upload.id, "storage-2")).toBe("REJECTED");
    const unavailable = files(e.DB, e.PRIVATE_BUCKET, {
      scanner: unavailableScanner,
    });
    const retry = await unavailable.requestUpload(
      user,
      "image/png",
      png.length,
      "storage-3",
    );
    await unavailable.putQuarantineObject(retry.id, png, "image/png");
    expect(await unavailable.scan(retry.id, "storage-3")).toBe("QUARANTINED");
  });

  it("recovers expired scan leases and cleans orphan promotions", async () => {
    const service = files(e.DB, e.PRIVATE_BUCKET, {
      scanner: deterministicTestScanner,
    });
    const upload = await service.requestUpload(
      user,
      "image/png",
      png.length,
      "storage-4",
    );
    await service.putQuarantineObject(upload.id, png, "image/png");
    await e.DB.prepare(
      "UPDATE storage_files SET status='SCANNING',scan_token='stale',scan_started_at='2000-01-01T00:00:00.000Z',scan_lease_until='2000-01-01T00:00:00.000Z',scan_attempts=1 WHERE id=?",
    )
      .bind(upload.id)
      .run();
    expect(await service.recoverExpiredFileScans()).toBeGreaterThan(0);
    expect(
      (
        await e.DB.prepare("SELECT status FROM storage_files WHERE id=?")
          .bind(upload.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("QUARANTINED");
    await e.DB.prepare(
      "INSERT INTO storage_file_promotions(object_key,file_id,scan_token,status,created_at) VALUES('active/orphan',?,'lost','CLEANUP','2000-01-01T00:00:00.000Z')",
    )
      .bind(upload.id)
      .run();
    await e.PRIVATE_BUCKET.put("active/orphan", png);
    expect(await service.cleanupOrphanPromotions()).toBeGreaterThan(0);
    expect(await e.PRIVATE_BUCKET.get("active/orphan")).toBeNull();
  });

  it("prevents concurrent scan ownership and marks a lost promotion for cleanup", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = files(e.DB, e.PRIVATE_BUCKET, {
      scanner: {
        async scan() {
          await wait;
          return "CLEAN";
        },
      },
    });
    const upload = await service.requestUpload(
      user,
      "image/png",
      png.length,
      "storage-fence",
    );
    await service.putQuarantineObject(upload.id, png, "image/png");
    const scanning = service.scan(upload.id, "storage-fence");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(
      service.scan(upload.id, "storage-competitor"),
    ).rejects.toMatchObject({ code: "FILE_STATE" });
    await e.DB.prepare(
      "UPDATE storage_files SET scan_lease_until='2000-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(upload.id)
      .run();
    release();
    await expect(scanning).rejects.toMatchObject({ code: "SCAN_LEASE_LOST" });
    const promotion = await e.DB.prepare(
      "SELECT status FROM storage_file_promotions WHERE file_id=?",
    )
      .bind(upload.id)
      .first<{ status: string }>();
    expect(promotion?.status).toBe("CLEANUP");
  });
});

const registry: EventRegistry = new Map([
  [
    "foundation.event:1",
    {
      aggregateType: "foundation",
      version: 1,
      payload: z.object({ value: z.string() }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
async function addEvent(
  id: string,
  policy: "IDEMPOTENT" | "RECONCILE" = "IDEMPOTENT",
) {
  await e.DB.prepare(
    "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES(?,'foundation','one','foundation.event',1,'{\"value\":\"ok\"}',?,?)",
  )
    .bind(id, "request-" + id, policy)
    .run();
}

describe("queue and outbox runtime", () => {
  it("claims once across duplicate delivery and passes deterministic provider idempotency", async () => {
    await addEvent("event-once");
    const keys: string[] = [];
    const handlers = new Map([
      [
        "foundation.event",
        async (_event: unknown, context: { idempotencyKey: string }) => {
          keys.push(context.idempotencyKey);
        },
      ],
    ]);
    const results = await Promise.all([
      processEvent(e.DB, "event-once", handlers, registry),
      processEvent(e.DB, "event-once", handlers, registry),
    ]);
    expect(results).toContain("processed");
    expect(keys).toEqual(["event-once"]);
  });

  it("retries retryable work and atomically dead-letters permanent/unknown outcomes", async () => {
    await addEvent("event-retry");
    expect(
      await processEvent(
        e.DB,
        "event-retry",
        new Map([
          [
            "foundation.event",
            async () => {
              throw new HandlerFailure("RETRYABLE", "TEMPORARY");
            },
          ],
        ]),
        registry,
        { backoffMs: 0 },
      ),
    ).toBe("retry");
    await addEvent("event-dead");
    expect(
      await processEvent(
        e.DB,
        "event-dead",
        new Map([
          [
            "foundation.event",
            async () => {
              throw new HandlerFailure("PERMANENT", "BAD_EVENT");
            },
          ],
        ]),
        registry,
      ),
    ).toBe("dead");
    const dead = await e.DB.prepare(
      "SELECT e.status,d.outbox_id FROM integration_outbox_events e JOIN integration_dead_letters d ON d.outbox_id=e.id WHERE e.id='event-dead'",
    ).first();
    expect(dead).toBeTruthy();
    await addEvent("event-unknown", "RECONCILE");
    expect(
      await processEvent(
        e.DB,
        "event-unknown",
        new Map([
          [
            "foundation.event",
            async () => {
              throw new Error("crash");
            },
          ],
        ]),
        new Map([
          [
            "foundation.event:1",
            {
              ...registry.get("foundation.event:1")!,
              externalEffect: "RECONCILE",
            },
          ],
        ]),
      ),
    ).toBe("dead");
  });

  it("recovers expired claims, relays lost messages, and rejects bad contracts/types", async () => {
    await addEvent("event-expired");
    await e.DB.prepare(
      "UPDATE integration_outbox_events SET status='PROCESSING',attempts=5,processing_token='old',lease_until='2000-01-01T00:00:00.000Z' WHERE id='event-expired'",
    ).run();
    expect(await recoverExpiredLeases(e.DB)).toBeGreaterThan(0);
    await addEvent("event-relay");
    const sent: string[] = [];
    await relayOutbox(
      e.DB,
      {
        send: async (message: { eventId: string }) => {
          sent.push(message.eventId);
        },
      } as unknown as Queue<{ eventId: string; requestId: string }>,
      0,
    );
    expect(sent).toContain("event-relay");
    await addEvent("event-unknown-type");
    expect(
      await processEvent(e.DB, "event-unknown-type", new Map(), registry),
    ).toBe("dead");
  });

  it("returns the canonical identity for concurrent inbound duplicates", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        receiveInbound(
          e.DB,
          "fixture",
          "provider-event-1",
          { ok: true },
          "inbound-request",
        ),
      ),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(
      results.filter((result) => result.disposition === "inserted"),
    ).toHaveLength(1);
  });

  it("rolls back a DEAD transition when dead-letter persistence fails", async () => {
    await addEvent("event-atomic-dead");
    await e.DB.exec(
      "CREATE TRIGGER fail_dead_letter BEFORE INSERT ON integration_dead_letters BEGIN SELECT RAISE(ABORT, 'dead-letter fixture failure'); END",
    );
    await expect(
      processEvent(e.DB, "event-atomic-dead", new Map(), registry),
    ).rejects.toThrow(/dead-letter fixture failure/);
    const event = await e.DB.prepare(
      "SELECT status, processing_token FROM integration_outbox_events WHERE id='event-atomic-dead'",
    ).first<{ status: string; processing_token: string | null }>();
    expect(event?.status).toBe("PROCESSING");
    expect(event?.processing_token).toBeTruthy();
    await e.DB.exec("DROP TRIGGER fail_dead_letter");
  });

  it("dead-letters an event contract version mismatch", async () => {
    await e.DB.prepare(
      "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES('event-version-mismatch','foundation','one','foundation.event',2,'{\"value\":\"ok\"}','request-mismatch','IDEMPOTENT')",
    ).run();
    expect(
      await processEvent(e.DB, "event-version-mismatch", new Map(), registry),
    ).toBe("dead");
  });
});
