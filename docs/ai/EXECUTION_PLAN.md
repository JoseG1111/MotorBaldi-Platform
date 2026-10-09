# MotorBaldi autonomous execution plan

This file is the checkpoint registry. `CURRENT_CHECKPOINT.md` is the recovery cursor; `WORK_LOG.md` records transitions. Detailed technical truth lives in the linked [architecture](../architecture/MOTORBALDI_MASTER.md), [Phase 1 design](../architecture/phase-1-identity-crm-organizations.md), [ADRs](../adr/), [Cloudflare runbooks](../cloudflare/), code, migrations, and tests. Repository and live environment reality override stale entries. Never infer a remote success solely from committed configuration.

## Recovery loop

1. Read applicable `AGENTS.md`, then `CURRENT_CHECKPOINT.md`; load only relevant sections of `PROJECT_STATE.md`, `ARCHITECTURE_DECISIONS.md`, and this plan.
2. Inspect code, tests, git state, and any safely accessible target environment. Reconcile discrepancies before work. Record the evidence source and its limit; historical operator evidence may be retained when corroborated and uncontradicted, but do not invent live verification.
3. Find the earliest checkpoint whose dependencies are `VERIFIED`. `VERIFIED` means its stated completion evidence exists. If a dependency has lost evidence or reality contradicts it, correct its status and move the cursor there. Only one checkpoint may be `IN PROGRESS`.
4. Mark the eligible checkpoint `IN PROGRESS` in this file and update `CURRENT_CHECKPOINT.md` before substantive work. Implement, run its verification, diagnose failures, fix safely, and rerun. Persist the cursor after meaningful recovery boundaries: diagnosis, implementation, failed gate, deployment, or newly found blocker.
5. If implementation exists but verification is incomplete, use `IMPLEMENTED — NOT VERIFIED`. On success, mark `VERIFIED` with concise evidence and add one `WORK_LOG.md` entry. Advance the cursor and continue automatically to the next eligible checkpoint. Phase 2 requires MB-CF-015 `VERIFIED`.
6. Stop only at a genuine human-action boundary. Mark `HUMAN ACTION REQUIRED` when a specific human action is necessary; `BLOCKED` is for a technical/external impediment with an identified retry condition. Resume automatically when it clears. Use `SKIPPED — WITH REASON` only for an explicit, justified non-applicable checkpoint and adjust dependents deliberately.

Allowed statuses, exactly: `NOT STARTED`, `READY`, `IN PROGRESS`, `IMPLEMENTED — NOT VERIFIED`, `VERIFIED`, `BLOCKED`, `HUMAN ACTION REQUIRED`, `SKIPPED — WITH REASON`. `READY` means dependencies are verified and no work has begun. Do not use `VERIFIED` to mean “coded” or “reported complete.”

## Autonomy and stop rule

Proceed without asking for repository inspection, routine choices settled by code/ADRs/tests, ordinary refactoring, tests, current-work lint/type fixes, correcting mistakes, non-destructive Development D1 operations, deployments to already-existing Development Workers/resources when verification needs them, Development smoke tests, and advancement to approved checkpoints. Select named remote Wrangler environments explicitly. Never weaken security or reveal/commit secrets. Do not ask anyone to paste secret values into files or these docs.

Stop for an actual secret/credential that must be supplied or an interactive account login, a new provider requiring manual interaction, unsafe account-level Cloudflare provisioning, DNS/nameserver work, spending money, production deployment, possible production data destruction, a materially destructive migration, an unresolved business choice, two legitimate architecture choices unresolved by ADRs, material repository conflict with an accepted decision, a step requiring weaker security, or genuinely absent necessary information. Prepare all safe work first and state the exact action needed. The initiating user authorized use of existing keys and Development resources; that does not authorize production deployment, destructive changes, DNS, spending, or writing secrets to the repository.

Checkpoint constraints below add to these global rules. If a future checkpoint needs a narrowly scoped technical prerequisite, add it with reason and dependencies; never silently change product scope or reverse architecture.

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

