import {
  auditStatement,
  customerPremiumFor,
  validateEvent,
  type EventRegistry,
} from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";
import { CUSTOMER_PLANS } from "@motorbaldi/shared/customer-plans";
import { vehiclePermissionPredicate } from "@motorbaldi/vehicles";
import { z } from "zod";
import { colombiaCalendarDate } from "./vehicle-reminders.js";
import { membershipNotificationEventRegistry } from "./notification-templates.js";

export const inAppVehicleReminderEventRegistry: EventRegistry = new Map([
  [
    "notification.vehicle.inapp.reminder.v1:1",
    {
      aggregateType: "notification",
      version: 1,
      externalEffect: "IDEMPOTENT",
      payload: z
        .object({
          entryId: z.uuid(),
          accountId: z.uuid(),
          daysBefore: z.union([
            z.literal(30),
            z.literal(15),
            z.literal(7),
            z.literal(1),
          ]),
          calendarDate: z.iso.date(),
        })
        .strict(),
    },
  ],
]);
const premium = customerPremiumFor("recipient.id", "recipient.person_id");
// This exact predicate runs again in the source INSERT inside the atomic batch.
// Relationships establish ownership; only a live canonical grant establishes read authority.
const candidate = `FROM vehicle_compliance_entries e
 JOIN vehicle_vehicles vehicle ON vehicle.id=e.vehicle_id
 JOIN iam_accounts recipient ON recipient.status='ACTIVE'
 JOIN iam_people person ON person.id=recipient.person_id AND person.status='ACTIVE'
 WHERE EXISTS(SELECT 1 FROM vehicle_relationships owner WHERE owner.vehicle_id=e.vehicle_id AND owner.person_id=recipient.person_id AND owner.relationship_type='OWNER' AND owner.ended_at IS NULL AND owner.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND NOT EXISTS(SELECT 1 FROM notification_preferences pref WHERE pref.account_id=recipient.id AND pref.category='TRANSACTIONAL' AND pref.channel='IN_APP' AND pref.enabled=0)
 AND NOT EXISTS(SELECT 1 FROM vehicle_compliance_entries newer WHERE newer.vehicle_id=e.vehicle_id AND newer.document_type=e.document_type AND (newer.created_at,newer.id)>(e.created_at,e.id))
 AND CAST(julianday(e.expires_on)-julianday(?) AS INTEGER) IN (30,15,7,1)
 AND (CAST(julianday(e.expires_on)-julianday(?) AS INTEGER)=15 OR ${premium})
 AND NOT EXISTS(SELECT 1 FROM notification_inbox inbox WHERE inbox.account_id=recipient.id AND inbox.template_code='VEHICLE_EXPIRY' AND json_extract(inbox.parameters_json,'$.entryId')=e.id AND json_extract(inbox.parameters_json,'$.daysBefore')=CAST(julianday(e.expires_on)-julianday(?) AS INTEGER))`;
const rank = `(SELECT count(*) FROM vehicle_vehicles v WHERE (v.created_at,v.id)<=(vehicle.created_at,vehicle.id) AND EXISTS(SELECT 1 FROM vehicle_relationships r WHERE r.vehicle_id=v.id AND r.person_id=recipient.person_id AND r.relationship_type='OWNER' AND r.ended_at IS NULL AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) <= CASE WHEN ${premium} THEN ${CUSTOMER_PLANS.premium.vehicleLimit} ELSE ${CUSTOMER_PLANS.free.vehicleLimit} END`;
type Recipient = {
  entry_id: string;
  account_id: string;
  person_id: string;
  vehicle_id: string;
  days_before: number;
};

/** Default-enabled inbox reminders need neither contact details nor an external transport.
 * The cursor advances over denied recipients, so each invocation does bounded work. */
