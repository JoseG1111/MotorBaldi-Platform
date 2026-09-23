# ADR 0016 - D1 Migration Strategy

Status: Accepted.

Wrangler D1 migrations in `migrations/` are authoritative. CF-0 does not ship an app migrator, migrator container or server-side migration runner.

Local application command: `pnpm d1:migrate:local`.

Remote migrations are manual-only after resources exist: `wrangler d1 migrations apply <database> --remote --config apps/api/wrangler.jsonc`.
