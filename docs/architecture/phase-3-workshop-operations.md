# Phase 3 — Workshop Operations

This contract adds operational work tracking to the accepted Vehicle and Organization models. Repository inspection found no prior detailed Workshop state machine. The following initial workflow is a bounded implementation choice under the operator's 2026-10-09 instruction to proceed autonomously and choose the best implementation. It is recorded explicitly rather than presented as a historical product specification. It does not establish legal ownership, customer contractual consent, quotes, taxes, payments, inventory, warranty, appointments or inspection report requirements; those remain outside this phase or UNKNOWN — VERIFY FROM REPOSITORY when needed.

An order belongs permanently to one vehicle, active verified organization and active location in that organization. A vehicle grant does not substitute for an organization role or membership, and organization membership does not substitute for a vehicle grant. A workshop is recognized by an existing service capability, not by assuming an exclusive organization type. Existing service capability codes are CAR_SERVICE, MOTORCYCLE_SERVICE, GENERAL_MAINTENANCE, ELECTRICAL, DIAGNOSTICS, TIRES and BODYWORK. Orders carry a bounded confidential work description, assigned executor, optimistic version and timestamps. No monetary values or private identifier lookup are introduced.

## Initial operational states

| From                     | To          | Authority and requirement                                                                                 |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------- |
| DRAFT                    | OPEN        | Organization Workshop manager; record admitted for operational tracking                                   |
| DRAFT, OPEN, IN_PROGRESS | CANCELLED   | Organization Workshop manager; required reason; cancellation is terminal                                  |
| OPEN                     | IN_PROGRESS | Assigned active executor with Workshop execute permission and matching location scope                     |
| IN_PROGRESS              | COMPLETED   | Same assigned executor; a FINAL professional record matching vehicle, organization and location is linked |
| COMPLETED                | CLOSED      | Organization Workshop manager with fresh MFA assurance; terminal                                          |

OPEN does not assert customer approval or authorize a charge. Detailed commercial approval policy is not inferred from an operational status. CLOSED and CANCELLED orders cannot be edited or reopened. Final professional records are never rewritten; their corrections retain the Vehicle amendment model. Every transition preserves append-only state history with actor/reason and uses compare-and-swap against the current version. Location, organization and vehicle cannot be reassigned by PATCH. Nonterminal descriptions and assignments may be revised through dedicated versioned commands; assigned people require active valid membership, location scope and execute permission.

## Authorization and privacy

The initial organization permissions are `org.workshop.read`, `org.workshop.manage`, `org.workshop.execute`. Owner and Admin receive all three; Service Advisor receives read/manage; Mechanic receives read/execute; Viewer receives read only. An actual vehicle operation separately requires a current exact `vehicle.workshop.read` or `vehicle.workshop.write` grant. Grants remain staff-issued under the Vehicle policy; no access is inferred from an OWNER/DRIVER/WORKSHOP relationship, garage bookmark, plate or VIN. Membership validity, organization verification, service capability, and active location scope are checked on every command/read, including replays. A selected-location member cannot access a different location by omitting the location filter.

Platform Workshop read permission permits MFA-assured staff to inspect operational records through Admin; it does not authorize execution on behalf of an organization. Portal provides organization/location-scoped list, creation, assignment, description revision and permitted state transitions. Finalization remains in Vehicle professional workflows, avoiding a second report source of truth.

Work descriptions, attachments and internal operational history are CONFIDENTIAL; evidence objects remain RESTRICTED and private in R2. Evidence attachment and download require both an authorized order and an ACTIVE file owned by the uploader at attachment time. Quarantined, unavailable or rejected scans cannot be published. Scanner integration remains fail-closed; a deterministic test scanner must never be treated as a real remote safety check.

## Persistence and delivery

D1 is canonical. New Workshop commands use the existing serialized coordinator with a single batch containing business changes, dependent CAS guards, append-only audit/history, minimal-ID outbox events and replay persistence. The existing generic financial-command crash window remains for MB-P5-000. Queue handlers acknowledge at-least-once events idempotently; they do not claim email delivery. UUIDv7, UTC ISO timestamps, default-deny authorization, private R2, Spanish-first native accessible controls and explicit Development environment selection remain required.

See [Vehicle Core](phase-2-vehicle-core.md), [Phase 1 organization authorization](phase-1-identity-crm-organizations.md), [master architecture](MOTORBALDI_MASTER.md) and [execution plan](../ai/EXECUTION_PLAN.md).

## Owner-approved scanner deferral

On 2026-10-09 the owner deferred real antimalware and MB-P3-005's remaining positive remote file validation with a $0 additional security-service budget. See [ADR 0024](../adr/0024-owner-antimalware-deferral.md). Core operational/negative quarantine evidence remains valid; the deferred checkpoint is not VERIFIED. Trusted Development test files remain private and quarantined, never promoted by trust. Independent report-domain development continues through verified prerequisites. Revisit real scanning before public file upload/download enablement.
