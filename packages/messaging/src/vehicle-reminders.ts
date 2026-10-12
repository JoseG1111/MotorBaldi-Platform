import { dispatchTrackedCommunication } from "./delivery-tracking.js";
import {
  configuredNotificationTransport,
  type NotificationTransportBindings,
} from "./configured-transports.js";
import { HandlerFailure } from "./handler.js";
import { CUSTOMER_PLANS } from "@motorbaldi/shared/customer-plans";
import { z } from "zod";
import {
  auditStatement,
  customerPremiumFor,
  getCustomerEntitlements,
  outboxStatement,
  type EventRegistry,
  type Event,
} from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";
import { authorizeNotificationDelivery } from "./notifications.js";
import { hasVehiclePermission } from "@motorbaldi/vehicles";
import type { Handler } from "./handler.js";

const payloadSchema = z.object({ reminderId: z.uuid() }).strict();
export const vehicleReminderEventRegistry: EventRegistry = new Map([
  [
    "notification.vehicle.reminder.v1:1",
    {
      aggregateType: "notification",
      version: 1,
      payload: payloadSchema,
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
/** Colombia is UTC-05 year-round. Date-only expirations never depend on the worker's local timezone. */
export function colombiaCalendarDate(now = new Date()) {
  if (!Number.isFinite(now.getTime()))
    throw new Error("INVALID_REMINDER_CLOCK");
  return new Date(now.getTime() - 5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
type Recipient = {
  entry_id: string;
  vehicle_id: string;
  expires_on: string;
  account_id: string;
  person_id: string;
  channel: "EMAIL" | "WHATSAPP";
  contact_method_id: string;
  days_before: number;
};
/** Bounded due selection excludes receipts so repeated cron invocations progress without duplicates. */
export async function scheduleVehicleReminders(
  db: D1Database,
  now = new Date(),
) {
  const today = colombiaCalendarDate(now);
  const progress = await db
    .prepare(
      "SELECT * FROM notification_vehicle_reminder_scan WHERE singleton=1",
    )
    .first<{
      calendar_date: string;
      entry_id: string;
      account_id: string;
      channel: string;
    }>();
  const cursor =
    progress?.calendar_date === today
      ? [progress.entry_id, progress.account_id, progress.channel]
      : ["", "", ""];
  const rows = (
    await db
      .prepare(
        `SELECT e.id AS entry_id,e.vehicle_id,e.expires_on,recipient.id AS account_id,recipient.person_id,pref.channel,pref.contact_method_id,CAST(julianday(e.expires_on)-julianday(?) AS INTEGER) AS days_before
    FROM vehicle_compliance_entries e JOIN vehicle_relationships owner ON owner.vehicle_id=e.vehicle_id AND owner.relationship_type='OWNER' AND owner.ended_at IS NULL AND owner.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    JOIN iam_accounts recipient ON recipient.person_id=owner.person_id AND recipient.status='ACTIVE' JOIN iam_people p ON p.id=recipient.person_id AND p.status='ACTIVE'
    JOIN notification_preferences pref ON pref.account_id=recipient.id AND pref.category='TRANSACTIONAL' AND pref.enabled=1 AND pref.channel IN ('EMAIL','WHATSAPP') AND pref.contact_method_id IS NOT NULL
    WHERE NOT EXISTS(SELECT 1 FROM vehicle_compliance_entries newer WHERE newer.vehicle_id=e.vehicle_id AND newer.document_type=e.document_type AND (newer.created_at,newer.id)>(e.created_at,e.id))
    AND e.expires_on IN (?,?,?,?)
    AND NOT EXISTS(SELECT 1 FROM notification_vehicle_reminders r WHERE r.compliance_entry_id=e.id AND r.account_id=recipient.id AND r.channel=pref.channel AND r.days_before=CAST(julianday(e.expires_on)-julianday(?) AS INTEGER))
    AND ((pref.channel='EMAIL' AND CAST(julianday(e.expires_on)-julianday(?) AS INTEGER)=15) OR ${customerPremiumFor("recipient.id", "recipient.person_id")})
    AND (e.id,recipient.id,pref.channel)>(?,?,?)
    GROUP BY e.id,recipient.id,pref.channel ORDER BY e.id,recipient.id,pref.channel LIMIT 100`,
      )
      .bind(
        today,
        ...CUSTOMER_PLANS.premium.reminderDays.map((days) =>
          new Date(Date.parse(today + "T00:00:00Z") + days * 86400000)
            .toISOString()
            .slice(0, 10),
        ),
        today,
        today,
        ...cursor,
      )
      .all<Recipient>()
  ).results;
  let queued = 0;
  for (const row of rows) {
    try {
      if (!(await eligible(db, row))) continue;
    } catch (error) {
      if (
        error instanceof Error &&
        "status" in error &&
        Number(error.status) === 403
      )
        continue;
      throw error;
    }
    const reminderId = newId(),
      requestId = newId();
    const event = outboxStatement(
      db,
      {
        aggregateType: "notification",
        aggregateId: reminderId,
        eventType: "notification.vehicle.reminder.v1",
        eventVersion: 1,
        payload: { reminderId },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      vehicleReminderEventRegistry,
    );
    try {
      await db.batch([
        event.statement,
        db
          .prepare(
            "INSERT INTO notification_vehicle_reminders(id,compliance_entry_id,account_id,channel,days_before,source_event_id) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            reminderId,
            row.entry_id,
            row.account_id,
            row.channel,
            row.days_before,
            event.id,
          ),
        auditStatement(db, {
          actorId: null,
          action: "notification.vehicle.reminder.queued",
          resourceType: "notification",
          resourceId: reminderId,
          requestId,
        }),
      ]);
      queued++;
    } catch (error) {
      if (
        !String(error).includes(
          "UNIQUE constraint failed: notification_vehicle_reminders.compliance_entry_id",
        )
      )
        throw error;
    }
  }
  const last = rows.length === 100 ? rows.at(-1)! : null;
  await db
    .prepare(
      "UPDATE notification_vehicle_reminder_scan SET calendar_date=?,entry_id=?,account_id=?,channel=? WHERE singleton=1",
    )
    .bind(
      today,
      last?.entry_id ?? "",
      last?.account_id ?? "",
      last?.channel ?? "",
    )
    .run();
  return { queued };
}
async function eligible(db: D1Database, row: Recipient) {
  if (
    !(await hasVehiclePermission(
      db,
      { accountId: row.account_id, personId: row.person_id },
      row.vehicle_id,
      "vehicle.read",
    ))
  )
    return false;
  const entitlement = await getCustomerEntitlements(db, {
    accountId: row.account_id,
    personId: row.person_id,
  });
  if (
    !(entitlement.reminderDays as readonly number[]).includes(
      row.days_before,
    ) ||
    (row.channel === "WHATSAPP" && !entitlement.premium)
  )
    return false;
  const vehicle = await db
    .prepare(
      `SELECT COUNT(*) AS rank FROM vehicle_vehicles v WHERE EXISTS(SELECT 1 FROM vehicle_relationships r WHERE r.vehicle_id=v.id AND r.person_id=? AND r.relationship_type='OWNER' AND r.ended_at IS NULL AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (v.created_at,v.id)<=(SELECT created_at,id FROM vehicle_vehicles WHERE id=?)`,
    )
    .bind(row.person_id, row.vehicle_id)
    .first<{ rank: number }>();
  return (
    !!vehicle && vehicle.rank > 0 && vehicle.rank <= entitlement.vehicleLimit
  );
}
export async function processVehicleReminder(
  db: D1Database,
  event: Event,
  now = new Date(),
  bindings?: NotificationTransportBindings,
  signal = new AbortController().signal,
) {
  const source = await db
    .prepare("SELECT * FROM integration_outbox_events WHERE id=?")
    .bind(event.id)
    .first<Event>();
  if (
    !source ||
    source.event_type !== "notification.vehicle.reminder.v1" ||
    source.aggregate_type !== "notification" ||
    source.event_version !== 1 ||
    source.external_effect_policy !== "IDEMPOTENT"
  )
    throw new Error("INVALID_REMINDER_SOURCE");
  const payload = payloadSchema.parse(JSON.parse(source.payload_json));
  if (source.aggregate_id !== payload.reminderId)
    throw new Error("INVALID_REMINDER_SOURCE");
  const row = await db
    .prepare(
      `SELECT r.*,e.id AS entry_id,e.vehicle_id,e.expires_on,a.person_id,pref.contact_method_id FROM notification_vehicle_reminders r JOIN vehicle_compliance_entries e ON e.id=r.compliance_entry_id JOIN iam_accounts a ON a.id=r.account_id LEFT JOIN notification_preferences pref ON pref.account_id=r.account_id AND pref.category='TRANSACTIONAL' AND pref.channel=r.channel AND pref.enabled=1 WHERE r.id=? AND r.source_event_id=?`,
    )
    .bind(payload.reminderId, source.id)
    .first<Recipient & { status: string }>();
  if (!row) throw new Error("INVALID_REMINDER_RECEIPT");
  if (row.status !== "QUEUED") return row.status;
  let status = "CANCELLED",
    reason = "REMINDER_AUTHORITY_CHANGED";
  const latest = await db
    .prepare(
      "SELECT id FROM vehicle_compliance_entries WHERE vehicle_id=? AND document_type=(SELECT document_type FROM vehicle_compliance_entries WHERE id=?) ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(row.vehicle_id, row.entry_id)
    .first<{ id: string }>();
  const days =
    (Date.parse(row.expires_on + "T00:00:00Z") -
      Date.parse(colombiaCalendarDate(now) + "T00:00:00Z")) /
    86400000;
  if (
    latest?.id === row.entry_id &&
    days === row.days_before &&
    row.contact_method_id
  ) {
    try {
      const owns = await db
        .prepare(
          "SELECT 1 FROM vehicle_relationships WHERE vehicle_id=? AND person_id=? AND relationship_type='OWNER' AND ended_at IS NULL AND effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        )
        .bind(row.vehicle_id, row.person_id)
        .first();
      if (owns && (await eligible(db, row))) {
        const delivery = await authorizeNotificationDelivery(db, {
          accountId: row.account_id,
          personId: row.person_id,
          category: "TRANSACTIONAL",
          channel: row.channel,
          contactMethodId: row.contact_method_id,
        });
        status = delivery.status;
        reason = delivery.code;
        const policy = await db
          .prepare(
            "SELECT external_delivery_enabled FROM notification_policy WHERE singleton=1",
          )
          .first<{ external_delivery_enabled: number }>();
        const transport = bindings
          ? configuredNotificationTransport(bindings, row.channel)
          : null;
        if (
          policy?.external_delivery_enabled === 1 &&
          transport?.capabilities.availability === "AVAILABLE"
        ) {
          const contact = await db
            .prepare(
              "SELECT normalized_value FROM iam_contact_methods WHERE id=? AND person_id=?",
            )
            .bind(row.contact_method_id, row.person_id)
            .first<{ normalized_value: string }>();
          if (!contact) throw new Error("INVALID_REMINDER_CONTACT");
          const document = await db
            .prepare(
              "SELECT document_type FROM vehicle_compliance_entries WHERE id=?",
            )
            .bind(row.entry_id)
            .first<{ document_type: string }>();
          const receipt = await dispatchTrackedCommunication(db, {
            provider: row.channel === "EMAIL" ? "RESEND" : "META_WHATSAPP",
            channel: row.channel,
            transport,
            request: {
              id: source.id,
              requestId: source.request_id,
              recipient: contact.normalized_value,
              template:
                row.channel === "EMAIL"
                  ? "vehicle-document-expiry"
                  : bindings!.META_WHATSAPP_APPROVED_TEMPLATE!,
              variables: {
                documentType: document!.document_type,
                expiresOn: row.expires_on,
                daysBefore: String(row.days_before),
              },
              signal,
            },
            authorize: async () => {
              const currentPolicy = await db
                .prepare(
                  "SELECT external_delivery_enabled FROM notification_policy WHERE singleton=1",
                )
                .first<{ external_delivery_enabled: number }>();
              if (currentPolicy?.external_delivery_enabled !== 1)
                throw new Error("DELIVERY_POLICY_CLOSED");
              const current = await db
                .prepare(
                  "SELECT id FROM vehicle_compliance_entries WHERE vehicle_id=? AND document_type=? ORDER BY created_at DESC,id DESC LIMIT 1",
                )
                .bind(row.vehicle_id, document!.document_type)
                .first<{ id: string }>();
              const owner = await db
                .prepare(
                  "SELECT 1 FROM vehicle_relationships WHERE vehicle_id=? AND person_id=? AND relationship_type='OWNER' AND ended_at IS NULL AND effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                )
                .bind(row.vehicle_id, row.person_id)
                .first();
              const currentContact = await db
                .prepare(
                  "SELECT normalized_value FROM iam_contact_methods WHERE id=? AND person_id=?",
                )
                .bind(row.contact_method_id, row.person_id)
                .first<{ normalized_value: string }>();
              if (
                current?.id !== row.entry_id ||
                !owner ||
                currentContact?.normalized_value !== contact.normalized_value ||
                !(await eligible(db, row)) ||
                (Date.parse(row.expires_on + "T00:00:00Z") -
                  Date.parse(colombiaCalendarDate() + "T00:00:00Z")) /
                  86400000 !==
                  row.days_before
              )
                throw new Error("REMINDER_AUTHORITY_CHANGED");
              await authorizeNotificationDelivery(db, {
                accountId: row.account_id,
                personId: row.person_id,
                category: "TRANSACTIONAL",
                channel: row.channel,
                contactMethodId: row.contact_method_id,
              });
            },
          });
          status = receipt.status;
          reason =
            receipt.status === "ACCEPTED"
              ? "PROVIDER_ACCEPTED"
              : (receipt.code ?? "TRANSPORT_UNKNOWN");
        }
      }
    } catch (error) {
      // Known authority denials cancel; infrastructure failures remain retryable in the existing Queue.
      if (!(
        error instanceof Error &&
        "status" in error &&
        [403, 404].includes(Number(error.status))
      ))
        throw error;
    }
  }
  await db.batch([
    db
      .prepare(
        "UPDATE notification_vehicle_reminders SET status=?,reason_code=?,processed_at=? WHERE id=? AND status='QUEUED'",
      )
      .bind(status, reason, now.toISOString(), payload.reminderId),
    auditStatement(db, {
      actorId: null,
      action: `notification.vehicle.reminder.${status.toLowerCase()}`,
      resourceType: "notification",
      resourceId: payload.reminderId,
      requestId: source.request_id,
    }),
  ]);
  if (status === "UNKNOWN")
    throw new HandlerFailure("PERMANENT", "EXTERNAL_DELIVERY_UNKNOWN");
  return status;
}
export function vehicleReminderEventHandlers(
  db: D1Database,
  bindings?: NotificationTransportBindings,
): ReadonlyMap<string, Handler> {
  return new Map([
    [
      "notification.vehicle.reminder.v1",
      async (event, context) => {
        await processVehicleReminder(
          db,
          event,
          new Date(),
          bindings,
          context.signal,
        );
      },
    ],
  ]);
}
