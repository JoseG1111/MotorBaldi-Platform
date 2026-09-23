# Migraciones

0001 crea schemas y tablas foundation. 0002 agrega tablas técnicas Better Auth. 0003 crea identidad de ambiente. 0004 endurece outbox con leases/contratos. 0005 endurece storage. 0006 cierra Foundation con idempotencia por operación/expiración y elimina defaults legacy de nuevos eventos outbox. No migra datos SQLite ni HubSpot. `iam.people`, `iam.accounts` y dominios futuros no se crean en Fase 0.

La ruta canónica es `apps/migrator` + `packages/db/src/migrate.ts`. `APP_ENV=... MIGRATION_DATABASE_URL=... INITIALIZE_DATABASE_ENVIRONMENT=true pnpm db:migrate` usa owner temporal y aplica migrations, environment identity, checksums, advisory lock y runtime grants. `DATABASE_URL` en API/worker debe ser runtime sin DDL; startup valida ambiente y privilegios.

`infra/docker/runtime-grants.sql` ya no contiene políticas; solo conserva bootstrap local del role. La política canónica vive en `packages/db/src/grants.ts` y el migrator ejecuta `applyRuntimeGrants()`.

Cada archivo se aplica dentro de transacción; advisory lock serializa migradores; checksum detecta edición de aplicado. Error revierte todo el archivo. Upgrade test preserva datos entre 0001→0002, fresh arranca DB vacía y verifica historial. No down automáticos: expand/migrate/contract y rollback de aplicación. Migrador no se ejecuta desde liveness/startup.

No hay base SQLite productiva ni dump del hosting disponibles para inspeccionar registros. Se revisó su DDL y comportamiento en api/wompi-common.php y pruebas locales de fixtures. Su migración/consolidación pertenece a Fase 5 con conciliación explícita.
