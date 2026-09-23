# ADR 0018 - Cloudflare Queues

Status: Accepted.

Cloudflare Queues replace Redis/BullMQ as the async transport. D1 outbox remains the source of truth for event state, attempts, availability, errors and recovery.

Delivery is at least once. Duplicate queue delivery is expected and consumers must be idempotent.
