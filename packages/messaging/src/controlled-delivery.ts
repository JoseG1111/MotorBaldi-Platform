import { Problem } from "@motorbaldi/contracts";
import { customerPremiumFor } from "@motorbaldi/db";
import { newId, sha256Hex } from "@motorbaldi/shared";
import type { NotificationTransportBindings } from "./configured-transports.js";

/** Human sessions only; automation assurance never authorizes a real test delivery. */
const staff = `EXISTS(SELECT 1 FROM iam_accounts staff JOIN iam_people person ON person.id=staff.person_id
 JOIN auth_users u ON u.id=staff.id JOIN auth_sessions s ON s.user_id=u.id
 JOIN platform_person_roles pr ON pr.person_id=person.id
 JOIN authz_roles role ON role.id=pr.role_id AND role.scope='PLATFORM'
 JOIN authz_role_permissions rp ON rp.role_id=role.id
 WHERE staff.id=? AND s.id=? AND staff.status='ACTIVE' AND person.status='ACTIVE'
 AND u.email_verified=1 AND u.two_factor_enabled=1
 AND EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=u.id AND f.verified=1)
 AND s.created_at>=u.updated_at AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND rp.permission_code='platform.notifications.controlled-test'
 AND NOT EXISTS(SELECT 1 FROM development_automation_identities d WHERE d.account_id=staff.id))`;

/** All checks run in the same SQL write that issues or reserves the permit. A direct
 * person grant is deliberately required; organization authority cannot widen this test. */
const eligible = `EXISTS(SELECT 1 FROM notification_vehicle_reminders r
 JOIN vehicle_compliance_entries e ON e.id=r.compliance_entry_id
 JOIN iam_accounts a ON a.id=r.account_id JOIN iam_people p ON p.id=a.person_id
 JOIN notification_preferences pref ON pref.account_id=a.id AND pref.category='TRANSACTIONAL' AND pref.channel='WHATSAPP' AND pref.enabled=1
 JOIN iam_contact_methods c ON c.id=pref.contact_method_id AND c.person_id=p.id
 JOIN integration_outbox_events source ON source.id=r.source_event_id
 WHERE r.id=? AND r.source_event_id=? AND r.channel='WHATSAPP' AND r.status='QUEUED'
 AND source.event_type='notification.vehicle.reminder.v1' AND source.event_version=1
 AND source.aggregate_type='notification' AND source.aggregate_id=r.id AND source.external_effect_policy='IDEMPOTENT'
 AND json_extract(source.payload_json,'$.reminderId')=r.id
 AND a.status='ACTIVE' AND p.status='ACTIVE' AND c.type='PHONE'
 AND c.verification_status='VERIFIED' AND c.verified_at IS NOT NULL AND c.normalized_value=?
 AND EXISTS(SELECT 1 FROM vehicle_relationships owner WHERE owner.vehicle_id=e.vehicle_id AND owner.person_id=p.id AND owner.relationship_type='OWNER' AND owner.ended_at IS NULL AND owner.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND EXISTS(SELECT 1 FROM vehicle_access_grants g WHERE g.vehicle_id=e.vehicle_id AND g.person_id=p.id AND g.permission_code='vehicle.read' AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
 AND ${customerPremiumFor("a.id", "p.id")}
 AND (SELECT COUNT(*) FROM vehicle_vehicles v WHERE EXISTS(SELECT 1 FROM vehicle_relationships owner WHERE owner.vehicle_id=v.id AND owner.person_id=p.id AND owner.relationship_type='OWNER' AND owner.ended_at IS NULL AND owner.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (v.created_at,v.id)<=(SELECT created_at,id FROM vehicle_vehicles WHERE id=e.vehicle_id)) BETWEEN 1 AND 3
 AND e.document_type IN ('SOAT','RTM') AND r.days_before IN (30,15,7,1)
 AND CAST(julianday(e.expires_on)-julianday(date('now','-5 hours')) AS INTEGER)=r.days_before
 AND NOT EXISTS(SELECT 1 FROM vehicle_compliance_entries newer WHERE newer.vehicle_id=e.vehicle_id AND newer.document_type=e.document_type AND (newer.created_at,newer.id)>(e.created_at,e.id)))`;

function allowlist(bindings: NotificationTransportBindings) {
  const hashes = bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256?.split(",") ?? [];
  if (
    bindings.ENVIRONMENT !== "development" ||
    bindings.NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED !== "true" ||
    bindings.META_WHATSAPP_TEMPLATE_STATUS !== "APPROVED" ||
    hashes.length < 1 ||
    hashes.length > 5 ||
    !hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))
  )
    throw new Problem(
      403,
      "CONTROLLED_DELIVERY_CLOSED",
      "Controlled delivery unavailable",
    );
  return hashes;
}
function deny(): never {
  throw new Problem(
    403,
    "CONTROLLED_DELIVERY_DENIED",
    "Controlled delivery authority unavailable",
  );
}
export interface ControlledReminderTarget {
  reminderId: string;
  sourceEventId: string;
  recipient: string;
}