- **Status:** HUMAN ACTION REQUIRED
- **Dependencies:** MB-P3-004
- **Objective:** Validate workshop operations in Development.
- **Scope / required work:** Core operational and negative file smoke passed. Integrate a real private malware scanner using its approved protocol, securely provision any required Worker secret, verify CLEAN promotion/attachment/download and rejection/unavailability, then rerun full smoke/gate/CI.
- **Relevant files/systems:** All Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke, negative tests, gate
- **Completion criteria:** Workflow remotely verified.
- **Human-action conditions:** No approved real private malware provider/protocol or credential exists in the repository/Development Worker. Supply provider name/documentation or endpoint; credentials must be installed securely as Worker secrets, never pasted into repository/continuity docs. Remote deterministic/no-op scanning is forbidden by existing config and ADR 0017.

## Phase 4 — Inspections / Peritaje

### MB-P4-001 — Inspection domain + immutable report contract

- **Status:** NOT STARTED
- **Dependencies:** MB-P3-005
- **Objective:** Define inspection/peritaje findings and immutable final report with amendments.
- **Scope / required work:** Define inspection/peritaje findings and immutable final report with amendments.
- **Relevant files/systems:** Inspection package, contracts, migration
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Domain and immutability tests
- **Completion criteria:** Report contract preserves evidence and corrections.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P4-002 — Evidence/media lifecycle

- **Status:** NOT STARTED
- **Dependencies:** MB-P4-001
- **Objective:** Bind inspection evidence to private R2 lifecycle and scanning.
- **Scope / required work:** Bind inspection evidence to private R2 lifecycle and scanning.
- **Relevant files/systems:** Storage, inspection, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Upload, scan, privacy tests
- **Completion criteria:** Only authorized clean media is served.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P4-003 — Workflow + authorization

- **Status:** NOT STARTED
- **Dependencies:** MB-P4-002
- **Objective:** Implement inspection states, role/location scopes, and review.
- **Scope / required work:** Implement inspection states, role/location scopes, and review.
- **Relevant files/systems:** Inspection/authz packages
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Transition and default-deny tests
- **Completion criteria:** Only permitted actors transition records.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P4-004 — APIs + Portal/Admin

- **Status:** NOT STARTED
- **Dependencies:** MB-P4-003
- **Objective:** Expose inspection flows in Spanish-first UI.
- **Scope / required work:** Expose inspection flows in Spanish-first UI.
- **Relevant files/systems:** API, Portal, Admin
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** API/UI tests
- **Completion criteria:** Authorized workflows complete.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P4-005 — Remote validation

- **Status:** NOT STARTED
- **Dependencies:** MB-P4-004
- **Objective:** Validate inspections in Development.
- **Scope / required work:** Validate inspections in Development.
- **Relevant files/systems:** All Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke, negative tests, gate
- **Completion criteria:** Inspection phase remotely verified.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

## Phase 5 — Billing + Wompi

The lead-specific atomic D1 batch does **not** fix generic `IdempotencyCoordinator` crash behavior. MB-P5-000 is mandatory before financially sensitive Wompi operations. See [ADR 0019](../adr/0019-durable-object-coordination.md).

### MB-P5-000 — Financial-grade generic idempotency hardening

- **Status:** NOT STARTED
- **Dependencies:** MB-P4-005
- **Objective:** Close generic coordinator crash window between business effect and replay persistence before financial commands.
- **Scope / required work:** Close generic coordinator crash window between business effect and replay persistence before financial commands.
- **Relevant files/systems:** `apps/api/src/coordinators.ts`, `packages/db/src/idempotency.ts`, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Failure-injection crash/retry tests across registered command types
- **Completion criteria:** Generic financial command cannot duplicate a committed effect after crash.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P5-001 — Billing/subscription domain

- **Status:** NOT STARTED
- **Dependencies:** MB-P5-000
- **Objective:** Define money-safe billing and subscriptions with integer minor units/currency.
- **Scope / required work:** Define money-safe billing and subscriptions with integer minor units/currency.
- **Relevant files/systems:** Payments package, contracts, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Financial invariant and migration tests
- **Completion criteria:** Ledger/state constraints established.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P5-002 — Wompi integration

