# Manual Cloudflare Actions

Do not run these from CF-0 automation. The owner will perform them manually later.

Missing before remote deployment:

- Cloudflare account subdomain
- D1 `database_id` for each environment
- R2 buckets for each environment
- Queues and DLQs for each environment
- Durable Object migrations deployment
- Rate Limiting binding names
- Turnstile site key and secret
- `AUTH_SECRET` and `AUTH_SECRETS`
- future Worker URLs for API, portal and admin
- production email provider, currently `UNCONFIGURED`
- production malware scanner provider, currently `UNCONFIGURED`

Local commands:

```bash
pnpm d1:migrate:local
pnpm dev:api
pnpm dev:worker
```

Remote commands to run only after resources exist and placeholders are replaced:

```bash
wrangler d1 migrations apply motorbaldi-core-dev --remote --config apps/api/wrangler.jsonc
wrangler deploy --config apps/api/wrangler.jsonc --dry-run
wrangler deploy --config apps/worker/wrangler.jsonc --dry-run
```

Do not use a production NOOP malware scanner. If no real provider is configured, production file scanning must surface `SCANNER_UNAVAILABLE`.
