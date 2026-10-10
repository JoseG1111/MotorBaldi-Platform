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

The authenticated smoke toggles the transactional in-app preference, checks replay/mismatch, then restores the original enabled setting using current CAS state. After an ambiguous first write, one retry with the original key/body recovers the authoritative receipt before restoration; the restoration command also has one bounded same-key recovery attempt. Restoration verifies the saved setting and exact expected version, without deleting retained history. An unexpected concurrent preference change is preserved and reported as a failure. Expected-success support and inbox mutations recover an ambiguous response once with the identical command key/body. Replays compare response fields independently of JSON property order. Persistent failures can retain partial support history; diagnostics report only the count of known unclosed test cases and whether an outcome is unknown. Never find cleanup targets by subject matching or close an unconfirmed/concurrently changed case. Repeating a successful full run intentionally creates another pair of retained synthetic cases.

The smoke creates two explicitly synthetic general support cases: customer creation/reply, staff self-assignment/reply, customer closure and a linked follow-up that is also closed. It checks replay, stale versions and terminal mutation denial. The two closed cases and their audit/history/outbox records remain as Development evidence. It reads an existing inbox item and replays that read if one is available. Failures report a fixed step label, numeric HTTP status (or `none`) and an allowlisted error code. Transport failures use `TIMEOUT`, `ABORTED` or `TRANSPORT_ERROR`; malformed responses use `INVALID_RESPONSE`; unknown server codes become `HTTP_ERROR`. Primary and restoration failures are retained separately. Output never includes paths containing record IDs, identities, credentials or raw response bodies. A failure does not prove that a mutation was rolled back: review aggregate D1 state before retrying.

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

On 2026-10-10 recovery, the existing assured session passed GET-only (`requests=14; mutation_requests=0`) and authenticated mutation runs. Both the original and revised scripts passed full mutations on retry; the historical generic failure cannot be reconstructed, and one diagnostic attempt observed a client TypeError before health. The initial remote baseline had zero Communications preferences, cases, messages, history, related audit and outbox rows: no persisted Communications effects from the reported failed run were observed. Later successful tests intentionally retained four closed synthetic cases, restored transactional in-app preference enabled at version4, and all 18 related events reached PROCESSED. Positive inbox materialization was initially skipped and remains a separate required closeout check; see the current execution cursor for final evidence. No deployment is necessary for a local harness-only change.

Final recovery smoke passed `requests=44; mutation_requests=21`, including a genuinely populated inbox and permitted read/replay. D1 confirmed enabled preference restored at version6, six closed cases with closing metadata, 12 messages/21 history records, three inbox items/one read and matching audits/replay references. Full local gate passed 510 tests, including 31 harness regressions. Final new Queue events and current-revision CI are still required before checkpoint closeout. The billing prerequisite supplied genuine source events and safely cleaned up, but failed its complete smoke assertion; no full billing PASS is claimed.
