# Read-only release and recovery preparation

The repository can prepare Staging and Production source manifests without provisioning resources or releasing either environment. Run from the repository root:

```sh
node scripts/release/readiness.mjs
```

The command reads the four tracked Wrangler manifests, numbered SQL migrations, existing `dist/<app>-staging` and `dist/<app>-production` build artifacts, and Git revision/tree/status metadata. It prints a JSON report and performs no provisioning, deployment, migrations, DNS changes, provider calls, secret retrieval, database queries or recovery operations. It does not read `.env` files, dedicated credential files or OS secret storage. Build artifacts are hashed without printing their contents. Symlinks are excluded and make their inventory incomplete.

Exit status `0` means the complete local preparation checks passed. Exit status `1` means the report identifies incomplete or unsafe local preparation. Invalid command arguments return `2`. Keep an incomplete report as evidence of outstanding work; do not bypass an error to claim readiness.

## What the report establishes

`environments.<name>.sourceReady` describes only static source configuration. `preparationReady` also requires all remote environment manifests to pass, the manifest/Git inventories to load, a contiguous migration inventory, and artifact inventories containing at least one nonempty JavaScript, ES module or WebAssembly runtime file for all four Staging and all four Production Workers. Metadata, source maps and static assets alone cannot establish a runtime build. The source check includes Development as an isolation reference. It cannot confirm that any named resource exists or that a migration has been applied.

`ready` is always `false`, and `remoteVerification` is always `NOT_PERFORMED`. A successful source check or Wrangler dry-run does not verify Staging or Production. `inventory.git.contentMatchToArtifacts` remains `UNVERIFIED`; artifact hashes alone do not prove they came from the reported revision. A dirty working tree is reported explicitly. Capture a clean, reviewed revision and build provenance separately at the actual release boundary. `artifactProvenance.status` also remains `UNVERIFIED` and lists required evidence: reviewed source/build worktree state, the explicit environment build command and toolchain versions, and a CI/build record linking the source revision to artifact hashes. These requirements are not satisfied merely by a populated build directory.

`nextActions` consolidates source, loading, migration and artifact deficiencies with repository paths and value-free remediation guidance. Source entries retain the app, environment and logical field (binding names identify collection entries); inspect that field in the named manifest. Resource identities and HTTPS origins must come from operator-confirmed configuration. The guidance does not authorize provisioning, deployment or secret retrieval.

| Check                                                            | Evidence produced                                                                   | Limit                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Worker/env names, entrypoints and compatibility date             | Declarative source fields and errors by app/environment                             | No deployed version inspection                                |
| API/background D1, private R2, Queue/DLQ and Outbox bindings     | Matching required bindings, UUID shape and separate DLQ                             | No actual resource identity or data inspection                |
| Portal/Admin API service bindings and API Durable Object exports | Exact environment target and declared SQLite classes                                | No remote service/namespace verification                      |
| API/auth rate limits                                             | Separate namespace IDs and declared bounds                                          | No runtime limiter probe                                      |
| Exact HTTPS auth, trusted and public origins                     | Placeholder/invalid origin errors                                                   | No domain ownership, TLS, DNS or routing proof                |
| Environment isolation                                            | Reused D1 IDs/names, buckets, queues, Worker names, origins or rate namespaces      | No account-level resource inventory                           |
| External auth/payment/notification gates                         | Missing or explicit `false` is disabled; other values fail preparation              | No secret presence, D1 policy or provider acceptance proof    |
| Source/build inventory                                           | SHA-256 per manifest, SQL file and allowed build artifact; aggregate inventory hash | No CI attestation, deployed content match or backup guarantee |

The report never includes credential values or raw parser/provider errors. Source credential variable names are flagged as `CREDENTIAL_IN_SOURCE_VARS`; move actual values through the established protected secret-management workflow. Do not add keys, passwords, authenticator codes, account cookies or message tokens to manifests or release evidence.

## Current repository evidence

The read-only check on 2026-10-13 found the Development source configuration complete, and both Staging and Production incomplete. Their API auth/trusted origins and D1 IDs still contain `REPLACE_WITH_*` placeholders. The background Worker repeats the deliberate target D1 placeholder. Both environments' declared resources remain distinct from Development; resource names in source are not proof of provisioning.

All four Staging and all four Production `dist` directories contained only build README metadata at that inspection; the validator correctly rejected their empty executable artifact inventories. The migration inventory contained 27 contiguous SQL files. These are local inventory observations, not applied remote migration evidence. Rerun against current repository reality before relying on this snapshot.

Auth email, production payment release, general notification delivery and controlled WhatsApp delivery are separately checked against their corresponding gates:

- `AUTH_EMAIL_DELIVERY_ENABLED`
- `WOMPI_PRODUCTION_RELEASE_AUTHORIZED`
- `NOTIFICATION_EXTERNAL_DELIVERY_ENABLED`
- `NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED`
- `NOTIFICATION_EMAIL_RELEASE_AUTHORIZED`
- `NOTIFICATION_WHATSAPP_RELEASE_AUTHORIZED`

