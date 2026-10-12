import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { ApiBindings } from "@motorbaldi/config";
import { outboxStatement, type EventRegistry } from "@motorbaldi/db";
import { notificationProviderRoutes } from "../../apps/api/src/notification-provider-routes.js";
import {
  dispatchTrackedCommunication,
  applyProviderDeliveryStatus,
} from "../../packages/messaging/src/delivery-tracking.js";
import type {
  CommunicationTransport,
  DeliveryRequest,
} from "../../packages/messaging/src/providers.js";
import type { NormalizedProviderStatus } from "../../packages/messaging/src/provider-webhooks.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import tracking from "../../migrations/0024_notification_delivery_tracking.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const registry: EventRegistry = new Map([
  [
    "notification.fixture.v1:1",
    {
      aggregateType: "notification",
      version: 1,
      payload: z.object({}),
      externalEffect: "RECONCILE",
    },
  ],
]);
beforeAll(async () => {
  for (const migration of [foundation, tracking])
    await db.exec(migration.replace(/\n/g, " "));
});
async function fixture(send?: CommunicationTransport["send"]) {
  const event = outboxStatement(
    db,
    {
      aggregateType: "notification",
      aggregateId: "fixture",
      eventType: "notification.fixture.v1",
      eventVersion: 1,
      payload: {},
      requestId: "fixture-request",
      externalEffectPolicy: "RECONCILE",
    },
    registry,
  );
  await event.statement.run();
  const request: DeliveryRequest = {
    id: event.id,
    requestId: "fixture-request",
    recipient: "private-recipient@example.test",
    template: "expiry",
    variables: { privateBody: "private-message-content" },
    signal: new AbortController().signal,
  };
  const sendMock = vi.fn(
    send ??
      (async () => ({
        status: "ACCEPTED" as const,
        providerReference: "local-" + event.id,
      })),
  );
  const transport: CommunicationTransport = {
    capabilities: {
      availability: "AVAILABLE",
      channels: ["EMAIL"],
      idempotency: "UNSUPPORTED",
      reconciliation: "UNSUPPORTED",
    },
    send: sendMock,
  };
  const options = {
    provider: "RESEND" as const,
    channel: "EMAIL" as const,
    request,
    transport,
    authorize: async () => {},
  };
  return {
    options,
    sendMock,
    dispatch: () => dispatchTrackedCommunication(db, options),
  };
}
const ledger = (id: string) =>
  db
    .prepare("SELECT * FROM notification_external_deliveries WHERE id=?")
    .bind(id)
    .first<Record<string, unknown>>();
const evidence = (
  reference: string,
  suffix: string,
  status: NormalizedProviderStatus["status"] = "DELIVERED",
): NormalizedProviderStatus => ({
  provider: "RESEND",
  providerReference: reference,
  evidenceId: "evidence-" + suffix,
  status,
  occurredAt: "2026-10-12T12:00:00.000Z",
  payloadSha256: "a".repeat(64),
});
async function acceptedFixture() {
  const f = await fixture();
  const receipt = await f.dispatch();
  expect(receipt.status).toBe("ACCEPTED");
  return { ...f, reference: receipt.providerReference! };
}
const audits = async (id: string) =>
  (await db
    .prepare(
      "SELECT count(*) AS n FROM governance_audit_events WHERE resource_id=?",
    )
    .bind(id)
    .first<{ n: number }>())!.n;
