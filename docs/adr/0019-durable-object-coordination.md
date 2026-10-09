# ADR 0019 - Durable Object Coordination

Status: Accepted.

Durable Objects are used only for strong coordination atoms: idempotency by `scope + key` and outbox relay ownership. They are not a replacement for D1 canonical persistence.

D1 stores replay records and outbox state durably. Durable Objects serialize concurrent operations.

Durable Object classes use Wrangler declarative `exports` with SQLite storage because no namespace migration history exists. The idempotency coordinator accepts a registered operation name and data, executes the server registered command inside its serialized boundary, then stores the D1 replay. Clients cannot submit executable behavior. Expired keys may be reclaimed with a conditional D1 upsert.

For `crm.lead.create`, the lead intake, outbox event, and D1 replay record now commit in one D1 batch under the same coordinator serialization. Vehicle Core commands also batch business changes, audit, event and replay, with a dependent audit guard for replay collisions and lost compare-and-swap updates. Other registered commands still store the replay after their business effect; that generic crash window remains technical debt for a later foundation hardening checkpoint before financially sensitive Wompi operations.

Crash models are explicit: a D1 only command uses one D1 atomic mutation pattern; an external idempotent provider receives a deterministic provider key; an external reconcile required command records an unknown outcome for reconciliation. The system does not claim external exactly once execution.
