import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import { outboxStatement, type EventRegistry } from "@motorbaldi/db";
import { newId, utcNow } from "@motorbaldi/shared";
import { billingPeriodEnd } from "./billing.js";
import type { WompiTransaction, WompiEnvironment } from "./wompi.js";

const transactionInput = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    reference: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("COP"),
    status: z.enum(["PENDING", "APPROVED", "DECLINED", "ERROR", "VOIDED"]),
  })
  .strict();
const hashInput = z.string().regex(/^[a-f0-9]{64}$/);
export const paymentLifecycleEventRegistry: EventRegistry = new Map([
  [
    "billing.payment.changed.v1:1",
    {
      aggregateType: "billing",
      version: 1,
      payload: z.object({
        paymentId: z.string().uuid(),
        subscriptionId: z.string().uuid(),
      }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "billing.subscription.expired.v1:1",
    {
      aggregateType: "billing",
      version: 1,
      payload: z.object({ subscriptionId: z.string().uuid() }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
type BoundPayment = {
  id: string;
  period_id: string;
  amount_minor: number;
  currency: string;
  reference: string;
  provider_environment: WompiEnvironment;
  provider_transaction_id: string | null;
  status: string;
  version: number;
  subscription_id: string;
  sequence: number;
  period_status: string;
  period_amount_minor: number;
  period_currency: string;
  starts_at: string;
  ends_at: string;
  subscription_status: string;
  subscription_version: number;
  current_period_end: string | null;
  account_status: string;
  person_status: string;
  cadence: "MONTH" | "YEAR";
};
type Observation = {
  payment_id: string;
  provider_transaction_id: string;
  provider_environment: string;
  provider_status: string;
  amount_minor: number;
  currency: string;
  reference: string;
};
function sameObservation(
  row: Observation,
  transaction: WompiTransaction,
  environment: WompiEnvironment,
  paymentId?: string,
) {
  return (
    (!paymentId || row.payment_id === paymentId) &&
    row.provider_transaction_id === transaction.id &&
    row.provider_environment === environment &&
    row.provider_status === transaction.status &&
    row.amount_minor === transaction.amountMinor &&
    row.currency === transaction.currency &&
    row.reference === transaction.reference
  );
}
function guardedAudit(
  db: D1Database,
  action: string,
  resourceId: string,
  requestId: string,
  resourceType = "billing_payment",
) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) VALUES(?,NULL,?,?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
    )
    .bind(newId(), action, resourceType, resourceId, requestId);
}

/** Trusted service entry point: callers must reconcile authenticated provider evidence first. No client route may call this with claimed payment status. */
export async function applyWompiTransaction(
  db: D1Database,
  transaction: WompiTransaction,
  evidenceHash64: string,
  requestId: string,
  environment: WompiEnvironment,
) {
  const input = transactionInput.safeParse(transaction),
    hash = hashInput.safeParse(evidenceHash64);
  if (
    !input.success ||
    !hash.success ||
    !["SANDBOX", "PRODUCTION"].includes(environment)
  )
    throw new Problem(
      400,
      "INVALID_PROVIDER_EVIDENCE",
      "Invalid provider evidence",
    );
  const t = input.data;
  const payment = await db
    .prepare(
      `SELECT pay.*,p.subscription_id,p.sequence,p.status AS period_status,p.amount_minor AS period_amount_minor,p.currency AS period_currency,p.starts_at,p.ends_at,
    s.status AS subscription_status,s.version AS subscription_version,s.current_period_end,a.status AS account_status,person.status AS person_status,plan.period AS cadence
    FROM billing_payments pay JOIN billing_periods p ON p.id=pay.period_id JOIN billing_subscriptions s ON s.id=p.subscription_id
    JOIN iam_accounts a ON a.id=s.account_id JOIN iam_people person ON person.id=a.person_id JOIN billing_plans plan ON plan.code=s.plan_code WHERE pay.reference=?`,
    )
    .bind(t.reference)
    .first<BoundPayment>();
  if (
    !payment ||
    payment.amount_minor !== t.amountMinor ||
    payment.currency !== t.currency ||
    payment.period_amount_minor !== t.amountMinor ||
    payment.period_currency !== t.currency ||
    payment.provider_environment !== environment
  )
    throw new Problem(
      409,
      "PROVIDER_EVIDENCE_MISMATCH",
      "Provider evidence does not match the recorded payment",
    );
  if (
    payment.provider_transaction_id &&
    payment.provider_transaction_id !== t.id
  )
    throw new Problem(
      409,
      "PROVIDER_TRANSACTION_CONFLICT",
      "Payment is already bound to another provider transaction",
    );
  const observation = await db
    .prepare("SELECT * FROM billing_provider_events WHERE evidence_hash=?")
    .bind(hash.data)
    .first<Observation>();
  if (observation) {
    if (!sameObservation(observation, t, environment, payment.id))
      throw new Problem(
        409,
        "PROVIDER_EVIDENCE_CONFLICT",
        "Evidence hash is already bound to another observation",
      );
    return {
      paymentId: payment.id,
      subscriptionId: payment.subscription_id,
      status: payment.status,
      replayed: true,
      activated: false,
    };
  }
  // A new provider transaction cannot replace an already approved transaction for a period.
  const other = await db
    .prepare(
      "SELECT 1 FROM billing_payments pay JOIN billing_payment_confirmations c ON c.payment_id=pay.id WHERE pay.period_id=? AND pay.id<>?",
    )
    .bind(payment.period_id, payment.id)
    .first();
  if (t.status === "APPROVED" && other)
    throw new Problem(
      409,
      "DUPLICATE_PERIOD_APPROVAL",
      "Another transaction already paid this period; reconcile manually",
    );
  const terminal = ["DECLINED", "ERROR", "VOIDED"].includes(payment.status);
  const status =
    payment.status === "APPROVED"
      ? t.status === "VOIDED"
        ? "VOIDED"
        : "APPROVED"
      : terminal
        ? payment.status
        : t.status;
  const firstApproval = status === "APPROVED" && payment.status !== "APPROVED";
  const now = utcNow();
  const overlappingSubscription = firstApproval
    ? await db
        .prepare(
          "SELECT 1 FROM billing_subscriptions other JOIN billing_subscriptions current ON current.account_id=other.account_id WHERE current.id=? AND other.id<>current.id AND other.status NOT IN ('CANCELLED','EXPIRED')",
        )
        .bind(payment.subscription_id)
        .first()
    : null;
  const activationAllowed =
    firstApproval &&
    !overlappingSubscription &&
    !["SUSPENDED", "CANCELLED"].includes(payment.subscription_status) &&
    payment.account_status === "ACTIVE" &&
    payment.person_status === "ACTIVE" &&
    payment.period_status === "PENDING";
  // A manual renewal begins after the existing paid boundary; a first period begins at verified server time.
  const startsAt =
    payment.sequence > 1 &&
    payment.current_period_end &&
    payment.current_period_end > now
      ? payment.current_period_end
      : now;
  const endsAt = billingPeriodEnd(
    startsAt,
    payment.cadence === "MONTH" ? "MONTHLY" : "ANNUAL",
  );
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO billing_provider_events(id,evidence_hash,payment_id,provider_transaction_id,provider_environment,provider_status,amount_minor,currency,reference) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(evidence_hash) DO NOTHING",
      )
      .bind(
        newId(),
        hash.data,
        payment.id,
        t.id,
        environment,
        t.status,
        t.amountMinor,
        t.currency,
        t.reference,
      ),
    guardedAudit(
      db,
      "billing.provider.evidence.accepted",
      payment.id,
      requestId,
    ),
  ];
  if (firstApproval)
    statements.push(
      db
        .prepare(
          "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(payment_id) DO NOTHING",
        )
        .bind(
          newId(),
          payment.id,
          t.id,
          environment,
          t.amountMinor,
          t.currency,
          hash.data,
        ),
    );
  statements.push(
    db
      .prepare(
        "UPDATE billing_payments SET status=?,provider_transaction_id=coalesce(provider_transaction_id,?),updated_at=?,version=version+1 WHERE id=? AND version=? AND reference=? AND amount_minor=? AND currency=? AND provider_environment=? AND (provider_transaction_id IS NULL OR provider_transaction_id=?)",
      )
      .bind(
        status,
        t.id,
        now,
        payment.id,
        payment.version,
        t.reference,
        t.amountMinor,
        t.currency,
        environment,
        t.id,
      ),
  );
  statements.push(
    guardedAudit(db, "billing.payment.observed", payment.id, requestId),
  );
  if (activationAllowed) {
    statements.push(
      db
        .prepare(
          "UPDATE billing_periods SET status='PAID',starts_at=?,ends_at=? WHERE id=? AND status='PENDING'",
        )
        .bind(startsAt, endsAt, payment.period_id),
    );
    statements.push(
      guardedAudit(
        db,
        "billing.period.paid",
        payment.period_id,
        requestId,
        "billing_period",
      ),
    );
    statements.push(
      db
        .prepare(
          `UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=?,current_period_end=?,updated_at=?,version=version+1
      WHERE id=? AND version=? AND status NOT IN ('SUSPENDED','CANCELLED') AND NOT EXISTS(SELECT 1 FROM billing_subscriptions other WHERE other.account_id=billing_subscriptions.account_id AND other.id<>billing_subscriptions.id AND other.status NOT IN ('CANCELLED','EXPIRED')) AND EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=billing_subscriptions.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')`,
        )
        .bind(
          startsAt,
          endsAt,
          now,
          payment.subscription_id,
          payment.subscription_version,
        ),
    );
    statements.push(
      guardedAudit(
        db,
        "billing.subscription.activated",
        payment.subscription_id,
        requestId,
        "billing_subscription",
      ),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'PAYMENT',?,?,NULL,?,?)",
      )
      .bind(
        newId(),
        payment.id,
        "billing.payment." + t.status.toLowerCase(),
        requestId,
        JSON.stringify({
          paymentId: payment.id,
          subscriptionId: payment.subscription_id,
          observedStatus: t.status,
          effectiveStatus: status,
          activationBlocked: firstApproval && !activationAllowed,
        }),
      ),
  );
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "billing",
        aggregateId: payment.id,
        eventType: "billing.payment.changed.v1",
        eventVersion: 1,
        payload: {
          paymentId: payment.id,
          subscriptionId: payment.subscription_id,
        },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      paymentLifecycleEventRegistry,
    ).statement,
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const winner = await db
      .prepare("SELECT * FROM billing_provider_events WHERE evidence_hash=?")
      .bind(hash.data)
      .first<Observation>();
    if (winner && sameObservation(winner, t, environment, payment.id)) {
      const current = await db
        .prepare("SELECT status FROM billing_payments WHERE id=?")
        .bind(payment.id)
        .first<{ status: string }>();
      return {
        paymentId: payment.id,
        subscriptionId: payment.subscription_id,
        status: current!.status,
        replayed: true,
        activated: false,
      };
    }
    if (String(error).includes("constraint failed"))
      throw new Problem(
        409,
        "PAYMENT_STATE_CONFLICT",
        "Payment state changed; reconcile and retry safely",
      );
    throw error;
  }
  return {
    paymentId: payment.id,
    subscriptionId: payment.subscription_id,
    status,
    replayed: false,
    activated: activationAllowed,
  };
}

