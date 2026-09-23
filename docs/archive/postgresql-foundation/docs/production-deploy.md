# Producción — requiere autorización explícita

No se ejecutó despliegue productivo. Antes: gate PASS, CI verde, aprobación del propietario, backup/PITR verificado, restore medido, migración compatible y revisión de plan. No habilitar onboarding/pagos de fases futuras.

Promover los mismos digests probados en staging. Secret manager por entorno, TLS verificado, red privada DB/Redis, ingress limitado a Cloudflare. Migrador de uso temporal con DDL; API/worker runtime sin ownership. Aplicar expand, desplegar nueva revisión sin retirar anterior, health+smoke, tráfico gradual si compute lo permite. Monitorear errores, p95, conexiones, cola, DLQ y storage. Si degradación, detener promoción y rollback de aplicación; no down migration destructiva.

Registrar commit/digests/migraciones/responsable/hora/resultado/rollback. Marketing PHP permanece como despliegue independiente. Configurar budgets/alertas, backups, secret rotation, escala y límites antes de exponer. RPO/RTO son objetivos hasta pruebas reales del proveedor.
Production Core requires separate migration owner and runtime credentials. Run the migrator image with `APP_ENV=production`, `MIGRATION_DATABASE_URL` using verified TLS and `INITIALIZE_DATABASE_ENVIRONMENT=true` only for first initialization or the documented zero-row 0003 repair.

API and worker must run final images, not `tsx` or source execution. `/health/ready` is `503 unavailable` only when DB is unavailable; Redis/storage outages report `200 degraded` and dependent operations still fail explicitly when their capability is required.
