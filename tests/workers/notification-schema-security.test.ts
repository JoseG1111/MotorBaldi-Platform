import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
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

const db = (env as unknown as ApiBindings).DB;
beforeAll(async () => {
  for (const sql of [
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
  ])
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function member() {
  const accountId = newId(),
    personId = newId(),
    contactId = newId(),
    email = `${accountId}@example.test`;
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Notification Member',?,1)",
    )
    .bind(accountId, email)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Notification','Member')",
    )
    .bind(personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(accountId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,verified_at,source) VALUES(?,?,'EMAIL',?,?,'VERIFIED','2026-10-09T00:00:00.000Z','AUTH')",
    )
    .bind(contactId, personId, email, email)
    .run();
  return { accountId, personId, contactId };
}
function preference(
  actor: Awaited<ReturnType<typeof member>>,
  options: {
    id?: string;
    category?: string;
    channel?: string;
    enabled?: number;
    contactId?: string | null;
    version?: number;
  } = {},
) {
  return db
    .prepare(
      "INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id,version) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      options.id ?? newId(),
      actor.accountId,
      options.category ?? "TRANSACTIONAL",
      options.channel ?? "IN_APP",
      options.enabled ?? 0,
      options.contactId ?? null,
      options.version ?? 1,
    );
}
async function event(
  actor: Awaited<ReturnType<typeof member>>,
  overrides: {
    aggregateId?: string;
    aggregateType?: string;
    eventType?: string;
    eventVersion?: number;
  } = {},
) {
  const subscriptionId = newId(),
    eventId = newId();
  await db
    .prepare(
      "INSERT INTO billing_subscriptions(id,account_id,plan_code) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY')",
    )
    .bind(subscriptionId, actor.accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES(?,?,?,?,?,?,?,'IDEMPOTENT')",
    )
    .bind(
      eventId,
      overrides.aggregateType ?? "billing",
      overrides.aggregateId ?? subscriptionId,
      overrides.eventType ?? "billing.subscription.changed.v1",
      overrides.eventVersion ?? 1,
      JSON.stringify({ subscriptionId }),
      newId(),
    )
    .run();
  return { eventId, subscriptionId };
}
function inbox(
  actor: Awaited<ReturnType<typeof member>>,
  source: Awaited<ReturnType<typeof event>>,
  options: {
    id?: string;
    parameters?: string;
    readAt?: string | null;
    version?: number;
  } = {},
) {
  return db
    .prepare(
      "INSERT INTO notification_inbox(id,account_id,template_code,template_version,locale,source_event_id,parameters_json,read_at,version) VALUES(?,?,'MEMBERSHIP_UPDATE',1,'es',?,?,?,?)",
    )
    .bind(
      options.id ?? newId(),
      actor.accountId,
      source.eventId,
      options.parameters ??
        JSON.stringify({ subscriptionId: source.subscriptionId }),
      options.readAt ?? null,
      options.version ?? 1,
    );
}
async function consent(
  actor: Awaited<ReturnType<typeof member>>,
  status: "GRANTED" | "REVOKED",
  time: string,
) {
  await db
    .prepare(
      "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id,occurred_at) VALUES(?,?,'MARKETING_EMAIL','notification-test-v1',?,'SELF_SERVICE',?,?)",
    )
    .bind(newId(), actor.personId, status, newId(), time)
    .run();
}
describe("notification D1 identity, consent and inbox boundaries", () => {
  it("preserves immutable template versions and immutable inbox content", async () => {
    await expect(
      db
        .prepare(
          "UPDATE notification_template_versions SET body='Replacement' WHERE code='MEMBERSHIP_UPDATE' AND version=1 AND locale='es'",
        )
        .run(),
    ).rejects.toThrow(/notification templates are immutable/);
    await expect(
      db
        .prepare(
          "DELETE FROM notification_template_versions WHERE code='MEMBERSHIP_UPDATE' AND version=1 AND locale='en'",
        )
        .run(),
    ).rejects.toThrow(/notification templates cannot be deleted/);
    await db
      .prepare(
        "INSERT INTO notification_template_versions(code,version,locale,category,title,body,parameter_contract_json) VALUES('MEMBERSHIP_UPDATE',2,'es','TRANSACTIONAL','New version','New immutable version','{\"subscriptionId\":\"uuid\"}')",
      )
      .run();
    const actor = await member(),
      source = await event(actor),
      id = newId();
    await inbox(actor, source, { id }).run();
    await expect(
      db
        .prepare(
          "UPDATE notification_inbox SET parameters_json='{}',read_at='2026-10-09T12:00:00.000Z',version=2 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/NOTIFICATION_INBOX_IMMUTABLE/);
    await expect(
      db.prepare("DELETE FROM notification_inbox WHERE id=?").bind(id).run(),
    ).rejects.toThrow(/notification history cannot be deleted/);
  });
  it("permits a single read transition and rejects stale version writes", async () => {
    const actor = await member(),
      source = await event(actor),
      id = newId();
    await inbox(actor, source, { id }).run();
    await expect(
      db
        .prepare(
          "UPDATE notification_inbox SET read_at='2026-10-09T12:00:00.000Z',version=3 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/NOTIFICATION_INBOX_IMMUTABLE/);
    const first = await db
      .prepare(
        "UPDATE notification_inbox SET read_at='2026-10-09T12:00:00.000Z',version=2 WHERE id=? AND account_id=? AND version=1",
      )
      .bind(id, actor.accountId)
      .run();
    expect(first.meta.changes).toBe(1);
    expect(
      (
        await db
          .prepare(
            "UPDATE notification_inbox SET read_at='2026-10-09T13:00:00.000Z',version=2 WHERE id=? AND account_id=? AND version=1",
          )
          .bind(id, actor.accountId)
          .run()
      ).meta.changes,
    ).toBe(0);
    await expect(
      db
        .prepare(
          "UPDATE notification_inbox SET read_at='2026-10-09T13:00:00.000Z',version=3 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/NOTIFICATION_INBOX_IMMUTABLE/);
  });
  it("denies a read acknowledgement after the account is suspended", async () => {
    const actor = await member(),
      source = await event(actor),
      id = newId();
    await inbox(actor, source, { id }).run();
    await db
      .prepare(
        "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(actor.accountId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE notification_inbox SET read_at='2026-10-09T12:00:00.000Z',version=2 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(
      /NOTIFICATION_INBOX_IMMUTABLE|NOTIFICATION_INBOX_BOUNDARY/,
    );
  });
  it("requires an active account and owned verified contact for enabled external preferences", async () => {
    const actor = await member(),
      other = await member();
    await expect(
      preference(actor, {
        channel: "EMAIL",
        enabled: 1,
        contactId: other.contactId,
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
    await db
      .prepare(
        "UPDATE iam_contact_methods SET verification_status='UNVERIFIED',verified_at=NULL WHERE id=?",
      )
      .bind(actor.contactId)
      .run();
    await expect(
      preference(actor, {
        channel: "EMAIL",
        enabled: 1,
        contactId: actor.contactId,
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
    await db
      .prepare(
        "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(actor.accountId)
      .run();
    await expect(preference(actor).run()).rejects.toThrow(
      /NOTIFICATION_PREFERENCE_BOUNDARY/,
    );
  });
  it("rejects stale AUTH email evidence and revoked auth verification", async () => {
    const stale = await member();
    await db
      .prepare("UPDATE auth_users SET email=? WHERE id=?")
      .bind(`${newId()}@example.test`, stale.accountId)
      .run();
    await expect(
      preference(stale, {
        channel: "EMAIL",
        enabled: 1,
        contactId: stale.contactId,
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
    const unverified = await member();
    await db
      .prepare("UPDATE auth_users SET email_verified=0 WHERE id=?")
      .bind(unverified.accountId)
      .run();
    await expect(
      preference(unverified, {
        channel: "EMAIL",
        enabled: 1,
        contactId: unverified.contactId,
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
  });
  it("uses the latest marketing consent and cannot reenable after revocation", async () => {
    const actor = await member(),
      id = newId();
    await consent(actor, "GRANTED", "2026-10-09T10:00:00.000Z");
    await preference(actor, {
      id,
      category: "MARKETING",
      channel: "EMAIL",
      enabled: 1,
      contactId: actor.contactId,
    }).run();
    await consent(actor, "REVOKED", "2026-10-09T11:00:00.000Z");
    await db
      .prepare(
        "UPDATE notification_preferences SET enabled=0,version=2 WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE notification_preferences SET enabled=1,version=3 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
    await expect(
      db
        .prepare(
          "UPDATE notification_preferences SET enabled=0,version=4 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
    const revoked = await member();
    await consent(revoked, "GRANTED", "2026-10-09T10:00:00.000Z");
    await consent(revoked, "REVOKED", "2026-10-09T11:00:00.000Z");
    await expect(
      preference(revoked, {
        category: "MARKETING",
        channel: "EMAIL",
        enabled: 1,
        contactId: revoked.contactId,
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_PREFERENCE_BOUNDARY/);
  });
  it("rejects unsupported in-app marketing without inventing a consent purpose", async () => {
    const actor = await member();
    await expect(
      preference(actor, {
        category: "MARKETING",
        channel: "IN_APP",
        enabled: 0,
      }).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
  it("binds inbox source event aggregate, event type, recipient and exact minimal parameters", async () => {
    for (const overrides of [
      { aggregateId: newId() },
      { aggregateType: "organization" },
      { eventType: "billing.payment.changed.v1" },
      { eventVersion: 2 },
    ]) {
      const actor = await member(),
        source = await event(actor, overrides);
      await expect(inbox(actor, source).run()).rejects.toThrow(
        /NOTIFICATION_INBOX_BOUNDARY/,
      );
    }
    const actor = await member(),
      other = await member(),
      source = await event(actor);
    await expect(inbox(other, source).run()).rejects.toThrow(
      /NOTIFICATION_INBOX_BOUNDARY/,
    );
    await expect(
      inbox(actor, source, {
        parameters: JSON.stringify({
          subscriptionId: source.subscriptionId,
          unapprovedField: "synthetic",
        }),
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_INBOX_BOUNDARY/);
    await expect(
      inbox(actor, source, {
        parameters: JSON.stringify({ subscriptionId: newId() }),
      }).run(),
    ).rejects.toThrow(/NOTIFICATION_INBOX_BOUNDARY/);
    await inbox(actor, source).run();
    await expect(inbox(actor, source).run()).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });
  it("allows basic inbox without premium access by default and honors explicit opt-out", async () => {
    const basic = await member(),
      source = await event(basic);
    await inbox(basic, source).run();
    const optedOut = await member(),
      blocked = await event(optedOut);
    await preference(optedOut, { enabled: 0 }).run();
    await expect(inbox(optedOut, blocked).run()).rejects.toThrow(
      /NOTIFICATION_INBOX_BOUNDARY/,
    );
    await expect(
      inbox(basic, source, { readAt: "2026-10-09T12:00:00.000Z" }).run(),
    ).rejects.toThrow(/NOTIFICATION_INBOX_BOUNDARY/);
    const inactive = await member(),
      inactiveSource = await event(inactive);
    await db
      .prepare(
        "UPDATE iam_accounts SET status='CLOSED',version=version+1 WHERE id=?",
      )
      .bind(inactive.accountId)
      .run();
    await expect(inbox(inactive, inactiveSource).run()).rejects.toThrow(
      /NOTIFICATION_INBOX_BOUNDARY/,
    );
  });
  it("keeps external delivery disabled and retention unapproved and unknown", async () => {
    expect(
      await db
        .prepare(
          "SELECT external_delivery_enabled,retention_seconds,retention_approved FROM notification_policy WHERE singleton=1",
        )
        .first(),
    ).toMatchObject({
      external_delivery_enabled: 0,
      retention_seconds: null,
      retention_approved: 0,
    });
    await expect(
      db
        .prepare(
          "UPDATE notification_policy SET external_delivery_enabled=1,version=version+1 WHERE singleton=1",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db
        .prepare(
          "UPDATE notification_policy SET retention_approved=1,version=version+1 WHERE singleton=1",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
