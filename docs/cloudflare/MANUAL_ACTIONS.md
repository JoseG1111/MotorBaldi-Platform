# Manual Cloudflare Actions

CF-0.1 performs no remote provisioning or deployment. An operator must complete these steps later for each of `development`, `staging`, and `production`.

1. Create the four Workers, D1 database, private R2 bucket, event Queue, and Queue DLQ using the inventory names or approved replacements.
2. Replace D1 IDs and future workers.dev/custom domain URL placeholders in every Wrangler environment. Verify every non-inheritable binding remains explicit.
3. Confirm declarative SQLite Durable Object exports and bindings, including the background Worker binding to the environment specific API Worker.
4. Configure `API_RATE_LIMITER` and `AUTH_RATE_LIMITER` namespace policies from Wrangler configuration.
5. Configure Portal/Admin `API_SERVICE` bindings to the matching API Worker.
6. Create separate Turnstile widgets for each deployment environment when approved. Configure `TURNSTILE_SECRET_KEY` as an API Worker secret only, never as a committed Wrangler var. Configure `TURNSTILE_EXPECTED_HOSTNAME` as a non-secret hostname-only API value. Set the website's exact HTTPS origin in `PUBLIC_CORS_ORIGINS`, separately from the Portal/Admin/auth `CORS_ORIGINS`. `TURNSTILE_BYPASS_TOKEN` is local/test-only and forbidden remotely. Keep `PUBLIC_LEAD_INTAKE` disabled until the real development widget and website integration pass.
7. Add API secrets `AUTH_SECRET` and a versioned `AUTH_SECRETS` keyring. Do not add them to background, Portal, or Admin Workers.
8. Record the final Worker URLs and configure exact HTTPS trusted origins. Keep browser app calls relative through the service binding proxy.
9. Apply D1 migrations, including `0002_phase1.sql` and `0003_phase1_closeout.sql`, manually, then initialize and verify D1 identity:

```bash
pnpm exec wrangler d1 migrations apply motorbaldi-core-dev --remote --env development --config apps/api/wrangler.jsonc
pnpm d1:init:development
pnpm exec wrangler d1 migrations apply motorbaldi-core-staging --remote --env staging --config apps/api/wrangler.jsonc
pnpm d1:init:staging
pnpm exec wrangler d1 migrations apply motorbaldi-core-prod --remote --env production --config apps/api/wrangler.jsonc
pnpm d1:init:production
```

10. Leave `PUBLIC_SIGNUP` and `PUBLIC_LEAD_INTAKE` disabled until the intended public workflows have been reviewed. `ORGANIZATION_CREATION` is also a governance feature flag. Remote signup currently remains disabled in code even when its flag is set because production email delivery is unconfigured.
11. Configure a production outbound email provider in a later approved phase before enabling verification email, password recovery, or automatic invitation delivery. `EMAIL_PROVIDER=DEVELOPMENT_SINK` captures local/test messages only; it is not evidence of remote delivery. Do not set `TURNSTILE_BYPASS_TOKEN` remotely. The public lead endpoint requires a real Turnstile secret and expected hostname.
12. For the first platform administrator, verify an existing personal account, then use the explicit operator script `scripts/phase1/bootstrap-staff.mjs` with the target environment, account ID, reason, and `--execute`. Review the script and D1 target before invoking it. It does not create credentials and is never part of deployment automation.
    For the first **development-only** personal account, run `node scripts/phase1/bootstrap-development-account.mjs development --execute` from an interactive terminal after migrations and D1 environment initialization. It prompts for name, email, and a hidden password, creates the verified Better Auth user, credential, signup consent, and governance events in one D1 import, and prints the account UUID. The existing account reconciliation creates `iam_people` and `iam_accounts` after first login. This script refuses local, staging, and production and is never a production account creation mechanism. Do not pass a password on the command line.
13. Run dry run bundles for each named environment before any deploy. A later, separately approved action may deploy them.

Local setup remains:

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm d1:migrate:local
pnpm d1:init:local
pnpm dev:api
```

Production malware scanning and email delivery remain unconfigured. Do not substitute a no-op scanner. Future Worker URLs, custom domains, Cloudflare account details, and real resource IDs remain unknown and must not be invented.
