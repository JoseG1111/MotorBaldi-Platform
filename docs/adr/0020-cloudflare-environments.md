# ADR 0020 - Cloudflare Environments

Status: Accepted.

The Foundation models `local`, `development`, `staging` and `production`. Each D1 database has exactly one row in `governance_environment_metadata`.

API and worker compare Worker `ENVIRONMENT` with D1 metadata and fail closed on mismatch.
