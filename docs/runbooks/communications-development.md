# Development communications validation

Use only the existing Development deployment and an existing Admin session that has completed MFA and holds `SUPPORT_AGENT` or `PLATFORM_SUPERADMIN`. The session must belong to an active account/person. This procedure creates no sessions, credentials, providers, files or paid resources.

The script reads the existing session cookie from stdin and keeps it in process memory. Never place a cookie in chat, a command argument, an environment variable, a repository file, a temporary file, a log or an evidence document. Disable shell tracing and enter the cookie through the hidden local prompt below. Use an already available session; if it has expired, its account holder must complete normal browser sign-in and MFA first.

```bash
node scripts/communications/development-smoke.mjs --anonymous
set +x
IFS= read -r -s -p 'Existing assured Development Admin cookie: ' communication_session
printf '\n'
printf '%s' "$communication_session" | node scripts/communications/development-smoke.mjs --verify-only
printf '%s' "$communication_session" | node scripts/communications/development-smoke.mjs
unset communication_session
```

`--anonymous` checks health, denies private inbox/preferences/customer and staff support lists, and checks deployed Portal/Admin communication assets. `--verify-only` performs GET requests only: it verifies the existing session's MFA, private preferences/inbox, support lists and available case details, plus an owner inbox cursor when an item exists.

The authenticated smoke toggles the transactional in-app preference, checks replay/mismatch, then restores the original enabled setting using current CAS state. Restoration also runs after an ambiguous first write. An unexpected concurrent preference change is preserved and reported as a failure. The smoke creates two explicitly synthetic general support cases: customer creation/reply, staff self-assignment/reply, customer closure and a linked follow-up that is also closed. It checks replay, stale versions and terminal mutation denial. The two closed cases and their audit/history/outbox records remain as Development evidence. It reads an existing inbox item and replays that read if one is available. Output includes only fixed status messages and request counts, never identity or response bodies.

An empty inbox prints an explicit skip. This is **not** complete positive remote notification validation. If no genuine synthetic membership event has previously materialized an inbox item, the existing bounded billing smoke can generate authoritative synthetic membership events and perform its own cleanup using the same existing session:

```bash
set +x
IFS= read -r -s -p 'Existing assured Development Admin cookie: ' communication_session
printf '\n'
printf '%s' "$communication_session" | node scripts/billing/development-smoke.mjs
printf '%s' "$communication_session" | node scripts/communications/development-smoke.mjs
unset communication_session
```

That prerequisite retains synthetic billing history according to the existing billing smoke. Do not insert a fabricated inbox event, claim an email/SMS/WhatsApp delivery, enable a payment provider or manufacture a session outside normal authentication. Record notification materialization separately from general support and preference success. If the existing assured session is unavailable, the exact human action is to supply that existing cookie at the hidden local stdin prompt; authenticated closeout remains unverified until successful evidence exists.

## Evidence status

On 2026-10-10, Node syntax checking and focused ESLint passed locally. The remote anonymous run passed health, four protected reads and four UI asset checks: `requests=9; mutation_requests=0`. Authenticated GET-only and mutation smoke are prepared but **not remotely verified** by this runbook. Existing local API/domain/security gate evidence does not replace those remote checks. Update execution evidence only after the corresponding mode passes, retaining any positive-notification skip as outstanding.
