# Incident Response

Use Cloudflare Worker logs/traces and structured application events. Never paste secrets, cookies, authorization headers or private document contents into incident notes.

Initial checks:

- API `/health` confirms Worker response.
- API `/health/dependencies` confirms D1 and environment identity.
- Queue issues are recovered from D1 outbox state.
- R2 failures keep files quarantined or unavailable; no public fallback is allowed.
- Scanner unavailability is surfaced as `SCANNER_UNAVAILABLE`.

Do not clear D1 outbox, queues or R2 objects to resolve an incident without a written recovery plan.
