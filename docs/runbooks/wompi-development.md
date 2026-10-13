# Wompi Development validation and release boundaries

Canonical decisions: [Phase 5 billing contract](../architecture/phase-5-membership-billing.md), [ADR 0025](../adr/0025-membership-billing-commercial-boundaries.md). Existing Development resources only; no live-money test, paid service, production deployment or raw card storage.

## Current technical integration

Development uses **SANDBOX only**. Production-capable source exists behind the separate disabled release gate; Production activation and recurring execution remain unavailable. Without all four valid sandbox bindings, checkout and provider processing return `503 PAYMENTS_UNAVAILABLE`; membership benefits never activate from a redirect or client price/status. Customer capabilities contain flags only, never keys. Selecting a plan creates a pending request without a charge.

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

Run this single local provisioning procedure from an interactive terminal:

```bash
python3 scripts/billing/provision-development-sandbox.py
```

It prompts invisibly for all four values, validates Sandbox prefixes before writing any binding, then passes each secret exclusively through Wrangler stdin to the existing Development API. Values never enter arguments, environment variables, files or output; failures are redacted. Production-format keys are rejected. The supplied production keys were not used, copied or provisioned. Alternatively use the authorized Cloudflare Development API secret-management interface with the four names above. Optional WOMPI_ENVIRONMENT must equal SANDBOX; omission defaults to sandbox. Provisioning is not a successful payment test.

Configure the merchant **sandbox** event URL to `https://motorbaldi-api-development.josegbarrios2.workers.dev/api/v1/payments/wompi/events`. Manual dashboard interaction is a genuine human-action boundary when no authorized merchant session/credentials exist. It does not justify weakening verification or blocking unrelated implementation.

## Validation evidence limits

Focused provider, gateway and D1 tests use synthetic **local** official-protocol fixtures and injected transport; they make no external financial transactions and do not prove merchant credentials or real recurring authorization. Closed-gateway Development probes prove rejection without credentials, not a successful Wompi payment. Full external validation belongs to MB-P5-005 and remains unverified until actual official sandbox evidence exists.

