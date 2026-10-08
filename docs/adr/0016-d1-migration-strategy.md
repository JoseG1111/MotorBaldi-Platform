# ADR 0016 - D1 Migration Strategy

Status: Accepted.

Wrangler D1 migrations in `migrations/` are authoritative. CF-0 does not ship an app migrator, migrator container or server-side migration runner.

Local application command: `pnpm d1:migrate:local`.

At CF-0, remote migrations were manual-only after resources existed. Subsequent approved Development execution may apply non-destructive migrations autonomously after inspecting the target and selecting `--env development` explicitly. Destructive migrations and Production operations remain human-action boundaries. Use `wrangler d1 migrations apply <database> --remote --env <environment> --config apps/api/wrangler.jsonc` only after verifying the target.
