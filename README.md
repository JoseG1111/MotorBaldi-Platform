# MotorBaldi Platform

This repository does NOT contain the public marketing website.

MotorBaldi Platform is the transactional foundation for API, portal, admin, background workers, data, storage, queues, auth, authorization, tests and architecture documentation. The public website/marketing repo remains separate.

Target runtime: Cloudflare Workers, D1, R2, Queues, Durable Objects, Workers Rate Limiting, Turnstile and Worker secrets.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Wrangler 4+

## Local Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm d1:migrate:local
pnpm dev:api
```

Local development uses Wrangler local storage for D1, R2, Queues and Durable Objects. Postgres, Redis, MinIO and Docker are not required for CF-0 Foundation.

## Tests And Builds

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:workers
pnpm openapi:check
pnpm boundaries:check
pnpm security:check
pnpm build
```

`pnpm build` uses `wrangler deploy --dry-run` only. It must not create remote resources or deploy.

## Manual Cloudflare Setup Status

No remote Cloudflare resources are provisioned by this repo. The owner will create resources manually later. See:

- [RESOURCE_INVENTORY.md](docs/cloudflare/RESOURCE_INVENTORY.md)
- [MANUAL_ACTIONS.md](docs/cloudflare/MANUAL_ACTIONS.md)
- [REPOSITORY_SPLIT.md](docs/architecture/REPOSITORY_SPLIT.md)