/** Internal engineering entry point, intentionally not exposed as a client command.
 * No permit exists until an assured staff operator supplies an exact queued target. */
export async function issueControlledWhatsAppPermit(
  db: D1Database,
  bindings: NotificationTransportBindings,
  actor: { accountId: string; sessionId: string },
  target: ControlledReminderTarget,
  options: { requestId: string; reason: string; validitySeconds?: number },
) {
  const hashes = allowlist(bindings);
  const seconds = options.validitySeconds ?? 300;
  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 900 ||
    !options.reason.trim() ||
    options.reason.length > 500 ||
    !/^\+[1-9][0-9]{7,14}$/.test(target.recipient)
  )
    deny();
  const hash = await sha256Hex(target.recipient);
  if (!hashes.includes(hash)) deny();
  const permitId = newId();
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO notification_controlled_delivery_permits(id,reminder_id,source_event_id,recipient_sha256,actor_account_id,actor_session_id,reason,request_id,expires_at)
      SELECT ?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
      WHERE EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development') AND ${staff} AND ${eligible}`,
      )
      .bind(
        permitId,
        target.reminderId,
        target.sourceEventId,
        hash,
        actor.accountId,
        actor.sessionId,
        options.reason.trim(),
        options.requestId,
        `+${seconds} seconds`,
        actor.accountId,
        actor.sessionId,
        target.reminderId,
        target.sourceEventId,
        target.recipient,
      ),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,reason,request_id) SELECT ?,?,'notification.controlled.permit.issued','notification',?,?,? WHERE changes()=1",
      )
      .bind(
        newId(),
        actor.accountId,
        permitId,
        options.reason.trim(),
        options.requestId,
      ),
  ]);
  if (result[0]!.meta.changes !== 1) deny();
  return { permitId };
}

/** This executes inside dispatchTrackedCommunication's authority callback, after its
 * permanent source-event reservation and before HTTP. A lost process never retries a permit. */
export async function reserveControlledWhatsAppPermit(
  db: D1Database,
  bindings: NotificationTransportBindings,
  target: ControlledReminderTarget,
) {
  const hash = await sha256Hex(target.recipient);
  if (!allowlist(bindings).includes(hash)) deny();
  const row = await db
    .prepare(
      "SELECT id,actor_account_id,actor_session_id FROM notification_controlled_delivery_permits WHERE reminder_id=? AND source_event_id=? AND recipient_sha256=? AND reserved_at IS NULL AND revoked_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(target.reminderId, target.sourceEventId, hash)
    .first<{
      id: string;
      actor_account_id: string;
      actor_session_id: string;
    }>();
  if (!row) deny();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE notification_controlled_delivery_permits SET reserved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND reserved_at IS NULL AND revoked_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development')
      AND EXISTS(SELECT 1 FROM notification_external_deliveries WHERE source_event_id=? AND provider='META_WHATSAPP' AND channel='WHATSAPP' AND status='RESERVED')
      AND ${staff} AND ${eligible}`,
      )
      .bind(
        row.id,
        target.sourceEventId,
        row.actor_account_id,
        row.actor_session_id,
        target.reminderId,
        target.sourceEventId,
        target.recipient,
      ),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) SELECT ?,actor_account_id,'notification.controlled.permit.reserved','notification',id,request_id FROM notification_controlled_delivery_permits WHERE id=? AND changes()=1",
      )
      .bind(newId(), row.id),
  ]);
  if (result[0]!.meta.changes !== 1) deny();
}

/** Current Development allowlist membership is also required while a queued
 * reminder awaits a permit; a configured test flag cannot widen the recipients. */
export async function isControlledWhatsAppRecipient(
  bindings: NotificationTransportBindings,
  recipient: string,
) {
  return allowlist(bindings).includes(await sha256Hex(recipient));
}

export async function hasControlledWhatsAppPermit(
  db: D1Database,
  bindings: NotificationTransportBindings,
  target: ControlledReminderTarget,
) {
  const hash = await sha256Hex(target.recipient);
  if (!allowlist(bindings).includes(hash)) return false;
  return !!(await db
    .prepare(
      "SELECT 1 FROM notification_controlled_delivery_permits WHERE reminder_id=? AND source_event_id=? AND recipient_sha256=? AND reserved_at IS NULL AND revoked_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(target.reminderId, target.sourceEventId, hash)
    .first());
}
