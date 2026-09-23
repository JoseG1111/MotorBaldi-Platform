# ADR 0008 — Outbox leases and external effects

Status: SUPERSEDED by ADR 0018 and ADR 0019 for Cloudflare transport and coordination.

Supersedes ADR 0004 execution/retry details. PostgreSQL owns PENDING → PROCESSING → PROCESSED/DEAD, attempts and next availability. BullMQ is disposable wakeup transport (one attempt); periodic relay recovers lost jobs. Relay commits enqueue metadata before Redis. A crash between commit and enqueue delays delivery at most the relay resend interval (30 seconds); Redis failure clears metadata for recovery.

Claim is one atomic UPDATE. Processing token and a 30 second lease fence acknowledgments. External handlers run without an open transaction or DB client; default deadline 10 seconds signals cancellation. A timeout cannot undo an external effect. Providers must honor AbortSignal and support idempotency using the immutable event UUID, or require reconciliation. No claim of external exactly-once is made.

Versioned strict Zod contracts identify aggregate type and external-effect policy. Unknown type/version/payload is permanent failure. RETRYABLE uses bounded exponential backoff with jitter, five attempts maximum. Unexpected exceptions/timeouts are UNKNOWN_EXTERNAL_OUTCOME: only a contract declaring provider IDEMPOTENT can retry. RECONCILE events become DEAD with UNKNOWN_EXTERNAL_OUTCOME and cannot be recovered without an explicit safe-to-retry reconciliation reference. DEAD is both DLQ and the suspended reconciliation state, avoiding a second retry machine. Internal recovery requires caller authorization and appends audit; no recovery endpoint is exposed.

Expired leases recover automatically each relay tick. An idempotent event retries; non-idempotent work goes to reconciliation because a dead process may have already contacted the provider. Stale tokens cannot acknowledge a newer claim. Late handler execution is possible after cancellation; provider idempotency is mandatory for retried irreversible effects. SQL-only future handlers must use their own short transaction with an inbox/dedup record, never rely on receiving an outer transaction.

Migration 0004 preserves historical rows, mapping QUEUED to PENDING and assigning legacy records conservative RECONCILE policy. They lack registered business contracts and fail closed to DLQ for review. No production handlers or events are introduced. The release must stop old workers before applying this protocol change; deployment rollback must use a compatible consumer, not the pre-0004 worker.

Tests use the runtime DB role and simulate Redis failure/lost jobs, duplicate wakeups, concurrency, timeout, all failure classes, lease expiry/fencing, reconciliation, provider-success-before-crash and transaction-free slow I/O.
