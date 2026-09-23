# Rollback

CF-0 does not deploy remotely. Future rollback uses Cloudflare Worker version rollback after verifying the target version against the current D1 schema.

Data migrations follow forward-fix preference. Do not run destructive D1 SQL without an approved recovery plan and backup/export strategy.

Outbox events remain canonical in D1. Duplicate queue delivery is expected after rollback and consumers must stay idempotent.
