# Cloudflare Resource Inventory

No remote resource or ID has been created. Every `REPLACE_WITH_*` value is a deliberate placeholder that must be replaced manually before a remote command can run.

| Resource          | Development                     | Staging                         | Production                     | Bindings and consumers                                                                 |
| ----------------- | ------------------------------- | ------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| API Worker        | `motorbaldi-api-development`    | `motorbaldi-api-staging`        | `motorbaldi-api-production`    | Public Foundation routes; D1, R2, Queue producer, two DO namespaces, two rate limiters |
| Background Worker | `motorbaldi-worker-development` | `motorbaldi-worker-staging`     | `motorbaldi-worker-production` | D1, private R2, Queue producer/consumer, Outbox DO, cron                               |
| Portal Worker     | `motorbaldi-portal-development` | `motorbaldi-portal-staging`     | `motorbaldi-portal-production` | `API_SERVICE` only                                                                     |
| Admin Worker      | `motorbaldi-admin-development`  | `motorbaldi-admin-staging`      | `motorbaldi-admin-production`  | `API_SERVICE` only                                                                     |
| D1                | `motorbaldi-core-dev`           | `motorbaldi-core-staging`       | `motorbaldi-core-prod`         | `DB` on API and background Worker                                                      |
| Private R2        | `motorbaldi-private-dev`        | `motorbaldi-private-staging`    | `motorbaldi-private-prod`      | `PRIVATE_BUCKET` on API and background Worker                                          |
| Queue             | `motorbaldi-events-dev`         | `motorbaldi-events-staging`     | `motorbaldi-events-prod`       | API/background producers; background consumer                                          |
| Queue DLQ         | `motorbaldi-events-dlq-dev`     | `motorbaldi-events-dlq-staging` | `motorbaldi-events-dlq-prod`   | Background consumer dead letter target                                                 |
| Idempotency DO    | declarative SQLite export       | declarative SQLite export       | declarative SQLite export      | `IDEMPOTENCY_COORDINATOR` on API                                                       |
| Outbox DO         | declarative SQLite export       | declarative SQLite export       | declarative SQLite export      | `OUTBOX_COORDINATOR` on API; service binding on background Worker                      |
| API rate limiter  | namespace policy 120/min        | namespace policy 120/min        | namespace policy 120/min       | `API_RATE_LIMITER` on API                                                              |
| Auth rate limiter | namespace policy 10/min         | namespace policy 10/min         | namespace policy 10/min        | `AUTH_RATE_LIMITER` on API                                                             |
| Turnstile         | manual site/secret              | manual site/secret              | manual site/secret             | Secret on API only; no public protected route in CF-0.1                                |

## Secrets

| Secret                 | API          | Background | Portal | Admin |
| ---------------------- | ------------ | ---------- | ------ | ----- |
| `AUTH_SECRET`          | yes          | no         | no     | no    |
| `AUTH_SECRETS`         | yes          | no         | no     | no    |
| `TURNSTILE_SECRET_KEY` | when enabled | no         | no     | no    |

Public API routes are `GET /health`, `GET /health/dependencies`, `GET /api/v1/openapi.json`, configured Better Auth routes, and authenticated `GET /api/v1/principal`. The Foundation idempotency fixture returns 404 outside local execution. Portal and Admin send same origin `/api/*` requests over `API_SERVICE`; no header can grant internal trust. Future custom domains should keep the apps and their API proxy same origin. Temporary workers.dev testing uses each Portal/Admin origin and its relative proxy, avoiding third party cookies.

Rate limit keys use a network derived signal for unauthenticated auth abuse. Future authenticated routes should use stable actor, tenant, and resource identifiers where available. Rate limiting is abuse control and never business or financial correctness.

SQLite backed Durable Objects and the listed Foundation services are intended to remain compatible with Cloudflare Free plan allowances. Operators must check current plan limits before provisioning; correctness requirements take priority over plan selection.
