# Marketplace Development verification

The owner-approved [Phase 8 contract](../architecture/phase-8-marketplace-proposal.md) enables optional public discovery and staff moderation only. Orders, checkout, payments/Wompi, inventory reservations/deductions, marketplace fees/commissions, media and fulfillment remain disabled. Merchant and real antimalware verification are separately parked; marketplace success does not verify them.

## Autonomous validation

Reuse the securely provisioned [Development identity](development-automation.md), without human passwords, cookies or TOTP. Credentials stay in OS Secret Service and the named Development API secret. Human staff still require actual MFA and privileged sessions. The machine can exercise only its fixed verified Workshop/site and owned synthetic offerings/listings.

```sh
node scripts/development/authentication-smoke.mjs
node scripts/marketplace/development-smoke.mjs --anonymous
node scripts/marketplace/development-smoke.mjs
node scripts/marketplace/check-consistency.mjs
node scripts/development/check-consistency.mjs
pnpm gate
```

Full smoke must verify explicit opt-in, private/pending exclusion, staff approval, anonymous positive public read/search, indicative COP pricing, allowlisted information/general location, source edit hiding, fresh re-review, replay/conflict/stale/origin rejection and withdrawal/revocation. It preserves immutable synthetic evidence and returns mutable synthetic offerings/canonical references to inactive/archived states. It does not create another organization, change customer preferences or adopt real partner resources.

Transient retries preserve the same logical body/idempotency key and use fresh signed request nonces. Unknown writes require authoritative replay/read reconciliation; a new key cannot resolve an ambiguous creation. Cleanup checks owned synthetic references/current versions and does not overwrite concurrent foreign changes. Do not delete history, audit, replay or outbox evidence. Diagnostic output contains step/status/allowlisted code and counts only, never credentials, PII or raw API/D1 bodies.

## Deployment and actual evidence

Apply pending additive migrations and deploy only named Development resources when required. Public reads are rate limited, strict and `no-store`. Eligibility is checked against current source version, canonical state, organization verification/capability/location and reviewed snapshot; an ACTIVE offering alone never publishes.

The consistency checker requires positive listing/approval/terminal-history and processed marketplace events, matching versions/organization/request audit evidence, no gaps/duplicates/FK issues or unresolved dead letters, and no remaining synthetic public listings. Empty tables cannot pass. Pending real events are distinct from an unavailable consistency query; wait for the existing relay/Queue schedule and rerun. Never manufacture events or mark them processed manually to obtain PASS.

MB-P8-005 remains unverified until actual authenticated mutation, anonymous positive discovery, safe cleanup, D1/audit/outbox/Queue convergence, full gate and exact implementation CI pass. Continuity records deployment versions and observed counts; local fixtures alone are insufficient evidence.
