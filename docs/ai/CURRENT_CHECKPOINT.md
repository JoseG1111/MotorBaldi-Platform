# Current checkpoint

- **Current checkpoint:** MB-P4-002 — Evidence/media lifecycle
- **Status:** IN PROGRESS
- **Last verified checkpoint:** MB-P4-001 — Inspection domain + immutable report contract
- **Work completed:** Owner decision recorded in ADR 0024: MB-P3-005 is DEFERRED — OWNER APPROVED, not VERIFIED, with a $0 additional security-service budget. No scanner integration or security bypass is authorized. MB-P4-001 now depends on verified MB-P2-005/MB-P3-004; existing Vehicle professional records/amendments remain canonical.
- **Verification completed:** Prior Workshop gate (29 unit/89 Worker tests), authenticated core/quarantine smoke, matching 13 Workshop command/audit/history/event receipts, all 70 outbox events processed and CI 37970938614 remain valid. Inspection contract gate passed 32 unit/89 Worker tests; strict findings, immutable snapshots, unauthorized evidence/duplicates/content bounds and amendments are tested.
- **Remaining work:** Implement/test immutable inspection evidence associations, owned ACTIVE-only attachment, exact report/org/location read/write checks and final snapshot evidence resolution. Specific checklists/legal verdicts remain UNKNOWN — VERIFY FROM REPOSITORY.
- **Current blocker:** None for report-domain work. Real remote scanner verification remains explicitly deferred, not a blocker for unrelated work and not permission to serve unscanned files.
- **Exact next action:** Implement media persistence and scoped authorization against canonical INSPECTION professional records; test unavailable/quarantined rejection and immutable finalized media without any scanner integration.
- **Relevant files:** `packages/vehicles/`, `packages/workshops/`, `packages/storage/`, `migrations/0006_vehicle_history.sql`, `docs/adr/0024-owner-antimalware-deferral.md`, `docs/runbooks/development-private-file-testing.md`, `docs/ai/EXECUTION_PLAN.md`.
- **Commands worth rerunning:** `pnpm gate`; `git diff --check`; Development-only Workshop smoke with an existing session through stdin. Never supply credentials in files/CLI arguments.
- **Expected result:** Private authorized immutable media associations and snapshot resolution are tested; continue to independent inspection workflow while real antimalware/public file release remain deferred.
