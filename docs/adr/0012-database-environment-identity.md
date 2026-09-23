# ADR 0012: Database Environment Identity

Status: SUPERSEDED by ADR 0020 for D1 environment identity.

Each Core database owns one immutable row in `governance.environment_metadata`. The migrator writes it when `INITIALIZE_DATABASE_ENVIRONMENT=true` and every API/worker startup checks it with `assertDatabaseEnvironment(APP_ENV)`.

The migration owner uses `MIGRATION_DATABASE_URL`; API and worker use the runtime `DATABASE_URL`. The migrator is the only canonical path for migrations and grants. It validates `APP_ENV`, migration checksums, advisory lock, environment identity and `applyRuntimeGrants()`.

Environment identity is immutable. If the stored value differs from `APP_ENV`, startup and migrations fail closed. A transitional repair is allowed only when `0003_environment.sql` is recorded with the expected checksum, the metadata table exists, it has zero rows and the operator explicitly sets `INITIALIZE_DATABASE_ENVIRONMENT=true`.