Leave these absent or `false` in preparation manifests. Development auth email also requires `AUTH_EMAIL_TEST_RECIPIENT_SHA256`: one to ten distinct lowercase SHA-256 hashes of trimmed lowercase authorized email addresses. Missing or malformed hashes make the Development auth adapter unavailable; nonallowlisted recipients are rejected before HTTP. Staging and Production legitimate auth delivery retain their separate release boundaries. This hash list permits only a bounded Development test scope and does not authorize general auth email activation. Remote `DEVELOPMENT_SINK`, deterministic malware scanning, Turnstile bypasses, source credentials and Development automation outside Development fail the check. A disabled source gate does not prove remote bindings or canonical D1 policies are disabled. At a future authorized release, inspect the actual auth/provider configuration, `notification_policy`, governed signup/lead flags and billing state without exposing credentials. Prepared provider code cannot replace real sender/template/recipient-consent evidence or approved live billing policies.

## Before any Staging or Production action

Complete the safe local work first: review the exact source revision, run required checks, generate each environment's dry-run artifacts, inspect the readiness report and retain the inventory hash with CI/build provenance. Build/dry-run evidence must explicitly say that remote verification has not happened.

An authorized operator must then confirm the actual isolated account resources, deployed Worker versions, service and Durable Object namespaces, rate-limit namespaces, private bucket access, Queue/DLQ, scheduler, HTTPS routes and environment identity. Verify protected secret names/presence/rotation through the established mechanism; never export secret values into the report. Required runtime auth keys and rotation keyring are not established by this script. Verify the actual applied migration history against the SQL checksums before beginning runtime validation.

Production deployment, account-level provisioning, DNS work, paid activation, live financial effects and possible production data destruction retain the human-action boundaries in [the execution plan](../ai/EXECUTION_PLAN.md). This runbook grants no such authorization. Staging/Production remote validation needs its own scoped evidence, including current authorization/MFA/origin/rate-limit negatives, no cross-environment access, actual callback routes and expected Queue/outbox behavior. Keep deferred scanning/private quarantine restrictions intact.

## Rollback prerequisites

Follow [the canonical rollback policy](rollback.md): choose a Worker version only after verifying its compatibility with the current D1 schema; prefer a forward fix for migrations. Record the candidate Worker version for API, background, Portal and Admin; source revision; artifact hashes; binding/secret-name expectations; compatible SQL inventory; and the actual release order before deployment. Do not assume rolling back code rolls back D1, R2 objects, Queue messages, Durable Object storage, provider submissions or canonical billing/audit/outbox history.

Maintain a protected, verified database backup/export or available recovery point and a private R2 recovery procedure before a migration that could require recovery. Identify authorized operators, incident escalation and the approval boundary for any destructive SQL or object operation. Establish recovery objectives with the operator; this repository does not invent an RPO or RTO. Confirm whether the target version can safely process persisted outbox/Queue events and retain idempotency/reconciliation behavior for ambiguous external effects. Disable newly activated external effects through their existing gates before recovery when authorized; never auto-resend uncertain payments or messages.

## Restore rehearsal and evidence

Prepare an isolated restore target with the same environment-specific access controls and external gates disabled. The rehearsal must use an actual retained recovery point, validate its checksum and provenance, and document the source snapshot time and restore target. Preserve originals and avoid treating the rehearsal as permission to overwrite Production.

After an authorized restore, verify D1 environment metadata, applied schema/migration inventory, foreign keys, representative canonical records and immutable financial/audit histories. Verify private R2 metadata/object associations without making unscanned content public. Inspect pending/processing/dead outbox state and Queue/DLQ handling; duplicate delivery is expected and consumers must remain idempotent. Reconcile ambiguous external transactions from canonical references rather than inferring success from restored data. Record observed recovery duration and any observed data gap; compare them only against separately approved recovery objectives.

A restore plan is preparation. A restore rehearsal is verified only when an actual isolated exercise and integrity checks have evidence. Neither the readiness JSON nor a dry-run counts as a completed rollback, backup, restore or Production release.

## Corrected executable build inventory — 2026-10-14

The installed Wrangler resolves a relative `--outdir` against the app manifest directory: prior commands left only metadata in root `dist`, while executable bundles lived under `apps/<app>/dist`. Build commands now use `scripts/foundation/build.mjs` with absolute repository-root output paths. Artifact verification asserts a nonempty executable for each of the four default and twelve explicit environment targets before scanning the same root inventory. The corrected artifact gate passes and all eight Staging/Production executable inventories are complete. Remaining eight source issues are confirmed-origin/D1 placeholders; `preparationReady=false`, provenance unverified and remote verification not performed remain accurate. No Staging/Production resource was provisioned or deployed.
