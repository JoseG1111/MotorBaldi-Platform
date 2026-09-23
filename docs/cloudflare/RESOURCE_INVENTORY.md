# Cloudflare Resource Inventory

No IDs are invented here. `database_id`, account subdomain, Turnstile keys and future Worker URLs must be filled after manual Cloudflare creation.

| Type           | Suggested name            | Environment | Binding                 | Worker                        | Secret | Purpose                                      |
| -------------- | ------------------------- | ----------- | ----------------------- | ----------------------------- | ------ | -------------------------------------------- |
| Worker         | motorbaldi-api-dev        | development | n/a                     | API                           | no     | Public API Worker                            |
| Worker         | motorbaldi-worker-dev     | development | n/a                     | worker                        | no     | Queue and scheduled background worker        |
| Worker         | motorbaldi-app-dev        | development | n/a                     | portal                        | no     | Portal shell                                 |
| Worker         | motorbaldi-admin-dev      | development | n/a                     | admin                         | no     | Admin shell                                  |
| D1             | motorbaldi-core-dev       | development | DB                      | API, worker                   | no     | Canonical SQL persistence                    |
| R2             | motorbaldi-private-dev    | development | PRIVATE_BUCKET          | API                           | no     | Private files, quarantine and active objects |
| Queue          | motorbaldi-events-dev     | development | EVENTS_QUEUE            | API producer, worker consumer | no     | Async transport for outbox events            |
| Queue          | motorbaldi-events-dlq-dev | development | n/a                     | worker                        | no     | Queue dead letter transport                  |
| Durable Object | IdempotencyCoordinator    | all         | IDEMPOTENCY_COORDINATOR | API                           | no     | Per scope/key request serialization          |
| Durable Object | OutboxCoordinator         | all         | OUTBOX_COORDINATOR      | API, worker                   | no     | Outbox relay ownership                       |
| Rate Limit     | api-general               | all         | API_RATE_LIMITER        | API                           | no     | General abuse protection                     |
| Rate Limit     | api-auth-sensitive        | all         | AUTH_RATE_LIMITER       | API                           | no     | Auth sensitive abuse protection              |
| Turnstile      | future site               | all         | TURNSTILE_SECRET_KEY    | API                           | yes    | Future anti abuse verification               |
| Secret         | auth secret               | all         | AUTH_SECRET             | API, worker                   | yes    | Better Auth signing                          |
| Secret         | auth keyring              | all         | AUTH_SECRETS            | API, worker                   | yes    | Secret rotation                              |

Repeat resource names with `-staging` and `-prod` for staging and production:

- D1: `motorbaldi-core-staging`, `motorbaldi-core-prod`
- R2: `motorbaldi-private-staging`, `motorbaldi-private-prod`
- Queue: `motorbaldi-events-staging`, `motorbaldi-events-prod`
- DLQ: `motorbaldi-events-dlq-staging`, `motorbaldi-events-dlq-prod`
