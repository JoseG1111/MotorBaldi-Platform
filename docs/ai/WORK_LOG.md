# Checkpoint transitions

One concise entry per newly verified checkpoint or major architectural state transition. Historical checkpoint evidence stays in `EXECUTION_PLAN.md` to avoid duplicating a diary.

- 2026-10-08 — Execution continuity established; older CF-0 Development statements reconciled. The auth-cookie fix passed the local gate, Cloudflare OAuth succeeded, the Development API was deployed, and read-only D1 checks confirmed an eligible superadmin. MB-CF-014 awaits the existing account holder's fresh Portal/Admin browser sign-in; no checkpoint was newly verified.
- 2026-10-08 — MB-CF-014 VERIFIED: operator confirmed Admin dashboard access after the UI fix; remote D1 showed a new assured superadmin session after deployment, and the API/Admin deployments and local gate passed. MB-CF-015 started.
- 2026-10-08 — MB-CF-015 VERIFIED: authenticated Development Portal/Admin, organization owner/membership/idempotency, CRM reads, D1 outbox/Queue, private R2, rate limit and security negative probes passed; current-revision GitHub CI and local gate passed. A short observability tail was inconclusive and is recorded as such. MB-P2-001 started.
- 2026-10-08 — MB-P2-001 VERIFIED: central ownership-neutral vehicle schema and invariant tests passed the gate; the additive Development D1 migration applied with no pending migrations. MB-P2-002 started.
- 2026-10-08 — MB-P2-002 VERIFIED: historical identifier, claim, relationship, grant, and garage schema plus default-deny access primitive passed tests/gate; the additive Development D1 migration applied without affecting Phase 1 data. MB-P2-003 started.
- 2026-10-08 — MB-P2-003 VERIFIED: append-only odometer/correction and final-record/amendment schema passed tests/gate; the additive Development D1 migration applied without affecting Phase 1 data. MB-P2-004 started.

- 2026-10-09 — Operator delegated implementation choices; adopted the bounded staff-reviewed Vehicle issuance/claim policy, preserving explicit grants, verified organization context and MFA. Prior policy blocker resolved; MB-P2-004 remains IN PROGRESS pending verification.

- 2026-10-09 — MB-P2-004 VERIFIED: staff-reviewed Vehicle commands and Portal/Admin workflows pass the gate (25 unit/80 Worker tests); migration 0007 and all four Development deployments completed. New commands atomically persist changes/audit/outbox/replay; generic financial idempotency debt remains. GitHub CI run 37963005598 passed for `d910e2d`. MB-P2-005 remote authentication requires a fresh operator password/TOTP session; anonymous remote checks pass.

- 2026-10-09 — MB-P2-005 VERIFIED: authenticated remote Vehicle lifecycle, negative access, replay/CAS and immutable professional history passed; 34 Vehicle audit/replay/event receipts match and all 41 outbox events are PROCESSED with no unresolved dead letters. Live API structured health log observed; Phase 1 counts/environment isolation preserved. CI 37966439869 passed.

- 2026-10-09 — MB-P3-001 VERIFIED: explicitly delegated bounded Workshop operational contract and six-state transition policy documented; 27 unit tests, typecheck and workspace boundaries pass. Assignment, final-record completion, MFA closure and terminal immutability are tested.

- 2026-10-09 — MB-P3-002 VERIFIED: immutable-scoped Workshop order/history schema and exact grant plus organization/location authorization pass the gate (27 unit/86 Worker tests); migration 0008 applied in Development with prior counts/identity preserved. Professional record reads/writes/amendments also enforce the grant resource location.

- 2026-10-09 — MB-P3-003 VERIFIED: atomic scoped Workshop commands, Portal operations, Admin reads and OpenAPI pass the gate (29 unit/88 Worker tests). All four Development apps deployed and authenticated remote operational progression/replay/CAS/assignment/scope/immutable closure smoke passed. File integration and full Phase 3 remote closeout remain separate.

- 2026-10-09 — MB-P3-004 VERIFIED: private ACTIVE-only immutable Workshop attachments/download and atomic retry/audit/outbox integration pass 29 unit/89 Worker tests and CI 37970578056. Migration 0009 and Development API/Worker/Portal deployed; remote quarantine rejection and 13 matching receipts verified. MB-P3-005 requires a real private antimalware provider before positive remote file verification.

- 2026-10-09 — Owner explicitly deferred MB-P3-005 real antimalware/remaining positive remote file closeout at a $0 additional-service budget. Status is DEFERRED — OWNER APPROVED, never VERIFIED. ADR 0024 preserves private quarantine/authorization and the pre-public-upload/download revisit requirement. MB-P4-001 now depends on verified MB-P2-005/MB-P3-004 so unrelated report-domain work can proceed.

- 2026-10-09 — MB-P4-001 VERIFIED: generic versioned Inspection findings/amendment contract reuses canonical professional records, validates evidence references and immutable bounded snapshots; gate passes 32 unit/89 Worker tests. Checklist/legal verdict remain unknown, real scanner stays owner-deferred.

- 2026-10-09 — MB-P4-002 VERIFIED: immutable owned ACTIVE-only Inspection media association and scoped snapshot/download metadata pass 32 unit/93 Worker tests, including quarantine/ownership/CAS/file-state/finalization/location/capability/revocation negatives. Migration 0010 applied in Development. Real scanner/positive remote file closeout remain owner-deferred.

- 2026-10-09 — MB-P4-003 VERIFIED: scoped Inspection execution/schema/evidence enforcement protects generic record commands/replays; author-only MFA finalization/amendments and atomic attachment coordinator pass 32 unit/95 Worker tests. Migration 0011 applied in Development; real scan remains deferred.

- 2026-10-09 — Owner-approved real parallel execution configured in `.codex/config.toml` (gpt-6.1-sol/low; initially two, then owner lifted the fixed two-agent policy and configured capacity became six, subject to actual runtime slots). Actual thread metadata confirmed both agents low and main medium; no restart needed for explicit spawns. Agents implemented Markdown state validation and Inspection amendment UI correctness with exclusive ownership; main integrates/gates/deploys.

- 2026-10-09 — MB-P4-004 VERIFIED: scoped Inspection APIs/Portal/Admin, latest amendment snapshots and immutable original presentation pass 37 unit/96 Worker tests and full gate. All Development applications deployed; authenticated no-file report/quarantine smoke passed. Real scan/remote ACTIVE-file delivery remain owner-deferred.

- 2026-10-09 — MB-P4-005 VERIFIED for independent no-file Inspection report/quarantine scope: final authenticated remote smoke and CI 37983831325 passed; 68 matching Vehicle-path receipts/events and all 88 outbox events processed, zero unresolved dead letters. Real scanner/ACTIVE remote media/public file release remain owner-deferred. MB-P5-000 now active.
