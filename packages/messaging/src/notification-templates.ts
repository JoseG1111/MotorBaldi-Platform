import { z } from "zod";
import {
  auditStatement,
  outboxStatement,
  type Event,
  type EventRegistry,
} from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";

const parameters = z.object({ subscriptionId: z.uuid() }).strict();
const templates = Object.freeze({
  es: Object.freeze({
    title: "Tu membresía tiene una actualización",
    body: "Revisa el estado de tu membresía en tu cuenta. Este aviso no confirma un pago ni activa beneficios.",
  }),
  en: Object.freeze({
    title: "Your membership has an update",
    body: "Review your membership status in your account. This notice does not confirm a payment or activate benefits.",
  }),
});
/** Fixed plain text only. No interpolation, arbitrary variables or HTML. */
export function renderNotificationTemplate(
  code: string,
  version: number,
  locale: string,
  input: unknown,
) {
  if (
    code !== "MEMBERSHIP_UPDATE" ||
    version !== 1 ||
    (locale !== "es" && locale !== "en")
  )
    throw new Error("UNKNOWN_NOTIFICATION_TEMPLATE");
  const parsed = parameters.safeParse(input);
  if (!parsed.success) throw new Error("INVALID_NOTIFICATION_PARAMETERS");
  return Object.freeze({
    code: "MEMBERSHIP_UPDATE" as const,
    version: 1,
    locale,
    category: "TRANSACTIONAL" as const,
    ...templates[locale],
    parameters: Object.freeze(parsed.data),
  });
}
export const membershipNotificationEventRegistry: EventRegistry = new Map([
  [
    "notification.inbox.created.v1:1",
    {
      aggregateType: "notification",
      version: 1,
      payload: z.object({ notificationId: z.uuid(), accountId: z.uuid() }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
export type MembershipNotificationResult =
  | { disposition: "created" | "duplicate"; notificationId: string }
  | { disposition: "skipped" };
/** Reload authoritative event; delivery is only an internal inbox record. */
export async function createMembershipNotification(
  db: D1Database,
  event: Event,
): Promise<MembershipNotificationResult> {
  if (!z.uuid().safeParse(event.id).success)
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  const source = await db
    .prepare("SELECT * FROM integration_outbox_events WHERE id=?")
    .bind(event.id)
    .first<Event>();
  if (
    !source ||
    source.event_type !== "billing.subscription.changed.v1" ||
    source.event_version !== 1 ||
    source.aggregate_type !== "billing" ||
    source.external_effect_policy !== "IDEMPOTENT" ||
    source.payload_json.length > 1024
  )
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  let payload: unknown;
  try {
    payload = JSON.parse(source.payload_json);
  } catch {
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  }
  const parsed = parameters.safeParse(payload);
  if (!parsed.success || source.aggregate_id !== parsed.data.subscriptionId)
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  const recipient = await db
    .prepare(
      `SELECT s.account_id FROM billing_subscriptions s JOIN iam_accounts a ON a.id=s.account_id JOIN iam_people p ON p.id=a.person_id WHERE s.id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM notification_preferences pref WHERE pref.account_id=a.id AND pref.category='TRANSACTIONAL' AND pref.channel='IN_APP' AND pref.enabled=0)`,
    )
    .bind(parsed.data.subscriptionId)
    .first<{ account_id: string }>();
  if (!recipient) return { disposition: "skipped" };
  const existing = () =>
    db
      .prepare(
        "SELECT id FROM notification_inbox WHERE account_id=? AND source_event_id=? AND template_code='MEMBERSHIP_UPDATE'",
      )
      .bind(recipient.account_id, source.id)
      .first<{ id: string }>();
  const prior = await existing();
  if (prior) return { disposition: "duplicate", notificationId: prior.id };
  const notificationId = newId();
  const rendered = renderNotificationTemplate(
    "MEMBERSHIP_UPDATE",
    1,
    "es",
    parsed.data,
  );
  const output = outboxStatement(
    db,
    {
      aggregateType: "notification",
      aggregateId: notificationId,
      eventType: "notification.inbox.created.v1",
      eventVersion: 1,
      payload: { notificationId, accountId: recipient.account_id },
      requestId: source.request_id,
      externalEffectPolicy: "IDEMPOTENT",
    },
    membershipNotificationEventRegistry,
  );
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO notification_inbox(id,account_id,template_code,template_version,locale,source_event_id,parameters_json) VALUES(?,?,'MEMBERSHIP_UPDATE',1,'es',?,?)",
        )
        .bind(
          notificationId,
          recipient.account_id,
          source.id,
          JSON.stringify(rendered.parameters),
        ),
      auditStatement(db, {
        actorId: null,
        action: "notification.inbox.created",
        resourceType: "notification",
        resourceId: notificationId,
        requestId: source.request_id,
      }),
      output.statement,
    ]);
  } catch (error) {
    // Only a permanent dedup collision converges; unrelated failures retain retryability.
    if (
      String(error).includes(
        "UNIQUE constraint failed: notification_inbox.account_id, notification_inbox.source_event_id, notification_inbox.template_code",
      )
    ) {
      const duplicate = await existing();
      if (duplicate)
        return { disposition: "duplicate", notificationId: duplicate.id };
    }
    throw error;
  }
  return { disposition: "created", notificationId };
}
