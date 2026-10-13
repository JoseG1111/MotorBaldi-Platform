import { beforeAll, describe, it, expect, vi } from "vitest";
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
  vehicleReminderEventHandlers,
  dispatchControlledVehicleReminders,
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
import m23 from "../../migrations/0024_notification_delivery_tracking.sql?raw";
import m25 from "../../migrations/0026_reminder_provider_outcomes.sql?raw";
import m26 from "../../migrations/0027_controlled_notification_tests.sql?raw";
import {
  issueControlledWhatsAppPermit,
  reserveControlledWhatsAppPermit,
} from "../../packages/messaging/src/controlled-delivery.js";
import { sha256Hex } from "@motorbaldi/shared";
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

async function controlledFixture() {
  const clock = new Date();
  const f = await fixture(15, true, "SOAT", clock);
  const phoneId = newId(),
    sessionId = newId(),
    recipient = "+573001234567";
  await db.batch([
    db
      .prepare(
        "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,verified_at,source) VALUES(?,?,'PHONE',?,?,'VERIFIED',?,'LOCAL_FIXTURE')",
      )
      .bind(phoneId, f.personId, recipient, recipient, clock.toISOString()),
    db
      .prepare(
        "INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id) VALUES(?,?,'TRANSACTIONAL','WHATSAPP',1,?)",
      )
      .bind(newId(), f.accountId, phoneId),
    db
      .prepare("UPDATE auth_users SET two_factor_enabled=1 WHERE id=?")
      .bind(f.accountId),
    db
      .prepare(
        "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES(?,?,'local-fixture-secret','[]',1)",
      )
      .bind(newId(), f.accountId),
    db
      .prepare(
        "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(?,?,?,?)",
      )
      .bind(
        sessionId,
        f.accountId,
        newId(),
        new Date(clock.getTime() + 3600000).toISOString(),
      ),
    db.prepare(
      "INSERT OR IGNORE INTO authz_role_permissions(role_id,permission_code) SELECT id,'platform.notifications.controlled-test' FROM authz_roles WHERE code='OPERATIONS_ADMIN' AND scope='PLATFORM'",
    ),
    db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id,assigned_by_person_id) SELECT ?,id,? FROM authz_roles WHERE code='OPERATIONS_ADMIN' AND scope='PLATFORM'",
      )
      .bind(f.personId, f.personId),
  ]);
  await scheduleVehicleReminders(db, clock);
  const event = (await db
    .prepare(
      "SELECT e.* FROM integration_outbox_events e JOIN notification_vehicle_reminders r ON r.source_event_id=e.id WHERE r.account_id=? AND r.channel='WHATSAPP'",
    )
    .bind(f.accountId)
    .first<Event>())!;
  const target = {
    reminderId: event.aggregate_id,
    sourceEventId: event.id,
    recipient,
  };
  const bindings = {
    ENVIRONMENT: "development",
    NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED: "true",
    META_WHATSAPP_ACCESS_TOKEN: "local-token-placeholder",
    META_WHATSAPP_PHONE_NUMBER_ID: "123456789",
    META_WHATSAPP_API_VERSION: "v26.0",
    META_WHATSAPP_APPROVED_TEMPLATE: "vehicle_document_expiry",
    META_WHATSAPP_TEMPLATE_LANGUAGE: "es_CO",
    META_WHATSAPP_TEMPLATE_STATUS: "APPROVED",
    META_WHATSAPP_TEST_RECIPIENT_SHA256: await sha256Hex(recipient),
  };
  return {
    ...f,
    clock,
    event,
    target,
    bindings,
    actor: { accountId: f.accountId, sessionId },
    phoneId,
  };
}

