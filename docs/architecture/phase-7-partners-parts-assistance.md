# Phase 7 — Partners, parts and assistance

## Established partner capability/relationship model

The accepted [master architecture](MOTORBALDI_MASTER.md), [identity/organization model](phase-1-identity-crm-organizations.md) and [ADR 0025](../adr/0025-membership-billing-commercial-boundaries.md) already establish partner participation as capabilities and relationships attached to an organization or professional. Partner is not an exclusive organization type.

An organization retains its existing type while holding several registered operational capabilities. For example, a WORKSHOP can also hold PARTS, INSPECTION and TOWING. `org_capabilities` stores organization/code pairs; the capability registry owns valid codes, and the composite primary key prevents duplicates. `org_location_capabilities` represents location-specific capabilities separately. Declaring a capability does not establish service availability, commercial approval or authorization to another account's vehicles or records.

Existing active organization membership and `org.capability.manage` authorize capability changes. Replacement is an atomic D1 batch with its audit event: invalid registry codes cannot erase the previous set. Capabilities do not create memberships, grant platform support access, enable payments or turn on premium assistance.

The existing versioned `commission_agreements` relationship attaches commercial terms to an organization without changing its type or capabilities. Agreements and their rules follow the approved [Phase 5 contract](phase-5-membership-billing.md): explicit authorized finance review, immutable approved terms, customer consent and verified completed-service evidence for recognition. A draft relationship does not imply an approved commission, settlement readiness, partner subscription charge or automatic payout. Organization capabilities remain independent of agreement versions and status.

Four real-D1 regressions verify membership denial, atomic rollback, combined capabilities and commercial relationship independence; full gate passes 514 tests. MB-P7-001 verifies this existing model rather than adding a parallel partner identity, exclusive PARTNER type or new commercial state machine. The existing capability PUT has no CAS/replay contract and unknown registry codes surface as errors; this model verification does not claim future operational API hardening, which MB-P7-004 must assess. Parts inventory and assistance fulfillment require their own business contracts before implementation.

## Parts contract — owner decision outstanding

Repository evidence establishes the PARTS capability and a future parts-assistance benefit, but supplies no approved item identity, catalog visibility, stock authority, reservation, order, payment, fulfillment, return or warranty contract. Workshop scope explicitly excludes inventory policy. These rules cannot be inferred from a capability or commission agreement.

A concrete conservative proposal for the next checkpoint is an informational catalog only: organization-owned draft items at organization level (location-specific publication remains deferred), management by active organization OWNER/ADMIN members, and publication only for verified active organizations with PARTS capability. Only authenticated ACTIVE accounts would browse published items. Items would contain bounded descriptive fields; they would not promise fitment, authenticity, stock availability, price, purchase, reservation, delivery or warranty. Internal stock management could be a separate explicitly approved scope, with organization/location ownership, integer quantities and auditable adjustments; it is not authorized by this proposal.

Before MB-P7-002 domain implementation, the owner must choose whether the first release is informational catalog only or also internal inventory. Approval must also settle audience/publication and management authority. If ordering, prices or fulfillment are requested, their commercial rules must be explicitly defined rather than seeded as technical defaults. This section is a reviewable proposal, not an accepted business policy.

## Assistance boundaries

The [approved general-support workflow](phase-6-communications-support.md#approved-support-workflow--2026-10-10) remains available under its exact customer/staff authorization. Premium guidance remains disabled until configured operating hours, staffing, entitlement/usage limits and business readiness. TOWING capability does not authorize dispatch, roadside availability, diagnosis, guaranteed response times or an SLA. A separate service-request/fulfillment contract is still required if Phase 7 assistance extends beyond existing support cases.
