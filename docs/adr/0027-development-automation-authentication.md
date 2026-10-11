# ADR 0027 — Dedicated Development automation authentication

- Status: Accepted
- Date: 2026-10-10
- Authority: Explicit owner directive authorizing dedicated non-interactive Development authentication and PARTS on the existing Development Validation Workshop.

Human MFA and privileged-session assurance remain required for human administrators. Development validation uses a separate passwordless IAM account with a distinct machine assurance; it never reports human MFA, creates a human session, or receives PLATFORM_SUPERADMIN. Staging and Production cannot configure or accept this mechanism.

Requests carry HMAC-SHA-256 signatures bound to method, exact path/query, timestamp, nonce and exact body digest. Sixty-second freshness and persisted unique nonces prevent replay; a retry signs a new nonce while preserving the command's body and idempotency key. The credential lives only in unlocked local OS Secret Service and the Development Cloudflare secret binding. D1 holds public key/version, revocation, expiry and fixed fixture scope. Missing, inconsistent, expired or revoked configuration fails closed.

The fixed machine roles permit canonical Parts editing and synthetic vehicle creation, plus Parts and Workshop management at the existing named verified synthetic organization/site. Route and command allowlists, current permissions, explicit ownership claims and mutation-time database guards restrict authority to synthetic resources created by that identity. The dedicated fixture command adds only PARTS and preserves every existing capability. Resource ownership cannot adopt existing customer data or be reassigned. Password credentials, human sessions, MFA factors, unrelated roles and broader organization scopes are prohibited for this identity.

The API audits authenticated and denied activity. Coordinator contexts bind account, current credential version, command operation and canonical body hash; authorization precedes replay. Business effects, ownership, domain audit, outbox and replay receipts commit atomically. Synthetic historical records, cancelled orders, inactive offerings, archived canonical references and price snapshots preserve immutable evidence. Temporary vehicle grants are revoked after validation.

Initial provisioning, rotation and revocation use fixed Development commands with captured provider output and private stdin. Provisioning stores the credential locally before installing the Worker secret; retries reuse matching material. Rotation invalidates the previous version, records audit/security evidence and fails closed during an incomplete rollout. A locked/unavailable OS collection or unavailable Cloudflare control-plane authorization remains a genuine external boundary; routine validation requires no human password, cookie or TOTP.

Future checkpoints reuse the signed client and extend explicit synthetic scope only when the owner-approved business contract requires it. They do not inherit unrestricted administrator access. See [Development automation runbook](../runbooks/development-automation.md).