export async function scheduleInAppVehicleReminders(
  db: D1Database,
  now = new Date(),
) {
  const today = colombiaCalendarDate(now);
  const progress = await db
    .prepare(
      "SELECT calendar_date,entry_id,account_id FROM notification_inapp_vehicle_scan WHERE singleton=1",
    )
    .first<{ calendar_date: string; entry_id: string; account_id: string }>();
  const cursor =
    progress?.calendar_date === today
      ? [progress.entry_id, progress.account_id]
      : ["", ""];
  const rows = (
    await db
      .prepare(
        `SELECT e.id AS entry_id,recipient.id AS account_id,recipient.person_id,e.vehicle_id,CAST(julianday(e.expires_on)-julianday(?) AS INTEGER) AS days_before ${candidate} AND (e.id,recipient.id)>(?,?) ORDER BY e.id,recipient.id LIMIT 100`,
      )
      .bind(today, today, today, today, ...cursor)
      .all<Recipient>()
  ).results;
  let queued = 0;
  for (const row of rows) {
    const sourceId = newId(),
      notificationId = newId(),
      outputId = newId(),
      requestId = newId();
    const payload = JSON.stringify({
      entryId: row.entry_id,
      accountId: row.account_id,
      daysBefore: row.days_before,
      calendarDate: today,
    });
    validateEvent(
      {
        event_type: "notification.vehicle.inapp.reminder.v1",
        event_version: 1,
        aggregate_type: "notification",
        payload_json: payload,
        external_effect_policy: "IDEMPOTENT",
      },
      inAppVehicleReminderEventRegistry,
    );
    const output = JSON.stringify({
      notificationId,
      accountId: row.account_id,
    });
    validateEvent(
      {
        event_type: "notification.inbox.created.v1",
        event_version: 1,
        aggregate_type: "notification",
        payload_json: output,
        external_effect_policy: "IDEMPOTENT",
      },
      membershipNotificationEventRegistry,
    );
    try {
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) SELECT ?,'notification',?,'notification.vehicle.inapp.reminder.v1',1,?,?,'IDEMPOTENT' ${candidate} AND e.id=? AND recipient.id=? AND ${rank} AND ${vehiclePermissionPredicate}`,
          )
          .bind(
            sourceId,
            row.entry_id,
            payload,
            requestId,
            today,
            today,
            today,
            row.entry_id,
            row.account_id,
            row.account_id,
            row.person_id,
            row.vehicle_id,
            "vehicle.read",
            null,
            null,
            null,
          ),
        db
          .prepare(
            "INSERT INTO notification_inbox(id,account_id,template_code,template_version,locale,source_event_id,parameters_json) SELECT ?,?,'VEHICLE_EXPIRY',1,'es',?,? WHERE EXISTS(SELECT 1 FROM integration_outbox_events WHERE id=?)",
          )
          .bind(
            notificationId,
            row.account_id,
            sourceId,
            JSON.stringify({
              entryId: row.entry_id,
              daysBefore: row.days_before,
            }),
            sourceId,
          ),
        auditStatement(db, {
          actorId: null,
          action: "notification.inbox.created",
          resourceType: "notification",
          resourceId: notificationId,
          requestId,
          requirePreviousChange: true,
        }),
        db
          .prepare(
            "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) SELECT ?,'notification',?,'notification.inbox.created.v1',1,?,?,'IDEMPOTENT' WHERE EXISTS(SELECT 1 FROM notification_inbox WHERE id=?)",
          )
          .bind(outputId, notificationId, output, requestId, notificationId),
      ]);
      queued += results[1]?.meta.changes ?? 0;
    } catch (error) {
      if (
        !String(error).includes(
          "UNIQUE constraint failed: index 'notification_inbox_vehicle_expiry'",
        ) &&
        !String(error).includes(
          "UNIQUE constraint failed: notification_inbox.account_id",
        )
      )
        throw error;
    }
  }
  const last = rows.length === 100 ? rows.at(-1) : null;
  await db
    .prepare(
      "UPDATE notification_inapp_vehicle_scan SET calendar_date=?,entry_id=?,account_id=? WHERE singleton=1",
    )
    .bind(today, last?.entry_id ?? "", last?.account_id ?? "")
    .run();
  return { queued };
}
