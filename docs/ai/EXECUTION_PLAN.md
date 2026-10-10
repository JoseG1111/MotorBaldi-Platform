# MotorBaldi autonomous execution plan

This file is the checkpoint registry. `CURRENT_CHECKPOINT.md` is the recovery cursor; `WORK_LOG.md` records transitions. Detailed technical truth lives in the linked [architecture](../architecture/MOTORBALDI_MASTER.md), [Phase 1 design](../architecture/phase-1-identity-crm-organizations.md), [ADRs](../adr/), [Cloudflare runbooks](../cloudflare/), code, migrations, and tests. Repository and live environment reality override stale entries. Never infer a remote success solely from committed configuration.

## Recovery loop

1. Read applicable `AGENTS.md`, then `CURRENT_CHECKPOINT.md`; load only relevant sections of `PROJECT_STATE.md`, `ARCHITECTURE_DECISIONS.md`, and this plan.
2. Inspect code, tests, git state, and any safely accessible target environment. Reconcile discrepancies before work. Record the evidence source and its limit; historical operator evidence may be retained when corroborated and uncontradicted, but do not invent live verification.
3. Find the earliest checkpoint whose dependencies are `VERIFIED`. `VERIFIED` means its stated completion evidence exists. If a dependency has lost evidence or reality contradicts it, correct its status and move the cursor there. Only one checkpoint may be `IN PROGRESS`; `READY`/`IMPLEMENTED — NOT VERIFIED` likewise occupy the sole engineering cursor. Multiple documented external/human boundaries may be parked without representing concurrent engineering.
4. Mark the eligible checkpoint `IN PROGRESS` in this file and update `CURRENT_CHECKPOINT.md` before substantive work. Implement, run its verification, diagnose failures, fix safely, and rerun. Persist the cursor after meaningful recovery boundaries: diagnosis, implementation, failed gate, deployment, or newly found blocker.
5. If implementation exists but verification is incomplete, use `IMPLEMENTED — NOT VERIFIED`. On success, mark `VERIFIED` with concise evidence and add one `WORK_LOG.md` entry. Advance the cursor and continue automatically to the next eligible checkpoint. Phase 2 requires MB-CF-015 `VERIFIED`.
6. Reconcile parked `BLOCKED`/`HUMAN ACTION REQUIRED` entries on every resume; when their stated condition clears, restore the earliest to `READY`. A parked boundary never satisfies a dependency. Continue independent checkpoints with verified prerequisites, keeping exactly one engineering cursor; stop only when no eligible engineering work remains. Mark `HUMAN ACTION REQUIRED` when a specific human action is necessary; `BLOCKED` is for a technical/external impediment with an identified retry condition. Resume automatically when it clears. Use `SKIPPED — WITH REASON` only for an explicit, justified non-applicable checkpoint and adjust dependents deliberately.

Allowed statuses, exactly: `NOT STARTED`, `READY`, `IN PROGRESS`, `IMPLEMENTED — NOT VERIFIED`, `VERIFIED`, `BLOCKED`, `HUMAN ACTION REQUIRED`, `SKIPPED — WITH REASON`, `DEFERRED — OWNER APPROVED`. `READY` means dependencies are verified and no work has begun. Do not use `VERIFIED` to mean “coded” or “reported complete.”

## Autonomy and stop rule

Proceed without asking for repository inspection, routine choices settled by code/ADRs/tests, ordinary refactoring, tests, current-work lint/type fixes, correcting mistakes, non-destructive Development D1 operations, deployments to already-existing Development Workers/resources when verification needs them, Development smoke tests, and advancement to approved checkpoints. Select named remote Wrangler environments explicitly. Never weaken security or reveal/commit secrets. Do not ask anyone to paste secret values into files or these docs.

Stop for an actual secret/credential that must be supplied or an interactive account login, a new provider requiring manual interaction, unsafe account-level Cloudflare provisioning, DNS/nameserver work, spending money, production deployment, possible production data destruction, a materially destructive migration, an unresolved business choice, two legitimate architecture choices unresolved by ADRs, material repository conflict with an accepted decision, a step requiring weaker security, or genuinely absent necessary information. Prepare all safe work first and state the exact action needed. The initiating user authorized use of existing keys and Development resources; that does not authorize production deployment, destructive changes, DNS, spending, or writing secrets to the repository.

An explicit owner deferral is recorded as `DEFERRED — OWNER APPROVED`, never as verified or skipped. Keep its outstanding verification and release restriction visible. Unrelated work may proceed only after its dependency is deliberately changed to verified prerequisites; deferred work does not satisfy a verified dependency. The 2026-10-09 owner decision defers MB-P3-005 real antimalware/positive remote file closeout at a $0 additional-service budget. Do not integrate ClamAV, Cloudflare Containers or paid antivirus now. Trusted synthetic Development uploads may exercise validation, authorization and private quarantine; no manual ACTIVE promotion or remote test scanner. Real scanning must be revisited before public file upload/download enablement.

Checkpoint constraints below add to these global rules. If a future checkpoint needs a narrowly scoped technical prerequisite, add it with reason and dependencies; never silently change product scope or reverse architecture.

## Approved parallel execution

The owner authorized real concurrent gpt-6.1-sol/low subagents on 2026-10-09 and subsequently removed the fixed two-agent policy; `.codex/config.toml` records these defaults without changing the main gpt-6.1-sol/medium session. When safe, spawn as many bounded independent tasks as useful within available runtime capacity (this session exposes seven total slots including main; project config allows up to six spawned threads) with the current owner limit of four concurrent implementation subagents, explicit model/effort overrides, exclusive file ownership or worktrees and focused acceptance tests. Main owns architectural/shared changes, state registry/cursor, Git integration, comprehensive validation and remote deployments. Never concurrently mutate schemas/migrations/auth/shared contracts/deployment configuration. Later-phase work is eligible only when its prerequisites are VERIFIED; otherwise parallelize independent subtasks of the eligible checkpoint. Verify actual runtime effort before claiming LOW is active. See the [parallel runbook](../runbooks/codex-parallel-development.md).

## Historical provenance

The initiating operator supplied a completed-checkpoint history. Repository code, migrations, Wrangler bindings, tests, git history, and direct anonymous Development checks on 2026-10-08 corroborate substantial parts. `VERIFIED` entries below preserve that historical operator attestation with its stated provenance; where remote D1, Queue, secret, or deployment details could not be independently queried in this unauthenticated workspace, the evidence explicitly says so. On contradictory live evidence, immediately downgrade the affected status and dependents. These entries are not claims of a fresh comprehensive remote audit.

## Foundation and Development

### MB-FND-000 — Cloudflare-native Foundation