After credentials/onboarding, verify sandbox checkout and authoritative provider confirmation, annual/monthly prices, duplicate notifications, signature/amount/environment mismatch, pending/declined/error outcomes, explicit manual renewal timing, cancellation cutoff, expiry, privilege/MFA/ownership denial, financial audit/outbox/Queue convergence and reconciliation. Use only [official sandbox data](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/) and the current [Wompi protocols](https://docs.wompi.co/docs/colombia/transacciones/). Do not create another customer account to bypass existing state or automatically charge a saved source.

`node scripts/billing/development-smoke.mjs --verify-only` reads an existing assured Development session via stdin and performs GET requests only. `--gateway-closed` additionally checks known rejection responses when capabilities are disabled and compares financial snapshots unchanged. The ordinary synthetic membership smoke creates an explicitly finite administrative test entitlement, removes coverage and suspends its own subscription; it does not claim a payment or antimalware verification. Missing four accessible fixtures means the remote three-vehicle-limit (fourth vehicle rejected) scenario is explicitly skipped; its local regression remains evidence only for local behavior.

## Outstanding production policies

Tax treatment, refunds, grace periods, payment retries, recurring authorization and partner commission rates/settlement rules require approval before live billing. Development uses no automatic retries/refunds/proration/grace/partner settlement and no invented rates. Cancellation/dispute/refund-related commission corrections are immutable manual adjustments and settlement dispute tracking, not provider refunds. Real antimalware stays owner-deferred; private R2/quarantine and the prohibition on external production access to unscanned files remain in force.

## MB-RL-001 — Current provisioning and controlled acceptance

Owner confirms all four Sandbox bindings provisioned through the existing script; do not overwrite or request them again. Cloudflare OAuth was restored after owner browser approval on 2026-10-13. Names-only inspection confirms all four Sandbox bindings; isolated GET-only remote preview confirms Development D1, valid Sandbox formats and actual merchant acceptance read. Private-key authentication and payment cycles remain pending. The deployed callback is reachable: an unsigned empty POST returned HTTP400 INVALID_PAYMENT_WEBHOOK on 2026-10-13; this proves no successful provider payment. Separate realistic synthetic invalid-signature and wrong-environment callbacks also returned400; no authoritative provider transaction was submitted. The deployed source validates all four Sandbox-prefixed bindings before signature rejection, corroborating configuration presence/formats indirectly; direct names-only inventory and actual merchant read now pass; private-key authentication and payment cycles remain pending.

After local Cloudflare login, perform a **GET-only** isolated remote preview with existing Development bindings:

```bash
pnpm exec wrangler dev scripts/billing/readiness-preview.mjs --config apps/api/wrangler.jsonc --env development --remote --port 8891 --inspector-port 9291
curl --fail http://localhost:8891/
```

Stop the preview immediately after collecting boolean evidence. It validates Development D1/environment, Sandbox key formats and merchant acceptance via the real adapter; output never includes credentials/tokens/raw responses. Merchant-read success does not prove private-key authentication or a payment cycle. Local dry-run and actual GET-only remote execution passed. Observed credentialsConfigured=true, merchantReadVerified=true, paymentCycleVerified=false, privateKeyAuthenticationVerified=false. Preview stopped after evidence collection. Remote D1 payment/dispatch counts remain zero, policy remains0 and FK check is clean.

Configure the separate [Sandbox dashboard event URL](https://docs.wompi.co/docs/colombia/eventos/) exactly as shown above. For real acceptance, use one legitimate authorized Development customer session and synthetic customer-owned data through the actual Portal membership screen; keep human MFA/security controls. Select monthly/annual canonical plan, initiate checkout, verify Wompi displays Sandbox and matching COP amount, then use only official test data. Capture IDs privately for authorized D1/reconciliation inspection, never payment data or sessions in screenshots/evidence. Verify the event has a valid signature and matches GET provider evidence, immutable payment/period/financial/outbox records, one Premium activation after APPROVED, no activation for DECLINED/PENDING/ERROR, no change after duplicate/replayed evidence, and manual renewal/cancellation/expiry behavior. Return query parameters are never confirmation. Keep mocked malicious-signature/amount/reference/timeout scenarios classified separately from real provider results. No automatic recurring billing or charge retry is enabled.

Production gateway and checkout reservations are now environment-aware and immutable, requiring **all** of platform production, WOMPI_ENVIRONMENT=PRODUCTION, correctly prefixed credentials and WOMPI_PRODUCTION_RELEASE_AUTHORIZED=true. The release flag is unset/false by default and must remain so until separate explicit Production authorization and rotation/revocation of previously exposed credentials. No live transactions occurred.

Hosted checkout additionally requires the server-only `PAYMENTS_RETURN_URL` to equal an approved Portal origin plus `/payment-return`. Development uses `https://motorbaldi-portal-development.josegbarrios2.workers.dev/payment-return`; no query, fragment, credentials or untrusted origin is accepted. Wompi receives this as `redirect-url`. The return screen discards provider query parameters and reloads authoritative subscription/payment state; a forged success URL never activates Premium.

## Saved callback continuation — 2026-10-13

Owner confirms the Sandbox event URL is saved in Wompi. This is owner-reported merchant configuration, not independently observed delivery. Live callback unsigned POST still returns400; Development D1 has zero payments and zero provider confirmations, FKclean. Existing outbox/policy inspected read-only. Cloudflare login remains usable. The remaining first-cycle boundary is a legitimate existing customer browser session/checkout, not missing Wompi credentials or callback configuration. Never mint a session, reuse a private browser profile or expand Parts automation into billing.

Open `https://motorbaldi-portal-development.josegbarrios2.workers.dev/#premium` with normal login/MFA. Choose monthly Premium COP29,900, open **Pagar en Wompi (pruebas)** and confirm Sandbox; use only the [official approved Sandbox card](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/) with a future expiry and test CVC. Return and **Consultar estado del pago**. Report completion or non-sensitive error text only, not passwords/MFA/cookies/real card data. The engineer then checks canonical payment/confirmation/period/entitlement/audit/outbox evidence. This first approved cycle does not close annual/decline/pending/replay/reconciliation acceptance.
