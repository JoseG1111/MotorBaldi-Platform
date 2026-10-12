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

## Verified recovery evidence — 2026-10-10

The initial D1 baseline had zero Communications preferences, cases, messages/history and related audit/outbox rows: no persisted Communications effects from the reported failed run were observed. The historical generic failure cannot be reconstructed. Original and revised full mutation retries both passed; one diagnostic attempt observed a pre-health client TypeError. The fixed harness adds actionable diagnostics and bounded recovery without claiming a proven historical API defect.

The existing assured session passed GET-only (`requests=14; mutation_requests=0`) and final full smoke (`requests=44; mutation_requests=21`). Full smoke included genuine populated-inbox pagination/read replay, preference restoration and customer/staff lifecycle/replay/CAS/terminal-state checks. D1 confirmed enabled preference restored at version6, six intentionally retained CLOSED synthetic cases with closing metadata, 12 messages/21 history records, three genuinely sourced inbox items/one read and consistent source/audit/command/replay references.

All 132 outbox events reached PROCESSED (31 notification/support), with zero pending/processing/dead events, duplicate inbox items or unresolved dead letters. The billing prerequisite supplied genuine membership-change source events and confirmed suspension/no coverage/renewal off; its full smoke assertion failed and is not reported PASS. No fabricated inbox event, external delivery or financial-provider success was used to close this checkpoint.

Communications gate passed 510 tests, including 31 harness regressions; code 3a1aac1 passed CI 38079787670. Final integrated fc41e52 passed [CI 38080249129](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/38080249129), including 514 tests, artifact and history secret scans. MB-P6-005 is VERIFIED for internal notifications/general support; external delivery and premium assistance remain disabled. No runtime deployment was necessary for these harness/test/documentation changes.

## Selected providers and safe Development preparation — 2026-10-12

Owner selected Resend for email and Meta WhatsApp Cloud API for automated WhatsApp. Human MotorBaldi WhatsApp assistance remains a separate staffed click-to-chat/support workflow with unlimited eligible Premium requests. No additional provider/dependency was introduced, no paid activation or external send occurred.

The selected adapters support fixed Spanish vehicle-expiry notifications, explicit channel preferences/verified contacts/current entitlement and latest vehicle dates. Provider acceptance is not delivery. A canonical D1 dispatch reservation precedes HTTP; ambiguous/crashed sends are quarantined rather than blindly repeated. This protects beyond Resend's documented24-hour key retention. Known-ID Resend reconciliation is acceptance-only; signed status webhooks establish sent/delivered/read/failed evidence separately. Meta does not advertise provider idempotency/reconciliation. Queue infrastructure retries remain bounded; permanent/ambiguous provider outcomes are not silently resent. Body hashes/provider IDs/status are retained without copying recipient/content to the delivery ledger.

### Resend owner setup

