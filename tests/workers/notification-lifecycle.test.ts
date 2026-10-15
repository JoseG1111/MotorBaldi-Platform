import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../../apps/worker/src/index.js";
import type {
  BackgroundWorkerBindings,
  QueueMessage,
} from "@motorbaldi/config";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import { prepareBillingCommand } from "../../packages/payments/src/billing.js";
import {
  createMembershipNotification,
  createSupportNotification,
} from "../../packages/messaging/src/notification-templates.js";
import { outboxStatement } from "@motorbaldi/db";
import { z } from "zod";
import {
  prepareSupportCommand,
  type SupportOperation,
} from "../../packages/messaging/src/support.js";
import type { Event } from "@motorbaldi/db";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";

import m14 from "../../migrations/0014_notifications.sql?raw";

import m15 from "../../migrations/0015_support.sql?raw";
import m16 from "../../migrations/0016_support_history_boundary.sql?raw";
import m20 from "../../migrations/0020_customer_plans.sql?raw";
import m21 from "../../migrations/0021_vehicle_services.sql?raw";
import m29 from "../../migrations/0029_notification_inbox_events.sql?raw";

const db = (env as unknown as ApiBindings).DB;
let preserved: {
  id: string;
  row: unknown;
  templates: unknown;
  foreignKeys: unknown;
};
type Actor = { accountId: string; personId: string; mfaEnabled: boolean };
beforeAll(async () => {
  for (const migration of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m12,
    m13,
    m14,
    m15,
    m16,
    m20,
    m21,
  ])
    await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  const f = await fixture();
  const created = await createMembershipNotification(db, f.event);
  if (created.disposition === "skipped")
    throw new Error("missing migration fixture");
  await db
    .prepare(
      "UPDATE notification_inbox SET read_at=?,version=version+1 WHERE id=?",
    )
    .bind(new Date().toISOString(), created.notificationId)
    .run();
  preserved = {
    id: created.notificationId,
    row: await db
      .prepare("SELECT * FROM notification_inbox WHERE id=?")
      .bind(created.notificationId)
      .first(),
    templates: (
      await db
        .prepare(
          "SELECT * FROM notification_template_versions ORDER BY code,version,locale",
        )
        .all()
    ).results,
    foreignKeys: (
      await db.prepare("PRAGMA foreign_key_list(notification_inbox)").all()
    ).results,
  };
  await db.exec(m29.replace(/^\s*--.*$/gm, "").replace(/\n/g, " "));
});
async function actor(): Promise<Actor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Checkout fixture',?,1)",
    )
    .bind(accountId, accountId + "@example.test")
    .run();
  return {
    accountId,
    personId: (await ensureMotorBaldiAccount(db, accountId, newId())).personId,
    mfaEnabled: false,
  };
}
async function subscription(owner: Actor, annual = false) {
  const response = (await commitPreparedCommand(
    db,
    await prepareBillingCommand(
      db,
      owner,
      "billing.subscription.create",
      { planCode: annual ? "ACOMPANAMIENTO_ANNUAL" : "ACOMPANAMIENTO_MONTHLY" },
      newId(),
    ),
  )) as Record<string, Json>;
  return String(response.subscriptionId);
}
async function fixture() {
  const owner = await actor();
  const id = await subscription(owner);
  const event = await db
    .prepare(
      "SELECT * FROM integration_outbox_events WHERE aggregate_id=? AND event_type='billing.subscription.changed.v1'",
    )
    .bind(id)
    .first<Event>();
  if (!event) throw new Error("Fixture source missing");
  return { owner, id, event };
}
async function count(table: string, where: string, value: string) {
  return (
    await db
      .prepare(`SELECT count(*) n FROM ${table} WHERE ${where}=?`)
      .bind(value)
      .first<{ n: number }>()
  )?.n;
}

