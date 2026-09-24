# Historical PostgreSQL Foundation Record

Before CF-0, the Platform foundation targeted managed PostgreSQL, Redis/BullMQ, containerized Node services, and an application migration runner. The useful lessons carried into the Cloudflare design are immutable audit history, database environment identity, outbox based effects, lease fencing, deny by default authorization, private object storage, and explicit external outcome reconciliation.

That implementation was removed because Git history is the authoritative source and retaining runnable migrations, deployment files, and tests created a shadow architecture. ADRs 0014 through 0022 record the active Cloudflare decisions.
