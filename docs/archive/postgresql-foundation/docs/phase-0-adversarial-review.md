# Revisión adversarial Fase 0

Revisión local del implementador, no auditoría independiente externa. Se inspeccionaron autorización, IDOR, concurrencia, retries, exposición, integridad, privacidad y recuperación; se repitieron los checks afectados tras correcciones.

| Hallazgo | Corrección y evidencia |
| --- | --- |
| Servidor marketing raíz podía servir fuentes privadas del Core/PHP | allowlist de rutas/assets, rechazo de dot segments; test HTTP de Core/.env/PHP/traversal |
| Auditoría append-only solo a nivel aplicación sería insuficiente | triggers UPDATE/DELETE/TRUNCATE + grants runtime SELECT/INSERT; test niega ALTER/disabling trigger |
| Runtime podría recibir owner DB por error | assertRuntimeRole al iniciar API/worker; smoke compilado con rol limitado |
| Idempotencia concurrente / payload cambiado | lock transaccional por scope+key, fingerprint canónico, resultado con efecto atómico; 12 solicitudes producen una operación; distinto payload 409 |
| Pérdida entre DB/Redis o redis flush | outbox source of truth, re-visita QUEUED, consumidor bloqueado/idempotente; prueba evento sin job y entrega repetida |
| Timeout Redis en conexión bloqueante impedía retry final | conexiones productor/worker separadas; cinco intentos y DLQ verificados |
| Handler tardío podría usar cliente ya liberado | deadline, AbortSignal y cliente protegido; test consulta posterior rechazada |
| Reupload con URL PUT todavía vigente después de scan | promoción de los bytes escaneados a otra clave privada; test sustitución no cambia archivo activo |
| Scanner no disponible / MIME falso / usuario distinto | cuarentena, rechazo y 404; pruebas negativas y SHA-256/estado |
| Logs/errores SDK podrían filtrar datos | logger allowlist, redaction y códigos seguros; sin error.message/body/URL; tests de secreto anidado |
| /404 o 429 fuera del formato uniforme | filtro común HttpException/Problem, pruebas 401/403/404/413/429/503 y requestId |
| Liveness dependía del rate limiter Redis | health exento de limiter; readiness conserva verificación de dependencias |
| Dependencias OpenTelemetry/Fastify vulnerables y emulador S3 sin parche | actualizaciones/override Fastify y eliminación emulador; integración MinIO real; audit sin vulnerabilidades conocidas |
| Staging podía desplegar sin checks | workflow_run restringido a push master exitoso, checkout exacto head_sha verificado |

Límites: auth aún no tiene personas/membresías/privilegios (Fase 1); no hay permisos de dominio otorgados, ni endpoints storage/recovery públicos. Métodos internos suponen caller servidor autorizado, no exponerlos sin policies. Recuperación DLQ dispone de función auditada, no UI. Signed GET es capacidad vigente máximo 60s; revocación inmediata de URL emitida no se promete. Objetos privados huérfanos por fallo de commit requieren política posterior; nunca quedan publicados. Retención legal remota aún requiere definición.

No se conocen Critical/High abiertos en el código Foundation revisado; no se extiende esta afirmación al sistema legacy, al hosting, a infraestructura no provisionada ni a imágenes aún sin ejecutar. Gate permanece FAIL por evidencia pendiente, no se simula PASS.
# Phase 0.2 Adversarial Review

Reviewed closeout risks: migration path divergence, runtime owner leakage, environment mismatch, unrun hardening tests, deep imports, cycles, secret leakage, Docker artifact differences, queue leases, storage leases, idempotency expiry, readiness false negatives, CI bypass and supply-chain credentials.

Critical/High fixes in 0.2:

- Single migration path requires `APP_ENV`, `MIGRATION_DATABASE_URL`, environment identity, checksums, advisory lock and runtime grants.
- Runtime role is used in integration tests for service operations; owner is limited to migrations and privileged fixtures.
- Idempotency has server-built operation scope, per-operation TTL, expiry index, cleanup and response size bound.
- Readiness is DB-critical and Redis/storage-degraded; capability-specific failures remain fail closed where required.
- Workspace boundaries are enforced with package exports, `workspace:*` dependencies and `pnpm boundaries:check`.
- Secret scanning covers GitHub, Wompi, HubSpot, AWS and private key patterns without printing values. History and generated artifact scans are CI gates.

No known Critical/High code issue remains from this review. Local Docker and history scan execution depend on Docker/socket or installed Gitleaks availability.
