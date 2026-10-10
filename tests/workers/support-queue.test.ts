import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand, type Event } from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";
import {
  prepareSupportCommand,
  supportCommandEventRegistry,
} from "../../packages/messaging/src/support.js";
import {
  supportEventHandlers,
  validateSupportEvent,
} from "../../packages/messaging/src/support-events.js";
import { processEvent } from "../../packages/messaging/src/queue.js";
import {
  HandlerFailure,
  type Handler,
} from "../../packages/messaging/src/handler.js";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m9 from "../../migrations/0009_workshop_files.sql?raw";
import m10 from "../../migrations/0010_inspection_media.sql?raw";
import m11 from "../../migrations/0011_inspection_workflow.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";
import m14 from "../../migrations/0014_notifications.sql?raw";
import m15 from "../../migrations/0015_support.sql?raw";
import m16 from "../../migrations/0016_support_history_boundary.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const handlers = supportEventHandlers(db),
  registry = supportCommandEventRegistry;
beforeAll(async () => {
  for (const m of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m9,
    m10,
    m11,
    m12,
    m13,
    m14,
    m15,
    m16,
  ])
    await db.exec(m.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function fixture() {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Support Queue',?,1)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  const actor = {
      accountId,
      personId: (await ensureMotorBaldiAccount(db, accountId, newId()))
        .personId,
      mfaEnabled: false,
    },
    requestId = newId();
  const result = (await commitPreparedCommand(
    db,
    await prepareSupportCommand(
      db,
      actor,
      "support.case.create",
      { subject: "Private queue subject", body: "Private queue body" },
      requestId,
    ),
  )) as { caseId: string };
  const event = (await db
    .prepare("SELECT * FROM integration_outbox_events WHERE request_id=?")
    .bind(requestId)
    .first<Event>())!;
  return { actor, event, caseId: result.caseId };
}
async function snapshot(caseId: string) {
  return {
    case: await db
      .prepare("SELECT * FROM support_cases WHERE id=?")
      .bind(caseId)
      .first(),
    messages: (
      await db
        .prepare("SELECT * FROM support_messages WHERE case_id=? ORDER BY id")
        .bind(caseId)
        .all()
    ).results,
    history: (
      await db
        .prepare(
          "SELECT * FROM support_case_history WHERE case_id=? ORDER BY id",
        )
        .bind(caseId)
        .all()
    ).results,
  };
}
async function state(eventId: string) {
  return await db
    .prepare(
      "SELECT status,attempts,last_error_code FROM integration_outbox_events WHERE id=?",
    )
    .bind(eventId)
    .first();
}
function wrapper(handler: Handler) {
  return new Map([["support.case.create.v1", handler]]);
}
describe("support queue durable internal processing", () => {
  it("processes persisted command references once across concurrent duplicate deliveries", async () => {
    const { event, caseId } = await fixture(),
      before = await snapshot(caseId),
      calls = vi.fn(handlers.get(event.event_type)!);
    const outcomes = await Promise.all([
      processEvent(db, event.id, wrapper(calls), registry),
      processEvent(db, event.id, wrapper(calls), registry),
    ]);
    expect(outcomes.sort()).toEqual(["ignored", "processed"]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]![1].idempotencyKey).toBe(event.id);
    expect(await processEvent(db, event.id, handlers, registry)).toBe(
      "ignored",
    );
    expect(await snapshot(caseId)).toEqual(before);
    expect(await state(event.id)).toMatchObject({
      status: "PROCESSED",
      attempts: 1,
      last_error_code: null,
    });
  });
  it("permanently rejects forged case/account/audit references with minimal dead-letter codes", async () => {
    for (const mutation of ["case", "account", "audit", "action"]) {
      const { event, caseId } = await fixture(),
        before = await snapshot(caseId);
      const payload = JSON.parse(event.payload_json) as {
        caseId: string;
        accountId: string;
      };
      if (mutation === "case") payload.caseId = newId();
      if (mutation === "account") payload.accountId = newId();
      await db
        .prepare(
          "UPDATE integration_outbox_events SET payload_json=?,request_id=?,event_type=? WHERE id=?",
        )
        .bind(
          JSON.stringify(payload),
          mutation === "audit" ? newId() : event.request_id,
          mutation === "action" ? "support.case.close.v1" : event.event_type,
          event.id,
        )
        .run();
      expect(await processEvent(db, event.id, handlers, registry)).toBe("dead");
      expect(await state(event.id)).toMatchObject({
        status: "DEAD",
        attempts: 1,
        last_error_code: "INVALID_SUPPORT_EVENT",
      });
      const dead = await db
        .prepare("SELECT * FROM integration_dead_letters WHERE outbox_id=?")
        .bind(event.id)
        .first();
      expect(dead).toMatchObject({
        error_code: "INVALID_SUPPORT_EVENT",
        attempts: 1,
        resolved_at: null,
      });
      expect(JSON.stringify(dead)).not.toContain("Private queue");
      expect(await snapshot(caseId)).toEqual(before);
    }
  });
  it("converges after retryable failure without repeating immutable domain effects", async () => {
    const { event, caseId } = await fixture(),
      before = await snapshot(caseId);
    let calls = 0;
    const flaky = wrapper(async (e, c) => {
      if (++calls === 1)
        throw new HandlerFailure("RETRYABLE", "SUPPORT_DB_UNAVAILABLE");
      await handlers.get(e.event_type)!(e, c);
    });
    expect(
      await processEvent(db, event.id, flaky, registry, { backoffMs: 0 }),
    ).toBe("retry");
    expect(
      await processEvent(db, event.id, flaky, registry, { backoffMs: 0 }),
    ).toBe("processed");
    expect(await snapshot(caseId)).toEqual(before);
    expect(await state(event.id)).toMatchObject({
      status: "PROCESSED",
      attempts: 2,
      last_error_code: null,
    });
  });
  it("safely retries an idempotent timeout with an aborted bounded handler", async () => {
    const { event, caseId } = await fixture(),
      before = await snapshot(caseId);
    let aborted = false;
    const stuck = wrapper(
      async (_e, c) =>
        new Promise<void>((resolve) =>
          c.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        ),
    );
    expect(
      await processEvent(db, event.id, stuck, registry, {
        timeoutMs: 5,
        backoffMs: 0,
      }),
    ).toBe("retry");
    expect(aborted).toBe(true);
    expect(await state(event.id)).toMatchObject({
      status: "PENDING",
      last_error_code: "HANDLER_TIMEOUT",
    });
    expect(await processEvent(db, event.id, handlers, registry)).toBe(
      "processed",
    );
    expect(await snapshot(caseId)).toEqual(before);
  });
  it("retains exhausted retry evidence without private body or exception text", async () => {
    const { event, caseId } = await fixture(),
      before = await snapshot(caseId);
    const failing = wrapper(async () => {
      throw new HandlerFailure("RETRYABLE", "Private queue body is sensitive");
    });
    expect(
      await processEvent(db, event.id, failing, registry, {
        maxAttempts: 2,
        backoffMs: 0,
      }),
    ).toBe("retry");
    expect(
      await processEvent(db, event.id, failing, registry, {
        maxAttempts: 2,
        backoffMs: 0,
      }),
    ).toBe("dead");
    expect(await state(event.id)).toMatchObject({
      status: "DEAD",
      attempts: 2,
      last_error_code: "HANDLER_FAILED",
    });
    const dead = await db
      .prepare("SELECT * FROM integration_dead_letters WHERE outbox_id=?")
      .bind(event.id)
      .first();
    expect(dead).toMatchObject({
      error_code: "HANDLER_FAILED",
      attempts: 2,
      resolved_at: null,
    });
    expect(JSON.stringify(dead)).not.toContain("Private queue");
    expect(await snapshot(caseId)).toEqual(before);
  });
  it("processes historical references after account revocation without any external transport", async () => {
    const { event, actor, caseId } = await fixture();
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(actor.accountId)
      .run();
    const before = await snapshot(caseId),
      transport = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected transport"));
    try {
      await validateSupportEvent(db, event);
      expect(await processEvent(db, event.id, handlers, registry)).toBe(
        "processed",
      );
      expect(transport).not.toHaveBeenCalled();
      expect(await snapshot(caseId)).toEqual(before);
      expect(JSON.stringify(await state(event.id))).not.toMatch(
        /DELIVERED|ACCEPTED/,
      );
    } finally {
      transport.mockRestore();
    }
  });
});
