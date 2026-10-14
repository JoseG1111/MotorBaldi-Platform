import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import { requirePlatformPermission } from "@motorbaldi/authz";
import {
  authorizeCheckout,
  createWompiAdapter,
  verifyWompiWebhook,
  wompiIntegritySignature,
  applyWompiTransaction,
  type WompiTransaction,
  type WompiEnvironment,
} from "@motorbaldi/payments";
import { sha256Hex } from "@motorbaldi/shared";

/** Credentials and the separately authorized production release gate belong exclusively to Worker bindings. */
export type PaymentGatewayBindings = {
  DB: D1Database;
  ENVIRONMENT: "local" | "development" | "staging" | "production";
  CORS_ORIGINS?: string;
  PAYMENTS_RETURN_URL?: string;
  WOMPI_ENVIRONMENT?: string;
  WOMPI_PRODUCTION_RELEASE_AUTHORIZED?: string;
  WOMPI_PUBLIC_KEY?: string;
  WOMPI_PRIVATE_KEY?: string;
  WOMPI_INTEGRITY_SECRET?: string;
  WOMPI_EVENTS_SECRET?: string;
};
type Actor = Principal & { personId: string };
function gatewayCredentials(bindings: PaymentGatewayBindings) {
  const production = bindings.ENVIRONMENT === "production";
  const environment: WompiEnvironment = production ? "PRODUCTION" : "SANDBOX";
  if (
    (production &&
      (bindings.WOMPI_ENVIRONMENT !== "PRODUCTION" ||
        bindings.WOMPI_PRODUCTION_RELEASE_AUTHORIZED !== "true")) ||
    (!production &&
      (!["local", "development", "staging"].includes(bindings.ENVIRONMENT) ||
        (bindings.WOMPI_ENVIRONMENT !== undefined &&
          bindings.WOMPI_ENVIRONMENT !== "SANDBOX")))
  )
    throw new Problem(
      503,
      "PAYMENTS_UNAVAILABLE",
      "Payment gateway unavailable",
    );
  const prefix = production ? "prod" : "test";
  const key = (value: string | undefined, expected: string) => {
    if (
      !value ||
      !new RegExp("^" + expected + "[A-Za-z0-9_-]{1,256}$").test(value)
    )
      throw new Problem(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Payment gateway unavailable",
      );
    return value;
  };
  return {
    environment,
    productionApproved: production,
    publicKey: key(bindings.WOMPI_PUBLIC_KEY, "pub_" + prefix + "_"),
    privateKey: key(bindings.WOMPI_PRIVATE_KEY, "prv_" + prefix + "_"),
    integritySecret: key(
      bindings.WOMPI_INTEGRITY_SECRET,
      prefix + "_integrity_",
    ),
    eventsSecret: key(bindings.WOMPI_EVENTS_SECRET, prefix + "_events_"),
  };
}
export function paymentsConfigured(bindings: PaymentGatewayBindings) {
  try {
    gatewayCredentials(bindings);
    return true;
  } catch {
    return false;
  }
}
function checkoutReturnUrl(bindings: PaymentGatewayBindings) {
  const raw = bindings.PAYMENTS_RETURN_URL;
  try {
    if (!raw) throw new Error("Missing return URL");
    const url = new URL(raw);
    const trusted = (bindings.CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim());
    const localHttp =
      bindings.ENVIRONMENT === "local" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !localHttp) ||
      !trusted.includes(url.origin) ||
      raw !== url.origin + "/payment-return"
    )
      throw new Error("Invalid return URL");
    return raw;
  } catch {
    throw new Problem(
      503,
      "PAYMENTS_UNAVAILABLE",
      "Payment checkout unavailable",
    );
  }
}
/** Checkout additionally requires a fixed trusted Portal return destination; reconciliation stays independent. */
export function checkoutConfigured(bindings: PaymentGatewayBindings) {
  try {
    gatewayCredentials(bindings);
    checkoutReturnUrl(bindings);
    return true;
  } catch {
    return false;
  }
}
/** Compatibility helper remains sandbox-specific; use paymentsConfigured for gated production support. */
export function sandboxPaymentsConfigured(bindings: PaymentGatewayBindings) {
  return bindings.ENVIRONMENT !== "production" && paymentsConfigured(bindings);
}
/** Public capability metadata contains no credential values and never promises recurrence. */
export function paymentGatewayCapabilities(bindings: PaymentGatewayBindings) {
  const available = paymentsConfigured(bindings);
  return {
    environment:
      bindings.ENVIRONMENT === "production"
        ? ("PRODUCTION" as const)
        : ("SANDBOX" as const),
    checkoutAvailable: checkoutConfigured(bindings),
    manualReconciliationAvailable: available,
    recurringAvailable: false,
    productionAvailable: available && bindings.ENVIRONMENT === "production",
  };
}
const checkoutReservation = z
  .object({ subscriptionId: z.string().uuid(), paymentId: z.string().uuid() })
  .strict();
