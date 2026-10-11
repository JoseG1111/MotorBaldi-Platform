# Development Parts validation

This smoke uses only fixed Development Admin, Portal and API hosts. Authenticated calls are signed for the fixed Development API with the trusted Development Admin origin. It never receives a password, TOTP secret, cookie argument, environment variable or credential file. Reports contain fixed steps, HTTP statuses, allowlisted error codes and fixture counts; no response bodies or identifiers.

Run anonymous protection, health and Parts asset validation:

```sh
node scripts/parts/development-smoke.mjs --anonymous
```

Authenticated validation uses the dedicated signed Development machine identity from [ADR 0027](../adr/0027-development-automation-authentication.md). Initial public-identity setup and OS/Cloudflare credential provisioning are documented in the [automation runbook](development-automation.md). Human passwords, browser cookies and TOTP codes are unnecessary.

```sh
node scripts/parts/development-smoke.mjs --verify-only
node scripts/parts/development-smoke.mjs
```

`--verify-only` uses authenticated GETs and never changes capability configuration. A full run identifies the existing named verified Workshop/site, then adds only PARTS through the signed, audited idempotent fixture workflow. It preserves other capabilities and creates no organization. Both commands load the credential through private OS Secret Service pipes; no credential arguments, environment variables, files or prompts are accepted.

A full pass requires a unique synthetic canonical DRAFT → ACTIVE → updated → ARCHIVED lifecycle, idempotent replay, mismatched replay rejection, stale-version and origin rejection, a new synthetic vehicle and location grants, a new DRAFT Workshop order, a unique scoped offering DRAFT → ACTIVE → updated → INACTIVE lifecycle, and an immutable price snapshot that stays unchanged after the offering's price changes. The new order is cancelled using its current version. No existing vehicle, order or offering is reused or modified. Synthetic vehicle/grant identities and immutable history remain as audit evidence; nothing is deleted. Temporary grants expire after one hour and are revoked after terminal fixture cleanup.

Ambiguous successful-status mutations retry once using the identical body and key. Expected negative checks never retry. Failure cleanup reads current versions and verifies they match the last confirmed version and expected status, as well as the unique synthetic reference or order vehicle and description, before attempting known newly created canonical/offering/order terminal transitions. Concurrently changed fixtures are preserved for authorized review. The primary failure remains visible if cleanup fails. Nonzero `known_unclosed`, `unknown_outcome` or `cleanup_failures` requires authorized fixture review before rerunning; never infer success from anonymous checks or empty tables.

This runbook and mocked tests are local evidence only. A checkpoint requires recorded sanitized output from the actual deployed Development full smoke; an unavailable OS collection or Cloudflare control-plane authentication remains a genuine external boundary. Routine validation is autonomous.

After the authenticated mutation smoke succeeds, run the aggregate Development consistency probe using the existing Cloudflare login:

```sh
node scripts/parts/check-consistency.mjs
```

The probe fixes the named Development database/environment and checks source histories, immutable snapshots, audit/event references, duplicate versions, foreign keys and dead letters. It requires positive catalog, offering, snapshot and processed Parts event counts. If Parts events are still pending, allow the existing Queue relay to process them and rerun the read-only probe; do not publish fabricated events. `--baseline` prints `BASELINE`, permits empty Parts tables, and never proves authenticated mutation or positive Queue closeout.

## Historical deployment evidence — before owner-directed automation

Additive migration 0017 is applied in Development: four Parts tables and 13 guards. API `5b20a4be-9b7f-4cd5-9613-33cb9c7558c4`, Worker `7b69a7e4-d991-4e57-8e7e-083837d0eafd`, Portal `c4b44910-7afb-439c-983a-b25bb58438d8` and Admin `f79fd789-7c13-4657-9e66-35932842a1c1` are deployed. Anonymous Parts protection/assets pass. Baseline has zero Parts records/events, all 133 existing outbox events PROCESSED, zero unresolved dead letters and zero foreign-key violations. The named verified synthetic Workshop does not yet have organization-wide PARTS capability. Implementation `da2752d` passed [CI 38082933560](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/38082933560) with 558 tests; no authenticated Parts mutation or positive Parts Queue convergence is claimed. MB-P7-005 remains unverified pending the secure authenticated run above.

Final secure harness/consistency commit `4e1c37e` passed [CI 38083420131](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/38083420131) with 570 tests and artifact/history secret checks. These local/CI results do not replace the outstanding authenticated Development mutations and positive Parts Queue validation.

After successful remote machine authentication and Parts lifecycle validation, also run:

```sh
node scripts/development/authentication-smoke.mjs
node scripts/development/check-consistency.mjs
```

These check real machine assurance, signature/replay/freshness and route isolation, then aggregate identity/least-privilege/human-auth exclusion, audit, fixture outbox/Queue and grant cleanup. Passing local tests or baseline counts alone cannot mark MB-P7-005 VERIFIED.

## Autonomous closeout evidence — 2026-10-10

Migration 0018 and the dedicated passwordless identity are provisioned. Development API 8fb877df-7390-4bda-bcff-a47f83781d4b and Worker 04822977-716f-4532-8027-1e8655dace14 implement distinct signed machine assurance; Portal/Admin human MFA is unchanged. Authentication smoke, full Parts lifecycle/cleanup, positive Parts consistency (canonical3/offering2/snapshot2/processed22) and automation consistency PASS. All temporary grants are revoked and owned orders cancelled; failed-run immutable histories are retained. Runner fixes omit the optional create assignee and compare the actual raw Workshop vehicle_id field; real contract/foreign-order regressions prevent repeats. Gate620 tests and artifact/secret checks PASS. The previous unspecific query failure is not attributed to an invented historical cause: current remote queries return valid evidence, and Queue-pending diagnostics are now distinct from missing/query/security evidence failures.
