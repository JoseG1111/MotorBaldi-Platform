import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  outboxStatement,
  type EventRegistry,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";
import { billingPeriodEnd } from "./billing.js";

type Actor = Principal & { personId: string };
export const checkoutInput = z
  .object({ subscriptionId: z.string().uuid() })
  .strict();
type Input = z.infer<typeof checkoutInput>;
type Subscription = {
  id: string;
  status: string;
  version: number;
  cancel_at_period_end: number;
  current_period_end: string | null;
  plan_code: string;
};
type Period = {
  id: string;
  amount_minor: number;
  currency: string;
  status: string;
};
type Payment = {
  id: string;
  reference: string;
  amount_minor: number;
  currency: string;
  period_id: string;
  status: string;
  provider_environment: string;
};
const registry: EventRegistry = new Map([
  [
    "billing.checkout.created.v1:1",
    {
      aggregateType: "billing",
      version: 1,
      payload: z
        .object({
          subscriptionId: z.string().uuid(),
          paymentId: z.string().uuid(),
          periodId: z.string().uuid(),
        })
        .strict(),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
const eligibleStatuses = [
  "PENDING_ACTIVATION",
  "ACTIVE",
  "PENDING_RENEWAL",
  "PAST_DUE",
  "EXPIRED",
];
async function subscriptionFor(db: D1Database, actor: Actor, input: Input) {
  const active = await db
    .prepare(
      "SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
    )
    .bind(actor.accountId, actor.personId)
    .first();
  if (!active)
    throw new Problem(
      403,
      "BILLING_ACCOUNT_UNAVAILABLE",
      "Billing account unavailable",
    );
  const subscription = await db
    .prepare(
      "SELECT id,status,version,cancel_at_period_end,current_period_end,plan_code FROM billing_subscriptions WHERE id=? AND account_id=?",
    )
    .bind(input.subscriptionId, actor.accountId)
    .first<Subscription>();
  if (!subscription)
    throw new Problem(
      404,
      "SUBSCRIPTION_NOT_FOUND",
      "Subscription unavailable",
    );
  if (
    subscription.cancel_at_period_end ||
    !eligibleStatuses.includes(subscription.status)
  )
    throw new Problem(
      409,
      "BILLING_CHECKOUT_UNAVAILABLE",
      "Checkout unavailable for this subscription",
    );
  if (subscription.status === "EXPIRED") {
    const other = await db
      .prepare(
        "SELECT 1 FROM billing_subscriptions WHERE account_id=? AND id<>? AND status NOT IN ('CANCELLED','EXPIRED')",
      )
      .bind(actor.accountId, subscription.id)
      .first();
    if (other)
      throw new Problem(
        409,
        "BILLING_CHECKOUT_UNAVAILABLE",
        "Another subscription is already open",
      );
  }
  return subscription;
}
/** Current identity, ownership and cancellation restrictions are rechecked before cached replay. */
export async function authorizeCheckout(
  db: D1Database,
  actor: Actor,
  input: Input,
) {
  await subscriptionFor(db, actor, checkoutInput.parse(input));
}
function paymentResponse(payment: Payment): Record<string, Json> {
  if (payment.provider_environment !== "SANDBOX")
    throw new Problem(
      409,
      "BILLING_CHECKOUT_UNAVAILABLE",
      "Checkout environment unavailable",
    );
  return {
    paymentId: payment.id,
    reference: payment.reference,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    periodId: payment.period_id,
    status: payment.status,
    ...(payment.status !== "CREATED" ? { checkoutAvailable: false } : {}),
  };
}
/** Builds a local sandbox ledger reservation only: no secrets, URLs, signatures or provider calls. */
export async function prepareCheckout(
  db: D1Database,
  actor: Actor,
  input: Input,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = checkoutInput.parse(input),
    subscription = await subscriptionFor(db, actor, body);
  const plan = await db
    .prepare(
      "SELECT period,amount_minor,currency,version FROM billing_plans WHERE code=? AND active=1",
    )
    .bind(subscription.plan_code)
    .first<{
      period: "MONTH" | "YEAR";
      amount_minor: number;
      currency: string;
      version: number;
    }>();
  if (!plan)
    throw new Problem(404, "BILLING_PLAN_UNAVAILABLE", "Plan unavailable");
  const pending = await db
    .prepare(
      "SELECT id,amount_minor,currency,status FROM billing_periods WHERE subscription_id=? AND status='PENDING' ORDER BY sequence DESC LIMIT 1",
    )
    .bind(subscription.id)
    .first<Period>();
  if (pending) {
    const existing = await db
      .prepare(
        "SELECT id,reference,amount_minor,currency,period_id,status,provider_environment FROM billing_payments WHERE period_id=? AND status IN ('CREATED','PENDING','UNKNOWN','APPROVED')",
      )
      .bind(pending.id)
      .first<Payment>();
    if (existing)
      return { statements: [], response: paymentResponse(existing) };
  }
  const now = utcNow();
  const paidEnd = await db
    .prepare(
      "SELECT max(ends_at) AS ends_at FROM billing_periods WHERE subscription_id=? AND status='PAID'",
    )
    .bind(subscription.id)
    .first<{ ends_at: string | null }>();
  const startsAt = [
    now,
    subscription.current_period_end ?? now,
    paidEnd?.ends_at ?? now,
  ]
    .sort()
    .at(-1)!;
  const endsAt = billingPeriodEnd(
    startsAt,
    plan.period === "YEAR" ? "ANNUAL" : "MONTHLY",
  );
  const periodId = pending?.id ?? newId(),
    paymentId = newId(),
    reference = "mb-" + newId();
  const amountMinor = pending?.amount_minor ?? plan.amount_minor,
    currency = pending?.currency ?? plan.currency;
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    currency !== "COP"
  )
    throw new Problem(
      409,
      "BILLING_CHECKOUT_UNAVAILABLE",
      "Invalid billing snapshot",
    );
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE billing_subscriptions SET version=version+1,updated_at=?,status=CASE WHEN status IN ('ACTIVE','EXPIRED') THEN 'PENDING_RENEWAL' ELSE status END WHERE id=? AND account_id=? AND version=? AND status=? AND cancel_at_period_end=0
      AND EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE')
      AND (status<>'EXPIRED' OR NOT EXISTS(SELECT 1 FROM billing_subscriptions other WHERE other.account_id=billing_subscriptions.account_id AND other.id<>billing_subscriptions.id AND other.status NOT IN ('CANCELLED','EXPIRED')))
      AND EXISTS(SELECT 1 FROM billing_plans p WHERE p.code=billing_subscriptions.plan_code AND p.active=1 AND p.version=? AND p.period=? AND p.amount_minor=? AND p.currency=?)
      AND NOT EXISTS(SELECT 1 FROM billing_payments pay JOIN billing_periods per ON per.id=pay.period_id WHERE per.subscription_id=billing_subscriptions.id AND per.status='PENDING' AND pay.status IN ('CREATED','PENDING','UNKNOWN','APPROVED'))
      ${pending ? "AND EXISTS(SELECT 1 FROM billing_periods per WHERE per.id=? AND per.subscription_id=billing_subscriptions.id AND per.status='PENDING')" : "AND NOT EXISTS(SELECT 1 FROM billing_periods per WHERE per.subscription_id=billing_subscriptions.id AND per.status='PENDING')"}`,
      )
      .bind(
        now,
        subscription.id,
        actor.accountId,
        subscription.version,
        subscription.status,
        actor.accountId,
        actor.personId,
        plan.version,
        plan.period,
        plan.amount_minor,
        plan.currency,
        ...(pending ? [pending.id] : []),
      ),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) VALUES(?,?,'billing.checkout.created','billing_payment',CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
      )
      .bind(newId(), actor.accountId, paymentId, requestId),
  ];
  if (!pending)
    statements.push(
      db
        .prepare(
          "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) SELECT ?,s.id,(SELECT coalesce(max(sequence),0)+1 FROM billing_periods WHERE subscription_id=s.id),?,?,p.amount_minor,p.currency FROM billing_subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.id=? AND p.active=1 AND p.version=? AND p.period=? AND p.amount_minor=? AND p.currency=?",
        )
        .bind(
          periodId,
          startsAt,
          endsAt,
          subscription.id,
          plan.version,
          plan.period,
          plan.amount_minor,
          plan.currency,
        ),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference,provider_environment) SELECT ?,id,amount_minor,currency,?,'SANDBOX' FROM billing_periods WHERE id=? AND status='PENDING'",
      )
      .bind(paymentId, reference, periodId),
    db
      .prepare(
        "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'PAYMENT',?,'billing.checkout.created',?,?,?)",
      )
      .bind(
        newId(),
        paymentId,
        actor.accountId,
        requestId,
        JSON.stringify({
          subscriptionId: subscription.id,
          paymentId,
          periodId,
        }),
      ),
    outboxStatement(
      db,
      {
        aggregateType: "billing",
        aggregateId: paymentId,
        eventType: "billing.checkout.created.v1",
        eventVersion: 1,
        payload: { subscriptionId: subscription.id, paymentId, periodId },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      registry,
    ).statement,
  );
  return {
    statements,
    response: paymentResponse({
      id: paymentId,
      reference,
      amount_minor: amountMinor,
      currency,
      period_id: periodId,
      status: "CREATED",
      provider_environment: "SANDBOX",
    }),
    guard: {
      table: "governance_audit_events",
      column: "resource_id",
      code: "BILLING_CHECKOUT_CONFLICT",
      message: "Billing state changed; refresh and retry",
    },
    recover: async (error) => {
      if (error instanceof Problem) throw error;
      if (
        String(error).includes("constraint") ||
        String(error).includes("SUBSCRIPTION_")
      )
        throw new Problem(
          409,
          "BILLING_CHECKOUT_CONFLICT",
          "Billing state changed; refresh and retry",
        );
      return null;
    },
  };
}