async function source(
  type: string,
  aggregate: string,
  payload: Record<string, string>,
  requestId = newId(),
) {
  const entry = outboxStatement(
    db,
    {
      aggregateType: type.startsWith("support") ? "support" : "billing",
      aggregateId: aggregate,
      eventType: type,
      eventVersion: 1,
      payload,
      requestId,
      externalEffectPolicy: "IDEMPOTENT",
    },
    new Map([
      [
        `${type}:1`,
        {
          aggregateType: type.startsWith("support") ? "support" : "billing",
          version: 1,
          payload: z.object(
            Object.fromEntries(
              Object.keys(payload).map((key) => [key, z.string()]),
            ),
          ),
          externalEffect: "IDEMPOTENT",
        },
      ],
    ]),
  );
  await entry.statement.run();
  return (await db
    .prepare("SELECT * FROM integration_outbox_events WHERE id=?")
    .bind(entry.id)
    .first<Event>())!;
}
async function staff() {
  const a = await actor();
  await db
    .prepare("UPDATE auth_users SET two_factor_enabled=1 WHERE id=?")
    .bind(a.accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES(?,?,'synthetic','[]',1)",
    )
    .bind(newId(), a.accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-support')",
    )
    .bind(a.personId)
    .run();
  return { ...a, mfaEnabled: true };
}
async function supportCommand(
  a: Actor,
  operation: SupportOperation,
  body: Record<string, Json>,
) {
  const requestId = newId();
  const result = (await commitPreparedCommand(
    db,
    await prepareSupportCommand(db, a, operation, body, requestId),
  )) as { caseId: string; version: number };
  const event = (await db
    .prepare(
      "SELECT * FROM integration_outbox_events WHERE request_id=? AND event_type=?",
    )
    .bind(requestId, `${operation}.v1`)
    .first<Event>())!;
  return { result, event };
}
async function supportFixture() {
  const owner = await actor(),
    agent = await staff();
  const created = await supportCommand(owner, "support.case.create", {
    purpose: "ACCOUNT",
    subject: "Private subject",
    body: "Private body",
  });
  const replied = await supportCommand(agent, "support.case.reply", {
    caseId: created.result.caseId,
    version: created.result.version,
    body: "Private staff response",
    staff: true,
  });
  return { owner, agent, created, replied };
}
it("preserves existing immutable membership templates, inbox read state and foreign keys during migration", async () => {
  expect(
    await db
      .prepare("SELECT * FROM notification_inbox WHERE id=?")
      .bind(preserved.id)
      .first(),
  ).toEqual(preserved.row);
  expect(
    (
      await db
        .prepare(
          "SELECT * FROM notification_template_versions WHERE code='MEMBERSHIP_UPDATE' ORDER BY code,version,locale",
        )
        .all()
    ).results,
  ).toEqual(preserved.templates);
  expect(
    (await db.prepare("PRAGMA foreign_key_list(notification_inbox)").all())
      .results,
  ).toEqual(preserved.foreignKeys);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});
describe("canonical billing lifecycle inbox", () => {
  it.each(["billing.subscription.expired.v1", "billing.payment.changed.v1"])(
    "creates one private neutral notice for %s",
    async (type) => {
      const f = await fixture();
      let aggregate = f.id,
        payload: Record<string, string> = { subscriptionId: f.id };
      if (type === "billing.payment.changed.v1") {
        const periodId = newId(),
          paymentId = newId();
        await db
          .prepare(
            "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) VALUES(?,?,2,'2026-10-01T00:00:00Z','2026-11-01T00:00:00Z',2990000,'COP')",
          )
          .bind(periodId, f.id)
          .run();
        await db
          .prepare(
            "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,2990000,'COP',?)",
          )
          .bind(paymentId, periodId, newId())
          .run();
        aggregate = paymentId;
        payload = { paymentId, subscriptionId: f.id };
      }
      const event = await source(type, aggregate, payload);
      const results = await Promise.all([
        createMembershipNotification(db, event),
        createMembershipNotification(db, { ...event, payload_json: "forged" }),
      ]);
      expect(results.map((r) => r.disposition).sort()).toEqual([
        "created",
        "duplicate",
      ]);
      const row = await db
        .prepare("SELECT * FROM notification_inbox WHERE source_event_id=?")
        .bind(event.id)
        .first();
      expect(row?.account_id).toBe(f.owner.accountId);
      expect(row?.parameters_json).toBe(
        JSON.stringify({ subscriptionId: f.id }),
      );
      expect(
        await count("notification_inbox", "source_event_id", event.id),
      ).toBe(1);
    },
  );
  it("rejects forged payment/subscription association and malformed payload", async () => {
    const f = await fixture();
    const invalidPayloads: Record<string, string>[] = [
      { paymentId: newId(), subscriptionId: f.id },
      { subscriptionId: f.id, extra: newId() },
    ];
    for (const payload of invalidPayloads) {
      const event = await source(
        "billing.payment.changed.v1",
        newId(),
        payload,
      );
      await expect(createMembershipNotification(db, event)).rejects.toThrow(
        "INVALID_NOTIFICATION_SOURCE",
      );
    }
  });
});
describe("support inbox for Free owners", () => {
  it("notifies staff replies once without copying private case content", async () => {
    const f = await supportFixture();
    expect(
      (await createSupportNotification(db, f.created.event)).disposition,
    ).toBe("skipped");
    const result = await createSupportNotification(db, f.replied.event);
    expect(result.disposition).toBe("created");
    expect(
      (await createSupportNotification(db, f.replied.event)).disposition,
    ).toBe("duplicate");
    const row = await db
      .prepare("SELECT * FROM notification_inbox WHERE source_event_id=?")
      .bind(f.replied.event.id)
      .first();
    expect(row?.account_id).toBe(f.owner.accountId);
    expect(row?.parameters_json).toBe(
      JSON.stringify({ caseId: f.created.result.caseId }),
    );
    expect(JSON.stringify(row)).not.toContain("Private");
    expect(
      await count("billing_subscriptions", "account_id", f.owner.accountId),
    ).toBe(0);
  });
  it.each(["support.case.assign", "support.case.close"] as const)(
    "notifies %s changes",
    async (operation) => {
      const f = await supportFixture();
      const change = await supportCommand(f.agent, operation, {
        caseId: f.created.result.caseId,
        version: f.replied.result.version,
        staff: true,
        ...(operation === "support.case.assign"
          ? { assigneePersonId: f.agent.personId }
          : { resolution: "Private resolution" }),
      });
      expect(
        (await createSupportNotification(db, change.event)).disposition,
      ).toBe("created");
    },
  );
  it("does not notify the owner about their own reply", async () => {
    const f = await supportFixture();
    const own = await supportCommand(f.owner, "support.case.reply", {
      caseId: f.created.result.caseId,
      version: f.replied.result.version,
      body: "Private owner reply",
    });
    expect((await createSupportNotification(db, own.event)).disposition).toBe(
      "skipped",
    );
  });
  it.each(["optout", "suspended", "merged"])(
    "skips %s recipients",
    async (reason) => {
      const f = await supportFixture();
      if (reason === "optout")
        await db
          .prepare(
            "INSERT INTO notification_preferences(id,account_id,category,channel,enabled) VALUES(?,?,'SUPPORT','IN_APP',0)",
          )
          .bind(newId(), f.owner.accountId)
          .run();
      if (reason === "suspended")
        await db
          .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
          .bind(f.owner.accountId)
          .run();
      if (reason === "merged")
        await db
          .prepare(
            "UPDATE iam_people SET status='MERGED',merged_into_person_id=? WHERE id=?",
          )
          .bind(f.agent.personId, f.owner.personId)
          .run();
      expect(
        (await createSupportNotification(db, f.replied.event)).disposition,
      ).toBe("skipped");
    },
  );
  it("rejects forged account/case sources lacking matching audit", async () => {
    const f = await supportFixture();
    const event = await source(
      "support.case.reply.v1",
      f.created.result.caseId,
      { caseId: f.created.result.caseId, accountId: f.agent.accountId },
    );
    await expect(createSupportNotification(db, event)).rejects.toThrow(
      "INVALID_NOTIFICATION_SOURCE",
    );
  });
  it("rolls back inbox and audit if final outbox fails, then retries", async () => {
    const f = await supportFixture();
    await db.exec(
      "CREATE TRIGGER lifecycle_outbox_failure BEFORE INSERT ON integration_outbox_events WHEN NEW.event_type='notification.inbox.created.v1' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
    );
    try {
      await expect(
        createSupportNotification(db, f.replied.event),
      ).rejects.toThrow("synthetic failure");
      expect(
        await count(
          "notification_inbox",
          "source_event_id",
          f.replied.event.id,
        ),
      ).toBe(0);
      expect(
        await count(
          "governance_audit_events",
          "request_id",
          f.replied.event.request_id,
        ),
      ).toBe(1);
    } finally {
      await db.exec("DROP TRIGGER lifecycle_outbox_failure");
    }
    expect(
      (await createSupportNotification(db, f.replied.event)).disposition,
    ).toBe("created");
  });
});

