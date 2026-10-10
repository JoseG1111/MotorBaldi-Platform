# Wompi Development validation and release boundaries

Canonical decisions: [Phase 5 billing contract](../architecture/phase-5-membership-billing.md), [ADR 0025](../adr/0025-membership-billing-commercial-boundaries.md). Existing Development resources only; no live-money test, paid service, production deployment or raw card storage.

## Current technical integration

The API gateway supports **SANDBOX only**. Production and recurring execution are always unavailable. Without all four valid sandbox bindings, checkout and provider processing return `503 PAYMENTS_UNAVAILABLE`; membership benefits never activate from a redirect or client price/status. Customer capabilities contain flags only, never keys. Selecting a plan creates a pending request without a charge.

Hosted checkout reserves a D1 payment/period with server-resolved money. Generic replay does not override the current ledger: signing rereads ownership, eligibility and payment status. The signed URL uses Wompi's fixed HTTPS host and a 15-minute expiry. A PENDING/UNKNOWN/APPROVED reservation cannot be offered again as a new charge. Initial payment uses the pending price snapshot; a manual renewal snapshots the current plan. Annual periods are calendar years with one payment.

`POST /api/v1/payments/wompi/events` accepts bounded JSON without browser Origin, solely for signed provider notifications. The exemption is this exact path; browser mutations retain origin enforcement. Signature/environment validation precedes a private-key GET to the official sandbox transaction API. Signed ID/status/amount and authoritative transaction reference/currency must match the internal ledger. Permanent semantic observation deduplication, confirmation, payment/period/subscription changes, audit and outbox commit atomically. Raw notifications and customer/payment credentials are never retained or logged.

`POST /api/v1/admin/billing/payments/{paymentId}/reconcile` accepts an empty JSON object. Active financial management privilege and MFA are checked before and after the provider read. It reconciles only the transaction ID already bound in D1. A missing ID returns `409 PAYMENT_TRANSACTION_UNKNOWN`; it does not guess a provider ID or retry a charge. Duplicate observations converge through permanent financial evidence, independently of generic replay TTL.

The background Worker expires subscriptions only after every finite administrative grant and confirmed paid period ends. Cancellation disables future renewal and preserves already-paid access through its cutoff. Suspended subscriptions retain immutable history and occupy the one-open-subscription boundary until expiry. Free account/vehicle/basic service-record access remains independent.

## Credential and merchant action

Sandbox credentials must be available from an authorized Wompi merchant dashboard and installed directly as Development API Worker secrets, using interactive secret input or an approved credential manager. Never paste them into repository files, execution notes, chat, logs or shell arguments. Four names are required:

- `WOMPI_PUBLIC_KEY` — sandbox public merchant key.
- `WOMPI_PRIVATE_KEY` — sandbox private API key.
- `WOMPI_INTEGRITY_SECRET` — sandbox checkout integrity secret.
- `WOMPI_EVENTS_SECRET` — sandbox event validation secret.

Use `pnpm exec wrangler secret put NAME --config apps/api/wrangler.jsonc --env development` for each name. Optional `WOMPI_ENVIRONMENT` must equal `SANDBOX`; omission defaults to sandbox. No production key is accepted by this gateway. Configuring secrets changes checkout availability and must be followed by the remote scenario matrix, not a fabricated successful payment.

Configure the merchant **sandbox** event URL to `https://motorbaldi-api-development.josegbarrios2.workers.dev/api/v1/payments/wompi/events`. Manual dashboard interaction is a genuine human-action boundary when no authorized merchant session/credentials exist. It does not justify weakening verification or blocking unrelated implementation.

## Validation evidence limits

Focused provider, gateway and D1 tests use synthetic **local** official-protocol fixtures and injected transport; they make no external financial transactions and do not prove merchant credentials or real recurring authorization. Closed-gateway Development probes prove rejection without credentials, not a successful Wompi payment. Full external validation belongs to MB-P5-005 and remains unverified until actual official sandbox evidence exists.

After credentials/onboarding, verify sandbox checkout and authoritative provider confirmation, annual/monthly prices, duplicate notifications, signature/amount/environment mismatch, pending/declined/error outcomes, explicit manual renewal timing, cancellation cutoff, expiry, privilege/MFA/ownership denial, financial audit/outbox/Queue convergence and reconciliation. Use only [official sandbox data](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/) and the current [Wompi protocols](https://docs.wompi.co/docs/colombia/transacciones/). Do not create another customer account to bypass existing state or automatically charge a saved source.

`node scripts/billing/development-smoke.mjs --verify-only` reads an existing assured Development session via stdin and performs GET requests only. `--gateway-closed` additionally checks known rejection responses when capabilities are disabled and compares financial snapshots unchanged. The ordinary synthetic membership smoke creates an explicitly finite administrative test entitlement, removes coverage and suspends its own subscription; it does not claim a payment or antimalware verification. Missing three accessible fixtures means the remote two-vehicle-limit scenario is explicitly skipped; its local regression remains evidence only for local behavior.

## Outstanding production policies

Tax treatment, refunds, grace periods, payment retries, final vehicle limits, recurring authorization and partner commission rates/settlement rules require approval before live billing. Development uses no automatic retries/refunds/proration/grace/partner settlement and no invented rates. Cancellation/dispute/refund-related commission corrections are immutable manual adjustments and settlement dispute tracking, not provider refunds. Real antimalware stays owner-deferred; private R2/quarantine and the prohibition on external production access to unscanned files remain in force.
