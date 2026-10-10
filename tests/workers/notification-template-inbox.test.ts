import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import { prepareBillingCommand } from "../../packages/payments/src/billing.js";
import {
  createMembershipNotification,
  renderNotificationTemplate,
} from "../../packages/messaging/src/notification-templates.js";
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

const db = (env as unknown as ApiBindings).DB;
type Actor = { accountId: string; personId: string; mfaEnabled: boolean };
beforeAll(async () => {
  for (const migration of [m1, m2, m3, m4, m5, m6, m7, m8, m12, m13, m14])
    await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/\n/g, " "));
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
describe("registered immutable notification templates", () => {
  it.each(["es", "en"])(
    "renders %s fixed plain text without claiming activation",
    (locale) => {
      const output = renderNotificationTemplate(
        "MEMBERSHIP_UPDATE",
        1,
        locale,
        { subscriptionId: newId() },
      );
      expect(output.body).toMatch(
        locale === "es"
          ? /no confirma un pago ni activa/
          : /does not confirm a payment or activate/,
      );
      expect(Object.isFrozen(output)).toBe(true);
      expect(output.body).not.toContain("<");
    },
  );
  it.each([
    { subscriptionId: newId(), email: "private@example.test" },
    { subscriptionId: "not-uuid" },
    { subscriptionId: newId(), html: "<script>" },
    { subscriptionId: newId(), credential: "secret" },
    null,
  ])("rejects arbitrary or invalid parameters %#", (input) => {
    expect(() =>
      renderNotificationTemplate("MEMBERSHIP_UPDATE", 1, "es", input),
    ).toThrow("INVALID_NOTIFICATION_PARAMETERS");
  });
  it.each([
    ["OTHER", 1, "es"],
    ["MEMBERSHIP_UPDATE", 2, "es"],
    ["MEMBERSHIP_UPDATE", 1, "fr"],
  ] as const)("rejects unregistered %s/%s/%s", (code, version, locale) => {
    expect(() =>
      renderNotificationTemplate(code, version, locale, {
        subscriptionId: newId(),
      }),
    ).toThrow("UNKNOWN_NOTIFICATION_TEMPLATE");
  });
});
describe("authoritative transactional inbox", () => {
  it.each(["es", "en"])(
    "keeps persisted %s template text aligned with the renderer",
    async (locale) => {
      const rendered = renderNotificationTemplate(
        "MEMBERSHIP_UPDATE",
        1,
        locale,
        { subscriptionId: newId() },
      );
      const stored = await db
        .prepare(
          "SELECT category,title,body,parameter_contract_json FROM notification_template_versions WHERE code='MEMBERSHIP_UPDATE' AND version=1 AND locale=?",
        )
        .bind(locale)
        .first<{
          category: string;
          title: string;
          body: string;
          parameter_contract_json: string;
        }>();
      expect(stored).toMatchObject({
        category: rendered.category,
        title: rendered.title,
        body: rendered.body,
      });
      expect(JSON.parse(stored!.parameter_contract_json)).toEqual({
        subscriptionId: "uuid",
      });
      expect(Object.isFrozen(rendered.parameters)).toBe(true);
    },
  );

  it("creates actual inbox plus audit and minimal outbox without changing subscription", async () => {
    const { owner, id, event } = await fixture();
    const result = await createMembershipNotification(db, event);
    expect(result.disposition).toBe("created");
    const row = await db
      .prepare("SELECT * FROM notification_inbox WHERE source_event_id=?")
      .bind(event.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      account_id: owner.accountId,
      template_code: "MEMBERSHIP_UPDATE",
      locale: "es",
      parameters_json: JSON.stringify({ subscriptionId: id }),
    });
    if (!row) throw new Error("Expected inbox");
    expect(
      await count("governance_audit_events", "resource_id", String(row.id)),
    ).toBe(1);
    const out = await db
      .prepare(
        "SELECT payload_json FROM integration_outbox_events WHERE aggregate_id=? AND event_type='notification.inbox.created.v1'",
      )
      .bind(row.id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(out?.payload_json ?? "null")).toEqual({
      notificationId: row.id,
      accountId: owner.accountId,
    });
    expect(
      await db
        .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ status: "PENDING_ACTIVATION" });
  });
  it("converges concurrent and repeated delivery to one permanent tuple", async () => {
    const { event } = await fixture();
    const results = await Promise.all([
      createMembershipNotification(db, event),
      createMembershipNotification(db, event),
    ]);
    expect(results.map((r) => r.disposition).sort()).toEqual([
      "created",
      "duplicate",
    ]);
    expect(await count("notification_inbox", "source_event_id", event.id)).toBe(
      1,
    );
    expect((await createMembershipNotification(db, event)).disposition).toBe(
      "duplicate",
    );
  });
  it("ignores forged queue recipient and payload, and rejects absent source", async () => {
    const { owner, event } = await fixture();
    const other = await fixture();
    await createMembershipNotification(db, {
      ...event,
      aggregate_id: other.id,
      payload_json: JSON.stringify({
        subscriptionId: other.id,
        accountId: other.owner.accountId,
      }),
    });
    expect(
      await db
        .prepare(
          "SELECT account_id FROM notification_inbox WHERE source_event_id=?",
        )
        .bind(event.id)
        .first(),
    ).toEqual({ account_id: owner.accountId });
    await expect(
      createMembershipNotification(db, { ...event, id: newId() }),
    ).rejects.toThrow("INVALID_NOTIFICATION_SOURCE");
  });
  it("rejects malformed stored source bindings", async () => {
    const { event } = await fixture();
    const fakeId = newId();
    await db
      .prepare(
        "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES(?,'billing',?,'billing.subscription.changed.v1',1,?,?,'IDEMPOTENT')",
      )
      .bind(fakeId, newId(), event.payload_json, newId())
      .run();
    await expect(
      createMembershipNotification(db, { ...event, id: fakeId }),
    ).rejects.toThrow("INVALID_NOTIFICATION_SOURCE");
    expect(await count("notification_inbox", "source_event_id", fakeId)).toBe(
      0,
    );
  });
  it("database boundary blocks identity changes during insert", async () => {
    const { owner, event } = await fixture();
    await db.exec(
      `CREATE TRIGGER notification_test_identity BEFORE INSERT ON notification_inbox WHEN NEW.source_event_id='${event.id}' BEGIN UPDATE iam_accounts SET status='SUSPENDED' WHERE id='${owner.accountId}'; END;`,
    );
    try {
      await expect(createMembershipNotification(db, event)).rejects.toThrow(
        "NOTIFICATION_INBOX_BOUNDARY",
      );
      expect(
        await count("notification_inbox", "source_event_id", event.id),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER notification_test_identity");
    }
    expect(
      await db
        .prepare("SELECT status FROM iam_accounts WHERE id=?")
        .bind(owner.accountId)
        .first(),
    ).toEqual({ status: "ACTIVE" });
  });
  it("skips explicit off and inactive identities", async () => {
    const { owner, event } = await fixture();
    await db
      .prepare(
        "INSERT INTO notification_preferences(id,account_id,category,channel,enabled) VALUES(?,?,'TRANSACTIONAL','IN_APP',0)",
      )
      .bind(newId(), owner.accountId)
      .run();
    expect(await createMembershipNotification(db, event)).toEqual({
      disposition: "skipped",
    });
    const second = await fixture();
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(second.owner.accountId)
      .run();
    expect(await createMembershipNotification(db, second.event)).toEqual({
      disposition: "skipped",
    });
  });
  it("rolls back inbox and audit on outbox failure then retries once", async () => {
    const { event } = await fixture();
    await db.exec(
      "CREATE TRIGGER notification_test_fail BEFORE INSERT ON integration_outbox_events WHEN NEW.event_type='notification.inbox.created.v1' BEGIN SELECT RAISE(ABORT,'LOCAL_NOTIFICATION_FAILURE'); END;",
    );
    try {
      await expect(createMembershipNotification(db, event)).rejects.toThrow(
        "LOCAL_NOTIFICATION_FAILURE",
      );
      expect(
        await count("notification_inbox", "source_event_id", event.id),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER notification_test_fail");
    }
    expect((await createMembershipNotification(db, event)).disposition).toBe(
      "created",
    );
  });
  it("database boundary blocks preference changes during insert atomically", async () => {
    const { owner, event } = await fixture();
    await db.exec(
      `CREATE TRIGGER notification_test_preference BEFORE INSERT ON notification_inbox WHEN NEW.source_event_id='${event.id}' BEGIN INSERT INTO notification_preferences(id,account_id,category,channel,enabled) VALUES('${newId()}','${owner.accountId}','TRANSACTIONAL','IN_APP',0); END;`,
    );
    try {
      await expect(createMembershipNotification(db, event)).rejects.toThrow(
        "NOTIFICATION_INBOX_BOUNDARY",
      );
      expect(
        await count("notification_inbox", "source_event_id", event.id),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER notification_test_preference");
    }
  });
});
