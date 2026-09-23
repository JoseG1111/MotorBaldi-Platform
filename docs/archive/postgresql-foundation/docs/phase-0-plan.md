# Fase 0: descubrimiento y plan

Estado inicial: worktree limpio. Marketing HTML/CSS/JS en raíz; build por allowlist a dist, PHP en api; npm lock; Playwright Chromium/Firefox; deploy FTPS de master. No backend Node, PostgreSQL, Redis, migraciones ni identidades centrales.

Se preservan raíz, assets, rutas públicas, PHP, pruebas y comandos npm. HubSpot en api/hubspot.php y assets/js/ui.js es legacy hasta Fase 1; Wompi PHP/SQLite es legacy hasta Fase 5. No importar automáticamente personas, medios de pago ni suscripciones. La base SQLite real no está disponible en el repositorio: cualquier migración futura exige inventario y conciliación con el operador. .env ignorado contiene configuración legacy; solo se inspeccionaron nombres, sin imprimir valores. No llamadas a proveedores ni despliegues.

Riesgos: publicación accidental del Core por servidor estático local; credenciales migrador usadas en runtime; idempotencia concurrente; pérdida entre PostgreSQL y Redis; reupload posterior a scan; propagación de secretos en logs; confundir usuario del proveedor de auth con persona. Mitigaciones: allowlist, roles SQL separados, locks/transacciones, outbox persistente y consumidores idempotentes, objetos promovidos a claves privadas diferentes, logs allowlist, tablas auth técnicas aisladas.

Archivos: apps/api y worker ejecutables; marketing wrapper; portal/admin reservados sin funcionalidades Fase 1. packages/contracts, db, auth, authz, config, observability, storage, messaging, payments, testing, shared. SQL explícito 0001 foundation, 0002 auth. Infra Docker local y contenedores runtime; Terraform R2; ADRs y runbooks.

Contratos: /api/v1, Problem Details, request UUID generado en servidor, actor independiente de persona. Health live/ready públicos; principal protegido. Ningún permiso de dominio concedido. Upload y jobs son servicios internos sin endpoints anónimos. No endpoints financieros ni onboarding.

Verificación: typecheck, lint, unit/authorization, PostgreSQL fresh/upgrade, integración Redis/storage, E2E marketing, OpenAPI, build, auditoría dependencias/secrets. Revisión adversarial después de pruebas y corrección de fallos. Gate solo PASS con evidencia; no continuar Fase 1.
