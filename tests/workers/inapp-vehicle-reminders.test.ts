import { beforeAll, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { scheduleInAppVehicleReminders } from "../../packages/messaging/src/inapp-vehicle-reminders.js";
import { colombiaCalendarDate } from "../../packages/messaging/src/vehicle-reminders.js";
import m29 from "../../migrations/0029_notification_inbox_events.sql?raw";
import m0 from "../../migrations/0001_foundation.sql?raw";
import m1 from "../../migrations/0002_phase1.sql?raw";
import m2 from "../../migrations/0003_phase1_closeout.sql?raw";
import m3 from "../../migrations/0004_vehicle_core.sql?raw";
import m4 from "../../migrations/0005_vehicle_access.sql?raw";
import m5 from "../../migrations/0006_vehicle_history.sql?raw";
import m6 from "../../migrations/0007_vehicle_commands.sql?raw";
import m7 from "../../migrations/0008_workshop_operations.sql?raw";
import m8 from "../../migrations/0009_workshop_files.sql?raw";
import m9 from "../../migrations/0010_inspection_media.sql?raw";
import m10 from "../../migrations/0011_inspection_workflow.sql?raw";
import m11 from "../../migrations/0012_billing_membership.sql?raw";
import m12 from "../../migrations/0013_payment_provider_evidence.sql?raw";
import m13 from "../../migrations/0014_notifications.sql?raw";
import m14 from "../../migrations/0015_support.sql?raw";
import m15 from "../../migrations/0016_support_history_boundary.sql?raw";
import m16 from "../../migrations/0017_parts_catalog.sql?raw";
import m17 from "../../migrations/0018_development_automation.sql?raw";
import m18 from "../../migrations/0019_marketplace_discovery.sql?raw";
import m19 from "../../migrations/0020_customer_plans.sql?raw";
import m20 from "../../migrations/0021_vehicle_services.sql?raw";
import m23 from "../../migrations/0024_notification_delivery_tracking.sql?raw";
import m25 from "../../migrations/0026_reminder_provider_outcomes.sql?raw";
import m26 from "../../migrations/0027_controlled_notification_tests.sql?raw";
import m21 from "../../migrations/0022_vehicle_reminders.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const now = new Date("2026-10-11T12:00:00.000Z");
beforeAll(async () => {
  for (const sql of [
    m0,
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
    m17,
    m18,
    m19,
    m20,
    m21,
    m23,
    m25,
    m26,
    m29,
  ])
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'development')",
    )
    .run();
});
async function fixture(
  days = 15,
  premium = false,
  documentType: "SOAT" | "RTM" = "SOAT",
  clock = now,
  grant = "current",
) {
  const accountId = newId(),
    personId = newId(),
    vehicleId = newId(),
    contactId = newId(),
    entryId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Synthetic reminders',?,0)",
      )
      .bind(accountId, accountId + "@example.test"),
    db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Synthetic','Reminders')",
      )
      .bind(personId),
    db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(accountId, personId),
    db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
      .bind(vehicleId),
    db
      .prepare(
        "INSERT INTO vehicle_relationships(id,vehicle_id,person_id,relationship_type) VALUES(?,?,?,'OWNER')",
      )
      .bind(newId(), vehicleId, personId),
    db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id,granted_at,expires_at) VALUES(?,?,?,'vehicle.read',?,?,?)",
      )
      .bind(
        newId(),
        vehicleId,
        personId,
        accountId,
        grant === "expired"
          ? "2019-01-01T00:00:00Z"
          : grant === "futureGrant"
            ? "2035-01-01T00:00:00Z"
            : new Date().toISOString(),
        grant === "expired" ? "2020-01-01T00:00:00Z" : null,
      ),
    db
      .prepare(
        "INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,information_source,verification_status,recorded_by_account_id) VALUES(?,?,?,?,'USER_ENTERED','USER_ENTERED',?)",
      )
      .bind(
        entryId,
        vehicleId,
        documentType,
        new Date(
          Date.parse(colombiaCalendarDate(clock) + "T00:00:00Z") +
            days * 86400000,
        )
          .toISOString()
          .slice(0, 10),
        accountId,
      ),
  ]);
  let subscriptionId: string | null = null;
  if (premium) {
    subscriptionId = newId();
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_subscriptions(id,account_id,plan_code,status) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY','PENDING_ACTIVATION')",
        )
        .bind(subscriptionId, accountId),
      db
        .prepare(
          "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,'2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',?,'Synthetic local authorised grant')",
        )
        .bind(newId(), subscriptionId, accountId),
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start='2020-01-01T00:00:00Z',current_period_end='2035-01-01T00:00:00Z',version=version+1 WHERE id=?",
        )
        .bind(subscriptionId),
    ]);
  }
  return { accountId, personId, vehicleId, entryId, contactId, subscriptionId };
}
async function inbox(accountId: string) {
  return (
    await db
      .prepare(
        "SELECT * FROM notification_inbox WHERE account_id=? AND template_code='VEHICLE_EXPIRY'",
      )
      .bind(accountId)
      .all<{ id: string; source_event_id: string; parameters_json: string }>()
  ).results;
}
async function optout(accountId: string) {
  await db
    .prepare(
      "INSERT INTO notification_preferences(id,account_id,category,channel,enabled) VALUES(?,?,'TRANSACTIONAL','IN_APP',0)",
    )
    .bind(newId(), accountId)
    .run();
}
describe("default-enabled canonical in-app vehicle reminders", () => {
  it("requires no verified contact or provider and atomically emits inbox, audit and distinct canonical source", async () => {
    const f = await fixture();
    await scheduleInAppVehicleReminders(db, now);
    await scheduleInAppVehicleReminders(db, now);
    const rows = await inbox(f.accountId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.parameters_json)).toEqual({
      entryId: f.entryId,
      daysBefore: 15,
    });
    const source = await db
      .prepare("SELECT * FROM integration_outbox_events WHERE id=?")
      .bind(rows[0]!.source_event_id)
      .first<{
        event_type: string;
        aggregate_id: string;
        payload_json: string;
      }>();
    expect(source?.event_type).toBe("notification.vehicle.inapp.reminder.v1");
    expect(source?.aggregate_id).toBe(f.entryId);
    expect(JSON.parse(source!.payload_json)).toEqual({
      entryId: f.entryId,
      accountId: f.accountId,
      daysBefore: 15,
      calendarDate: colombiaCalendarDate(now),
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM governance_audit_events WHERE resource_id=? AND action='notification.inbox.created'",
        )
        .bind(rows[0]!.id)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM integration_outbox_events WHERE aggregate_id=? AND event_type='notification.inbox.created.v1'",
        )
        .bind(rows[0]!.id)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM notification_vehicle_reminders WHERE account_id=?",
        )
        .bind(f.accountId)
        .first("n"),
    ).toBe(0);
  });
  it.each(["SOAT", "RTM"] as const)(
    "applies Free/Premium calendar cadence to %s",
    async (document) => {
      for (const premium of [false, true])
        for (const days of [30, 15, 7, 1]) {
          const f = await fixture(days, premium, document);
          await scheduleInAppVehicleReminders(db, now);
          expect(await inbox(f.accountId)).toHaveLength(
            premium || days === 15 ? 1 : 0,
          );
        }
    },
  );
  it.each([
    "optout",
    "revoked",
    "expired",
    "futureGrant",
    "retired",
    "account",
    "person",
    "latest",
  ])("excludes current %s authority", async (change) => {
    const f = await fixture(15, false, "SOAT", now, change);
    if (change === "optout") await optout(f.accountId);
    if (change === "revoked")
      await db
        .prepare(
          "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
        )
        .bind(f.vehicleId)
        .run();
    if (change === "retired")
      await db
        .prepare(
          "UPDATE vehicle_relationships SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
        )
        .bind(f.vehicleId)
        .run();
    if (change === "account")
      await db
        .prepare(
          "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
        )
        .bind(f.accountId)
        .run();
    if (change === "person")
      await db
        .prepare(
          "UPDATE iam_people SET status='PROVISIONAL',version=version+1 WHERE id=?",
        )
        .bind(f.personId)
        .run();
    if (change === "latest")
      await db
        .prepare(
          "INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,information_source,verification_status,recorded_by_account_id,created_at) VALUES(?,?,'SOAT','2027-01-01','USER_ENTERED','USER_ENTERED',?,'2030-01-01T00:00:00Z')",
        )
        .bind(newId(), f.vehicleId, f.accountId)
        .run();
    await scheduleInAppVehicleReminders(db, now);
    expect(await inbox(f.accountId)).toHaveLength(0);
  });
  it.each(["optout", "revoked"])(
    "rechecks %s between selection and atomic persistence",
    async (change) => {
      const f = await fixture();
      let changed = false;
      const raced = new Proxy(db, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (!changed) {
                changed = true;
                if (change === "optout") await optout(f.accountId);
                else
                  await db
                    .prepare(
                      "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
                    )
                    .bind(f.vehicleId)
                    .run();
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await scheduleInAppVehicleReminders(raced, now);
      expect(changed).toBe(true);
      expect(await inbox(f.accountId)).toHaveLength(0);
      expect(
        await db
          .prepare(
            "SELECT count(*) n FROM integration_outbox_events WHERE aggregate_id=? AND event_type='notification.vehicle.inapp.reminder.v1'",
          )
          .bind(f.entryId)
          .first("n"),
      ).toBe(0);
    },
  );
  it("rolls back source, inbox and audit when output persistence fails", async () => {
    const f = await fixture();
    await db.exec(
      "CREATE TRIGGER synthetic_inapp_failure BEFORE INSERT ON integration_outbox_events WHEN NEW.event_type='notification.inbox.created.v1' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_INAPP_FAILURE'); END;",
    );
    try {
      await expect(scheduleInAppVehicleReminders(db, now)).rejects.toThrow(
        "SYNTHETIC_INAPP_FAILURE",
      );
    } finally {
      await db.exec("DROP TRIGGER synthetic_inapp_failure;");
    }
    expect(await inbox(f.accountId)).toHaveLength(0);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM integration_outbox_events WHERE aggregate_id=? AND event_type='notification.vehicle.inapp.reminder.v1'",
        )
        .bind(f.entryId)
        .first("n"),
    ).toBe(0);
    await scheduleInAppVehicleReminders(db, now);
    expect(await inbox(f.accountId)).toHaveLength(1);
  });
});

