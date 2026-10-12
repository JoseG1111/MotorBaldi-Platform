import { beforeAll, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import type { Event } from "@motorbaldi/db";
import { processEvent } from "../../packages/messaging/src/queue.js";
import {
  colombiaCalendarDate,
  scheduleVehicleReminders,
  processVehicleReminder,
  vehicleReminderEventRegistry,
} from "../../packages/messaging/src/vehicle-reminders.js";
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
  ])
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function fixture(
  days = 15,
  premium = false,
  documentType: "SOAT" | "RTM" = "SOAT",
) {
  const accountId = newId(),
    personId = newId(),
    vehicleId = newId(),
    contactId = newId(),
    entryId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Synthetic reminders',?,1)",
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
      .prepare(
        "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,verified_at,source) VALUES(?,?,'EMAIL',?,?,'VERIFIED','2026-01-01T00:00:00Z','LOCAL_FIXTURE')",
      )
      .bind(
        contactId,
        personId,
        accountId + "@example.test",
        accountId + "@example.test",
      ),
    db
      .prepare(
        "INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id) VALUES(?,?,'TRANSACTIONAL','EMAIL',1,?)",
      )
      .bind(newId(), accountId, contactId),
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
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
      )
      .bind(newId(), vehicleId, personId, accountId),
    db
      .prepare(
        "INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,information_source,verification_status,recorded_by_account_id) VALUES(?,?,?,?,'USER_ENTERED','USER_ENTERED',?)",
      )
      .bind(
        entryId,
        vehicleId,
        documentType,
        new Date(Date.parse("2026-10-11T00:00:00Z") + days * 86400000)
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
  return { accountId, personId, vehicleId, entryId, subscriptionId };
}
async function eventFor(accountId: string) {
  return (await db
    .prepare(
      "SELECT e.* FROM integration_outbox_events e JOIN notification_vehicle_reminders r ON r.source_event_id=e.id WHERE r.account_id=? ORDER BY r.created_at DESC LIMIT 1",
    )
    .bind(accountId)
    .first<Event>())!;
}
describe("Vehicle reminder canonical scheduling and delivery authority", () => {
  it("uses Colombia calendar and queues Free email only at fifteen days, without duplicate or false delivery", async () => {
    expect(colombiaCalendarDate(new Date("2026-10-12T04:59:59Z"))).toBe(
      "2026-10-11",
    );
    expect(colombiaCalendarDate(new Date("2026-10-12T05:00:00Z"))).toBe(
      "2026-10-12",
    );
    const f = await fixture(),
      excluded = await fixture(30);
    await scheduleVehicleReminders(db, now);
    await scheduleVehicleReminders(db, now);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM notification_vehicle_reminders WHERE account_id=?",
        )
        .bind(f.accountId)
        .first("count"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM notification_vehicle_reminders WHERE account_id=?",
        )
        .bind(excluded.accountId)
        .first("count"),
    ).toBe(0);
    expect(
      await processVehicleReminder(db, await eventFor(f.accountId), now),
    ).toBe("UNAVAILABLE");
    expect(
      await processVehicleReminder(db, await eventFor(f.accountId), now),
    ).toBe("UNAVAILABLE");
    expect(
      await db
        .prepare(
          "SELECT reason_code FROM notification_vehicle_reminders WHERE account_id=?",
        )
        .bind(f.accountId)
        .first("reason_code"),
    ).toBe("TRANSPORT_UNAVAILABLE");
  });
  it("Premium schedules thirty, fifteen, seven and one; downgrade cancels queued advanced reminder", async () => {
    for (const days of [30, 15, 7, 1]) {
      const f = await fixture(days, true);
      await scheduleVehicleReminders(db, now);
      expect(await eventFor(f.accountId)).toBeTruthy();
    }
    const f = await fixture(7, true);
    await scheduleVehicleReminders(db, now);
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='EXPIRED',version=version+1 WHERE id=?",
      )
      .bind(f.subscriptionId)
      .run();
    expect(
      await processVehicleReminder(db, await eventFor(f.accountId), now),
    ).toBe("CANCELLED");
  });
  it("new immutable expiry revision and revoked preferences cancel old queued reminders", async () => {
    const f = await fixture();
    await scheduleVehicleReminders(db, now);
    await db
      .prepare(
        "INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,information_source,verification_status,recorded_by_account_id,created_at) VALUES(?,?,'SOAT','2026-12-01','USER_ENTERED','USER_ENTERED',?,'2030-01-01T00:00:00Z')",
      )
      .bind(newId(), f.vehicleId, f.accountId)
      .run();
    expect(
      await processVehicleReminder(db, await eventFor(f.accountId), now),
    ).toBe("CANCELLED");
    const other = await fixture();
    await scheduleVehicleReminders(db, now);
    await db
      .prepare(
        "UPDATE notification_preferences SET enabled=0,version=version+1 WHERE account_id=?",
      )
      .bind(other.accountId)
      .run();
    expect(
      await processVehicleReminder(db, await eventFor(other.accountId), now),
    ).toBe("CANCELLED");
  });
  it("explicit WhatsApp opt-in is Premium only and current grant revocation cancels delivery", async () => {
    for (const premium of [false, true]) {
      const f = await fixture(15, premium),
        phone = newId();
      await db.batch([
        db
          .prepare(
            "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,verified_at,source) VALUES(?,?,'PHONE','+573000000000','+573000000000','VERIFIED','2026-01-01T00:00:00Z','LOCAL_FIXTURE')",
          )
          .bind(phone, f.personId),
        db
          .prepare(
            "INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id) VALUES(?,?,'TRANSACTIONAL','WHATSAPP',1,?)",
          )
          .bind(newId(), f.accountId, phone),
      ]);
      await scheduleVehicleReminders(db, now);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM notification_vehicle_reminders WHERE account_id=? AND channel='WHATSAPP'",
          )
          .bind(f.accountId)
          .first("count"),
      ).toBe(premium ? 1 : 0);
      if (premium) {
        await db
          .prepare(
            "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
          )
          .bind(f.vehicleId)
          .run();
        expect(
          await processVehicleReminder(db, await eventFor(f.accountId), now),
        ).toBe("CANCELLED");
      }
    }
  });
  it("Queue retry retains receipt and provider-unavailable outcome is acknowledged honestly", async () => {
    const f = await fixture();
    await scheduleVehicleReminders(db, now);
    const event = await eventFor(f.accountId);
    const handlers = new Map([
      [
        "notification.vehicle.reminder.v1",
        async (e: Event) => {
          await processVehicleReminder(db, e, now);
        },
      ],
    ]);
    await db.exec(
      "CREATE TRIGGER synthetic_reminder_write_failure BEFORE UPDATE ON notification_vehicle_reminders BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DATABASE_FAILURE'); END;",
    );
    expect(
      await processEvent(db, event.id, handlers, vehicleReminderEventRegistry),
    ).toBe("retry");
    expect(
      await db
        .prepare(
          "SELECT status FROM notification_vehicle_reminders WHERE account_id=?",
        )
        .bind(f.accountId)
        .first("status"),
    ).toBe("QUEUED");
    await db.exec("DROP TRIGGER synthetic_reminder_write_failure;");
    await db
      .prepare(
        "UPDATE integration_outbox_events SET available_at='2020-01-01T00:00:00Z' WHERE id=?",
      )
      .bind(event.id)
      .run();
    expect(
      await processEvent(db, event.id, handlers, vehicleReminderEventRegistry),
    ).toBe("processed");
    expect(
      await db
        .prepare(
          "SELECT status FROM notification_vehicle_reminders WHERE account_id=?",
        )
        .bind(f.accountId)
        .first("status"),
    ).toBe("UNAVAILABLE");
    expect(
      await db
        .prepare("SELECT status FROM integration_outbox_events WHERE id=?")
        .bind(event.id)
        .first("status"),
    ).toBe("PROCESSED");
  });
  it("bounded scan advances beyond denied recipients instead of starving later valid owners", async () => {
    for (let i = 0; i < 101; i++) {
      const f = await fixture();
      await db
        .prepare(
          "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
        )
        .bind(f.vehicleId)
        .run();
    }
    const valid = await fixture();
    for (let i = 0; i < 3; i++) await scheduleVehicleReminders(db, now);
    expect(await eventFor(valid.accountId)).toBeTruthy();
  });
});

it.each(["SOAT", "RTM"] as const)(
  "%s uses exact Free/Premium schedules with idempotent generation",
  async (documentType) => {
    for (const premium of [false, true])
      for (const days of [30, 15, 7, 1]) {
        const f = await fixture(days, premium, documentType);
        await scheduleVehicleReminders(db, now);
        await scheduleVehicleReminders(db, now);
        expect(
          await db
            .prepare(
              "SELECT COUNT(*) AS count FROM notification_vehicle_reminders WHERE account_id=? AND compliance_entry_id=? AND days_before=?",
            )
            .bind(f.accountId, f.entryId, days)
            .first("count"),
        ).toBe(premium || days === 15 ? 1 : 0);
      }
  },
);
