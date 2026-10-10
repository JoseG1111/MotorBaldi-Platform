# ADR 0026 — Canonical parts, partner offerings and Phase 7 boundaries

Status: Accepted — owner-approved baseline, 2026-10-10.

MotorBaldi owns a canonical parts reference catalog. Verified active partner organizations own separate offerings, optionally scoped to an active location, with optional explicit links to canonical parts. Existing organizations retain their types and multiple capabilities. Exact platform PLATFORM_SUPERADMIN/CATALOG_ADMIN staff manage canonical data with verified MFA, privileged-session assurance and reviewed, reasoned commands. Active organization OWNER/ADMIN members manage only their own verified PARTS-capable organization/location offerings under existing location scopes and assurance rules. Organization roles confer no canonical mutation authority or access to another organization's commercial information.

Canonical and offering records have independent audited versioned lifecycles (DRAFT/ACTIVE/ARCHIVED and DRAFT/ACTIVE/INACTIVE). Strong canonical matching uses controlled normalized brand/manufacturer-reference pairs; product names never cause automatic matching or merging. A duplicate strong identity produces a conflict for explicit authorized review. Historical references and snapshots remain immutable; no destructive deletion of referenced records.

Offerings contain optional integer COP minor-unit prices (omission means Consultar), informational availability and update time. Compatibility references are informational and never establish fitment from a model alone. Workshops must confirm fitment. No private VIN/plate lookup or fabricated verification is introduced.

Phase 7 adds catalog foundations and part references/snapshots in existing authorized Workshop service workflows. Repository inspection finds no quotation domain, so this implementation does not invent financial quotation acceptance, totals, purchase orders or checkout. Existing operational service snapshots freeze part/price/version data; future quotation capabilities must preserve the same immutable snapshot boundary when explicitly implemented.

Inventory reservation/deduction, standalone customer checkout, direct parts payments, public marketplace/discovery, automatic new parts commissions and sourcing assistance remain unavailable. Phase 8 requires its own public/commercial contract before adding those capabilities. Existing Wompi merchant boundary, disabled external providers, private R2/malware quarantine and real-scanner deferral remain unchanged. No unscanned media is published; the initial Parts contract does not attach or expose files.

See [Phase 7 design](../architecture/phase-7-partners-parts-assistance.md), [ADR 0025](0025-membership-billing-commercial-boundaries.md), [ADR 0024](0024-owner-antimalware-deferral.md) and [execution evidence](../ai/EXECUTION_PLAN.md). Local fixtures are not authenticated remote or provider verification.
