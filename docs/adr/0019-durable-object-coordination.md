# ADR 0019 - Durable Object Coordination

Status: Accepted.

Durable Objects are used only for strong coordination atoms: idempotency by `scope + key` and outbox relay ownership. They are not a replacement for D1 canonical persistence.

D1 stores replay records and outbox state durably. Durable Objects serialize concurrent operations.