- **Status:** VERIFIED
- **Dependencies:** None
- **Objective:** Establish the modular Cloudflare platform.
- **Scope / required work:** Workspace, Workers, D1/R2/Queue/DO adapters, contracts, tests, CI.
- **Relevant files/systems:** `apps/`, `packages/`, `migrations/0001_foundation.sql`, `docs/adr/`, `.github/workflows/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Local gate and dry-run bundles.
- **Completion criteria:** Foundation code and guardrails pass.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Repository foundation migration, four app entries, ADRs, and tests; historical operator completion.

### MB-P1-001 — Identity + Native CRM + Organizations

- **Status:** VERIFIED
- **Dependencies:** MB-FND-000
- **Objective:** Deliver Phase 1 business domains.
- **Scope / required work:** Better Auth, person/account reconciliation, memberships, roles, organizations, CRM.
- **Relevant files/systems:** `migrations/0002_phase1.sql`, `packages/{auth,identity,authz,organizations,crm}/`, Phase 1 design
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Phase 1 domain and Worker tests, local gate.
- **Completion criteria:** Identity and business flows pass.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Phase 1 schema/code/tests present; historical operator completion.

### MB-P1-002 — Phase 1 hardening + atomic closeout

- **Status:** VERIFIED
- **Dependencies:** MB-P1-001
- **Objective:** Close Phase 1 security and state transitions.
- **Scope / required work:** Atomic lead/outbox/replay, security fixes, closeout triggers/tests.
- **Relevant files/systems:** `migrations/0003_phase1_closeout.sql`, `packages/db/`, `tests/workers/phase1-*`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Atomic closeout and security tests; gate.
- **Completion criteria:** Hardening passes without weakening controls.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Closeout migration and targeted/atomic tests present; historical operator completion.

### MB-CF-001 — Wrangler/account Development readiness

- **Status:** VERIFIED
- **Dependencies:** MB-P1-002
- **Objective:** Existing account and Wrangler can target Development safely.
- **Scope / required work:** Confirm auth/account, named env and explicit target.
- **Relevant files/systems:** `apps/*/wrangler.jsonc`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Wrangler whoami and target review.
- **Completion criteria:** Correct Development account and target confirmed.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Named Development config exists; Cloudflare OAuth login succeeded on 2026-10-08 and an explicit `--env development` API deployment succeeded.

### MB-CF-002 — Development D1

- **Status:** VERIFIED
- **Dependencies:** MB-CF-001
- **Objective:** Canonical Development database exists.
- **Scope / required work:** Provisioned D1 binding and identity.
- **Relevant files/systems:** `apps/api/wrangler.jsonc`, `migrations/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote D1 read and environment identity.
- **Completion criteria:** D1 reachable with Development identity.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Committed Development D1 binding, live dependency response D1 available, and read-only remote query returned environment `development`.

### MB-CF-003 — Private Development R2

- **Status:** VERIFIED
- **Dependencies:** MB-CF-002
- **Objective:** Private object storage is bound.
- **Scope / required work:** Confirm bucket binding and private access.
- **Relevant files/systems:** `apps/{api,worker}/wrangler.jsonc`, `packages/storage/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Dependency probe and private-object negative test.
- **Completion criteria:** R2 configured and no public object exposure.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Committed private bucket bindings plus live dependency response R2 configured; privacy not freshly re-tested.

### MB-CF-004 — Events Queue + DLQ

- **Status:** VERIFIED
- **Dependencies:** MB-CF-003
- **Objective:** Asynchronous transport is ready.
- **Scope / required work:** Producer, consumer, DLQ bindings.
- **Relevant files/systems:** `apps/{api,worker}/wrangler.jsonc`, `packages/messaging/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Publish/consume and DLQ behavior.
- **Completion criteria:** Queue processing and DLQ verified.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Bindings, consumer code, tests, and operator completion report; live Queue state not independently queried.

### MB-CF-005 — Development environment configuration

- **Status:** VERIFIED
- **Dependencies:** MB-CF-004
- **Objective:** Named Development configuration is correct.
- **Scope / required work:** Exact origins, service bindings, flags, secrets by name.
- **Relevant files/systems:** `apps/*/wrangler.jsonc`, `packages/config/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Config validation and deployed environment behavior.
- **Completion criteria:** Development isolated from local/staging/production.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Committed named bindings and live Development endpoints; secret values never inspected.

### MB-CF-006 — Remote migrations + environment identity

- **Status:** VERIFIED
- **Dependencies:** MB-CF-005
- **Objective:** Remote D1 schema and identity are current.
- **Scope / required work:** Apply three migrations, initialize singleton.
- **Relevant files/systems:** `migrations/`, `scripts/foundation/d1-init.mjs`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote migration list and identity query.
- **Completion criteria:** Current schema and Development identity.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Live API dependency reports D1 available; remote migration list reported no pending migrations and D1 environment identity query returned `development`.

### MB-CF-007 — API Development deployment

- **Status:** VERIFIED
- **Dependencies:** MB-CF-006
- **Objective:** API Worker serves Development.
- **Scope / required work:** Deploy API and bind D1/R2/Queue/DO.
- **Relevant files/systems:** `apps/api/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Live health and deployment version.
- **Completion criteria:** API reachable with expected bindings.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** 2026-10-08 API `/health` HTTP 200; bindings committed.

### MB-CF-008 — API runtime/security validation

- **Status:** VERIFIED
- **Dependencies:** MB-CF-007
- **Objective:** API rejects unsafe requests and exposes expected routes.
- **Scope / required work:** Validate environment, auth, origins, rate limits, secret handling.
- **Relevant files/systems:** `apps/api/`, `packages/auth/`, `tests/workers/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Security tests and Development negative probes.
- **Completion criteria:** Default deny and security controls intact.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Security tests/code and operator completion report; full remote negative probes not repeated.

### MB-CF-009 — Background Worker

- **Status:** VERIFIED
- **Dependencies:** MB-CF-008
- **Objective:** Worker handles schedule and Queue.
- **Scope / required work:** Deploy consumer/scheduler and outbox relay.
- **Relevant files/systems:** `apps/worker/`, `packages/messaging/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote event processing and scheduled run.
- **Completion criteria:** Worker active and idempotent.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Committed Worker bindings/code/tests and operator completion report; live consumer not queried.

### MB-CF-010 — Portal + Admin

- **Status:** VERIFIED
- **Dependencies:** MB-CF-009
- **Objective:** Both UIs serve Development.
- **Scope / required work:** Deploy UI Workers with same-origin API binding.
- **Relevant files/systems:** `apps/{portal,admin}/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Live page and auth proxy checks.
- **Completion criteria:** Both pages and proxies reachable.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** 2026-10-08 both pages HTTP 200 and anonymous auth proxy HTTP 200 `null`.

### MB-CF-011 — Full infrastructure smoke

