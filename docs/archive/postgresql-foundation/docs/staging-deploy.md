# Staging

1. Requerir Foundation CI verde en el commit exacto y un entorno separado. Revisar gate y limitaciones antes de activar Core.
2. Marketing existente: workflow FTPS solo tras push master y CI exitoso; publica exclusivamente dist. No contiene Core ni secretos. Mantener secretos FTP existentes.
3. Core: crear DB/Redis/storage/secret manager/red separados. Instalar runtime role sin privilegios owner, migrador temporal. Usar AUTH_BASE_URL/CORS exactos HTTPS, Redis TLS, PostgreSQL sslmode=verify-full, bucket/nombre DB staging. No importar datos productivos.
4. Construir imágenes API/worker desde el mismo commit y publicar por digest. Aplicar migraciones SQL expand con MIGRATION_DATABASE_URL; aplicar grants como owner. Runtime no recibe credencial migradora. No comandos apply automatizados desde este repositorio.
5. Arrancar API y worker, verificar health, principal 401, contrato, logs redacted, métricas, retries/DLQ; simulaciones de fallo en staging. Probar restore y registrar tiempos.
6. Activar ingress/dominios únicamente tras verificar TLS y CORS; no apuntar el marketing actual al Core.

Recursos remotos y CI del proveedor deben configurarse con credenciales del operador; no han sido desplegados en esta fase.
Staging deploy is marketing-only. It runs only after Foundation CI succeeds for the exact `head_sha`, builds `dist/`, scans the generated artifact and deploys `dist/` by FTPS. Core images are not deployed by FTP.

HubSpot remains a LEGACY MARKETING BRIDGE - TO BE REMOVED IN PHASE 1. Use `config/legacy-hubspot.env.example` for operator examples, not `.env.example`.
