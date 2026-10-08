# Current checkpoint

- **Current checkpoint:** MB-P2-003 — Odometer/history + immutable professional records
- **Status:** IN PROGRESS
- **Last verified checkpoint:** MB-P2-002 — Identifiers, relationships, claims and garage access
- **Work completed:** MB-P2-001/002 created central vehicle and separated identifier, relationship, claim, grant, and garage schemas. `@motorbaldi/vehicles` checks exact grants against active accounts, people, organizations, memberships and location scope. Additive migrations `0004` and `0005` are applied in Development.
- **Verification completed:** `pnpm gate` passed 22 unit and 72 Worker tests. Development D1 has six Vehicle tables, no vehicle records yet, intact Phase 1 counts, `development` identity, and no pending migrations. Tests prove identifier/claim/relationship/garage alone cannot authorize access.
- **Remaining work:** Implement append-oriented odometer history and immutable finalized professional records with explicit amendments; avoid inventing detailed service workflows.
- **Current blocker:** None. Exact professional record fields/workflow are **UNKNOWN — VERIFY FROM REPOSITORY**; implement only established technical invariants until a real product choice is unavoidable.
- **Exact next action:** Inspect existing professional and storage patterns, then design MB-P2-003 history/finalization/amendment schema and tests.
- **Relevant files:** `docs/architecture/phase-2-vehicle-core.md`, `migrations/0004_vehicle_core.sql`, `migrations/0005_vehicle_access.sql`, `packages/{vehicles,professional,storage}/`, `tests/workers/vehicle-schema.test.ts`.
- **Commands worth rerunning:** `pnpm gate`; `pnpm exec wrangler d1 migrations list motorbaldi-core-dev --remote --env development --config apps/api/wrangler.jsonc`.
- **Expected result:** Odometer readings append without rewriting history; finalized professional records cannot be edited or deleted and corrections preserve the prior record through amendments.
