# Release rollback and recovery

Development has deployed evidence in docs/ai; Staging and Production have not been authorized or provisioned. This is an executable preparation checklist, not a claim that a recovery drill passed. `pnpm release:readiness` performs read-only local inventory and cannot authorize a release or restore.

## Application rollback

1. Identify the exact current environment, Worker versions, Git/artifact hashes, applied migration set and immutable environment metadata before choosing a rollback version. Preserve separate API/Worker/Portal/Admin boundaries and correct origins/cookies/provider environments.
2. Disable separately authorized external effects before maintenance: Production payments, notification email/WhatsApp release, controlled test permits and auth-email sending. Preserve evidence of prior settings; never copy Development keys/data into Production. Do not replay ambiguous payment or message attempts.
3. Select a previously verified version compatible with the **current** D1 schema and event contracts. A prior green CI alone does not establish schema compatibility. Use the existing Cloudflare version/rollback interface only after the appropriate environment authorization; no script in this batch performs that operation.
4. Validate unauthenticated denial, ordinary login/logout, privileged MFA, tenant isolation, history reads, provider environment rejection, notification policy closure and Queue/outbox convergence. Record deployed versions and actual smoke results. Keep payments/messages disabled when evidence is ambiguous.
5. Resume only explicitly authorized effects after current merchant/template/sender/consent and financial/dispatch reconciliation. Re-enable nothing merely because HTTP health passes.

## Database, storage and Queue recovery

D1 is canonical. Prefer forward-fix migrations; immutable financial/domain history cannot be erased to make a test or release pass. Never run destructive/down-migration SQL without separately approved recovery scope and backups. Confirm current Cloudflare recovery capabilities and retention on the actual approved account; approved RPO/RTO and business retention remain owner decisions.

Before a restore, record the intended restore point, resource IDs, environment identity, artifact/schema versions and backup integrity. Pause ingress/writers/cron/Queue consumers as required by the approved procedure; keep external-effect gates closed. Rehearse only in a separately authorized isolated environment using synthetic records, and verify empty/fresh environment identity before loading a fixture. No existing Development data is a Production baseline.

After restoration verify foreign keys, tenant ownership, subscriptions/periods/payment confirmations, immutable financial/audit histories, outbox aggregate versions, receipts/leases, notification dispatch/status reservations and private R2 object associations. A historical D1 restore can lose evidence of externally accepted payments/messages: do **not** automatically resend lost reservations or recreate charges. Quarantine uncertain effects, reconcile real provider evidence against original merchant/reference/amount/currency/customer records, and require operator review where original evidence cannot be recovered. Provider acceptance and delivery are distinct.

R2 must remain private; restoring objects must preserve quarantine/scan/authorization metadata and no public ACL. Queue duplication is expected; receipts and consumers must remain idempotent. Review unresolved dead letters with current authorization and original payload integrity; never bulk-clear or manufacture processed receipts.

Acceptance requires an actually executed restore/rollback drill, measured recovery time/loss against approved objectives, data-integrity and cross-tenant checks, no duplicate external effects, operational alert evidence, deployment identifiers and final owner release authorization. None of those remote recovery results was produced by local manifest validation.