describe("controlled Development WhatsApp permit", () => {
  it("keeps general policy closed and consumes one audited exact-target permit before mocked HTTP", async () => {
    const f = await controlledFixture();
    const { permitId } = await issueControlledWhatsAppPermit(
      db,
      f.bindings,
      f.actor,
      f.target,
      { requestId: newId(), reason: "Local regression fixture" },
    );
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        expect(
          await db
            .prepare(
              "SELECT reserved_at FROM notification_controlled_delivery_permits WHERE id=?",
            )
            .bind(permitId)
            .first("reserved_at"),
        ).toBeTruthy();
        expect(
          await db
            .prepare(
              "SELECT status FROM notification_external_deliveries WHERE source_event_id=?",
            )
            .bind(f.event.id)
            .first("status"),
        ).toBe("RESERVED");
        return Response.json({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.local_fixture" }],
        });
      });
    try {
      expect(
        await processVehicleReminder(db, f.event, f.clock, f.bindings),
      ).toBe("ACCEPTED");
      expect(
        await processVehicleReminder(db, f.event, f.clock, f.bindings),
      ).toBe("ACCEPTED");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        await db
          .prepare(
            "SELECT external_delivery_enabled FROM notification_policy WHERE singleton=1",
          )
          .first("external_delivery_enabled"),
      ).toBe(0);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) FROM governance_audit_events WHERE resource_id=? AND action IN ('notification.controlled.permit.issued','notification.controlled.permit.reserved')",
          )
          .bind(permitId)
          .first("COUNT(*)"),
      ).toBe(2);
    } finally {
      fetcher.mockRestore();
    }
  });
  it("rejects unsupported duration and a stale assured session without creating a permit", async () => {
    const f = await controlledFixture();
    await expect(
      issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
        requestId: newId(),
        reason: "Local regression",
        validitySeconds: 901,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .prepare(
        "UPDATE auth_sessions SET expires_at='2020-01-01T00:00:00Z' WHERE id=?",
      )
      .bind(f.actor.sessionId)
      .run();
    await expect(
      issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
        requestId: newId(),
        reason: "Local regression",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) FROM notification_controlled_delivery_permits WHERE reminder_id=?",
        )
        .bind(f.target.reminderId)
        .first("COUNT(*)"),
    ).toBe(0);
  });
  it("rechecks current grant atomically and never sends after revocation", async () => {
    const f = await controlledFixture();
    await issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
      requestId: newId(),
      reason: "Local regression",
    });
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
      )
      .bind(f.vehicleId)
      .run();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider HTTP"));
    try {
      await processVehicleReminder(db, f.event, f.clock, f.bindings);
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        await db
          .prepare(
            "SELECT reserved_at FROM notification_controlled_delivery_permits WHERE reminder_id=?",
          )
          .bind(f.target.reminderId)
          .first("reserved_at"),
      ).toBeNull();
    } finally {
      fetcher.mockRestore();
    }
  });
});

it("quarantines ambiguous controlled provider effects across redelivery", async () => {
  const f = await controlledFixture();
  await issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
    requestId: newId(),
    reason: "Local ambiguity fixture",
    validitySeconds: 900,
  });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Mock connection lost"));
  try {
    await expect(
      processVehicleReminder(db, f.event, f.clock, f.bindings),
    ).rejects.toThrow("EXTERNAL_DELIVERY_UNKNOWN");
    expect(await processVehicleReminder(db, f.event, f.clock, f.bindings)).toBe(
      "UNKNOWN",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare(
          "SELECT status FROM notification_external_deliveries WHERE source_event_id=?",
        )
        .bind(f.event.id)
        .first("status"),
    ).toBe("UNKNOWN");
  } finally {
    fetcher.mockRestore();
  }
});

it.each([
  "preference",
  "owner",
  "coverage",
  "contact",
  "template",
  "allowlist",
])("closes controlled sends when current %s changes", async (change) => {
  const f = await controlledFixture();
  await issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
    requestId: newId(),
    reason: "Local negative fixture",
  });
  if (change === "preference")
    await db
      .prepare(
        "UPDATE notification_preferences SET enabled=0,version=version+1 WHERE account_id=? AND channel='WHATSAPP'",
      )
      .bind(f.accountId)
      .run();
  if (change === "owner")
    await db
      .prepare(
        "UPDATE vehicle_relationships SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
      )
      .bind(f.vehicleId)
      .run();
  if (change === "coverage")
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(f.subscriptionId)
      .run();
  if (change === "contact")
    await db
      .prepare(
        "UPDATE iam_contact_methods SET verification_status='UNVERIFIED',verified_at=NULL WHERE id=?",
      )
      .bind(f.phoneId)
      .run();
  if (change === "template")
    f.bindings.META_WHATSAPP_TEMPLATE_STATUS = "PENDING";
  if (change === "allowlist")
    f.bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256 = "0".repeat(64);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected provider HTTP"));
  try {
    await processVehicleReminder(db, f.event, f.clock, f.bindings);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});

