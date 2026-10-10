import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { prepareBillingCommand } from "@motorbaldi/payments";
import {
  commitPreparedCommand,
  commitIdempotentCommand,
  buildIdempotencyScope,
  readReplay,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  parseNotificationCommand,
  prepareNotificationCommand,
  authorizeNotificationCommand,
  listNotificationPreferences,
  listNotificationInbox,
  authorizeNotificationDelivery,
  type NotificationOperation,
} from "../../packages/messaging/src/notifications.js";
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
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function member(): Promise<Actor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Notification Member',?,1)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  return {
    accountId,
    personId: (await ensureMotorBaldiAccount(db, accountId, newId())).personId,
    mfaEnabled: false,
  };
}
async function command(
  actor: Actor,
  operation: NotificationOperation,
  body: Record<string, Json>,
  requestId = newId(),
) {
  return commitPreparedCommand(
    db,
    await prepareNotificationCommand(db, actor, operation, body, requestId),
  ) as Promise<Record<string, Json>>;
}
function preference(overrides: Record<string, Json> = {}) {
  return {
    category: "TRANSACTIONAL",
    channel: "IN_APP",
    enabled: true,
    version: 0,
    ...overrides,
  };
}
async function email(actor: Actor) {
  return (await db
    .prepare(
      "SELECT id FROM iam_contact_methods WHERE person_id=? AND type='EMAIL' AND source='AUTH'",
    )
    .bind(actor.personId)
    .first<{ id: string }>())!.id;
}
async function consent(
  actor: Actor,
  status: "GRANTED" | "REVOKED",
  purpose = "MARKETING_EMAIL",
  at = "2026-01-01T00:00:00.000Z",
) {
  await db
    .prepare(
      "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id,occurred_at) VALUES(?,?,?,'local-policy',?,'LOCAL_FIXTURE',?,?)",
    )
    .bind(newId(), actor.personId, purpose, status, newId(), at)
    .run();
}
async function inbox(actor: Actor) {
  const created = (await commitPreparedCommand(
    db,
    await prepareBillingCommand(
      db,
      actor,
      "billing.subscription.create",
      { planCode: "ACOMPANAMIENTO_MONTHLY" },
      newId(),
    ),
  )) as { subscriptionId: string };
  const source = (await db
    .prepare(
      "SELECT id FROM integration_outbox_events WHERE aggregate_id=? AND event_type='billing.subscription.changed.v1'",
    )
    .bind(created.subscriptionId)
    .first<{ id: string }>())!.id;
  const notificationId = newId();
  await db
    .prepare(
      "INSERT INTO notification_inbox(id,account_id,template_code,template_version,locale,source_event_id,parameters_json) VALUES(?,?,'MEMBERSHIP_UPDATE',1,'es',?,?)",
    )
    .bind(
      notificationId,
      actor.accountId,
      source,
      JSON.stringify({ subscriptionId: created.subscriptionId }),
    )
    .run();
  return { notificationId, source, subscriptionId: created.subscriptionId };
}