type Payment = {
  id: string;
  period_id: string;
  amount_minor: number;
  currency: string;
  reference: string;
  status: string;
  provider_environment: string;
  provider_transaction_id: string | null;
  period_status: string;
};
/** Called after the reservation commits, including generic replay. Cached status/amount/reference are never used for signing. */
export async function buildHostedCheckout(
  bindings: PaymentGatewayBindings,
  actor: Actor,
  reservation: { subscriptionId: string; paymentId: string },
) {
  const input = checkoutReservation.parse(reservation),
    keys = gatewayCredentials(bindings),
    returnUrl = checkoutReturnUrl(bindings);
  await authorizeCheckout(bindings.DB, actor, {
    subscriptionId: input.subscriptionId,
  });
  const payment = await bindings.DB.prepare(
    `SELECT pay.id,pay.period_id,pay.amount_minor,pay.currency,pay.reference,pay.status,pay.provider_environment,pay.provider_transaction_id,p.status AS period_status
    FROM billing_payments pay JOIN billing_periods p ON p.id=pay.period_id JOIN billing_subscriptions s ON s.id=p.subscription_id
    WHERE pay.id=? AND s.id=? AND s.account_id=?`,
  )
    .bind(input.paymentId, input.subscriptionId, actor.accountId)
    .first<Payment>();
  if (!payment)
    throw new Problem(404, "PAYMENT_NOT_FOUND", "Payment unavailable");
  if (payment.provider_environment !== keys.environment)
    throw new Problem(
      503,
      "PAYMENTS_UNAVAILABLE",
      "Payment gateway unavailable",
    );
  const response = {
    paymentId: payment.id,
    periodId: payment.period_id,
    reference: payment.reference,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    status: payment.status,
  };
  if (
    payment.status !== "CREATED" ||
    payment.period_status !== "PENDING" ||
    payment.provider_transaction_id !== null
  )
    return { ...response, checkoutAvailable: false };
  if (payment.currency !== "COP")
    throw new Problem(
      409,
      "PROVIDER_EVIDENCE_MISMATCH",
      "Payment currency unavailable",
    );
  const expirationTime = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = await wompiIntegritySignature({
    environment: keys.environment,
    reference: payment.reference,
    amountMinor: payment.amount_minor,
    currency: "COP",
    integritySecret: keys.integritySecret,
    expirationTime,
  });
  const url = new URL("https://checkout.wompi.co/p/");
  for (const [name, value] of Object.entries({
    "public-key": keys.publicKey,
    "redirect-url": returnUrl,
    currency: "COP",
    "amount-in-cents": String(payment.amount_minor),
    reference: payment.reference,
    "signature:integrity": signature,
    "expiration-time": expirationTime,
  }))
    url.searchParams.set(name, value);
  // Hosted checkout handles provider consent and payment data; no identity or secret is included here.
  return {
    ...response,
    checkoutAvailable: true,
    checkoutUrl: url.toString(),
    expiresAt: expirationTime,
  };
}
/** No public route can inject transport. The optional dependency is for local unit fixtures only. */
export async function reconcilePaymentWebhook(
  bindings: PaymentGatewayBindings,
  payload: unknown,
  requestId: string,
  options: {
    checksumHeader?: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  } = {},
) {
  const keys = gatewayCredentials(bindings);
  let signed: Awaited<ReturnType<typeof verifyWompiWebhook>>;
  try {
    signed = await verifyWompiWebhook(payload, {
      environment: keys.environment,
      eventsSecret: keys.eventsSecret,
      ...(options.checksumHeader !== undefined
        ? { checksumHeader: options.checksumHeader }
        : {}),
    });
  } catch {
    throw new Problem(
      400,
      "INVALID_PAYMENT_WEBHOOK",
      "Invalid payment webhook",
    );
  }
  const adapter = createWompiAdapter({
    ...keys,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let transaction: Awaited<ReturnType<typeof adapter.reconcile>>;
  try {
    transaction = await adapter.reconcile(signed.id, options.signal);
  } catch {
    throw new Problem(
      502,
      "PAYMENT_RECONCILIATION_UNAVAILABLE",
      "Provider reconciliation unavailable",
    );
  }
  if (
    transaction.id !== signed.id ||
    transaction.status !== signed.status ||
    transaction.amountMinor !== signed.amountMinor ||
    (signed.reference !== null && transaction.reference !== signed.reference) ||
    (signed.currency !== null && transaction.currency !== signed.currency)
  )
    throw new Problem(
      409,
      "PROVIDER_EVIDENCE_MISMATCH",
      "Provider event does not match reconciled evidence",
    );
  return applyReconciledEvidence(bindings, transaction, requestId);
}

async function applyReconciledEvidence(
  bindings: PaymentGatewayBindings,
  transaction: WompiTransaction,
  requestId: string,
) {
  const transactionEnvironment = gatewayCredentials(bindings).environment;
  // Permanent semantic evidence identity ignores mutable transport timestamps/PII and deduplicates provider observations across webhook deliveries.
  const evidenceHash = await sha256Hex(
    JSON.stringify([
      "WOMPI",
      transactionEnvironment,
      transaction.id,
      transaction.reference,
      transaction.amountMinor,
      transaction.currency,
      transaction.status,
    ]),
  );
  return applyWompiTransaction(
    bindings.DB,
    transaction,
    evidenceHash,
    requestId,
    transactionEnvironment,
  );
}

async function requireReconciliationAuthority(
  bindings: PaymentGatewayBindings,
  actor: Actor,
) {
  const active = await bindings.DB.prepare(
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
  await requirePlatformPermission(
    bindings.DB,
    actor,
    "platform.billing.manage",
    { mfa: true },
  );
}
/** Manual reconciliation reads only an already-bound provider transaction; it never creates/retries a charge or accepts a frontend transaction binding. */
export async function reconcileStoredPayment(
  bindings: PaymentGatewayBindings,
  actor: Actor,
  paymentId: string,
  requestId: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  z.string().uuid().parse(paymentId);
  await requireReconciliationAuthority(bindings, actor);
  const keys = gatewayCredentials(bindings);
  const payment = await bindings.DB.prepare(
    "SELECT id,reference,amount_minor,currency,provider_environment,provider_transaction_id FROM billing_payments WHERE id=?",
  )
    .bind(paymentId)
    .first<{
      id: string;
      reference: string;
      amount_minor: number;
      currency: string;
      provider_environment: string;
      provider_transaction_id: string | null;
    }>();
  if (!payment)
    throw new Problem(404, "PAYMENT_NOT_FOUND", "Payment unavailable");
  if (payment.provider_environment !== keys.environment)
    throw new Problem(
      503,
      "PAYMENTS_UNAVAILABLE",
      "Payment gateway unavailable",
    );
  if (!payment.provider_transaction_id)
    throw new Problem(
      409,
      "PAYMENT_TRANSACTION_UNKNOWN",
      "Provider transaction is unknown; a new charge must not be attempted",
    );
  const adapter = createWompiAdapter({
    ...keys,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  let transaction: WompiTransaction;
  try {
    transaction = await adapter.reconcile(
      payment.provider_transaction_id,
      options.signal,
    );
  } catch {
    throw new Problem(
      502,
      "PAYMENT_RECONCILIATION_UNAVAILABLE",
      "Provider reconciliation unavailable",
    );
  }
  if (
    transaction.id !== payment.provider_transaction_id ||
    transaction.reference !== payment.reference ||
    transaction.amountMinor !== payment.amount_minor ||
    transaction.currency !== payment.currency
  )
    throw new Problem(
      409,
      "PROVIDER_EVIDENCE_MISMATCH",
      "Provider evidence does not match the recorded payment",
    );
  await requireReconciliationAuthority(bindings, actor);
  return applyReconciledEvidence(bindings, transaction, requestId);
}
