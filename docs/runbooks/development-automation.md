# Development automation authentication

Development automation uses its own passwordless service account and signed machine assurance. Its credential is never a human session or MFA factor. The Worker accepts it only in Development, with the dedicated account's existing permissions and synthetic-resource restrictions.

## Local prerequisite

The operating system Secret Service must already be running with its default collection unlocked. Install the Python `secretstorage` dependency through the workstation's approved package mechanism. The helper does not prompt, create a collection, or unlock one. An unavailable or locked service fails closed.

The item uses fixed attributes `service=motorbaldi-development-automation` and `environment=development`. Its secret is the complete credential JSON. Do not place that JSON in environment variables, command arguments, files, clipboard history, logs, or a shell command. The Python bridge receives storage input over a private pipe and returns lookup data only to the capturing Node process.

## Provision and retry

After migration 0018 is applied to Development, provision the dedicated public identity against the existing verified synthetic Workshop/site, then securely install its credential:

```sh
node scripts/development/automation-bootstrap.mjs
node scripts/development/automation-key.mjs
```

This reads public metadata from the fixed Development database, generates a cryptographically random credential, stores it in OS Secret Service first, and then supplies the JSON through hidden stdin to Wrangler's Development secret binding `DEVELOPMENT_AUTOMATION_CREDENTIAL`. Wrangler output is captured and discarded. Errors are fixed messages without provider details.

If the Cloudflare write fails, rerun the same command. Matching OS key metadata reuses the stored credential, so a retry does not silently change the secret. A mismatch fails closed and requires deliberate rotation recovery. Never delete the OS item simply to bypass this guard.

## Requests

Use `getAutomationFetch()` from `scripts/development/automation-client.mjs`. Mark only approved machine requests with `x-motorbaldi-automation-intent: true`. The adapter removes this marker, signs Admin Development `/api/v1` requests, and forwards them to the fixed API Development host. It rejects cookies and existing authorization for machine requests, preserves idempotency keys, sets the trusted Admin origin, and refuses redirects. Unmarked requests remain unsigned.

Each attempt gets a fresh timestamp and nonce. Retrying a mutation retains the same idempotency key and exact body while receiving a new signature. The signature binds method, exact path and query, and SHA-256 of exact body bytes. Runtime transport errors expose a fixed message only.

## Revocation and rotation

Revoke the dedicated identity immediately with:

```sh
node scripts/development/automation-key.mjs --revoke
```

This reads the current fixed Development identity and changes only its matching active key/version to `REVOKED`, with audit and security evidence. API active-key checks reject its signed requests immediately. Removing a local OS item alone does not revoke the Worker credential. Revocation does not read or print the secret.

Rotate an active, revoked, or expired identity with:

```sh
node scripts/development/automation-key.mjs --rotate
```

Rotation requires the existing OS key ID and version to match Development D1. It generates a new random secret with the same key ID and next version, stores it in OS Secret Service first, then changes D1 with a compare-and-swap against the exact metadata snapshot. Successful rotation activates the new version for 90 days and records audit and security evidence before installing the Worker binding through hidden stdin. Old Worker credentials fail the current-version check during this transition.

If the D1 operation fails after OS storage, rerun `--rotate`: an OS version exactly one ahead of D1 is recognized as the pending rotation, and the same stored secret is reused. Other mismatches fail closed. If D1 succeeds but the Cloudflare secret write fails, rerun ordinary provisioning:

```sh
node scripts/development/automation-key.mjs
```

Ordinary provisioning reuses the now-matching OS credential and does not increment the version. Do not delete or reset the OS item to bypass any mismatch, and do not rerun `--rotate` after a confirmed D1 update merely to retry the Cloudflare write. All lifecycle commands use fixed Development targets, reject environment credential injection, capture provider output, and expose only fixed sanitized results. No secret is accepted through arguments, environment variables, files, logs, or shell history.

## Autonomous validation

```sh
node scripts/development/authentication-smoke.mjs
node scripts/parts/development-smoke.mjs
node scripts/parts/check-consistency.mjs
node scripts/development/check-consistency.mjs
```

Each routine reuses OS-backed signing. The Parts full smoke enables only the owner-approved existing fixture capability, uses its own synthetic resources, preserves historical snapshots and revokes temporary grants after cleanup. Wait for the existing outbox relay/Queue before positive consistency checks; pending events never count as verification.