1. Use the existing authorized Resend account. Confirm permitted zero-cost Development testing/quota; no paid plan activation is authorized.
2. Select an owned sending domain/address and complete the DNS verification shown by Resend (DKIM/SPF). DNS changes must be performed by the owner through the existing DNS management process; this run makes none. Do not claim verification from a local flag alone. See [official domain instructions](https://resend.com/docs/dashboard/domains/introduction).
3. Configure RESEND_API_KEY on the Development Worker through Cloudflare secret management or hidden local Wrangler input. Configure RESEND_FROM and RESEND_DOMAIN_VERIFIED only after actual verification. Configure RESEND_WEBHOOK_SECRET on the Development API, with callback https://motorbaldi-api-development.josegbarrios2.workers.dev/api/v1/notifications/providers/resend/events. Use the real webhook signing secret; never place it in chat/files/arguments.
4. Keep NOTIFICATION_EXTERNAL_DELIVERY_ENABLED unset/false. Existing notification_policy remains hard-closed (external_delivery_enabled=0). Actual activation requires resuming VS007 after authorized account/quota/recipient verification; that checkpoint must deliberately amend the closed policy and execute real controlled acceptance/delivery/retry evidence. Merely adding a key does not send messages.

### Meta owner setup

Use the existing authorized Meta development app and its test phone/allowlisted recipient; no live business number is required for independent code/testing. Configure Worker secrets META_WHATSAPP_ACCESS_TOKEN and operator settings META_WHATSAPP_PHONE_NUMBER_ID, META_WHATSAPP_API_VERSION, META_WHATSAPP_APPROVED_TEMPLATE, META_WHATSAPP_TEMPLATE_LANGUAGE. The approved Spanish utility template must contain three body parameters in order: document type, declared expiry date and days remaining. Verify actual template approval; do not infer it from a configured name. Ensure recipient opt-in and provider test/billing constraints before any authorized test.

Configure Development API META_WHATSAPP_APP_SECRET, META_WHATSAPP_PHONE_NUMBER_ID and META_WHATSAPP_WEBHOOK_VERIFY_TOKEN securely; callback https://motorbaldi-api-development.josegbarrios2.workers.dev/api/v1/notifications/providers/meta/events. GET performs configured subscription verification; POST verifies HMAC on bounded raw bytes and accepts status evidence only for the configured phone ID. Inbound personal messages/media are not stored. Never enable automatic sending or paid service from provider selection alone. Human-team WhatsApp is unaffected by missing automated API credentials.

Primary protocol references: [Resend send API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [Svix signature verification](https://docs.svix.com/receiving/verifying-payloads/how-manual), [Meta-owned send example](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive), [Meta status objects](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object), [Meta-owned HMAC sample](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/blob/main/CONTRIBUTING.md). External credentials/account/template/domain/delivery verification remain unavailable, never VERIFIED by mocked protocol tests.

## Meta pending-template recovery — 2026-10-12

Owner reports Development app `2211755326884841`, WABA `3073715739631435`, Graph `v26.0`, active subscription/messages field, verified HTTP200 callback and Cloudflare system-user token. Template `motorbaldi_recordatorio_vencimiento`, language `es`, is **PENDING**, not approved. This is operator evidence, not independent token/asset inspection. Anonymous live callback GET/POST without verification/signature credentials both return403: configured guards reject unauthorized requests. Cloudflare names-only secret inventory could not run in this workspace because Wrangler authentication is unavailable. Neither token permissions nor template approval are inferred from those responses.

New fail-closed Worker bindings: `META_WHATSAPP_TEMPLATE_STATUS` must equal `APPROVED`; `META_WHATSAPP_TEST_RECIPIENT_SHA256` must contain one to five comma-separated lowercase SHA256 hashes of exact normalized `+E164` test recipients, without spaces. Missing/invalid settings or PENDING/REJECTED/PAUSED/DISABLED templates make the adapter unavailable. Nonallowlisted recipients are rejected before HTTP. These settings are preparation, not approval proof; keep template status PENDING now and `NOTIFICATION_EXTERNAL_DELIVERY_ENABLED` unset/false. D1 external policy remains0. No bindings were changed or production deployment performed.

### Read-only token/template verification

Restore authorized Cloudflare login locally with `pnpm exec wrangler login`, then inspect names only with `pnpm exec wrangler secret list --config apps/worker/wrangler.jsonc --env development` and the equivalent API configuration. Deploy the prepared Worker guards after restoring access with `pnpm exec wrangler deploy --config apps/worker/wrangler.jsonc --env development --keep-vars`; the flag preserves owner-configured dashboard variables. Keep template status PENDING and sending disabled. This deploy was not possible in the current unauthenticated workspace. A listed secret cannot prove its scopes or value. Cloudflare does not reveal stored secret values; do not add a token-extraction endpoint.

Run locally in an interactive terminal:

```bash
python3 -B scripts/communications/meta-development-preflight.py
```

Enter the authorized Development system-user token and same Development app secret at hidden prompts, the test phone-number **ID** at the local nonsecret prompt, and the opted-in test recipient invisibly. No values go into command arguments, environment variables, source files or logs. The tool performs only bounded GET requests to fixed Graphv26.0 endpoints, refuses redirects/pagination URLs, suppresses raw provider errors and prints only permission/app/type booleans, template contract/approval booleans and recipient hash. Token inspection requires `whatsapp_business_messaging` and `whatsapp_business_management`, correct app and valid SYSTEM_USER token; read access independently checks phone membership in WABA and app subscription. `business_management` is not demanded for unrelated business-portfolio operations. No HTTP send is performed to prove a permission. A failed/missing scope or asset access remains unresolved, not an invitation to grant unrelated permissions.

The template must be UTILITY with exactly three BODY parameters in order: document type, declared expiry date, days remaining. PENDING produces an honest incomplete result. App subscription does not itself prove the messages field setting; retain the owner's dashboard evidence separately. Meta test-recipient allowlisting is not proved by token scopes or a WABA read: independently confirm the exact test phone/recipient in Meta's API Setup UI. A matching local hash is an additional restriction, not proof of Meta allowlisting or customer consent.

### Controlled end-to-end procedure after approval

1. Obtain actual APPROVED template evidence, rerun the read-only preflight successfully, restore authorized Cloudflare access and confirm Worker/API bindings match the reported app/WABA/phone/version/template/language. Verify the actual template's three-parameter contract; never mark a pending template APPROVED locally to bypass Meta.
2. Confirm the permitted no-cost Development/test-number conditions before any test. Retain separate explicit recipient opt-in and Meta API Setup recipient-allowlist evidence. Use one authorized test account with verified owned phone, saved enabled TRANSACTIONAL/WHATSAPP preference, valid Premium entitlement, OWNER relationship and canonical vehicle.read grant. No fabricated customer consent/verified phone or human MFA bypass.
3. Keep **general delivery disabled**. The current D1 `notification_policy.external_delivery_enabled` CHECK0 and global switch deliberately prohibit external sends. Do not edit the applied migration, flip the global switch/policy or directly call Graph messages outside canonical tracking. Real E2E requires a separately reviewed, narrowly scoped, expiring test dispatch permission for the exact synthetic reminder(s), channel and recipient while general policy remains closed. Such a permit is not implemented/activated by this preparation and is a remaining engineering prerequisite; resume VS007 to implement it after account/template/recipient evidence is available. Approval alone does not unlock cron sending.
4. Through authorized canonical vehicle/document commands record synthetic SOAT and RTM revisions due at an approved reminder interval on the Colombia calendar. Do not overwrite terminal UNAVAILABLE receipts or replay old stale reminders to simulate a fresh send. Schedule through the actual cron/outbox/Queue and select only those newly generated references for the controlled permit.
5. Before HTTP, require unchanged consent/contact verification, current Premium/coverage/ownership/grant, current document revision/date and the exact test-recipient hash. Verify one dispatch reservation per source event and ACCEPTED only for a shaped Meta `wamid`. Capture only reference/status/audit metadata; never persist token or raw message/phone in QA evidence.
6. Verify the actual signed Meta callback reaches the canonical API and matches configured phone ID, provider message reference and dispatch reservation. Observe SENT/DELIVERED status separately from acceptance. READ is optional and must not be required if recipient read receipts are unavailable. Retain normalized status evidence; duplicate callbacks/Queue processing must not produce another send, and late statuses must not regress stronger evidence. Test failure ordering/replay/ambiguous transport using mocks, rather than deliberately sending extra paid messages.
7. Close/remove the scoped permit immediately, confirm global policy remains0 and sending disabled, disable synthetic preferences/revoke fixture access as appropriate while preserving immutable audit/outbox/status history. Mark only actually observed channel/stage VERIFIED. Email, monthly automatic summary delivery and Wompi remain separate boundaries.

Until approval and the above prerequisites, only mocked acceptance/status tests and internal generation are verified. A webhook200 or processed outbox is not E2E delivery evidence. The preflight uses Meta's [official API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), not an additional provider.
