# Desarrollo local

Node 24, corepack/pnpm 10.34.5, Docker con Compose v2. Marketing sigue en raíz. No usar npm install/ci (un solo lockfile pnpm). No sobrescribir el .env legacy existente.

```sh
corepack enable
pnpm install --frozen-lockfile
docker compose -f infra/docker/compose.yaml up -d
node --env-file=.env.example --import tsx scripts/foundation/local-setup.ts
node --env-file=.env.example --import tsx apps/api/src/main.ts
# otra terminal
node --env-file=.env.example --import tsx apps/worker/src/main.ts
# otra terminal, marketing
pnpm dev
```

Valores .env.example son solo local descartable. Para cambios copiar a .env.core (ignorado) y cambiar --env-file. API :3000, marketing :5173, PostgreSQL :55432, Redis :56379, S3 :59000, consola :59001, Mailpit :58025/SMTP :51025. Acceso local únicamente. No datos productivos ni cuentas semilla de negocio en Fase 0.

Tests usan DB **motorbaldi_test** separada. Crear con `docker compose -f infra/docker/compose.yaml exec postgres createdb -U motorbaldi_owner motorbaldi_test`. Exportar `TEST_DATABASE_URL=postgresql://motorbaldi_owner:motorbaldi_local_owner@127.0.0.1:55432/motorbaldi_test`. Test crea fixtures únicas, nunca limpia una DB compartida. Test migrations requiere CREATEDB y crea/elimina solo una DB efímera con prefijo migration_test_.

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:authorization
pnpm test:migrations
pnpm test:integration
pnpm openapi:check
pnpm build:core
pnpm build
pnpm exec playwright install chromium firefox
QA_REPORT=test-results/marketing.json pnpm exec playwright test
pnpm security:check
pnpm audit --audit-level high
pnpm exec tsx scripts/foundation/baseline.ts
```

No prueba llama a Wompi/HubSpot reales. El storage test usa MinIO real. API /health/live verifica proceso; /health/ready valida PostgreSQL/Redis/bucket. Principal anónimo devuelve 401. Signup cerrado intencionalmente. Worker sin handlers de negocio; fixtures async solo tests. Apagar con Ctrl+C y `docker compose ... stop`; no `down -v` si se desean conservar datos.
# Local Core Foundation

Start local dependencies with the Core profile or equivalent local services:

```bash
docker compose -f infra/docker/compose.yaml --profile core-smoke up postgres redis storage storage-init
```

Then initialize the database:

```bash
APP_ENV=local INITIALIZE_DATABASE_ENVIRONMENT=true MIGRATION_DATABASE_URL=postgresql://motorbaldi_owner:motorbaldi_local_owner@127.0.0.1:55432/motorbaldi_local pnpm db:migrate
```

`scripts/foundation/local-setup.ts` delegates to the same canonical migrator and creates the private bucket. Do not run a separate grants SQL file after migrations; grants are applied by the migrator from `packages/db/src/grants.ts`.

API and worker use `DATABASE_URL` with `motorbaldi_runtime`. Startup validates `governance.environment_metadata=local` and the runtime role privileges.