it("atomically denies permit reservation after staff authority is revoked", async () => {
  const f = await controlledFixture();
  const { permitId } = await issueControlledWhatsAppPermit(
    db,
    f.bindings,
    f.actor,
    f.target,
    { requestId: newId(), reason: "Local reservation race" },
  );
  await db
    .prepare(
      "INSERT INTO notification_external_deliveries(id,source_event_id,provider,channel,payload_sha256,status) VALUES(?,?,'META_WHATSAPP','WHATSAPP',?,'RESERVED')",
    )
    .bind(f.event.id, f.event.id, "0".repeat(64))
    .run();
  await db
    .prepare("DELETE FROM platform_person_roles WHERE person_id=?")
    .bind(f.personId)
    .run();
  await expect(
    reserveControlledWhatsAppPermit(db, f.bindings, f.target),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    await db
      .prepare(
        "SELECT reserved_at FROM notification_controlled_delivery_permits WHERE id=?",
      )
      .bind(permitId)
      .first("reserved_at"),
  ).toBeNull();
});

it("rejects a mismatched source event and recipient hash without issuing durable permits", async () => {
  const f = await controlledFixture();
  const options = { requestId: newId(), reason: "Local target binding" };
  await expect(
    issueControlledWhatsAppPermit(
      db,
      f.bindings,
      f.actor,
      { ...f.target, sourceEventId: newId() },
      options,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    issueControlledWhatsAppPermit(
      db,
      f.bindings,
      f.actor,
      { ...f.target, recipient: "+573001234568" },
      options,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM notification_controlled_delivery_permits WHERE reminder_id=?",
      )
      .bind(f.target.reminderId)
      .first("COUNT(*)"),
  ).toBe(0);
});

async function revokePendingLocalPermits() {
  await db
    .prepare(
      "UPDATE notification_controlled_delivery_permits SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reserved_at IS NULL AND revoked_at IS NULL",
    )
    .run();
}

describe("bounded controlled permit cron drain", () => {
  it("permits a later human authorization after canonical Queue processing and sends once without rewriting outbox history", async () => {
    await revokePendingLocalPermits();
    const f = await controlledFixture();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.late_local_permit" }],
      }),
    );
    try {
      expect(
        await processEvent(
          db,
          f.event.id,
          vehicleReminderEventHandlers(db, f.bindings),
          vehicleReminderEventRegistry,
        ),
      ).toBe("processed");
      expect(
        await db
          .prepare(
            "SELECT status FROM notification_vehicle_reminders WHERE id=?",
          )
          .bind(f.target.reminderId)
          .first("status"),
      ).toBe("QUEUED");
      expect(fetcher).not.toHaveBeenCalled();
      const sourceBefore = await db
        .prepare(
          "SELECT status,attempts,processed_at FROM integration_outbox_events WHERE id=?",
        )
        .bind(f.event.id)
        .first();
      expect(sourceBefore?.status).toBe("PROCESSED");
      await issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
        requestId: newId(),
        reason: "Local late permit",
        validitySeconds: 900,
      });
      expect(
        await dispatchControlledVehicleReminders(db, f.bindings, f.clock),
      ).toEqual({ scanned: 1 });
      expect(
        await dispatchControlledVehicleReminders(db, f.bindings, f.clock),
      ).toEqual({ scanned: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        await db
          .prepare(
            "SELECT status FROM notification_vehicle_reminders WHERE id=?",
          )
          .bind(f.target.reminderId)
          .first("status"),
      ).toBe("ACCEPTED");
      expect(
        await db
          .prepare(
            "SELECT status,attempts,processed_at FROM integration_outbox_events WHERE id=?",
          )
          .bind(f.event.id)
          .first(),
      ).toEqual(sourceBefore);
      expect(
        await db
          .prepare(
            "SELECT external_delivery_enabled FROM notification_policy WHERE singleton=1",
          )
          .first("external_delivery_enabled"),
      ).toBe(0);
    } finally {
      fetcher.mockRestore();
    }
  });
  it.each(["revoked", "expired", "noFlag", "production"])(
    "sends no HTTP for %s permits/configuration",
    async (condition) => {
      await revokePendingLocalPermits();
      const f = await controlledFixture();
      const { permitId } = await issueControlledWhatsAppPermit(
        db,
        f.bindings,
        f.actor,
        f.target,
        {
          requestId: newId(),
          reason: "Local inactive permit",
          validitySeconds: condition === "expired" ? 1 : 900,
        },
      );
      if (condition === "revoked")
        await db
          .prepare(
            "UPDATE notification_controlled_delivery_permits SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          )
          .bind(permitId)
          .run();
      if (condition === "expired")
        await new Promise((resolve) => setTimeout(resolve, 1100));
      const bindings = {
        ...f.bindings,
        ...(condition === "noFlag"
          ? { NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED: "false" }
          : {}),
        ...(condition === "production" ? { ENVIRONMENT: "production" } : {}),
      };
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected HTTP"));
      try {
        expect(
          await dispatchControlledVehicleReminders(db, bindings, f.clock),
        ).toEqual({ scanned: 0 });
        expect(fetcher).not.toHaveBeenCalled();
        expect(
          await db
            .prepare(
              "SELECT reserved_at FROM notification_controlled_delivery_permits WHERE id=?",
            )
            .bind(permitId)
            .first("reserved_at"),
        ).toBeNull();
      } finally {
        fetcher.mockRestore();
      }
    },
  );
  it("rechecks revoked human MFA during cron dispatch before HTTP", async () => {
    await revokePendingLocalPermits();
    const f = await controlledFixture();
    const { permitId } = await issueControlledWhatsAppPermit(
      db,
      f.bindings,
      f.actor,
      f.target,
      { requestId: newId(), reason: "Local changed MFA", validitySeconds: 900 },
    );
    await db
      .prepare("UPDATE auth_users SET two_factor_enabled=0 WHERE id=?")
      .bind(f.accountId)
      .run();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected HTTP"));
    try {
      expect(
        await dispatchControlledVehicleReminders(db, f.bindings, f.clock),
      ).toEqual({ scanned: 1 });
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        await db
          .prepare(
            "SELECT reserved_at FROM notification_controlled_delivery_permits WHERE id=?",
          )
          .bind(permitId)
          .first("reserved_at"),
      ).toBeNull();
    } finally {
      fetcher.mockRestore();
    }
  });
  it("retains default closed-channel behavior when controlled mode is disabled", async () => {
    const f = await controlledFixture();
    expect(
      await processVehicleReminder(db, f.event, f.clock, {
        ...f.bindings,
        NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED: "false",
      }),
    ).toBe("UNAVAILABLE");
    expect(
      await dispatchControlledVehicleReminders({} as D1Database, {
        ENVIRONMENT: "development",
      }),
    ).toEqual({ scanned: 0 });
  });
  it("drains at most five exact targets per invocation and progresses on the next cron", async () => {
    await revokePendingLocalPermits();
    const fixtures = [];
    for (let i = 0; i < 6; i++) fixtures.push(await controlledFixture());
    for (const f of fixtures)
      await issueControlledWhatsAppPermit(db, f.bindings, f.actor, f.target, {
        requestId: newId(),
        reason: "Local bounded cron",
        validitySeconds: 900,
      });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.local_bound_" + newId().replaceAll("-", "") }],
      }),
    );
    try {
      expect(
        await dispatchControlledVehicleReminders(db, fixtures[0]!.bindings),
      ).toEqual({ scanned: 5 });
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect(
        await dispatchControlledVehicleReminders(db, fixtures[0]!.bindings),
      ).toEqual({ scanned: 1 });
      expect(fetcher).toHaveBeenCalledTimes(6);
      expect(
        await dispatchControlledVehicleReminders(db, fixtures[0]!.bindings),
      ).toEqual({ scanned: 0 });
    } finally {
      fetcher.mockRestore();
    }
  });
});