it("excludes an otherwise permitted vehicle outside its owner's current plan rank", async () => {
  const f = await fixture();
  const older = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO vehicle_vehicles(id,kind_code,created_at) VALUES(?,'CAR','2020-01-01T00:00:00Z')",
      )
      .bind(older),
    db
      .prepare(
        "INSERT INTO vehicle_relationships(id,vehicle_id,person_id,relationship_type) VALUES(?,?,?,'OWNER')",
      )
      .bind(newId(), older, f.personId),
  ]);
  await scheduleInAppVehicleReminders(db, now);
  expect(await inbox(f.accountId)).toHaveLength(0);
});
it("bounds denied recipients and advances to a later eligible recipient", async () => {
  for (let i = 0; i < 101; i++) {
    const f = await fixture();
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
      )
      .bind(f.vehicleId)
      .run();
  }
  const f = await fixture();
  await scheduleInAppVehicleReminders(db, now);
  expect(await inbox(f.accountId)).toHaveLength(0);
  await scheduleInAppVehicleReminders(db, now);
  expect(await inbox(f.accountId)).toHaveLength(1);
});
it("rejects another account's inbox against a valid reminder source", async () => {
  const f = await fixture(),
    other = await fixture();
  for (let i = 0; i < 3; i++) await scheduleInAppVehicleReminders(db, now);
  const source = (await inbox(f.accountId))[0]!;
  await expect(
    db
      .prepare(
        "INSERT INTO notification_inbox(id,account_id,template_code,template_version,locale,source_event_id,parameters_json) VALUES(?,?,'VEHICLE_EXPIRY',1,'es',?,?)",
      )
      .bind(
        newId(),
        other.accountId,
        source.source_event_id,
        JSON.stringify({ entryId: f.entryId, daysBefore: 15 }),
      )
      .run(),
  ).rejects.toThrow("NOTIFICATION_INBOX_BOUNDARY");
});