describe("account notification intent and private inbox", () => {
  it("rejects mismatched account/person authority for reads, commands and delivery", async () => {
    const actor = await member(),
      other = await member(),
      mismatched = { ...actor, personId: other.personId };
    for (const action of [
      () => listNotificationPreferences(db, mismatched),
      () => listNotificationInbox(db, mismatched),
      () => command(mismatched, "notification.preference.update", preference()),
      () =>
        authorizeNotificationDelivery(db, {
          accountId: actor.accountId,
          personId: other.personId,
          category: "TRANSACTIONAL",
          channel: "EMAIL",
          contactMethodId: actor.accountId,
        }),
    ])
      await expect(action()).rejects.toMatchObject({
        code: "NOTIFICATION_ACCOUNT_UNAVAILABLE",
      });
  });

  it("rolls back a prepared preference after contact verification is revoked", async () => {
    const actor = await member(),
      contactMethodId = await email(actor),
      requestId = newId(),
      prepared = await prepareNotificationCommand(
        db,
        actor,
        "notification.preference.update",
        preference({ channel: "EMAIL", contactMethodId }),
        requestId,
      );
    await db
      .prepare("UPDATE auth_users SET email_verified=0 WHERE id=?")
      .bind(actor.accountId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      code: "NOTIFICATION_STATE_CONFLICT",
    });
    for (const table of [
      "governance_audit_events",
      "integration_outbox_events",
    ])
      expect(
        await db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`)
          .bind(requestId)
          .first(),
      ).toEqual({ n: 0 });
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.category === "TRANSACTIONAL" && p.channel === "EMAIL",
      ),
    ).toMatchObject({ id: null, version: 0, enabled: false });
  });

  it("returns private defaults without premium or MFA gates", async () => {
    const actor = await member(),
      overview = await listNotificationPreferences(db, actor);
    expect(overview.items).toHaveLength(11);
    expect(overview.externalDeliveryAvailable).toBe(false);
    expect(
      overview.items
        .filter((p) => p.enabled)
        .map((p) => [p.category, p.channel]),
    ).toEqual([
      ["TRANSACTIONAL", "IN_APP"],
      ["SUPPORT", "IN_APP"],
    ]);
    expect(
      overview.items.every(
        (p) =>
          p.id === null && p.version === 0 && p.externalAvailable === false,
      ),
    ).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("@example.test");
    const response = await command(
      actor,
      "notification.preference.update",
      preference({ enabled: false }),
    );
    expect(response).toMatchObject({
      enabled: false,
      contactMethodId: null,
      version: 1,
    });
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.category === "TRANSACTIONAL" && p.channel === "IN_APP",
      )?.enabled,
    ).toBe(false);
  });
  it("rejects forbidden marketing inbox, route ownership fields and invalid versions", () => {
    for (const body of [
      preference({ category: "MARKETING" }),
      preference({ accountId: newId() }),
      preference({ version: -1 }),
      preference({ channel: "EMAIL" }),
      preference({ contactMethodId: newId() }),
    ])
      expect(() =>
        parseNotificationCommand("notification.preference.update", body),
      ).toThrow();
    expect(() =>
      parseNotificationCommand("notification.inbox.read", {
        notificationId: newId(),
        version: 0,
      }),
    ).toThrow();
    expect(
      parseNotificationCommand("notification.preference.update", preference()),
    ).toMatchObject({ contactMethodId: null });
  });
  it("requires currently owned verified contacts and current AUTH email binding", async () => {
    const actor = await member(),
      other = await member(),
      ownEmail = await email(actor);
    await expect(
      command(
        actor,
        "notification.preference.update",
        preference({ channel: "EMAIL", contactMethodId: await email(other) }),
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTACT_UNAVAILABLE" });
    const phoneId = newId();
    await db
      .prepare(
        "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,'PHONE','+573001234567','+573001234567','LOCAL_FIXTURE')",
      )
      .bind(phoneId, actor.personId)
      .run();
    await expect(
      command(
        actor,
        "notification.preference.update",
        preference({ channel: "SMS", contactMethodId: phoneId }),
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTACT_UNAVAILABLE" });
    await command(
      actor,
      "notification.preference.update",
      preference({ channel: "EMAIL", contactMethodId: ownEmail }),
    );
    await db
      .prepare("UPDATE auth_users SET email=? WHERE id=?")
      .bind(`changed-${actor.accountId}@example.test`, actor.accountId)
      .run();
    await expect(
      authorizeNotificationCommand(
        db,
        actor,
        "notification.preference.update",
        preference({ channel: "EMAIL", contactMethodId: ownEmail, version: 0 }),
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTACT_UNAVAILABLE" });
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.channel === "EMAIL" && p.category === "TRANSACTIONAL",
      ),
    ).toMatchObject({ enabled: true, effectiveEnabled: false });
  });
  it("requires latest exact-channel marketing consent and preserves opt-out", async () => {
    const actor = await member(),
      contactMethodId = await email(actor),
      body = preference({
        category: "MARKETING",
        channel: "EMAIL",
        contactMethodId,
      });
    await consent(actor, "GRANTED", "MARKETING_SMS");
    await expect(
      command(actor, "notification.preference.update", body),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONSENT_REQUIRED" });
    await consent(actor, "GRANTED");
    await command(actor, "notification.preference.update", body);
    await consent(
      actor,
      "REVOKED",
      "MARKETING_EMAIL",
      "2026-02-01T00:00:00.000Z",
    );
    await expect(
      authorizeNotificationCommand(
        db,
        actor,
        "notification.preference.update",
        body,
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONSENT_REQUIRED" });
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.channel === "EMAIL" && p.category === "MARKETING",
      ),
    ).toMatchObject({ enabled: true, effectiveEnabled: false });
    await command(actor, "notification.preference.update", {
      ...body,
      enabled: false,
      contactMethodId: null,
      version: 1,
    });
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.channel === "EMAIL" && p.category === "MARKETING",
      ),
    ).toMatchObject({ enabled: false, version: 2 });
  });
  it("denies future-dated latest grants in current consent, effective intent and delivery authority", async () => {
    const actor = await member(),
      contactMethodId = await email(actor),
      body = preference({
        category: "MARKETING",
        channel: "EMAIL",
        contactMethodId,
      });
    await consent(actor, "GRANTED");
    await command(actor, "notification.preference.update", body);
    const delivery = {
      accountId: actor.accountId,
      personId: actor.personId,
      category: "MARKETING" as const,
      channel: "EMAIL" as const,
      contactMethodId,
    };
    expect(await authorizeNotificationDelivery(db, delivery)).toEqual({
      status: "UNAVAILABLE",
      code: "TRANSPORT_UNAVAILABLE",
    });
    await consent(
      actor,
      "GRANTED",
      "MARKETING_EMAIL",
      "2099-01-01T00:00:00.000Z",
    );
    await expect(
      authorizeNotificationCommand(
        db,
        actor,
        "notification.preference.update",
        body,
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONSENT_REQUIRED" });
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.category === "MARKETING" && p.channel === "EMAIL",
      ),
    ).toMatchObject({ enabled: true, effectiveEnabled: false });
    await expect(
      authorizeNotificationDelivery(db, delivery),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONSENT_REQUIRED" });
    const other = await member();
    await consent(
      other,
      "GRANTED",
      "MARKETING_EMAIL",
      "2099-01-01T00:00:00.000Z",
    );
    await expect(
      command(other, "notification.preference.update", {
        ...body,
        contactMethodId: await email(other),
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONSENT_REQUIRED" });
  });

  it("rechecks latest opt-out and current AUTH email at external delivery authority", async () => {
    const actor = await member(),
      contactMethodId = await email(actor);
    await consent(actor, "GRANTED");
    await command(
      actor,
      "notification.preference.update",
      preference({ category: "MARKETING", channel: "EMAIL", contactMethodId }),
    );
    const delivery = {
      accountId: actor.accountId,
      personId: actor.personId,
      category: "MARKETING" as const,
      channel: "EMAIL" as const,
      contactMethodId,
    };
    await consent(
      actor,
      "REVOKED",
      "MARKETING_EMAIL",
      "2026-02-01T00:00:00.000Z",
    );
    await expect(
      authorizeNotificationDelivery(db, delivery),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONSENT_REQUIRED" });
    await consent(
      actor,
      "GRANTED",
      "MARKETING_EMAIL",
      "2026-03-01T00:00:00.000Z",
    );
    await db
      .prepare("UPDATE auth_users SET email=? WHERE id=?")
      .bind(`changed-${actor.accountId}@example.test`, actor.accountId)
      .run();
    await expect(
      authorizeNotificationDelivery(db, delivery),
    ).rejects.toMatchObject({ code: "NOTIFICATION_CONTACT_UNAVAILABLE" });
  });

  it("uses exact preference CAS and rechecks revoked consent at mutation time", async () => {
    const actor = await member();
    await command(actor, "notification.preference.update", preference());
    await expect(
      command(
        actor,
        "notification.preference.update",
        preference({ version: 0 }),
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_STATE_CONFLICT" });
    await expect(
      command(
        actor,
        "notification.preference.update",
        preference({ version: 99 }),
      ),
    ).rejects.toMatchObject({ code: "NOTIFICATION_VERSION_CONFLICT" });
    await command(
      actor,
      "notification.preference.update",
      preference({ enabled: false, version: 1 }),
    );
    const contactMethodId = await email(actor);
    await consent(actor, "GRANTED");
    const requestId = newId(),
      prepared = await prepareNotificationCommand(
        db,
        actor,
        "notification.preference.update",
        preference({
          category: "MARKETING",
          channel: "EMAIL",
          contactMethodId,
        }),
        requestId,
      );
    await consent(
      actor,
      "REVOKED",
      "MARKETING_EMAIL",
      "2026-02-01T00:00:00.000Z",
    );
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      code: "NOTIFICATION_STATE_CONFLICT",
    });
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
        )
        .bind(requestId)
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("does not send externally even with a verified consented preference", async () => {
    const actor = await member(),
      contactMethodId = await email(actor);
    await command(
      actor,
      "notification.preference.update",
      preference({ channel: "EMAIL", contactMethodId }),
    );
    expect(
      await authorizeNotificationDelivery(db, {
        accountId: actor.accountId,
        personId: actor.personId,
        category: "TRANSACTIONAL",
        channel: "EMAIL",
        contactMethodId,
      }),
    ).toEqual({ status: "UNAVAILABLE", code: "TRANSPORT_UNAVAILABLE" });
    await command(
      actor,
      "notification.preference.update",
      preference({ channel: "EMAIL", enabled: false, version: 1 }),
    );
    await expect(
      authorizeNotificationDelivery(db, {
        accountId: actor.accountId,
        personId: actor.personId,
        category: "TRANSACTIONAL",
        channel: "EMAIL",
        contactMethodId,
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_PREFERENCE_DISABLED" });
  });
  it("bounds the own-account inbox and marks read with exact CAS and immutable content", async () => {
    const actor = await member(),
      other = await member(),
      notice = await inbox(actor),
      otherNotice = await inbox(other);
    const overview = await listNotificationInbox(db, actor, { limit: 1 });
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({
      id: notice.notificationId,
      locale: "es",
      parameters: { subscriptionId: notice.subscriptionId },
      readAt: null,
      version: 1,
    });
    expect(JSON.stringify(overview)).not.toContain("@example.test");
    expect(overview.items[0]).not.toHaveProperty("accountId");
    await expect(
      listNotificationInbox(db, actor, { cursor: otherNotice.notificationId }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
    await expect(
      command(other, "notification.inbox.read", {
        notificationId: notice.notificationId,
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND" });
    await command(actor, "notification.inbox.read", {
      notificationId: notice.notificationId,
      version: 1,
    });
    await expect(
      command(actor, "notification.inbox.read", {
        notificationId: notice.notificationId,
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "NOTIFICATION_VERSION_CONFLICT" });
    expect(
      await command(actor, "notification.inbox.read", {
        notificationId: notice.notificationId,
        version: 2,
      }),
    ).toMatchObject({ read: true, version: 2 });
    await expect(
      db
        .prepare(
          "UPDATE notification_inbox SET parameters_json='{}',version=version+1 WHERE id=?",
        )
        .bind(notice.notificationId)
        .run(),
    ).rejects.toThrow("NOTIFICATION_INBOX_IMMUTABLE");
    await expect(
      listNotificationInbox(db, actor, { limit: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_NOTIFICATION_CURSOR" });
  });
  it("rolls back a read receipt and replay when its final outbox event fails", async () => {
    const actor = await member(),
      notice = await inbox(actor),
      operation = "notification.inbox.read" as const,
      scope = buildIdempotencyScope({ accountId: actor.accountId, operation }),
      key = newId(),
      requestId = newId(),
      body = { notificationId: notice.notificationId, version: 1 };
    const prepare = () =>
      prepareNotificationCommand(db, actor, operation, body, requestId);
    await db.exec(
      `CREATE TRIGGER reject_notification_read BEFORE INSERT ON integration_outbox_events WHEN NEW.request_id='${requestId}' BEGIN SELECT RAISE(ABORT,'notification read rejected'); END;`,
    );
    try {
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          key,
          body,
          requestId,
          await prepare(),
        ),
      ).rejects.toThrow("notification read rejected");
    } finally {
      await db.exec("DROP TRIGGER reject_notification_read");
    }
    expect((await listNotificationInbox(db, actor)).items[0]).toMatchObject({
      readAt: null,
      version: 1,
    });
    expect(await readReplay(db, scope, key, body)).toBe(null);
    const response = await commitIdempotentCommand(
      db,
      scope,
      key,
      body,
      requestId,
      await prepare(),
    );
    expect((await readReplay(db, scope, key, body))?.response).toEqual(
      response,
    );
    expect((await listNotificationInbox(db, actor)).items[0]).toMatchObject({
      version: 2,
    });
  });

  it("preserves replay and rolls back preference/audit/outbox/replay when the final event fails", async () => {
    const actor = await member(),
      operation = "notification.preference.update" as const,
      scope = buildIdempotencyScope({ accountId: actor.accountId, operation }),
      key = newId(),
      requestId = newId(),
      body = preference();
    const prepare = () =>
      prepareNotificationCommand(db, actor, operation, body, requestId);
    await db.exec(
      `CREATE TRIGGER reject_notification_event BEFORE INSERT ON integration_outbox_events WHEN NEW.request_id='${requestId}' BEGIN SELECT RAISE(ABORT,'notification event rejected'); END;`,
    );
    try {
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          key,
          body,
          requestId,
          await prepare(),
        ),
      ).rejects.toThrow("notification event rejected");
    } finally {
      await db.exec("DROP TRIGGER reject_notification_event");
    }
    expect(await readReplay(db, scope, key, body)).toBe(null);
    expect(
      (await listNotificationPreferences(db, actor)).items.find(
        (p) => p.category === "TRANSACTIONAL" && p.channel === "IN_APP",
      )?.version,
    ).toBe(0);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
        )
        .bind(requestId)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    const response = await commitIdempotentCommand(
      db,
      scope,
      key,
      body,
      requestId,
      await prepare(),
    );
    expect((await readReplay(db, scope, key, body))?.response).toEqual(
      response,
    );
    await db
      .prepare(
        "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(actor.accountId)
      .run();
    await expect(
      authorizeNotificationCommand(db, actor, operation, body),
    ).rejects.toMatchObject({ code: "NOTIFICATION_ACCOUNT_UNAVAILABLE" });
  });
});
