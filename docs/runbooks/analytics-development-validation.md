# Development operational analytics validation

Use the existing Development automation identity and OS Secret Service credential described in [the authentication runbook](development-automation.md). Do not use human passwords, cookies or authenticator codes. Staging/Production authentication is unchanged. No new credential or permission is required; global Queue reports deliberately deny the machine.

Run from the repository root after the local gate and explicit Development deployment:

```sh
node scripts/analytics/development-smoke.mjs
node scripts/analytics/check-consistency.mjs
```

Both commands use read-only authenticated reports, retain no report data and output fixed sanitized diagnostics. They verify anonymous and foreign-scope denial, machine Queue denial, GET-only/strict queries, no-store and strict count-only owned-synthetic DTOs. Existing immutable synthetic Parts and marketplace fixtures provide positive evidence: archived canonical, inactive offering and suspended listing counts. No additional organization, capability, preference, resource mutation or cleanup is needed for these reports.

Compare each authenticated count with independently queried captured Development D1 aggregates, including currently eligible reviewed discovery. Missing D1 results, absent positive fixture evidence or any count mismatch fails. Then run the existing Parts, marketplace and automation consistency probes for immutable audit/history/outbox, actual processed Queue events, signing security evidence, fixture cleanup and global foreign-key/pending/dead-letter constraints. Empty or pending evidence never becomes PASS. Queue-wide private API counts are verified with actual human MFA locally; remote automation remains denied and remote Queue consistency uses the existing authorized Cloudflare D1 probes.

Bounded transient read retries use a fresh signed nonce through the existing client; they cannot create resources or mutate preferences. Unknown errors, child-process output, raw response bodies, identifiers and credentials remain withheld. Reporting failures do not authorize stale cached values or wider permissions. Source evidence retention remains unchanged; reports have no persistence, exports, profiling or financial estimates.

MB-P9-005 becomes VERIFIED only after these remote checks, the relevant security/regression tests, `pnpm gate` and exact implementation CI pass. Separately parked Wompi and antimalware verification is neither enabled nor satisfied by reporting.
