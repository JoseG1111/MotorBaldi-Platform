# Fase 0 — evidencia y gate

Fecha: 2026-09-22. Solo workspace local, sin commit/push, recursos remotos ni despliegue productivo. Sitio HTML/CSS/JS y endpoints PHP preservados. Lock npm sustituido por pnpm (original recuperable desde Git). Cambios de capturas producidos por E2E restaurados a su versión original.

## Verificación ejecutada

| Check | Resultado |
| --- | --- |
| pnpm install --frozen-lockfile | OK, 17 workspace projects |
| pnpm lint / typecheck | OK |
| pnpm test:unit | 6/6 OK: config fail-fast/TLS, redaction/context, canonicalización, timeout sin consultas tardías, aislamiento servidor marketing |
| pnpm test:authorization | 2 tests OK: default deny, negativo cross-org/anónimo/inactivo |
| pnpm test:integration | 9 tests OK sobre PostgreSQL 18.6, Redis 8.0.5, MinIO real: audit, transacciones, concurrencia, inbound dedup, queue, files, HTTP, runtime compilado, S3 |
| pnpm test:migrations | OK: DB efímera vacía, 0001→0002, preservación y checksum alterado rechazado |
| pnpm openapi:check | OK, incluye contratos auth permitidos; normaliza nullable de proveedor a OpenAPI 3.0 |
| pnpm build / build:core | OK |
| pnpm lint:php | OK |
| Playwright Chromium + Firefox | 48/48 OK, reporte local test-results/foundation-marketing.json |
| tests/wompi-endpoint.mjs con PHP 8.5 local | OK, fixtures sin cobros externos |
| pnpm audit --audit-level high | Sin vulnerabilidades conocidas al ejecutar |
| pnpm security:check / git diff --check | OK; análisis de archivos, no certifica historial remoto |
| Terraform init -backend=false / validate / fmt -check | OK, provider 5.25.0 bloqueado; sin plan/apply |
| Compose config --quiet | OK usando Compose 2.40.3 extraído localmente |
| local-setup.ts sobre motorbaldi_local vacía | OK: migraciones, grants runtime y bucket privado; sin datos de negocio |
| pg_dump + restore DB aislada | OK: 2 migraciones y 15 eventos audit recuperados en snapshot local; no acredita PITR remoto |
| Docker build API/worker / Compose completo | NO VERIFICADO: acceso denegado al daemon Docker; no se modificaron permisos del host |
| GitHub CI remoto | CONFIGURADO, NO EJECUTADO: no push ni permisos/credenciales usados |

PostgreSQL/Redis/MinIO se ejecutaron directamente en loopback con binarios aislados en .local (ignorado), al no disponer del daemon. Se verificó arranque y SIGTERM de API y worker **compilados**, con rol runtime sin ownership. No se atribuye ese resultado a una prueba de las imágenes Docker.

## Baseline reproducible

`pnpm exec tsx scripts/foundation/baseline.ts`: 100 peticiones HTTP secuenciales reales a /health/live, boot desde factory hasta listen ~181 ms (imports ya cargados), p50 ~2.23 ms, p95 ~3.23 ms, local sin TLS y sin carga concurrente. No es SLO ni benchmark de auth. Pool 5 conexiones por proceso (config 1–20), worker concurrency 2 (1–16). Multiplicar por réplicas antes de asignar presupuesto DB. Handler 10s, statement 10s, lock 5s, 5 intentos con jitter.

## Gate

**FAIL — pendiente de evidencia de contenedores/CI.** Para cambiar a PASS deben completarse build y smoke de las imágenes API/worker y arranque local limpio mediante Compose, y obtener CI verde del commit entregado. No hay autorización implícita para desplegar producción. Las configuraciones de servicios remotos, antivirus real, secret manager, OTLP y PITR quedan condicionadas a credenciales/infraestructura, como permite el alcance Foundation.

No se implementó ni inició Fase 1. Portal/admin son reservas documentadas, sin onboarding, CRM, vehículos, peritajes, cobros o roles privilegiados.
# Foundation 0.2 Verification

Foundation 0.2 remains pre-domain. Do not create `iam.people`, `iam.accounts`, organizations, memberships, vehicles, services, inspections or billing product flows.

Required gates:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:foundation:unit`
- `pnpm test:authorization`
- `pnpm test:migrations`
- `pnpm test:foundation:integration`
- `pnpm test:foundation:hardening`
- `pnpm openapi:check`
- `pnpm build:core`
- `pnpm build`
- `pnpm exec playwright test`
- `pnpm security:check`
- `pnpm security:scan:dist`
- `pnpm audit --audit-level high`
- `pnpm boundaries:check`
- Docker builds for `api`, `worker`, `migrator`
- compose `core-smoke`
- `terraform init -backend=false && terraform validate`

Foundation PASS requires the exact-head Foundation CI run to be green. Local PASS cannot be declared when Docker or history-secret scanning cannot run.
