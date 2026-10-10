# Phase 6 — Communications, notifications and support

The owner-approved [membership contract](phase-5-membership-billing.md) supplies the benefit boundaries. [Master architecture](MOTORBALDI_MASTER.md), existing identity/consent/authorization, [coordination ADR](../adr/0019-durable-object-coordination.md) and [scanner deferral](../adr/0024-owner-antimalware-deferral.md) remain canonical. This phase does not wait for external Wompi merchant credentials: its dependency is the verified technical billing/entitlement foundation, while actual billing validation stays outstanding.

## Provider and delivery semantics

Extend the existing Messaging ports; do not create another service or enable a paid provider. EMAIL, SMS and WHATSAPP external transports are initially unavailable. Provider acceptance does not prove delivery. Outcomes distinguish ACCEPTED, REJECTED, UNAVAILABLE and UNKNOWN; provider references must be bounded opaque identifiers, never arbitrary response bodies. Logging/audit uses minimal internal IDs and allowlisted outcome codes, excluding recipient/contact/body/token/provider credentials.

Use a stable internal notification ID as the provider idempotency key. Every send/reconcile requires a current-authority decision immediately before transport. Recipient verification, channel preference, purpose-specific consent and current account/resource authorization belong to that decision. A timeout, network failure or caller abort after dispatch is an unknown external effect; no blind retry is safe. Provider integration must demonstrate idempotency/reconciliation capability before Queue delivery may execute it. The current unavailable transport makes no external call and never fabricates an accepted/delivered receipt.

D1 atomic command/outbox/replay guarantees do not magically make external delivery atomic. Queue processing must retain unknown effects for reconciliation and preserve existing DEAD_LETTER/error evidence. A future provider with absent idempotency or reconciliation cannot be silently treated as safe at-least-once delivery. Existing local authentication email sink remains local-only, expressly distinct from a real provider; remote authentication restrictions/MFA stay unchanged.

## Preferences, templates and private inbox

Reuse person contact/consent evidence and account ownership. Marketing consent is separate from transactional service/account and requested support communication; granting a channel preference does not manufacture marketing consent. External delivery requires a currently verified destination and the relevant latest consent where applicable. Newly created notification preferences default to external channels disabled. Basic service history and free customer workflows never require premium membership merely to receive relevant account/service information.

Versioned templates use natural Colombian Spanish and preserve English localization. Rendering permits only registered template variables and rejects unrecognized inputs; template content must not contain credentials, authentication action URLs or unnecessary customer/vehicle PII. Queue/outbox envelopes contain internal references rather than message bodies or recipients. A private account inbox is an internal application record; creating it must not be represented as email/SMS/WhatsApp delivery.

Premium maintenance reminders and enhanced assistance use current subscription plus vehicle authorization, not garage membership alone. Reminder inputs must carry provenance (verified or customer-provided), with no government-API inference. Detailed reminder cadence/retention, notification legal-purpose classification and provider-specific transport behavior remain **UNKNOWN — VERIFY FROM REPOSITORY** until a concrete implementation needs a decision; unknown release settings stay disabled/configurable instead of inventing commercial promises.

## Human assistance

Human support hours, timezone, contact/channel readiness and usage limits are configurable. The default policy is disabled with no invented opening hours, unlimited allowance, staffing or 24/7 promise. Enabled policies require validated opening intervals and finite usage settings. Availability is a schedule assessment, not guaranteed human response or mechanical diagnosis. Direct WhatsApp assistance needs an explicitly configured real contact; adding a future provider port alone does not make it operational.

Usage accounting must be authoritative and atomic in D1 when support cases are implemented. A pure policy helper can validate a supplied usage snapshot, but is not a durable quota counter. Existing Vehicle/Workshop records and verified statuses supply customer service context; no fabricated workshop updates, diagnosis or third-party contact-sharing consent.

Support cases may record customer requests, authorized staff assignment, responses and closure under account/organization/location boundaries. Exact workflow details not established by owner/repository remain **UNKNOWN — VERIFY FROM REPOSITORY**; routine technical choices may follow existing domain patterns, but unresolved business choices must be recorded before enabling them. Requested general support and lawful purchased-order records remain distinct from premium assisted guidance. Private evidence continues through existing validated/quarantined storage; there is no public unscanned upload/download exception.

## Validation and release

Provider contract tests must exercise invalid recipients/templates, authority denial/revocation, unavailable transport, abort/timeout/unknown effects, permanent rejection, safe references and absence of retries/PII exposure. Notification/support persistence requires ownership/MFA where privileged, current consent/preference checks, CAS, atomic audit/outbox/replay and regression coverage. Development smoke uses existing resources and trusted synthetic data; it cannot claim external delivery without a real approved provider. No paid provider or production operation is activated by this foundation.
