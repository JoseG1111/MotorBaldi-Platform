# ADR 0020 - Cloudflare Environments

Status: Accepted.

The Foundation models `local`, `development`, `staging` and `production`. Each D1 database has exactly one row in `governance_environment_metadata`.

API and worker compare Worker `ENVIRONMENT` with D1 metadata and fail closed on mismatch.

Top level Wrangler configuration means local execution. Named `development` is a remote development deployment; it is never used as a synonym for local Wrangler. After migrations, one explicit `d1:init:<environment>` command inserts the singleton only when absent and verifies it without overwriting a different identity. Runtime verification is cached per isolate after success because metadata is database immutable.
