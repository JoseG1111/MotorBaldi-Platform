# Manual Cloudflare Actions

This is the original CF-0.1 setup runbook. Development resources and deployments have since been configured; do not repeat creation steps there. Staging and production remain unverified. Check [current execution state](../ai/PROJECT_STATE.md) and target inventory before any remote command. The steps below describe setup or verification where still applicable.

1. Create the four Workers, D1 database, private R2 bucket, event Queue, and Queue DLQ using the inventory names or approved replacements.
2. Replace D1 IDs and future workers.dev/custom domain URL placeholders in every Wrangler environment. Verify every non-inheritable binding remains explicit.
3. Confirm declarative SQLite Durable Object exports and bindings, including the background Worker binding to the environment specific API Worker.
4. Configure `API_RATE_LIMITER` and `AUTH_RATE_LIMITER` namespace policies from Wrangler configuration.
5. Configure Portal/Admin `API_SERVICE` bindings to the matching API Worker.
6. Create separate Turnstile widgets for each deployment environment when approved. Development has a widget and the public lead flow was historically exercised; verify its current state before changing it. Configure `TURNSTILE_SECRET_KEY` as an API Worker secret only, never as a committed Wrangler var. Configure `TURNSTILE_EXPECTED_HOSTNAME` as a non-secret hostname-only API value. Set the website's exact HTTPS origin in `PUBLIC_CORS_ORIGINS`, separately from the Portal/Admin/auth `CORS_ORIGINS`. `TURNSTILE_BYPASS_TOKEN` is local/test-only and forbidden remotely.
7. Add API secrets `AUTH_SECRET` and a versioned `AUTH_SECRETS` keyring. Do not add them to background, Portal, or Admin Workers.
8. Record the final Worker URLs and configure exact HTTPS trusted origins. Keep browser app calls relative through the service binding proxy.
9. Verify D1 migrations, including `0002_phase1.sql` and `0003_phase1_closeout.sql`, and D1 identity before applying any missing migration. The commands below target remote environments explicitly:

```bash
pnpm exec wrangler d1 migrations apply motorbaldi-core-dev --remote --env development --config apps/api/wrangler.jsonc
pnpm d1:init:development
pnpm exec wrangler d1 migrations apply motorbaldi-core-staging --remote --env staging --config apps/api/wrangler.jsonc
pnpm d1:init:staging
pnpm exec wrangler d1 migrations apply motorbaldi-core-prod --remote --env production --config apps/api/wrangler.jsonc
pnpm d1:init:production
```

10. Leave `PUBLIC_SIGNUP` disabled until the intended workflow and outbound email are configured. Development `PUBLIC_LEAD_INTAKE` was historically exercised with Turnstile; inspect the current flag rather than assuming its value. Keep it disabled in any environment until its real widget and integration pass. `ORGANIZATION_CREATION` is also a governance feature flag. Remote signup currently remains disabled in code even when its flag is set because production email delivery is unconfigured.
11. Configure a production outbound email provider in a later approved phase before enabling verification email, password recovery, or automatic invitation delivery. `EMAIL_PROVIDER=DEVELOPMENT_SINK` captures local/test messages only; it is not evidence of remote delivery. Do not set `TURNSTILE_BYPASS_TOKEN` remotely. The public lead endpoint requires a real Turnstile secret and expected hostname.
12. For the first platform administrator, verify an existing personal account, then use the explicit operator script `scripts/phase1/bootstrap-staff.mjs` with the target environment, account ID, reason, and `--execute`. Review the script and D1 target before invoking it. It does not create credentials and is never part of deployment automation.
    For the first **development-only** personal account, run `node scripts/phase1/bootstrap-development-account.mjs development --execute` from an interactive terminal after migrations and D1 environment initialization. It prompts for name, email, and a hidden password, creates the verified Better Auth user, credential, signup consent, and governance events in one D1 import, and prints the account UUID. The existing account reconciliation creates `iam_people` and `iam_accounts` after first login. This script refuses local, staging, and production and is never a production account creation mechanism. Do not pass a password on the command line.
13. Run dry run bundles for each named environment before any deploy. Deployment to existing Development Workers is allowed for approved checkpoint verification; Production deployment requires explicit human authorization.

Local setup remains:

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm d1:migrate:local
pnpm d1:init:local
pnpm dev:api
```

Production malware scanning and email delivery remain unconfigured. Do not substitute a no-op scanner. Future Worker URLs, custom domains, Cloudflare account details, and real resource IDs remain unknown and must not be invented.
