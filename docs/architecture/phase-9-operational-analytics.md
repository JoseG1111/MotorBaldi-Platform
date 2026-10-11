# Phase 9 — Read-only operational analytics

Status: Accepted engineering contract within existing operational purposes and source authorization. No new commercial decision, cross-organization partner disclosure or personal-data use is introduced.

## Established scope

Foundation observability already defines pending outbox, live processing leases and unresolved dead-letter metrics. Approved Parts and marketplace lifecycles establish canonical/offering/listing states and exact current role/organization/location access. Phase 9 reports counts of those same authorized source facts, not inferred transactions or new customer behavior. Owner delegated routine implementation decisions; these reports preserve the existing purposes and authorities instead of introducing new business rules.

Version1 reports comprise platform Queue operational counts for existing assured PLATFORM_SUPERADMIN/AUDITOR audit readers; canonical Parts state counts for existing assured catalog staff; and offering/publication state counts for exact own-organization/location Parts managers. Development automation reads only its fixed fixture and owned synthetic records through its existing minimal Parts permissions. It receives no audit/superadmin authority. Ordinary organization roles or support/finance roles alone do not grant reports. Anonymous users receive no private analytics endpoint.

Counts use canonical current D1 records. One aggregate source query gives each report's consistent point-in-time facts and UTC observation time. State is counted once per resource, independent of duplicate delivery. A published listing count describes lifecycle state; a separately named discoverable count applies current reviewed-source eligibility, because published state alone does not establish current visibility. Null price is not zero money; no revenue, sales, income, payment success or commissions are inferred.

## Event semantics and provenance

Versioned Parts and marketplace events retain their existing strict minimal resource/organization/version references, authoritative immutable history/audit and at-least-once transport. Current state reports do not count raw delivery attempts or claim a complete historical trend. Source table families, schema version, measure names, scope and observation time are explicit. Unknown schemas, malformed/missing rows or unsafe counts fail closed; absent query evidence never becomes a zero result. An empty authorized source set can truthfully produce zero counts, distinguished from missing/unavailable evidence.

No new event content, Analytics Queue stream or materialization is required for these live reports. Existing Worker consumers and permanent version histories remain authoritative. Notification delivery, merchant verification, billing smoke and real antimalware limitations stay separately documented; reporting does not verify or enable them.

## Privacy, access and retention

Reports are INTERNAL scoped operational data and contain only fixed measure names, nonnegative integer counts, schema/scope identifiers, source provenance and UTC observation time. No source rows, event payloads, actor IDs, customer/vehicle identifiers, VIN/plate, contact/street-address/coordinates, credentials, notes, raw errors or commercial price/amount data are exposed. Human access retains MFA and privileged-session assurance. Recheck exact current authority in the aggregate query, not only before it; location-scoped reports cannot count another location or organization-wide offerings. Return `no-store` and use bounded strict queries.

Do not copy source data or persist reports, introduce analytics retention/deletion jobs, export raw records, send third-party telemetry or change append-only evidence retention. Each response is transient; source retention follows its existing domain. No new retention duration is invented. Forecasting, profiling/scoring, recommendations, advertising, automatic decisions and additional business measures remain unavailable until their separate requirements and purposes exist.

## Verification

Contract tests enforce stable measures/version, strict event/report allowlists, safe counts and explicit provenance. Real D1/security tests verify exact current roles, human MFA, own scope/selected locations, machine ownership, revocation races, source equality, duplicate-delivery independence, missing-query fail-closed behavior and public exclusion. Spanish screens explain current counts and visibility rather than financial/predictive conclusions. Development validation compares authenticated synthetic reports with independently queried D1 aggregates and existing audit/outbox/Queue consistency. Every checkpoint needs its own actual evidence before VERIFIED.
