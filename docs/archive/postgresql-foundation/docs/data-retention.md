# Clasificación y retención foundation

| Tabla | Clasificación | Integridad / tratamiento |
| --- | --- | --- |
| governance.audit_events | CONFIDENTIAL | append-only; acceso operativo restringido; purga solo gobernanza fuera runtime tras política aprobada |
| governance.security_events | CONFIDENTIAL | append-only; IDs y códigos, no cuerpos ni secretos |
| governance.feature_flags | INTERNAL / targeting CONFIDENTIAL | environment único por key; versión; futuras personas/org IDs sin inferir membership |
| governance.idempotency_records | CONFIDENTIAL | PK scope+key, hash request, respuesta segura; no borrar hasta definir horizonte de reintento por operación |
| governance.files | RESTRICTED | dueño FK, privado, MIME/tamaño/hash/estado, version; eliminación lógica y revisión de retención por categoría |
| integration.outbox_events | CONFIDENTIAL | payload mínimo y versionado por handler; status/attempts/processed; retener para recuperación |
| integration.inbound_events | RESTRICTED | raw autenticado, dedup provider+event ID; cifrado proveedor y permisos SQL, sin PAN/CVV/secretos |
| integration.dead_letters | INTERNAL | FK restrict, error_code seguro, intentos/requestId; recuperación con razón/auditoría |
| iam.auth_* | RESTRICTED | sesión/password hash/MFA cifrado por framework; nunca exponer ni registrar; revocación, expiry y limpieza futura por proceso controlado |

No se definen plazos legales sin requisitos. Fase 0 no tiene datos reales ni jobs de purga destructiva. Antes de datos reales: aprobar política de categorías/plazos/hold/export/anonymization, operadores, cifrado/backups y acceso. DB timestamps TIMESTAMPTZ; audit actor/resource históricos no tienen cascadas hacia futuras identidades. Nunca hard-delete historial por cerrar cuenta/organización.

Los roles SQL runtime no son separación entre API y worker: ambos comparten permisos foundation limitados. Separar credenciales por deployable y reducir grants al activar dominios. Las credenciales locales del ejemplo son públicas y descartables, prohibidas remotamente. Auth no habilita onboarding ni usuarios privilegiados en esta fase.