async function deliver(event: Event) {
  let acknowledgements = 0,
    retries = 0;
  const message = {
    body: { eventId: event.id, requestId: event.request_id },
    ack: () => {
      acknowledgements++;
    },
    retry: () => {
      retries++;
    },
  };
  const batch = {
    messages: [message],
  } as unknown as MessageBatch<QueueMessage>;
  await worker.queue(batch, env as unknown as BackgroundWorkerBindings);
  expect(retries).toBe(0);
  expect(acknowledgements).toBe(1);
}
describe("actual worker queue inbox routing", () => {
  it.each([
    "billing.subscription.expired.v1",
    "billing.payment.changed.v1",
    "support.case.reply.v1",
  ])(
    "materializes %s and acknowledges duplicate delivery without a second notice",
    async (type) => {
      let event: Event, accountId: string;
      if (type === "support.case.reply.v1") {
        const f = await supportFixture();
        event = f.replied.event;
        accountId = f.owner.accountId;
      } else {
        const f = await fixture();
        accountId = f.owner.accountId;
        if (type === "billing.payment.changed.v1") {
          const period = (await db
            .prepare("SELECT id FROM billing_periods WHERE subscription_id=?")
            .bind(f.id)
            .first<{ id: string }>())!;
          const paymentId = newId();
          await db
            .prepare(
              "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,2990000,'COP',?)",
            )
            .bind(paymentId, period.id, newId())
            .run();
          event = await source(type, paymentId, {
            paymentId,
            subscriptionId: f.id,
          });
        } else event = await source(type, f.id, { subscriptionId: f.id });
      }
      await deliver(event);
      await deliver(event);
      expect(
        await count("notification_inbox", "source_event_id", event.id),
      ).toBe(1);
      expect(
        await db
          .prepare(
            "SELECT account_id FROM notification_inbox WHERE source_event_id=?",
          )
          .bind(event.id)
          .first("account_id"),
      ).toBe(accountId);
      expect(
        await db
          .prepare("SELECT status FROM integration_outbox_events WHERE id=?")
          .bind(event.id)
          .first("status"),
      ).toBe("PROCESSED");
    },
  );
});
