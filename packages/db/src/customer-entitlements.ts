import { Problem } from "@motorbaldi/contracts";
import { CUSTOMER_PLANS } from "@motorbaldi/shared/customer-plans";

/** Two bindings: accountId, personId. SQL clock is evaluated inside the canonical transaction.
 * Cancellation retains valid paid coverage until its end; no client tier or organization role is evidence. */
export const customerPremiumPredicate = `EXISTS (
 SELECT 1 FROM iam_accounts a JOIN iam_people person ON person.id=a.person_id
 JOIN billing_subscriptions s ON s.account_id=a.id
 WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND person.status='ACTIVE'
 AND s.status NOT IN ('SUSPENDED','EXPIRED') AND (
 EXISTS(SELECT 1 FROM billing_admin_grants g WHERE g.subscription_id=s.id
 AND g.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR EXISTS(SELECT 1 FROM billing_periods period JOIN billing_payments pay ON pay.period_id=period.id
 JOIN billing_payment_confirmations confirmation ON confirmation.payment_id=pay.id
 WHERE period.subscription_id=s.id AND period.status='PAID' AND pay.status='APPROVED'
 AND period.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND period.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND confirmation.amount_minor=period.amount_minor AND pay.amount_minor=period.amount_minor
 AND confirmation.currency=period.currency AND pay.currency=period.currency
 AND confirmation.provider_environment=pay.provider_environment
 AND confirmation.provider_transaction_id=pay.provider_transaction_id)
 ))`;

/** Internal correlated SQL only: callers supply qualified, static column names, never request values. */
export function customerPremiumFor(
  accountColumn: string,
  personColumn: string,
) {
  if (
    ![accountColumn, personColumn].every((value) =>
      /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(value),
    )
  )
    throw new Error("INVALID_ENTITLEMENT_SQL_COLUMN");
  return customerPremiumPredicate.replace(
    "a.id=? AND a.person_id=?",
    `a.id=${accountColumn} AND a.person_id=${personColumn}`,
  );
}

export async function getCustomerEntitlements(
  db: D1Database,
  actor: { accountId: string; personId: string },
) {
  const active = await db
    .prepare(
      "SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
    )
    .bind(actor.accountId, actor.personId)
    .first();
  if (!active)
    throw new Problem(
      403,
      "CUSTOMER_ACCOUNT_UNAVAILABLE",
      "Customer account unavailable",
    );
  const premium = !!(await db
    .prepare(`SELECT 1 WHERE ${customerPremiumPredicate}`)
    .bind(actor.accountId, actor.personId)
    .first());
  const policy = premium ? CUSTOMER_PLANS.premium : CUSTOMER_PLANS.free;
  return {
    premium,
    vehicleLimit: policy.vehicleLimit,
    manualMaintenanceLimit: policy.manualMaintenanceLimit,
    assistedRequestLimit: premium ? null : 0,
    personalizedSupport: premium,
    reminderDays: policy.reminderDays,
  };
}