- **Status:** VERIFIED
- **Dependencies:** MB-CF-010
- **Objective:** Cross-resource Development smoke passes.
- **Scope / required work:** API, D1, R2, Queue, UI bindings.
- **Relevant files/systems:** `apps/`, `packages/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke across resources.
- **Completion criteria:** Expected dependency behavior observed.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Operator completion report; live API D1/R2 probe and UI reachability partially corroborate.

### MB-CF-012 — Observability

- **Status:** VERIFIED
- **Dependencies:** MB-CF-011
- **Objective:** Development logs/traces/issues enabled safely.
- **Scope / required work:** Enable structured telemetry without PII/secrets.
- **Relevant files/systems:** `apps/*/wrangler.jsonc`, `packages/observability/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Inspect configuration and safe test events.
- **Completion criteria:** Telemetry active and redacted.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Development observability config committed in 38693d4/468327c; operator completion report; remote trace delivery not freshly queried.

### MB-CF-013 — Turnstile + public lead protection

- **Status:** VERIFIED
- **Dependencies:** MB-CF-012
- **Objective:** Anonymous lead intake is protected and durable.
- **Scope / required work:** Separate Development widget/secret, rate limit, atomic lead/outbox/replay.
- **Relevant files/systems:** `apps/portal/src/turnstile-test.ts`, `apps/api/`, `packages/crm/`, `packages/auth/src/anti-abuse.ts`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Portal Turnstile flow, HTTP 202, D1 lead/outbox/replay query.
- **Completion criteria:** One lead, one event, one completed replay for tested key.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Operator reported Portal HTTP 202 and one lead/event/completed replay; code/config/test corroborate. D1 rows not freshly queried.

### MB-CF-014 — First Development administrator + MFA + Admin access

- **Status:** VERIFIED
- **Dependencies:** MB-CF-013
- **Objective:** Establish one verified Development superadmin session and Admin access.
- **Scope / required work:** Reproduce password → TOTP → cookie/session transition; fix cause; verify account/person reconciliation and staff bootstrap from D1; validate post-enrollment session assurance and Admin dashboard.
- **Relevant files/systems:** `apps/{api,portal,admin}/src/`, `packages/{auth,identity,authz}/`, `scripts/phase1/bootstrap-staff.mjs`, D1 auth/IAM/role tables
- **Constraints:** Never disable MFA, create a bypass account, weaken assurance, or print auth secrets.
- **Verification:** Existing-account browser/network sequence, safe D1 role/session queries, Admin access, `pnpm gate`, Development deploy smoke.
- **Completion criteria:** Password and TOTP succeed; fresh session exists; principal linked; PLATFORM_SUPERADMIN verified; MFA assurance true; Admin authorization/dashboard pass; gate and Development deploy verified.
- **Human-action conditions:** Existing account browser authentication is required for final MFA/Admin smoke; Cloudflare OAuth and API deployment are complete. Never ask for secret values in docs.
- **Evidence:** Operator confirmed the Development Admin dashboard opens after the Admin UI fix. Remote D1 on 2026-10-08 found a new 16:49 UTC post-enrollment session joined to one verified-MFA, active person/account with `platform-superadmin`. API and Admin Development deployments succeeded; `pnpm gate` passed 22 unit and 64 Worker tests.

### MB-CF-015 — Full remote Phase 1 validation

- **Status:** VERIFIED
- **Dependencies:** MB-CF-014
- **Objective:** Prove all Phase 1 behavior in Development.
- **Scope / required work:** Exercise authentication, reconciliation, MFA, roles, organizations/memberships, CRM, Turnstile/public lead, idempotency, audit/security events, outbox/Queue, R2 privacy, CORS/origin, rate limits, isolation, Portal/Admin/API/Worker, observability and CI/gate.
- **Relevant files/systems:** `apps/`, `packages/`, D1, R2, Queues, `docs/cloudflare/`, `.github/workflows/`
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote positive/negative matrix plus `pnpm gate` and CI status.
- **Completion criteria:** All applicable remote cases pass with recorded evidence; Phase 2 gate opens.
- **Human-action conditions:** Only real external account access or unresolved product decision after safe checks.
- **Evidence:** On 2026-10-08, existing MFA-assured Portal/Admin sessions returned 200 for principal, workspaces, evidence list and Admin access; the operator opened the Admin dashboard. A Development validation workshop was created with owner membership/permissions and idempotent replay, then its creation flag was restored off. Admin CRM reads returned 200. D1 showed completed lead/organization replays, append-only audit/security records and all five outbox events `PROCESSED`, including `organization.created.v1`; Queue/DLQ and private R2 configurations were checked. CORS/origin, remote signup, anonymous access and Turnstile negative probes passed; a bounded live auth limiter probe returned 429. D1 reported `development` and no pending migrations; API/Portal/Admin/Worker Development deployments exist. `pnpm gate` passed 22 unit/65 Worker tests and GitHub [Platform CI run 37815258715](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37815258715) passed at `f0ba378`. Development observability bindings/logging were inspected; a short log tail did not capture a request, so direct delivery remains unproved by that probe.

## Phase 2 — Vehicle Core

### MB-P2-001 — Vehicle domain invariants + schema

- **Status:** VERIFIED
- **Dependencies:** MB-CF-015
- **Objective:** Define central vehicle, generic kind/spec, ownership-neutral model and constraints.
- **Scope / required work:** Define central vehicle, generic kind/spec, ownership-neutral model and constraints.
- **Relevant files/systems:** `packages/` vehicle domain, new D1 migration, architecture docs
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Migration and invariant tests
- **Completion criteria:** Schema enforces accepted vehicle invariants.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** Migration `0004_vehicle_core.sql` defines an ownership-neutral central vehicle row, generic kind/specification, UUIDv7 shape and one-step version checks. Three Worker invariant tests passed; the full gate passed 22 unit/68 Worker tests. The additive migration was applied to Development D1 on 2026-10-08 with explicit environment selection; remote schema/trigger inspection succeeded, vehicle count was zero, environment identity remained `development`, and no migrations remain pending.

### MB-P2-002 — Identifiers, relationships, claims and garage access

- **Status:** VERIFIED
- **Dependencies:** MB-P2-001
- **Objective:** Add historical identifiers, explicit owner/driver/workshop ties, claims and grants; garage differs from ownership; no private plate lookup.
- **Scope / required work:** Add historical identifiers, explicit owner/driver/workshop ties, claims and grants; garage differs from ownership; no private plate lookup.
- **Relevant files/systems:** Vehicle package, authz, migration
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Authorization and claim tests
- **Completion criteria:** Access is explicit and default deny.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** `0005_vehicle_access.sql` separates historical identifiers, relationship claims, explicit relationships, grants, and garage entries. Read-only `@motorbaldi/vehicles` authorization defaults to deny; tests show an identifier, claim, ownership relationship, or garage entry alone does not authorize a read. Direct grants require an active linked account/person; organization grants require active membership and matching location scope. History/revocation triggers prevent rewrite or deletion. `pnpm gate` passed 22 unit/72 Worker tests. The additive Development D1 migration applied on 2026-10-08; six Vehicle tables exist, prior Phase 1 row counts and environment identity remained intact, and no migrations are pending. Claim adjudication and grant issuance APIs remain for MB-P2-004; no private identifier lookup was exposed.

### MB-P2-003 — Odometer/history + immutable professional records

- **Status:** VERIFIED
- **Dependencies:** MB-P2-002
- **Objective:** Append odometer history; finalize records immutably with amendments.
- **Scope / required work:** Append odometer history; finalize records immutably with amendments.
- **Relevant files/systems:** Vehicle/professional packages, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** History and amendment tests
- **Completion criteria:** Corrections preserve final record history.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** `0006_vehicle_history.sql` adds append-only odometer readings with same-vehicle correction links, draft-to-final professional records that cannot be edited or deleted after finalization, and append-only amendments requiring a final original. Two focused Worker tests passed and `pnpm gate` passed 22 unit/74 Worker tests. The additive Development migration applied on 2026-10-08; remote D1 has all three tables, prior Phase 1 counts and `development` identity remain intact, and no migrations are pending. Detailed record fields and workflow remain for MB-P2-004 and later phases.

### MB-P2-004 — Vehicle APIs + authorization + Portal/Admin workflows

- **Status:** VERIFIED
- **Dependencies:** MB-P2-003
- **Objective:** Expose authorized vehicle operations in API and Spanish-first UIs.
- **Scope / required work:** Expose authorized vehicle operations in API and Spanish-first UIs.
- **Relevant files/systems:** `apps/{api,portal,admin}/`, contracts
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** API and UI route tests
- **Completion criteria:** Flows enforce roles, context, and accessibility.
- **Human-action conditions:** Global stop rule; otherwise none.
- **Evidence:** On 2026-10-09 the delegated staff-reviewed policy was documented and implemented in 16 Vehicle commands, with exact grants, verified organization/location professional authorization, MFA on privileged review/finalization, immutable histories and optimistic versions. New commands batch business changes, audit, outbox and replay; current authority is rechecked before replay. Portal/Admin workflows and OpenAPI are implemented. `pnpm gate` passed 25 unit/80 Worker tests, including real password/TOTP command integration, replay/body conflicts, stale-CAS rollback, revoked replay denial, odometer corrections and immutable professional finalization/amendments. Additive migration `0007_vehicle_commands.sql` applied to Development; no migrations remain. API version `a50d8a6b-8cdf-4aba-9f09-61895fafa830`, Worker `ceb992ee-9ed5-4810-9599-6982fdde509a`, Portal `3a8c9c7f-ed68-45ec-bbd7-589e5ffd7ca9` and Admin `bd008e85-a2f8-4920-b666-b7f54a79afb3` deployed. GitHub [Platform CI run 37963005598](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37963005598) passed for implementation commit `d910e2d`. Remote end-to-end command validation is separately required by MB-P2-005.

### MB-P2-005 — Vehicle Core remote Development validation

- **Status:** VERIFIED
- **Dependencies:** MB-P2-004
- **Objective:** Verify Vehicle Core across Development services.
- **Scope / required work:** Run `scripts/vehicles/development-smoke.mjs` with an existing MFA-assured Development session, inspect audit/outbox/Queue processing and preserved environment isolation. Anonymous remote protection and Vehicle UI asset checks already pass.
- **Relevant files/systems:** API, Portal, Admin, D1, observability
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke, negative auth, gate
- **Completion criteria:** Vehicle Core remotely verified.
- **Human-action conditions:** Sign in to Development Admin with the existing account and TOTP when no usable assured browser session is available. The available saved session expired on 2026-10-09 and authenticated `/me` returned 401; never mint a session or bypass MFA to unblock verification.

- **Evidence:** On 2026-10-09 authenticated Development smoke passed creation/replay/body conflicts, exact grants, garage, claim review, identifier retirement, stale-version rejection, odometer corrections, finalization/amendment immutability and revocation. D1 has 34 completed Vehicle replays, 34 command audit receipts and 34 matching Vehicle events with no mismatched receipts; all 41 total outbox events are PROCESSED with zero unresolved dead letters. One account and three Phase 1 leads remain, the synthetic professional record is FINAL at version 3 with one amendment, Development environment identity matches and migrations are current. Live API tail captured a structured dependency-health HTTP 200 event. GitHub CI run [37966439869](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37966439869) passed for `7b0565c`; the runner correction preserves the established organization-submit HTTP 202 contract. Existing code gate passed 25 unit/80 Worker tests. Synthetic history is retained, and no secrets were recorded.

## Phase 3 — Workshop Operations

### MB-P3-001 — Workshop workflow/state-machine contract

- **Status:** VERIFIED
- **Dependencies:** MB-P2-005
- **Objective:** Derive exact workflow states, transitions, roles, and invariants from repository; unknown rules require decision.
- **Scope / required work:** Derive exact workflow states, transitions, roles, and invariants from repository; unknown rules require decision.
- **Relevant files/systems:** Architecture/contracts docs, workshop package
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Contract review and transition tests
- **Completion criteria:** No undocumented business transitions; bounded initial operational choices are explicitly attributed to operator delegation.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** The explicitly delegated initial operational contract is documented in `phase-3-workshop-operations.md`; `@motorbaldi/workshops` defines six states and bounded transitions. Two focused contract tests cover allowed progress, terminal immutability, assignment, final-record completion and MFA closure. 27 unit tests, typecheck and workspace boundary checks passed on 2026-10-09. Financial/legal/service policy details are not invented by this operational model.

### MB-P3-002 — Persistence + authorization

- **Status:** VERIFIED
- **Dependencies:** MB-P3-001
- **Objective:** Persist workshop operations with location and membership context.
- **Scope / required work:** Persist workshop operations with location and membership context.
- **Relevant files/systems:** D1 migration, workshop/authz packages
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Migration and default-deny tests
- **Completion criteria:** State and permissions enforced.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Migration `0008_workshop_operations.sql` adds immutable-scoped orders, enforced state/version/final-record invariants and append-only operational history. Five Worker tests cover exact grants, organization/location isolation (including all-location membership with a location-limited grant), illegal transitions, terminal immutability and final-record completion. Professional record/amendment access now also honors the resource organization/location, with an additional API regression test. `pnpm gate` passed 27 unit/86 Worker tests. The additive Development migration applied on 2026-10-09; both tables exist, order count is zero, one account/three leads and Development identity remain intact.

### MB-P3-003 — APIs + Portal/Admin workflows

- **Status:** VERIFIED
- **Dependencies:** MB-P3-002
- **Objective:** Expose authorized workshop flows.
- **Scope / required work:** Expose authorized workshop flows.
- **Relevant files/systems:** API, Portal, Admin, contracts
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** API/UI tests
- **Completion criteria:** Approved workflows work end to end.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Create/update/transition commands commit order/history/audit/outbox/replay atomically and recheck current scoped authority before replay. API, Spanish Portal operations, staff Admin reads and OpenAPI pass 29 unit/88 Worker tests, including full password/TOTP operational progression, replay conflicts, stale-CAS rollback, assignment/scope negatives, immutable completion and MFA UI closure. Additive migration 0008 is applied. Development API `9134c18a-b134-43c5-b3b8-96fae1715868`, Worker `61677149-9037-454e-8b81-5c190ad81409`, Portal `dbf7414c-5518-44fa-a536-d671cabc17a0`, Admin `c1be7145-2e9c-4b55-b4d5-30bd56e0e831` deployed. Authenticated Workshop core smoke passed on 2026-10-09, including organization/location-specific grants, CORS rejection, terminal immutability and revoked replay denial. Synthetic organization/location/order history is retained; file integration and full remote closeout remain MB-P3-004/005.

### MB-P3-004 — Async/files/audit integration

- **Status:** VERIFIED
- **Dependencies:** MB-P3-003
- **Objective:** Connect outbox, Queue, private R2, and append-only audit.
- **Scope / required work:** Connect outbox, Queue, private R2, and append-only audit.
- **Relevant files/systems:** Workshop, messaging, storage, audit
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Retry/idempotency and file security tests; authenticated remote quarantine rejection and D1 receipt inspection. Real positive remote scanning remains MB-P3-005.
- **Completion criteria:** Events and files remain private and traceable.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** On 2026-10-09, `pnpm gate` passed 29 unit/89 Worker tests and GitHub CI [37970578056](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37970578056) passed for `17e2d80`. Migration 0009 and Development API/Worker/Portal file integration deployed. Local tests verify owned ACTIVE attachment, atomic replay/CAS rollback, append-only association and scoped private download/revocation; the deterministic scanner is local-only. Authenticated Development smoke verifies upload 202, private QUARANTINED status, attachment 409, download 404 and unchanged order version. D1 has 13 matching Workshop command replays, command receipts, operation audits, history rows and outbox events; all 70 total outbox events PROCESSED (13 Workshop), zero missing receipts or unresolved dead letters. No positive real remote scan is claimed.

### MB-P3-005 — Remote validation

- **Status:** DEFERRED — OWNER APPROVED
- **Dependencies:** MB-P3-004
- **Objective:** Validate workshop operations in Development.
- **Scope / required work:** Owner deferred real antimalware scanning and the remaining positive remote file closeout on 2026-10-09. Core operational and negative quarantine smoke already passed. Retain real CLEAN promotion/attachment/download and rejection/unavailability plus full closeout as outstanding verification to revisit before public file upload/download enablement.
- **Relevant files/systems:** All Development apps/resources
- **Constraints:** $0 additional security-service budget; no ClamAV, Cloudflare Containers or paid antivirus. Preserve private R2, validation, authorization and quarantine. Trusted synthetic Development files may exercise existing quarantine paths; no fake scan or manual ACTIVE promotion. See ADR 0024.
- **Verification:** Remote smoke, negative tests, gate
- **Completion criteria:** Workflow remotely verified.
- **Human-action conditions:** Revisit with owner before public file upload/download enablement; future provider/protocol/secret provision and any spend remain human boundaries. This owner deferral does not block independent checkpoints.

## Phase 4 — Inspections / Peritaje

### MB-P4-001 — Inspection domain + immutable report contract

- **Status:** VERIFIED
- **Dependencies:** MB-P2-005, MB-P3-004 (independent report domain; MB-P3-005 scanner closeout explicitly deferred by owner)
- **Objective:** Define inspection/peritaje findings and immutable final report with amendments.
- **Scope / required work:** Define inspection/peritaje findings and immutable final report with amendments.
- **Relevant files/systems:** Inspection package, contracts, migration
- **Constraints:** Reuse canonical Vehicle professional records/amendments; preserve owner scanner deferral. Do not invent legal certification, inspection checklist or verdict requirements.
- **Verification:** Domain and immutability tests
- **Completion criteria:** Report contract preserves evidence and corrections.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Repository has no established detailed checklist/legal verdict. The bounded generic contract in `packages/inspections` reuses canonical INSPECTION professional records/amendments, strictly validates versioned findings/content, rejects duplicate/unauthorized evidence references and serializes immutable snapshots at 64 KiB. `pnpm gate` passed 32 unit/89 Worker tests, including immutable input/snapshot, unauthorized evidence, duplicate/unknown fields, size and amendment reason tests; existing D1 FINAL/amendment trigger tests remain green. No API workflow, remote scan or legal certification is claimed by this contract.

### MB-P4-002 — Evidence/media lifecycle

- **Status:** VERIFIED
- **Dependencies:** MB-P4-001
- **Objective:** Bind inspection evidence to existing private R2 metadata/quarantine/ACTIVE lifecycle; implement immutable associations and scoped authorization without integrating the owner-deferred scanner.
- **Scope / required work:** Bind inspection evidence to existing private R2 metadata/quarantine/ACTIVE lifecycle; implement immutable associations and scoped authorization without integrating the owner-deferred scanner.
- **Relevant files/systems:** Storage, inspection, D1
- **Constraints:** ADR 0024 owner deferral applies. Private R2, ACTIVE-only association/download, no new scanner or remote test mode; real scanning remains a prerequisite to public file enablement.
- **Verification:** Association/ownership/authorization/immutability tests, unavailable/quarantined rejection and existing local file-lifecycle tests. No real remote scan or manual promotion.
- **Completion criteria:** Only authorized clean media is served.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Migration 0010 adds immutable owned ACTIVE-only associations to canonical DRAFT INSPECTION records. Scoped private metadata/download helpers and snapshot resolution enforce type, author, verified INSPECTION capability/location and exact vehicle grants. Gate passed 32 unit/93 Worker tests: quarantine/unassociated rejection, stale CAS/file-state rollback, other-uploader rejection, immutable/final media, location grant/capability/revocation denial. Migration 0010 applied in Development. ACTIVE metadata fixtures are isolated local D1 state tests, not scanner results or remote promotion. No positive real remote scan is claimed.

### MB-P4-003 — Workflow + authorization

- **Status:** VERIFIED
- **Dependencies:** MB-P4-002
- **Objective:** Enforce canonical DRAFT/FINAL authorship, exact organization/location/vehicle grants, INSPECTION capability and privileged finalization/amendments; no mandatory second reviewer or legal verdict is inferred.
- **Scope / required work:** Enforce canonical DRAFT/FINAL authorship, exact organization/location/vehicle grants, INSPECTION capability and privileged finalization/amendments; no mandatory second reviewer or legal verdict is inferred.
- **Relevant files/systems:** Inspection/authz packages
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Transition and default-deny tests
- **Completion criteria:** Only permitted actors transition records.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Migration 0011 grants scoped inspection execution to Owner/Admin/Inspector. Serialized Vehicle record commands enforce the Inspection schema/evidence/capability/execution guard before replay, including generic entry points; author-only finalization/amendments retain fresh MFA. The attachment coordinator commits version/association/audit/minimal-ID outbox/replay atomically and rechecks current authority. Gate passed 32 unit/95 Worker tests, including capability/schema/evidence rejection, revoked execution replay denial, immutable final/amendment history, missing MFA and atomic attachment replay/conflict/rollback. Migration 0011 applied in Development; no deployed Inspection UI or remote scan claimed yet.

### MB-P4-004 — APIs + Portal/Admin

- **Status:** VERIFIED
- **Dependencies:** MB-P4-003
- **Objective:** Expose inspection flows in Spanish-first UI.
- **Scope / required work:** Expose inspection flows in Spanish-first UI.
- **Relevant files/systems:** API, Portal, Admin
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** API/UI tests
- **Completion criteria:** Authorized workflows complete.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Scoped Inspection report/media APIs and OpenAPI, Spanish Portal draft/findings/MFA finalization/amendment controls and MFA staff Admin reads pass 37 unit/96 Worker tests and the full gate. Original final reports remain visible; subsequent amendments use the latest snapshot and show all correction observations. Latest 100 amendment history is bounded with explicit truncation; regression covers 101 entries. Local ACTIVE metadata fixtures test private bytes/replay/revocation without claiming a real scan. Development migrations 0010/0011 and all four applications deployed; authenticated no-file report/quarantine smoke passed. Owner scanner deferral is unchanged.

### MB-P4-005 — Remote validation

- **Status:** VERIFIED
- **Dependencies:** MB-P4-004
- **Objective:** Validate inspections in Development.
- **Scope / required work:** Validate independent Inspection report workflow without media: scoped creation/read/update/finalization/amendments, MFA, replay/CAS/revocation, Portal/Admin, Queue/audit consistency and CI. Exercise trusted file upload/private quarantine rejection. Positive real scan/ACTIVE remote delivery remains explicitly deferred under ADR 0024 and MB-P3-005.
- **Relevant files/systems:** All Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke, negative tests, gate
- **Completion criteria:** Independent no-file report workflow and private quarantine negatives remotely verified with receipts/Queue/CI; real scan/remote ACTIVE media and public file release remain owner-deferred, not verified.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Final authenticated Development smoke passed on 2026-10-09: no-file report creation/replay/conflict, exact location grants, origin rejection, schema/CAS/final immutability/amendments/staff reads, revoked write replay denial, private trusted upload QUARANTINED/attachment 409/download 404/no mutation. D1 preserves two FINAL/two DRAFT Inspection fixtures and two amendments, zero real ACTIVE associations, one account/three leads; 68 Vehicle-path replays/command receipts/events match, all 88 outbox events PROCESSED and no unresolved dead letters. Full gate passed 37 unit/96 Worker tests plus state fixtures; CI [37983831325](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37983831325) passed for `cdd86dd`. Latest Development API `2768fd5f-180d-4e01-9ced-256d5a4e2d61`, Portal `17760b09-2a9e-4e69-ac41-b4112a150657`, Admin `da955846-f31a-4d02-ab36-87626fd6b455`, Worker `d9f61b80-734c-43f8-ba77-067071bfd65c` deployed. This verifies the documented independent report/quarantine scope only; real antimalware/remote ACTIVE media/public file release remain owner-deferred.

## Phase 5 — Billing + Wompi

The historical lead-specific atomic D1 batch did **not** fix generic `IdempotencyCoordinator` crash behavior. MB-P5-000 separately closes the generic D1 crash window and is mandatory before financially sensitive Wompi operations. See [ADR 0019](../adr/0019-durable-object-coordination.md).

### MB-P5-000 — Financial-grade generic idempotency hardening

- **Status:** VERIFIED
- **Dependencies:** MB-P4-005
- **Objective:** Close generic coordinator crash window between business effect and replay persistence before financial commands.
- **Scope / required work:** Prepared domain commands; atomic D1 replay claim/receipt/business/audit/outbox; collision/CAS guards, current authority before replay and invitation token redaction; remove unsupported registry entry and cross-store test fixture.
- **Relevant files/systems:** `apps/api/src/coordinators.ts`, `packages/db/src/idempotency.ts`, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Real D1 failure-injection/retry tests across generic command families; authority revocation, account suspension, replay redaction and collision tests; gate, CI and synthetic Development receipt verification.
- **Completion criteria:** Generic financial command cannot duplicate a committed effect after crash.
- **Human-action conditions:** Global stop rule; otherwise none.

- **Evidence:** 2026-10-09: generic prepared-command atomic D1 transaction passes rollback/collision/CAS, current-authority/suspension and token-redaction tests across Organization/CRM/Identity families. Integrated revision 735fc5e passes full CI [37985406024](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37985406024) (37 unit/115 Worker); closeout CI [37985691201](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/37985691201) passes all 37 unit/119 Worker tests. Development API 282c8212-6c47-4baa-9144-f6fa5f8eff55 synthetic invitation has one replay/command receipt/invitation and zero stored tokens; creation feature restriction, one account and zero ACTIVE files preserved; invitation event PROCESSED and zero unresolved dead letters. External financial exactly-once execution is not claimed.

### MB-P5-001 — Billing/subscription domain

- **Status:** VERIFIED
- **Dependencies:** MB-P5-000
- **Objective:** Define money-safe billing and subscriptions with integer minor units/currency.
- **Scope / required work:** Implement owner-approved account subscription plans/lifecycle, finite administrative grants, entitlement/vehicle-limit foundation, period/payment ledger constraints and separate configurable partner agreement/referral/commission/adjustment/manual-settlement foundation; scoped APIs and Spanish Portal/Admin. See [Phase 5 contract](../architecture/phase-5-membership-billing.md) and [ADR 0025](../adr/0025-membership-billing-commercial-boundaries.md).
- **Relevant files/systems:** Payments package, contracts, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Financial invariant/migration, lifecycle, ownership/MFA/entitlement, commission calculation/consent/completion/CAS/rollback, UI regression tests; gate/CI and Development migration/synthetic scope verification.
- **Completion criteria:** Ledger/state constraints established.
- **Human-action conditions:** No blocker for independently testable Development foundation. Production financial activation needs approved tax/refund/grace/retry/final-vehicle-limit/recurring/settlement policies; no automatic partner charge/payout.

- **Evidence:** CI 38011067893 passed revision a0144b7 with all integrated tests/security/format/type/boundary/OpenAPI/audit/artifact/history checks. Development migrations 0012/0013 applied; membership smoke verifies pending/replay/conflict, finite MFA grant, coverage add/remove, cancellation cutoff and free access. Eight membership events PROCESSED with zero errors; cleanup leaves synthetic subscription SUSPENDED, renewal off and no covered vehicles. Remote three-fixture limit scenario explicitly skipped; local two-vehicle-limit regression passed. Commission financial scenarios are locally verified, not claimed remotely exercised.

### MB-P5-002 — Wompi integration

- **Status:** VERIFIED
- **Dependencies:** MB-P5-001
- **Objective:** Implement provider adapter with deterministic keys and safe secrets.
- **Scope / required work:** Official-protocol sandbox adapter, CARD/NEQUI reusable-source capability, single-use PSE boundary, acceptance documents, hosted checkout/server integrity and fail-closed secret/environment controls. Automatic source charging remains unavailable; real merchant validation belongs to MB-P5-005.
- **Relevant files/systems:** Payments package, API config
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Local official-sandbox-protocol fixtures and provider contract/security checks, integrated CI and closed-gateway Development negatives. These do not claim a real merchant payment.
- **Completion criteria:** Tested adapter/checkout uses permanent ledger references, server prices and fixed sandbox endpoints; missing credentials/production fail closed. MB-P5-000 remains verified.
- **Human-action conditions:** None for local technical contract. Real credential/onboarding validation is retained in MB-P5-005; production policies remain release conditions.

- **Evidence:** 42 provider and 27 gateway fixtures plus 16 checkout D1 scenarios pass, integrated CI 38011067893/a0144b7 succeeds. Official Wompi docs checked; current-ledger signing and source/environment/unknown-outcome guards are covered. Development API 2890a34d-20a2-4489-8107-02ccbc524d39 rejects absent-secret checkout/webhook with 503, retains browser origin/auth checks and financial snapshots unchanged. No external payment/charge or working credentials claimed.

### MB-P5-003 — Webhooks + renewals + reconciliation

- **Status:** VERIFIED
- **Dependencies:** MB-P5-002
- **Objective:** Verify signatures, dedupe events, renewals and reconciliation.
- **Scope / required work:** Bounded sandbox webhook validation/private-provider reconciliation, permanent observation deduplication, atomic verified activation, explicit manual calendar renewals/cancellation cutoff and scheduled expiry. Automated recurring charges remain unavailable until commercial authorization and separate verification.
- **Relevant files/systems:** API, Worker, messaging, payments
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Local signed-provider transport fixtures and D1 replay/ordering/ownership/MFA/atomicity/cadence tests, integrated CI, Development closed-gateway rejection. Real external provider convergence remains MB-P5-005.
- **Completion criteria:** At-least-once events converge safely.
- **Human-action conditions:** Global stop rule; otherwise none.

- **Evidence:** CI 38011067893/a0144b7 passes 27 gateway and 14 lifecycle scenarios, including concurrent duplicate convergence, rollback, signed/provider mismatches, manual MFA reconciliation/revocation, late/early renewal, cancellation and actual calendar clamping. Development Worker 79104b99-a231-4495-aeb2-2336bab4572e includes expiry/event contracts. Missing-secret hooks cannot activate access; real sandbox payments are not claimed.

### MB-P5-004 — Failure/retry/refund lifecycle

- **Status:** VERIFIED
- **Dependencies:** MB-P5-003
- **Objective:** Define and implement failure, retry and refund controls.
- **Scope / required work:** Explicit pending/terminal/unknown outcome controls, no blind retry or automatic refund/proration, verified VOIDED evidence revocation, immutable manual commission adjustments/reversals/disputes and settlement reconciliation. Unapproved refund/retry policies remain disabled; this scope does not execute provider refunds.
- **Relevant files/systems:** Payments package, Worker, audit
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Ambiguous/terminal/stale/VOIDED provider-state and no-retry tests, financial atomicity, cancellation cutoff, commission reversal/dispute/manual settlement and immutable evidence tests.
- **Completion criteria:** Money states traceable and idempotent.
- **Human-action conditions:** Global stop rule; otherwise none.

- **Evidence:** 75 focused provider/lifecycle/commission tests pass and integrated CI 38011067893/a0144b7 succeeds. Unknown external outcomes are not retried, terminal evidence cannot spuriously activate, verified VOIDED removes payment-derived entitlement, cancellation retains paid cutoff, and commission corrections/disputes/manual reconciliation retain immutable audit. No automated refund/proration/retry/settlement executor exists or is enabled; live policies/provider-refund activation remain unapproved release conditions.

### MB-P5-005 — Remote validation

- **Status:** HUMAN ACTION REQUIRED
- **Dependencies:** MB-P5-004
- **Objective:** Validate billing/Wompi in Development sandbox.
- **Scope / required work:** Validate billing/Wompi in Development sandbox.
- **Relevant files/systems:** Development apps, D1, Queue, provider sandbox
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote financial scenario matrix and gate
- **Completion criteria:** Financial flows and reconciliation pass.
- **Human-action conditions:** Supply authorized Wompi Sandbox merchant credentials directly as Development API Worker secrets (WOMPI_PUBLIC_KEY, WOMPI_PRIVATE_KEY, WOMPI_INTEGRITY_SECRET, WOMPI_EVENTS_SECRET) and configure the sandbox event URL. Names-only inventory finds none and no authorized merchant browser session exists. See [Wompi Development runbook](../runbooks/wompi-development.md). No keys in files/chat/logs, no real-money test. Local protocol fixtures/closed-gateway negatives are not external merchant verification. This parked boundary does not block independent Communications implementation.

## Phase 6 — Communications + Notifications + Support

### MB-P6-001 — Communication provider abstraction

- **Status:** VERIFIED
- **Dependencies:** MB-P5-004 (owner-approved independent work; MB-P5-005 credentials block external billing validation only)
- **Objective:** Define outbound channels and provider contracts.
- **Scope / required work:** Extend existing provider ports with explicit delivery/unknown/unavailable semantics, current consent/preference and idempotency boundaries, no-PII audit contract and configurable human support availability/usage foundation. No paid provider, actual WhatsApp delivery or invented support promise.
- **Relevant files/systems:** Messaging package, config
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Provider contract/configuration/timeout/unknown/no-auto-retry/privacy tests and repository gates.
- **Completion criteria:** No production delivery assumed.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Two real LOW agents implemented exclusive provider and human-policy contracts; 11 provider/62 support-policy tests and full gate (55 unit/347 Worker, 402 total) pass. Current authority precedes send/reconcile, bounded ambiguous effects never auto-retry, unavailable transport makes zero calls, acceptance is distinct from delivery. IANA/UTC/overlap/finite-usage/fixed-link policy validation passes; pure usage assessment does not claim a persisted quota. No real provider or production delivery enabled.

### MB-P6-002 — Notifications/preferences/templates

- **Status:** VERIFIED
- **Dependencies:** MB-P6-001
- **Objective:** Implement consent-aware notifications and localized templates.
- **Scope / required work:** Account-owned channel/category preferences, current verified contact and separate latest marketing consent gates, immutable Spanish/English template versions and private deduplicated account inbox. External delivery stays unavailable; no marketing consent inferred or premium gate for basic account/service notifications.
- **Relevant files/systems:** Messaging, identity, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Preference and template tests
- **Completion criteria:** Preferences govern delivery.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** 2026-10-10 full gate passed 60 unit/396 Worker tests (456 total), including real verified non-MFA notification API sessions, replay/CAS/origin/account ownership, current contact/marketing consent, mutation-time revocation rollback, immutable bilingual templates, deduplicated atomic membership inbox and paginated Portal retry/stale-response tests. Development migration 0014 applied; API bb7e3326-bdac-43ac-a657-d733ac158b7b, Worker 6e7de33c-dfd7-45cb-a586-509534932d0f and Portal 37de9729-98de-4e28-bbd2-220450bca364 deployed. Remote D1 confirms development identity, two templates, external_delivery_enabled=0 and zero pre-existing inbox/preferences; API health 200, anonymous preference/inbox 401 and deployed pagination asset verified. Authenticated remote notification/Queue smoke and current-revision CI are not claimed; they remain remote closeout work. Two real review agents ran; runtime metadata shows domain reviewer MEDIUM and UI reviewer LOW (initial all-history fork inherited effort). External provider delivery remains unavailable.

### MB-P6-003 — Support workflows

- **Status:** VERIFIED
- **Dependencies:** MB-P6-002
- **Objective:** Define support cases and permissions from established requirements.
- **Scope / required work:** Define support cases and permissions from established requirements.
- **Relevant files/systems:** Support package, API, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Workflow and auth tests
- **Completion criteria:** Support lifecycle approved and enforced.
- **Human-action conditions:** None for the owner-approved general-support workflow (2026-10-10); premium assistance remains disabled pending its separate readiness/business configuration. Global stop rule still applies.

- **Evidence:** Owner approved exact account ownership, SUPPORT_AGENT/PLATFORM_SUPERADMIN assured MFA authority and OPEN/ASSIGNED/CLOSED terminal policy on 2026-10-10. Full gate passes 65 unit/408 Worker tests (473 total); real local sessions exercise customer/staff API, origin, ownership, eligible assignment, CAS/replay/revocation and atomic audit/outbox. Spanish Portal/Admin supports creation, replies, assignment, closure, pagination and immutable bounded history/closing metadata. Additional focused 12-test gate verifies migration 0016 prevents appending a second CLOSE receipt to terminal history; Development migrations 0015/0016 applied. No premium provider, staffing/SLA promise or authenticated remote support closeout claimed. Three actual gpt-6.1-sol LOW agents confirmed in runtime metadata.

### MB-P6-004 — Queue delivery/retry/audit

- **Status:** VERIFIED
- **Dependencies:** MB-P6-003
- **Objective:** Integrate async retries, idempotency and audit.
- **Scope / required work:** Integrate async retries, idempotency and audit.
- **Relevant files/systems:** Worker, messaging, outbox
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Retry/DLQ and audit tests
- **Completion criteria:** No duplicate effects or silent loss.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

- **Evidence:** Full gate passes 65 unit/414 Worker tests (479 total) after bounding test isolate concurrency to four; prior full-suite cold-start timeouts in existing coordinator environment test reproduce only under unrestricted contention and pass focused/bounded runs. Six real-D1 support Queue tests cover concurrent duplicate claim, persisted case/account/audit references, forgery/permanent failures, retry convergence, bounded abort timeout, sanitized exhausted dead letters and historical events after suspension without transport calls. Support commands atomically retain audit/history/outbox/replay; handlers process internal references only, never claim delivery. All four Development apps deployed; remote anonymous routes deny access and assets contain support functionality. Authenticated remote closeout remains MB-P6-005.

### MB-P6-005 — Remote validation

- **Status:** HUMAN ACTION REQUIRED
- **Dependencies:** MB-P6-004
- **Objective:** Validate communication/support in Development.
- **Scope / required work:** Validate internal account notifications/preferences and owner-approved general support in Development; confirm unavailable external channels and premium guidance remain disabled. No real email/SMS/WhatsApp delivery or staffing promise is claimed.
- **Relevant files/systems:** Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke and gate
- **Completion criteria:** Authenticated internal notification materialization/read, preferences, customer/staff support and Queue/audit consistency pass with current code CI. External transport and premium guidance remain disabled.
- **Human-action conditions:** Execute the prepared authenticated smoke with an existing authorized, assured Development Admin session through the hidden local stdin prompt in the [Communications runbook](../runbooks/communications-development.md); never provide a cookie in chat/files/logs. D1 has one eligible assured session, but targeted accessible browser stores contain no Development cookie and no other authorized session source is available. A normal account-holder browser sign-in/MFA is required only if that session expires. This is the execution plan credential/interactive-login boundary, not another support-policy approval. Positive inbox materialization remains outstanding when explicitly skipped; the bounded existing billing smoke can supply genuine synthetic events.

- **Evidence:** Development migrations through 0016 current; all four apps deployed. Remote anonymous smoke passes 9 reads/asset checks with zero mutations. Remote aggregate checks confirm development identity, two templates, exact support grants and disabled transport; no support/inbox fixtures yet. Full local gate 479 tests and CLI syntax/focused lint pass. Authenticated case/preference/inbox/Queue checks remain unverified. CI is being run against the integrated revision; no success inferred yet.

## Phase 7 — Partners + Parts + Assistance

### MB-P7-001 — Partner capability/relationship model

- **Status:** NOT STARTED
- **Dependencies:** MB-P6-005
- **Objective:** Represent partner as capability/relationship, not exclusive org type.
- **Scope / required work:** Represent partner as capability/relationship, not exclusive org type.
- **Relevant files/systems:** Organizations/partner package, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Membership/capability tests
- **Completion criteria:** Multi-capability organizations supported.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P7-002 — Parts domain contract

- **Status:** NOT STARTED
- **Dependencies:** MB-P7-001
- **Objective:** Derive parts catalog/inventory business rules from repository.
- **Scope / required work:** Derive parts catalog/inventory business rules from repository.
- **Relevant files/systems:** Parts package/contracts
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Domain tests
- **Completion criteria:** No invented commerce rules.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P7-003 — Assistance domain contract

- **Status:** NOT STARTED
- **Dependencies:** MB-P7-002
- **Objective:** Derive assistance request/service rules from repository.
- **Scope / required work:** Derive assistance request/service rules from repository.
- **Relevant files/systems:** Assistance package/contracts
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Domain tests
- **Completion criteria:** State and scope approved.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P7-004 — APIs/workflows/authorization

- **Status:** NOT STARTED
- **Dependencies:** MB-P7-003
- **Objective:** Expose partner, parts and assistance operations.
- **Scope / required work:** Expose partner, parts and assistance operations.
- **Relevant files/systems:** API, Portal, Admin, authz
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** API/UI/auth tests
- **Completion criteria:** Scoped workflows work.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P7-005 — Remote validation

- **Status:** NOT STARTED
- **Dependencies:** MB-P7-004
- **Objective:** Validate phase in Development.
- **Scope / required work:** Validate phase in Development.
- **Relevant files/systems:** Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke and gate
- **Completion criteria:** Partner/parts/assistance verified.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

## Phase 8 — Marketplace

### MB-P8-001 — Marketplace business contract

- **Status:** NOT STARTED
- **Dependencies:** MB-P7-005
- **Objective:** Resolve listings, transactions, fees, moderation and liability from existing docs or human decision.
- **Scope / required work:** Resolve listings, transactions, fees, moderation and liability from existing docs or human decision.
- **Relevant files/systems:** Architecture/contracts docs
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Contract review against repository and stakeholder decision if needed
- **Completion criteria:** Business rules explicit before coding.
- **Human-action conditions:** Human business decision if repository does not establish marketplace rules.

### MB-P8-002 — Marketplace domain + authorization

- **Status:** NOT STARTED
- **Dependencies:** MB-P8-001
- **Objective:** Model marketplace entities and context permissions.
- **Scope / required work:** Model marketplace entities and context permissions.
- **Relevant files/systems:** Marketplace package, D1, authz
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Domain and auth tests
- **Completion criteria:** Default-deny business invariants hold.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P8-003 — Listings/discovery/moderation

- **Status:** NOT STARTED
- **Dependencies:** MB-P8-002
- **Objective:** Implement listing lifecycle, discovery and moderation.
- **Scope / required work:** Implement listing lifecycle, discovery and moderation.
- **Relevant files/systems:** Marketplace, API, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Lifecycle/moderation tests
- **Completion criteria:** Unsafe/unapproved listings excluded.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P8-004 — Marketplace workflows/UI

- **Status:** NOT STARTED
- **Dependencies:** MB-P8-003
- **Objective:** Expose approved flows in Portal/Admin.
- **Scope / required work:** Expose approved flows in Portal/Admin.
- **Relevant files/systems:** Portal, Admin, API
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** UI/API tests
- **Completion criteria:** Spanish-first accessible workflows pass.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P8-005 — Remote validation

- **Status:** NOT STARTED
- **Dependencies:** MB-P8-004
- **Objective:** Validate marketplace Development behavior.
- **Scope / required work:** Validate marketplace Development behavior.
- **Relevant files/systems:** Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke and gate
- **Completion criteria:** Marketplace verified.
- **Human-action conditions:** Global stop rule; otherwise none.

## Phase 9 — Intelligence / Analytics

### MB-P9-001 — Analytics data/event contract

- **Status:** NOT STARTED
- **Dependencies:** MB-P8-005
- **Objective:** Define event schema, provenance and allowed uses from established requirements.
- **Scope / required work:** Define event schema, provenance and allowed uses from established requirements.
- **Relevant files/systems:** Contracts, messaging, analytics package
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Schema/privacy tests
- **Completion criteria:** Events have stable semantics.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P9-002 — Operational/business analytics

- **Status:** NOT STARTED
- **Dependencies:** MB-P9-001
- **Objective:** Build approved aggregates and measures.
- **Scope / required work:** Build approved aggregates and measures.
- **Relevant files/systems:** Analytics package, D1/Worker
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Aggregation tests
- **Completion criteria:** Metrics reproduce source facts.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P9-003 — Access/privacy/retention

- **Status:** NOT STARTED
- **Dependencies:** MB-P9-002
- **Objective:** Enforce class-based access, PII limits and retention.
- **Scope / required work:** Enforce class-based access, PII limits and retention.
- **Relevant files/systems:** Authz, analytics, migrations
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Privacy/retention tests
- **Completion criteria:** Restricted data protected.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P9-004 — Reporting/UI

- **Status:** NOT STARTED
- **Dependencies:** MB-P9-003
- **Objective:** Expose scoped Spanish-first reports.
- **Scope / required work:** Expose scoped Spanish-first reports.
- **Relevant files/systems:** API, Portal, Admin
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Report/UI tests
- **Completion criteria:** Reports accurate and accessible.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P9-005 — Remote validation

- **Status:** NOT STARTED
- **Dependencies:** MB-P9-004
- **Objective:** Validate analytics in Development.
- **Scope / required work:** Validate analytics in Development.
- **Relevant files/systems:** Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke and gate
- **Completion criteria:** Analytics phase verified.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.
