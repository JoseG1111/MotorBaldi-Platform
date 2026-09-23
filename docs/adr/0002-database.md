# ADR 0002 — PostgreSQL, Drizzle y migraciones SQL

Status: SUPERSEDED by ADR 0015 and ADR 0016 for MotorBaldi Platform CF-0.

PostgreSQL 18, Drizzle sobre pg como capa tipada disponible. Los servicios foundation usan SQL parametrizado explícito y resultados tipados de pg para locks, SAVEPOINT y transacciones; no depender de validaciones ORM. SQL versionado con checksum, lock de migrador, transacción por migración. Sin sync/auto-migration al arrancar API.

Credencial owner solo migrador, runtime sin DDL ni propiedad de tablas. Auditoría protegida con privilegios y triggers UPDATE/DELETE/TRUNCATE. UUIDv7 generados con uuid; UTC; sin schema business futuro. Auth technical tables aisladas. EXPAND/MIGRATE/CONTRACT; nunca alterar checksum aplicado. Tests fresh y upgrade preservan fila previa y detectan alteración de checksum.
