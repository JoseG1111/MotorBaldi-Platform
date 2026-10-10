# Development Parts validation

This smoke uses only fixed Development Admin, Portal and API hosts. Authenticated calls use the Admin same-origin `/api/v1` proxy. It never receives a password, TOTP secret, cookie argument, environment variable or credential file. Reports contain fixed steps, HTTP statuses, allowlisted error codes and fixture counts; no response bodies or identifiers.

Run anonymous protection, health and Parts asset validation:

```sh
node scripts/parts/development-smoke.mjs --anonymous
```

For authenticated validation, sign in normally to Development Admin and complete MFA. The same person must already be an OWNER or ADMIN of the verified synthetic organization `MotorBaldi Development Validation Workshop`, with an active `MotorBaldi Development Workshop Site` location and organization-wide `PARTS` capability. Platform catalog authority alone does not confer organization scope.

If the capability is missing, sign in normally to Development Portal as the authorized synthetic organization's OWNER or ADMIN; select that organization in the workspace selector, open its capabilities form, select `PARTS` and submit once. The form reads and preserves existing capability codes. Do this in a quiet fixture-maintenance window: the legacy capability replacement has no CAS version. Refresh and confirm the existing capabilities remain present. Do not use SQL, bypass verification, replace unrelated capabilities or configure a real organization. The smoke deliberately fails `step=fixture-prerequisite code=PARTS_FIXTURE_REQUIRED` before any mutation when these prerequisites are absent.

Supply the existing post-MFA Admin Cookie request header value locally through hidden stdin. Do not paste it into chat or persist it. Disable shell tracing before input, and use this exact local command (the variable is neither exported nor echoed):

```sh
set +x
IFS= read -r -s -p 'Existing Development Admin Cookie header: ' parts_session
printf '\n'
printf '%s' "$parts_session" | node scripts/parts/development-smoke.mjs --verify-only
unset parts_session
```

`--verify-only` performs authenticated GET checks for MFA, canonical catalog and the person's existing synthetic organization scope. After those pass, repeat the hidden-input command without `--verify-only` for the complete mutation smoke.

A full pass requires a unique synthetic canonical DRAFT → ACTIVE → updated → ARCHIVED lifecycle, idempotent replay, mismatched replay rejection, stale-version and origin rejection, a new synthetic vehicle and location grants, a new DRAFT Workshop order, a unique scoped offering DRAFT → ACTIVE → updated → INACTIVE lifecycle, and an immutable price snapshot that stays unchanged after the offering's price changes. The new order is cancelled using its current version. No existing vehicle, order or offering is reused or modified. Synthetic vehicle/grant identities and immutable history remain as audit evidence; nothing is deleted.

Ambiguous successful-status mutations retry once using the identical body and key. Expected negative checks never retry. Failure cleanup reads current versions and verifies they match the last confirmed version and expected status, as well as the unique synthetic reference or order vehicle and description, before attempting known newly created canonical/offering/order terminal transitions. Concurrently changed fixtures are preserved for authorized review. The primary failure remains visible if cleanup fails. Nonzero `known_unclosed`, `unknown_outcome` or `cleanup_failures` requires authorized fixture review before rerunning; never infer success from anonymous checks or empty tables.

This runbook and mocked tests are local evidence only. A checkpoint requires recorded sanitized output from the actual deployed Development full smoke; absent credentials or fixture scope remains a human action boundary.

After the authenticated mutation smoke succeeds, run the aggregate Development consistency probe using the existing Cloudflare login:

```sh
node scripts/parts/check-consistency.mjs
```

The probe fixes the named Development database/environment and checks source histories, immutable snapshots, audit/event references, duplicate versions, foreign keys and dead letters. It requires positive catalog, offering, snapshot and processed Parts event counts. If Parts events are still pending, allow the existing Queue relay to process them and rerun the read-only probe; do not publish fabricated events. `--baseline` prints `BASELINE`, permits empty Parts tables, and never proves authenticated mutation or positive Queue closeout.

## Deployment evidence — 2026-10-10

Additive migration 0017 is applied in Development: four Parts tables and 13 guards. API `5b20a4be-9b7f-4cd5-9613-33cb9c7558c4`, Worker `7b69a7e4-d991-4e57-8e7e-083837d0eafd`, Portal `c4b44910-7afb-439c-983a-b25bb58438d8` and Admin `f79fd789-7c13-4657-9e66-35932842a1c1` are deployed. Anonymous Parts protection/assets pass. Baseline has zero Parts records/events, all 133 existing outbox events PROCESSED, zero unresolved dead letters and zero foreign-key violations. The named verified synthetic Workshop does not yet have organization-wide PARTS capability. Implementation `da2752d` passed [CI 38082933560](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/38082933560) with 558 tests; no authenticated Parts mutation or positive Parts Queue convergence is claimed. MB-P7-005 remains unverified pending the secure authenticated run above.
