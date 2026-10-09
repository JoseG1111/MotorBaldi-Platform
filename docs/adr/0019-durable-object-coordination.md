# ADR 0019 - Durable Object Coordination

Status: Accepted.

Durable Objects are used only for strong coordination atoms: idempotency by `scope + key` and outbox relay ownership. They are not a replacement for D1 canonical persistence.

D1 stores replay records and outbox state durably. Durable Objects serialize concurrent operations.

Durable Object classes use Wrangler declarative `exports` with SQLite storage because no namespace migration history exists. The idempotency coordinator accepts a registered operation name and data, prepares the server registered command inside its serialized boundary, then commits its D1 effects and replay together. Clients cannot submit executable behavior. Expired keys may be reclaimed with a conditional D1 upsert.

Registered D1 commands return prepared statements without committing. The generic transaction orders the conditional replay claim, a dependent append-only `command.accepted` receipt (a zero-change claim deliberately violates NOT NULL), then domain changes/audit/outbox in one D1 batch. Domain compare-and-swap failures roll back replay and all effects. Organization, CRM conversion and person merge compatibility wrappers preserve direct callers; their prepared path is used by the coordinator. Invitation tokens are returned only by the initial successful invocation; stored/replayed responses omit them. Current session/account/permission checks run before authenticated replay retrieval, including fresh MFA where required.

Vehicle, Workshop and Inspection prepared paths retain their established atomic guarded transactions. Public `crm.lead.create` now also uses the common replay-claim receipt guard, preserving its earlier lead/outbox/replay atomicity. The local-only `foundation.test` fixture models an atomic D1 receipt rather than a separate Durable Object counter; it does not claim cross-store atomicity. The unused `identity.account.ensure` registry entry is removed: account reconciliation remains the existing authenticated identity helper, not an unsupported idempotent command.

MB-P5-000 verification is recorded in `docs/ai/EXECUTION_PLAN.md`; completion must be evidenced before enabling financial commands. D1 idempotency keys are retained for the registered TTL; key expiry permits a new invocation, so future financial commands require business/provider identifiers and durable reconciliation beyond a generic replay TTL.

Crash models are explicit: a D1 only command uses one D1 atomic mutation pattern; an external idempotent provider receives a deterministic provider key; an external reconcile required command records an unknown outcome for reconciliation. The system does not claim external exactly once execution.
