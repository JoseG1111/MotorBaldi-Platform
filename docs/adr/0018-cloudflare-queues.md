# ADR 0018 - Cloudflare Queues

Status: Accepted.

Cloudflare Queues replace Redis/BullMQ as the async transport. D1 outbox remains the source of truth for event state, attempts, availability, errors and recovery.

Delivery is at least once. Duplicate queue delivery is expected and consumers must be idempotent.

An event transition to `DEAD` and its operational dead letter are written in one D1 batch, including expired lease recovery. Provider calls receive the immutable event ID as their idempotency key. An unknown result for a reconcile required provider becomes `DEAD`; no external exactly once guarantee is claimed. Future D1 mutations must batch the business statement with `outboxStatement()`.
