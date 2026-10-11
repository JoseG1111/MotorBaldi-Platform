# ADR 0029 — Scoped read-only operational analytics

Status: Accepted — routine engineering decision within existing authorized operational purposes, 2026-10-10.

Build versioned transient reports from current canonical D1 states and established Queue metrics. Preserve existing assured audit/catalog/own-organization-location Parts authority and the Development machine's fixed synthetic ownership. No new roles, broader disclosure, raw source rows, personal data, financial estimates or predictive use are introduced.

Compute counts in one authorization-bound source query with explicit observation time/provenance and fail closed on malformed or absent evidence. Keep publication lifecycle counts distinct from currently discoverable snapshots. At-least-once event delivery cannot multiply current resource counts. Existing event/history/audit validation is reused; no new analytics materialization, provider, report storage, source retention policy or deletion job is needed.

This implements the existing operational reporting purpose, not approval of additional business intelligence, profiling, sharing or commerce. Disabled marketplace/payment/media capabilities and separately parked Wompi/antimalware verification remain unchanged. See the [Phase 9 contract](../architecture/phase-9-operational-analytics.md).
