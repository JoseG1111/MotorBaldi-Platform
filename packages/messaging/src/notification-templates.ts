import { z } from "zod";
import {
  auditStatement,
  outboxStatement,
  type Event,
  type EventRegistry,
} from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";

const parameters = z.object({ subscriptionId: z.uuid() }).strict();
const supportParameters = z.object({ caseId: z.uuid() }).strict();
const paymentParameters = z
  .object({ paymentId: z.uuid(), subscriptionId: z.uuid() })
  .strict();
const supportTemplates = {
  es: {
    title: "Tu caso de soporte tiene una actualización",
    body: "Revisa el estado y las respuestas de tu caso en la sección de soporte.",
  },
  en: {
    title: "Your support case has an update",
    body: "Review your case status and replies in the support section.",
  },
};
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
    (code !== "MEMBERSHIP_UPDATE" && code !== "SUPPORT_UPDATE") ||
    version !== 1 ||
    (locale !== "es" && locale !== "en")
  )
    throw new Error("UNKNOWN_NOTIFICATION_TEMPLATE");
  const parsed = (
    code === "SUPPORT_UPDATE" ? supportParameters : parameters
  ).safeParse(input);
  if (!parsed.success) throw new Error("INVALID_NOTIFICATION_PARAMETERS");
  return Object.freeze({
    code,
    version: 1,
    locale,
    category: code === "SUPPORT_UPDATE" ? "SUPPORT" : "TRANSACTIONAL",
    ...(code === "SUPPORT_UPDATE"
      ? supportTemplates[locale]
      : templates[locale]),
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
    ![
      "billing.subscription.changed.v1",
      "billing.subscription.expired.v1",
      "billing.payment.changed.v1",
    ].includes(source.event_type) ||
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
  const paymentEvent = source.event_type === "billing.payment.changed.v1";
  const parsed = (paymentEvent ? paymentParameters : parameters).safeParse(
    payload,
  );
  if (!parsed.success) throw new Error("INVALID_NOTIFICATION_SOURCE");
  const subscriptionId = parsed.data.subscriptionId;
  if (paymentEvent) {
    const paymentId =
      "paymentId" in parsed.data ? parsed.data.paymentId : undefined;
    if (
      source.aggregate_id !== paymentId ||
      !(await db
        .prepare(
          "SELECT 1 FROM billing_payments payment JOIN billing_periods period ON period.id=payment.period_id WHERE payment.id=? AND period.subscription_id=?",
        )
        .bind(paymentId, subscriptionId)
        .first())
    )
      throw new Error("INVALID_NOTIFICATION_SOURCE");
  } else if (source.aggregate_id !== subscriptionId)
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  const recipient = await db
    .prepare(
      `SELECT s.account_id FROM billing_subscriptions s JOIN iam_accounts a ON a.id=s.account_id JOIN iam_people p ON p.id=a.person_id WHERE s.id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM notification_preferences pref WHERE pref.account_id=a.id AND pref.category='TRANSACTIONAL' AND pref.channel='IN_APP' AND pref.enabled=0)`,
    )
    .bind(subscriptionId)
    .first<{ account_id: string }>();
  if (!recipient) return { disposition: "skipped" };
  return createInboxNotification(
    db,
    source,
    recipient.account_id,
    "MEMBERSHIP_UPDATE",
    { subscriptionId },
  );
}

/** Persist a support update only from an authoritative case command and audit. */
export async function createSupportNotification(
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
    source.aggregate_type !== "support" ||
    source.event_version !== 1 ||
    source.external_effect_policy !== "IDEMPOTENT" ||
    source.payload_json.length > 1024 ||
    ![
      "support.case.create.v1",
      "support.case.reply.v1",
      "support.case.assign.v1",
      "support.case.close.v1",
    ].includes(source.event_type)
  )
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  let payload: unknown;
  try {
    payload = JSON.parse(source.payload_json);
  } catch {
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  }
  const parsed = z
    .object({ caseId: z.uuid(), accountId: z.uuid() })
    .strict()
    .safeParse(payload);
  if (!parsed.success || source.aggregate_id !== parsed.data.caseId)
    throw new Error("INVALID_NOTIFICATION_SOURCE");
  const evidence = await db
    .prepare(
      "SELECT audit.actor_id FROM support_cases c JOIN governance_audit_events audit ON audit.resource_id=c.id AND audit.resource_type='support' WHERE c.id=? AND c.account_id=? AND audit.action=? AND audit.request_id=? LIMIT 1",
    )
    .bind(
      parsed.data.caseId,
      parsed.data.accountId,
      source.event_type.replace(/\.v1$/, ""),
      source.request_id,
    )
    .first<{ actor_id: string | null }>();
  if (!evidence) throw new Error("INVALID_NOTIFICATION_SOURCE");
  if (
    source.event_type === "support.case.create.v1" ||
    (source.event_type === "support.case.reply.v1" &&
      (!evidence.actor_id || evidence.actor_id === parsed.data.accountId))
  )
    return { disposition: "skipped" };
  const recipient = await db
    .prepare(
      "SELECT a.id FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM notification_preferences pref WHERE pref.account_id=a.id AND pref.category='SUPPORT' AND pref.channel='IN_APP' AND pref.enabled=0)",
    )
    .bind(parsed.data.accountId)
    .first();
  if (!recipient) return { disposition: "skipped" };
  return createInboxNotification(
    db,
    source,
    parsed.data.accountId,
    "SUPPORT_UPDATE",
    { caseId: parsed.data.caseId },
  );
}

async function createInboxNotification(
  db: D1Database,
  source: Event,
  accountId: string,
  templateCode: string,
  input: unknown,
): Promise<MembershipNotificationResult> {
  const existing = () =>
    db
      .prepare(
        "SELECT id FROM notification_inbox WHERE account_id=? AND source_event_id=? AND template_code=?",
      )
      .bind(accountId, source.id, templateCode)
      .first<{ id: string }>();
  const prior = await existing();
  if (prior) return { disposition: "duplicate", notificationId: prior.id };
  const notificationId = newId();
  const rendered = renderNotificationTemplate(templateCode, 1, "es", input);
  const output = outboxStatement(
    db,
    {
      aggregateType: "notification",
      aggregateId: notificationId,
      eventType: "notification.inbox.created.v1",
      eventVersion: 1,
      payload: { notificationId, accountId },
      requestId: source.request_id,
      externalEffectPolicy: "IDEMPOTENT",
    },
    membershipNotificationEventRegistry,
  );
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO notification_inbox(id,account_id,template_code,template_version,locale,source_event_id,parameters_json) VALUES(?,?,?,1,'es',?,?)",
        )
        .bind(
          notificationId,
          accountId,
          templateCode,
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