describe("permanent notification dispatch ledger with actual D1 and local transport fixtures", () => {
  it("records provider acceptance with delivery still pending and no recipient/content copied", async () => {
    const f = await acceptedFixture();
    const row = await ledger(f.options.request.id);
    expect(row).toMatchObject({
      status: "ACCEPTED",
      delivery_status: "PENDING",
      provider_reference: f.reference,
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(f.options.request.recipient);
    expect(stored).not.toContain("private-message-content");
    expect(stored).not.toContain("privateBody");
    expect(row?.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("replays accepted dispatch without a second send even after 24 hours", async () => {
    const f = await acceptedFixture();
    await db
      .prepare(
        "UPDATE notification_external_deliveries SET created_at='2020-01-01T00:00:00.000Z',updated_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(f.options.request.id)
      .run();
    expect(await f.dispatch()).toEqual({
      status: "ACCEPTED",
      providerReference: f.reference,
    });
    expect(f.sendMock).toHaveBeenCalledOnce();
    expect(await audits(f.options.request.id)).toBe(2);
  });
  it("reserves concurrent duplicate dispatch exactly once", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.dispatch(),
      f.dispatch(),
      f.dispatch(),
    ]);
    expect(f.sendMock).toHaveBeenCalledOnce();
    expect(results.some((r) => r.status === "ACCEPTED")).toBe(true);
    expect((await f.dispatch()).status).toBe("ACCEPTED");
  });
  it.each(["UNKNOWN", "NETWORK", "ABORT"])(
    "quarantines %s and never blindly retries",
    async (mode) => {
      const controller = new AbortController();
      const f = await fixture(async () => {
        if (mode === "UNKNOWN")
          return { status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" };
        if (mode === "ABORT") controller.abort();
        throw new Error("local network failure");
      });
      if (mode === "ABORT") f.options.request.signal = controller.signal;
      expect((await f.dispatch()).status).toBe("UNKNOWN");
      expect((await f.dispatch()).status).toBe("UNKNOWN");
      expect((await ledger(f.options.request.id))?.status).toBe("UNKNOWN");
      expect(f.sendMock).toHaveBeenCalledOnce();
    },
  );
  it("never resends a reservation left behind by a crash", async () => {
    const f = await acceptedFixture();
    await db
      .prepare(
        "UPDATE notification_external_deliveries SET status='RESERVED',provider_reference=NULL WHERE id=?",
      )
      .bind(f.options.request.id)
      .run();
    expect((await f.dispatch()).status).toBe("UNKNOWN");
    expect(f.sendMock).toHaveBeenCalledOnce();
  });
  it("rejects altered payload and provider mismatches against the permanent reservation", async () => {
    const f = await acceptedFixture();
    expect(
      await dispatchTrackedCommunication(db, {
        ...f.options,
        request: { ...f.options.request, recipient: "changed@example.test" },
      }),
    ).toEqual({ status: "REJECTED", code: "INVALID_REQUEST" });
    expect(
      await dispatchTrackedCommunication(db, {
        ...f.options,
        provider: "META_WHATSAPP",
      }),
    ).toEqual({ status: "REJECTED", code: "INVALID_REQUEST" });
    expect(f.sendMock).toHaveBeenCalledOnce();
  });
  it("denied current authority makes no HTTP call and is not retried", async () => {
    const f = await fixture();
    f.options.authorize = async () => {
      throw new Error("denied");
    };
    expect(await f.dispatch()).toEqual({
      status: "REJECTED",
      code: "AUTHORITY_DENIED",
    });
    await f.dispatch();
    expect(f.sendMock).not.toHaveBeenCalled();
  });
  it("allows a retry after D1 failure before reservation without an external send", async () => {
    const f = await fixture();
    const failingDb = {
      batch: vi.fn(async () => {
        throw new Error("local D1 pre-reservation failure");
      }),
      prepare: db.prepare.bind(db),
    } as unknown as D1Database;
    await expect(
      dispatchTrackedCommunication(failingDb, f.options),
    ).rejects.toThrow("pre-reservation failure");
    expect(await ledger(f.options.request.id)).toBeNull();
    expect(f.sendMock).not.toHaveBeenCalled();
    expect((await f.dispatch()).status).toBe("ACCEPTED");
    expect(f.sendMock).toHaveBeenCalledOnce();
  });
  it("applies known evidence once, preserving immutable status history and one audit", async () => {
    const f = await acceptedFixture();
    const status = evidence(f.reference, f.options.request.id);
    expect(
      await applyProviderDeliveryStatus(db, status, "webhook-one"),
    ).toEqual({ applied: true });
    const count = await audits(f.options.request.id);
    expect(
      await applyProviderDeliveryStatus(db, status, "webhook-replay"),
    ).toEqual({ applied: false });
    expect(await audits(f.options.request.id)).toBe(count);
    expect((await ledger(f.options.request.id))?.delivery_status).toBe(
      "DELIVERED",
    );
    await expect(
      db
        .prepare(
          "UPDATE notification_provider_status_events SET status='READ' WHERE evidence_id=?",
        )
        .bind(status.evidenceId)
        .run(),
    ).rejects.toThrow("IMMUTABLE_PROVIDER_STATUS");
    await expect(
      db
        .prepare(
          "DELETE FROM notification_provider_status_events WHERE evidence_id=?",
        )
        .bind(status.evidenceId)
        .run(),
    ).rejects.toThrow("IMMUTABLE_PROVIDER_STATUS");
    const stored = await db
      .prepare(
        "SELECT * FROM notification_provider_status_events WHERE evidence_id=?",
      )
      .bind(status.evidenceId)
      .first();
    expect(JSON.stringify(stored)).not.toContain(f.options.request.recipient);
    expect(JSON.stringify(stored)).not.toContain("private-message-content");
  });
  it("out-of-order sent and failed statuses cannot downgrade delivered/read", async () => {
    const f = await acceptedFixture();
    for (const [index, status] of (
      ["DELIVERED", "SENT", "READ", "FAILED", "SENT"] as const
    ).entries()) {
      await applyProviderDeliveryStatus(
        db,
        evidence(f.reference, f.options.request.id + index, status),
        "webhook",
      );
      expect((await ledger(f.options.request.id))?.delivery_status).toBe(
        index < 2 ? "DELIVERED" : "READ",
      );
    }
  });
  it("does not associate unmatched references or a different provider", async () => {
    const f = await acceptedFixture();
    for (const status of [
      evidence("unmatched-reference", f.options.request.id),
      {
        ...evidence(f.reference, f.options.request.id),
        provider: "META_WHATSAPP" as const,
      },
    ])
      expect(
        await applyProviderDeliveryStatus(db, status, "unmatched"),
      ).toEqual({ applied: false });
    expect((await ledger(f.options.request.id))?.delivery_status).toBe(
      "PENDING",
    );
    expect(await audits(f.options.request.id)).toBe(2);
  });
  it("rejects changed payload/status on replay of an existing evidence ID without altering delivery", async () => {
    const f = await acceptedFixture();
    const status = evidence(f.reference, f.options.request.id, "SENT");
    await applyProviderDeliveryStatus(db, status, "first");
    const count = await audits(f.options.request.id);
    await expect(
      applyProviderDeliveryStatus(
        db,
        { ...status, status: "READ", payloadSha256: "b".repeat(64) },
        "changed",
      ),
    ).rejects.toThrow();
    expect((await ledger(f.options.request.id))?.delivery_status).toBe("SENT");
    expect(await audits(f.options.request.id)).toBe(count);
  });
  it("rejects reusing evidence ID against a different delivery without reassociation", async () => {
    const first = await acceptedFixture();
    const second = await acceptedFixture();
    const status = evidence(
      first.reference,
      first.options.request.id,
      "DELIVERED",
    );
    await applyProviderDeliveryStatus(db, status, "first-delivery");
    await expect(
      applyProviderDeliveryStatus(
        db,
        { ...status, providerReference: second.reference },
        "different-delivery",
      ),
    ).rejects.toThrow();
    expect((await ledger(second.options.request.id))?.delivery_status).toBe(
      "PENDING",
    );
    expect(await audits(second.options.request.id)).toBe(2);
    const stored = await db
      .prepare(
        "SELECT delivery_id FROM notification_provider_status_events WHERE provider=? AND evidence_id=?",
      )
      .bind(status.provider, status.evidenceId)
      .first<{ delivery_id: string }>();
    expect(stored?.delivery_id).toBe(first.options.request.id);
  });
});

function webhookBindings(
  environment: ApiBindings["ENVIRONMENT"] = "development",
  configured = true,
): ApiBindings {
  return {
    ...env,
    DB: db,
    ENVIRONMENT: environment,
    RESEND_WEBHOOK_SECRET: configured
      ? "whsec_" + btoa("synthetic-webhook-test-secret")
      : undefined,
    META_WHATSAPP_APP_SECRET: configured
      ? "synthetic-meta-app-secret"
      : undefined,
    META_WHATSAPP_PHONE_NUMBER_ID: configured ? "123456789" : undefined,
    META_WHATSAPP_WEBHOOK_VERIFY_TOKEN: configured
      ? "synthetic-verification-token"
      : undefined,
  } as unknown as ApiBindings;
}
const webhookPaths = [
  "/api/v1/notifications/providers/resend/events",
  "/api/v1/notifications/providers/meta/events",
] as const;
function webhookPost(path: string, body = "{}") {
  return new Request("https://api.test" + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "svix-id": "synthetic-evidence",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1," + btoa("wrong-synthetic-signature"),
      "x-hub-signature-256": "sha256=" + "0".repeat(64),
    },
  });
}
describe("notification provider route boundaries without transport calls", () => {
  it.each(webhookPaths)(
    "requires development webhook configuration for exact path %s",
    async (path) => {
      await expect(
        notificationProviderRoutes(
          webhookPost(path),
          webhookBindings("development", false),
          "missing-config",
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: "NOTIFICATIONS_UNAVAILABLE",
      });
    },
  );
  it.each(webhookPaths)(
    "rejects wrong synthetic signatures before any D1 status update for %s",
    async (path) => {
      const f = await acceptedFixture();
      const before = await audits(f.options.request.id);
      await expect(
        notificationProviderRoutes(
          webhookPost(path),
          webhookBindings(),
          "bad-signature",
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: "INVALID_PROVIDER_SIGNATURE",
      });
      expect((await ledger(f.options.request.id))?.delivery_status).toBe(
        "PENDING",
      );
      expect(await audits(f.options.request.id)).toBe(before);
    },
  );
  it.each(webhookPaths)(
    "rejects raw bodies over 64 KiB for %s",
    async (path) => {
      await expect(
        notificationProviderRoutes(
          webhookPost(path, "x".repeat(65537)),
          webhookBindings(),
          "oversize",
        ),
      ).rejects.toMatchObject({
        status: 413,
        code: "PROVIDER_PAYLOAD_TOO_LARGE",
      });
    },
  );
  it.each(["staging", "production"] as const)(
    "keeps both providers unavailable in configured %s",
    async (environment) => {
      for (const path of webhookPaths)
        await expect(
          notificationProviderRoutes(
            webhookPost(path),
            webhookBindings(environment),
            "non-development",
          ),
        ).rejects.toMatchObject({
          status: 503,
          code: "NOTIFICATIONS_UNAVAILABLE",
        });
    },
  );
  it("returns a plain no-store Meta verification challenge for the correct synthetic token", async () => {
    const request = new Request(
      "https://api.test" +
        webhookPaths[1] +
        "?hub.mode=subscribe&hub.verify_token=synthetic-verification-token&hub.challenge=fixture_challenge_123",
    );
    const response = await notificationProviderRoutes(
      request,
      webhookBindings(),
      "verify-challenge",
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("fixture_challenge_123");
    expect(response?.headers.get("content-type")).toBe("text/plain");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects the wrong Meta verification token", async () => {
    await expect(
      notificationProviderRoutes(
        new Request(
          "https://api.test" +
            webhookPaths[1] +
            "?hub.mode=subscribe&hub.verify_token=wrong-synthetic-token&hub.challenge=fixture_challenge_123",
        ),
        webhookBindings(),
        "wrong-token",
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "INVALID_PROVIDER_SIGNATURE",
    });
  });
  it("deduplicates identical Meta semantic evidence despite a different envelope hash", async () => {
    const f = await fixture();
    f.options.transport.capabilities = {
      ...f.options.transport.capabilities,
      channels: ["WHATSAPP"],
    };
    const receipt = await dispatchTrackedCommunication(db, {
      ...f.options,
      provider: "META_WHATSAPP",
      channel: "WHATSAPP",
      request: { ...f.options.request, recipient: "+573001234567" },
    });
    expect(receipt.status).toBe("ACCEPTED");
    const status: NormalizedProviderStatus = {
      ...evidence(receipt.providerReference!, f.options.request.id),
      provider: "META_WHATSAPP",
    };
    expect(
      await applyProviderDeliveryStatus(db, status, "meta-first-envelope"),
    ).toEqual({ applied: true });
    const before = await audits(f.options.request.id);
    expect(
      await applyProviderDeliveryStatus(
        db,
        { ...status, payloadSha256: "b".repeat(64) },
        "meta-second-envelope",
      ),
    ).toEqual({ applied: false });
    expect(await audits(f.options.request.id)).toBe(before);
    expect((await ledger(f.options.request.id))?.delivery_status).toBe(
      "DELIVERED",
    );
    const stored = await db
      .prepare(
        "SELECT payload_sha256 FROM notification_provider_status_events WHERE provider='META_WHATSAPP' AND evidence_id=?",
      )
      .bind(status.evidenceId)
      .first<{ payload_sha256: string }>();
    expect(stored?.payload_sha256).toBe(status.payloadSha256);
  });
});

it("retains an early signed status and reconciles it after provider acceptance is bound", async () => {
  const reference = "early-delivery-reference";
  const evidence: NormalizedProviderStatus = {
    provider: "RESEND",
    evidenceId: "early-status-event",
    providerReference: reference,
    status: "DELIVERED",
    occurredAt: "2026-10-12T00:00:00.000Z",
    payloadSha256: "a".repeat(64),
  };
  const f = await fixture(async () => {
    expect(
      await applyProviderDeliveryStatus(db, evidence, "early-webhook"),
    ).toEqual({ applied: false });
    expect(
      await db
        .prepare(
          "SELECT status FROM integration_inbound_events WHERE provider_event_id=?",
        )
        .bind(evidence.evidenceId)
        .first(),
    ).toEqual({ status: "PENDING" });
    return { status: "ACCEPTED", providerReference: reference };
  });
  expect(await f.dispatch()).toEqual({
    status: "ACCEPTED",
    providerReference: reference,
  });
  expect(
    await db
      .prepare(
        "SELECT delivery_status FROM notification_external_deliveries WHERE id=?",
      )
      .bind(f.options.request.id)
      .first(),
  ).toEqual({ delivery_status: "DELIVERED" });
  expect(
    await db
      .prepare(
        "SELECT status FROM integration_inbound_events WHERE provider_event_id=?",
      )
      .bind(evidence.evidenceId)
      .first(),
  ).toEqual({ status: "PROCESSED" });
  expect(f.sendMock).toHaveBeenCalledOnce();
});
