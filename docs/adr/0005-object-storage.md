# ADR 0005 — S3 privado y R2

Status: SUPERSEDED by ADR 0017.

Interfaz ObjectStorage; adapter AWS S3 SDK compatible con R2; MinIO local. Bucket sin acceso anónimo, sin dominios públicos. PUT 120s/GET 60s; claves aleatorias sin nombre de archivo/PII. Metadata PostgreSQL y FK a account técnica. MIME detectado desde bytes, tamaño máximo 10 MiB, SHA-256, scanner inyectable. Sin antivirus remoto configurado, scanner UNAVAILABLE mantiene QUARANTINED.

El objeto escaneado se escribe desde los mismos bytes a una clave active distinta. Reutilizar PUT de cuarentena no cambia contenido activo. Fase 0.1 registra una reserva de promoción antes de PUT, para detectar resultados ambiguos y objetos huérfanos. No hay endpoint público upload. `uploaded_by_account_id` registra procedencia, nunca propiedad. Download exige una policy de recurso inyectada desde servidor; sin policy DENY, incluso para uploader.

Scan reclama atómicamente token/lease, incrementa attempts y COMMIT antes de leer storage, detectar MIME, escanear o escribir. Finalización breve verifica token vigente, guarda hash/estado, referencia promoción y audita. Competidores no adquieren lease vigente; lease expirado se reclama o recupera a QUARANTINED mediante `recoverStaleScans`. Deadlines I/O 10s y lease 60s por defecto, configurables con lease al menos cuatro deadlines. Ninguna URL firmada se genera dentro de transacción. Resultado scanner desconocido, timeout o fallo mantiene cuarentena. Un resultado tardío nunca activa metadata tras perder token.

`detectCleanupCandidates` clasifica PENDING_UPLOAD expirado, cuarentena abandonada y REJECTED que requiere revisión de retención. No elimina registros ni documentos potencialmente legales. `cleanupOrphanPromotions` marca CLEANUP bajo locks breves, comprueba que el objeto no está referenciado ni pertenece a un scan vigente, y elimina fuera de transacción exclusivamente promociones técnicas con antigüedad mínima de un día. Mantiene tombstone y auditoría; repite DELETE idempotente para capturar PUT tardío tras timeout. El adapter remoto debe respetar deadlines; no se promete cancelación de un proveedor arbitrario ni exactly-once. Mantener este mantenimiento como operación interna, no endpoint público. Recolección de documentos referenciados queda pendiente de política legal futura.

Fuente: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/). URLs son capacidades temporales; no revocación instantánea tras emisión (límite 60s).
