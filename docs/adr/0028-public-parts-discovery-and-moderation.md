# ADR 0028 — Public parts discovery and staff moderation

Status: Accepted — owner-approved MB-P8-001, 2026-10-10.

Implement optional public parts discovery for verified active PARTS-capable partners. Offerings remain private by default. Explicit scoped partner submission creates a versioned allowlisted public snapshot; current assured MotorBaldi staff review is required for publication. Partners retain their offerings/prices and MotorBaldi retains the canonical reference catalog. Source/eligibility changes cannot silently alter or preserve stale public claims; withdrawal and staff revocation are audited.

Public data is approved part information, business name/general location, optional indicative integer COP price, availability/update time and informational compatibility. Exclude customer/vehicle/private commercial data and VIN/plate lookup. Preserve authorization, MFA/privileged assurance for humans, validation, rate limiting, atomic audit/idempotency/outbox and reviewed immutable history. Development machine validation remains distinct and restricted to owned synthetic data.

Orders, checkout, payments/Wompi, reservations/inventory deduction, marketplace fees/commissions, media and automatic fulfillment are disabled and out of scope. This decision does not establish commercial/legal transaction terms or satisfy separately parked merchant/scanner verification.

See the [approved Phase 8 contract](../architecture/phase-8-marketplace-proposal.md). It supersedes only Phase 7's pending-public-discovery boundary; all other accepted Parts and security invariants remain.
