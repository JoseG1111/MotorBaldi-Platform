# Phase 4 — Inspections / Peritaje

Repository inspection found no detailed inspection checklist, severity taxonomy, mandatory commercial report fields or legal certification contract. Under the owner's instruction to proceed autonomously, this initial contract captures bounded professional observations without inventing a pass/fail verdict, valuation, warranty or jurisdictional certificate. These product-specific requirements remain **UNKNOWN — VERIFY FROM REPOSITORY** if a later feature needs them.

## Canonical report

Reuse `vehicle_professional_records` with `record_type=INSPECTION`. Vehicle, organization, location, author, optimistic version, DRAFT/FINAL state and UTC timestamps remain canonical there. Reuse append-only `vehicle_professional_amendments` for corrections; do not create a second final report database. The initial report content is a strict versioned object: schemaVersion 1, bounded summary, and up to 200 findings. Each finding has a UUID identifier, bounded label/observation and up to 20 distinct evidence file UUIDs. Finding IDs are unique within the report. No price, legal ownership, score or regulatory verdict is inferred.

`packages/inspections` defines content and amendment validation and an immutable canonical JSON snapshot bounded to 64 KiB. Caller-owned objects cannot alter that snapshot. Evidence IDs must resolve to current authorized ACTIVE associations before snapshot finalization; caller-provided IDs alone confer no access or scan assurance. The next media/workflow checkpoints implement that resolution and authorization in the API/coordinator. The contract alone does not expose an inspection endpoint or grant permissions.

D1's existing FINAL-record triggers prohibit rewriting/deleting final content or changing its vehicle/organization/location/author identity. Corrections are append-only amendments by an authorized author with a bounded reason; they do not replace the original report. A generic empty findings list is valid observation content, not a declaration that a vehicle passed an inspection. Specific required findings/checklists remain unknown.

## Access and workflow boundaries

People act through active accounts and appropriately scoped organization memberships. Organizations must be verified/active and have INSPECTION capability. An explicit current vehicle permission remains separate from a role or relationship; use the existing professional-record authorization seam and add any narrowly scoped inspection requirement deliberately. Staff inspection requires its existing MFA assurance; staff roles never imply execution as an organization member.

The independent workflow checkpoint establishes assignment/review/finalization permissions and state transitions. Do not claim those exist merely from this contract. Keep scope fixed, optimistic concurrency, atomic command/audit/outbox/replay, immutable final content, Spanish UI and default-deny access.

## Evidence and owner deferral

R2 stays private; metadata/lifecycle remains in D1. Media associations require owned ACTIVE files and authorized scoped report access; downloads recheck current authority. Trusted Development fixtures can exercise upload, validation, private quarantine and rejection. They cannot be manually promoted or served while quarantined. Real scanning and positive remote file closeout are deferred by [ADR 0024](../adr/0024-owner-antimalware-deferral.md); never claim a fake scan or a completed real-scanner verification. Revisit scanning before public file upload/download enablement. Reports without file evidence and unrelated workflow development can progress independently.

See [Vehicle Core](phase-2-vehicle-core.md), [Workshop Operations](phase-3-workshop-operations.md), [ADR 0017](../adr/0017-r2-storage.md), [trusted Development testing](../runbooks/development-private-file-testing.md), and [execution plan](../ai/EXECUTION_PLAN.md).

## Initial execution policy

The delegated initial workflow uses canonical DRAFT to FINAL, without inventing a mandatory second reviewer. Owner/Admin/Inspector may execute through `org.inspection.execute`, but only the actual author can mutate/finalize/amend a report. Finalization and amendments require fresh MFA under the existing professional-record policy. All execution requires active valid membership/scope, verified INSPECTION capability/location and exact vehicle.record.write; personal grants alone do not authorize organizational authorship. FINAL reports may be read through explicit vehicle.record.read, including a directly granted person; drafts remain author-only. Capability/location and current exact grant are rechecked for Inspection/media reads and generic Vehicle report lists.

Generic Vehicle create/update/finalize/amend endpoints run the same Inspection guard inside the serialized coordinator before replay, so a client cannot bypass the schema or Inspection execution permission by selecting recordType INSPECTION outside dedicated UI. Finalized content is amended separately, never reopened. Amendment evidence references use the original immutable associations; new evidence for a separate observation requires a new draft report under this initial contract. No regulatory or customer acceptance statement is inferred.

Media attachment is a dedicated atomic command with replay, version/association, audit and minimal-ID outbox in one D1 batch. A revoked executor cannot obtain an earlier replay. The existing generic financial-command debt remains MB-P5-000; these narrow command implementations do not close it globally.