- **Status:** NOT STARTED
- **Dependencies:** MB-P5-001
- **Objective:** Implement provider adapter with deterministic keys and safe secrets.
- **Scope / required work:** Implement provider adapter with deterministic keys and safe secrets.
- **Relevant files/systems:** Payments package, API config
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Sandbox tests and provider contract checks
- **Completion criteria:** No financially sensitive operation enabled before MB-P5-000 verified.
- **Human-action conditions:** Provider credentials/manual onboarding if needed; never store secrets in repo.

### MB-P5-003 — Webhooks + renewals + reconciliation

- **Status:** NOT STARTED
- **Dependencies:** MB-P5-002
- **Objective:** Verify signatures, dedupe events, renewals and reconciliation.
- **Scope / required work:** Verify signatures, dedupe events, renewals and reconciliation.
- **Relevant files/systems:** API, Worker, messaging, payments
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Replay, ordering and reconciliation tests
- **Completion criteria:** At-least-once events converge safely.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P5-004 — Failure/retry/refund lifecycle

- **Status:** NOT STARTED
- **Dependencies:** MB-P5-003
- **Objective:** Define and implement failure, retry and refund controls.
- **Scope / required work:** Define and implement failure, retry and refund controls.
- **Relevant files/systems:** Payments package, Worker, audit
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Failure and refund state tests
- **Completion criteria:** Money states traceable and idempotent.
- **Human-action conditions:** Global stop rule; otherwise none.

### MB-P5-005 — Remote validation

- **Status:** NOT STARTED
- **Dependencies:** MB-P5-004
- **Objective:** Validate billing/Wompi in Development sandbox.
- **Scope / required work:** Validate billing/Wompi in Development sandbox.
- **Relevant files/systems:** Development apps, D1, Queue, provider sandbox
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote financial scenario matrix and gate
- **Completion criteria:** Financial flows and reconciliation pass.
- **Human-action conditions:** Global stop rule; otherwise none.

## Phase 6 — Communications + Notifications + Support

### MB-P6-001 — Communication provider abstraction

- **Status:** NOT STARTED
- **Dependencies:** MB-P5-005
- **Objective:** Define outbound channels and provider contracts.
- **Scope / required work:** Define outbound channels and provider contracts.
- **Relevant files/systems:** Messaging package, config
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Provider contract tests
- **Completion criteria:** No production delivery assumed.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P6-002 — Notifications/preferences/templates

- **Status:** NOT STARTED
- **Dependencies:** MB-P6-001
- **Objective:** Implement consent-aware notifications and localized templates.
- **Scope / required work:** Implement consent-aware notifications and localized templates.
- **Relevant files/systems:** Messaging, identity, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Preference and template tests
- **Completion criteria:** Preferences govern delivery.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P6-003 — Support workflows

- **Status:** NOT STARTED
- **Dependencies:** MB-P6-002
- **Objective:** Define support cases and permissions from established requirements.
- **Scope / required work:** Define support cases and permissions from established requirements.
- **Relevant files/systems:** Support package, API, D1
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Workflow and auth tests
- **Completion criteria:** Support lifecycle approved and enforced.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P6-004 — Queue delivery/retry/audit

- **Status:** NOT STARTED
- **Dependencies:** MB-P6-003
- **Objective:** Integrate async retries, idempotency and audit.
- **Scope / required work:** Integrate async retries, idempotency and audit.
- **Relevant files/systems:** Worker, messaging, outbox
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Retry/DLQ and audit tests
- **Completion criteria:** No duplicate effects or silent loss.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

### MB-P6-005 — Remote validation

- **Status:** NOT STARTED
- **Dependencies:** MB-P6-004
- **Objective:** Validate communication/support in Development.
- **Scope / required work:** Validate communication/support in Development.
- **Relevant files/systems:** Development apps/resources
- **Constraints:** Apply accepted ADRs; use explicit Development environment for remote work.
- **Verification:** Remote smoke and gate
- **Completion criteria:** Channels and support verified.
- **Human-action conditions:** Global stop rule; resolve only truly missing business requirements.

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