/** Expiration changes membership state only; no charge, refund, grace or retry policy is inferred. */
export async function expireMemberships(db: D1Database, requestId: string) {
  const now = utcNow();
  const expiredPredicate = `current_period_end IS NOT NULL AND current_period_end<=? AND NOT EXISTS(SELECT 1 FROM billing_admin_grants g WHERE g.subscription_id=billing_subscriptions.id AND g.ends_at>?) AND NOT EXISTS(SELECT 1 FROM billing_periods p JOIN billing_payments pay ON pay.period_id=p.id WHERE p.subscription_id=billing_subscriptions.id AND p.status='PAID' AND pay.status='APPROVED' AND p.ends_at>?)`;
  const rows = (
    await db
      .prepare(
        `SELECT id,version FROM billing_subscriptions WHERE status IN ('ACTIVE','PENDING_RENEWAL','PAST_DUE','SUSPENDED') AND ${expiredPredicate} ORDER BY id LIMIT 100`,
      )
      .bind(now, now, now)
      .all<{ id: string; version: number }>()
  ).results;
  let expired = 0;
  for (const row of rows) {
    try {
      await db.batch([
        db
          .prepare(
            `UPDATE billing_subscriptions SET status='EXPIRED',auto_renew=0,updated_at=?,version=version+1 WHERE id=? AND version=? AND status IN ('ACTIVE','PENDING_RENEWAL','PAST_DUE','SUSPENDED') AND ${expiredPredicate}`,
          )
          .bind(now, row.id, row.version, now, now, now),
        guardedAudit(
          db,
          "billing.subscription.expired",
          row.id,
          requestId,
          "billing_subscription",
        ),
        db
          .prepare(
            "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'SUBSCRIPTION',?,'billing.subscription.expired',NULL,?,?)",
          )
          .bind(
            newId(),
            row.id,
            requestId,
            JSON.stringify({ subscriptionId: row.id }),
          ),
        outboxStatement(
          db,
          {
            aggregateType: "billing",
            aggregateId: row.id,
            eventType: "billing.subscription.expired.v1",
            eventVersion: 1,
            payload: { subscriptionId: row.id },
            requestId,
            externalEffectPolicy: "IDEMPOTENT",
          },
          paymentLifecycleEventRegistry,
        ).statement,
      ]);
      expired++;
    } catch (error) {
      if (
        !String(error).includes(
          "NOT NULL constraint failed: governance_audit_events.resource_id",
        )
      )
        throw error;
    }
  }
  return { expired };
}
