# Restore PostgreSQL

Target RPO ≤15min y RTO ≤60min; medir, no asumir. Proveedor administrado: backups cifrados automáticos + WAL/PITR, retención definida por gobernanza, alarmas de backup fallido y prueba regular.

Simulacro: anotar instante/cantidad de eventos; backup a repositorio cifrado privado; restaurar snapshot+WAL a DB aislada con credenciales nuevas; **nunca restaurar encima de producción**. Validar checksum de migraciones, conteos, FK, auditoría y secuencia outbox; comprobar health y tests de consistencia. Medir último commit recuperado/RPO, duración hasta disponibilidad/RTO. Redis es reconstruible desde outbox; reconciliar efectos externos y URLs/objetos antes de retomar workers. Un evento PROCESSED anterior a PITR puede requerir conciliación externa; no prometer exactly-once fuera de DB.

Prueba local posible con pg_dump formato custom y pg_restore --exit-on-error en DB nueva. No demuestra PITR administrado. Registrar evidencia sin PII/credenciales. El operador aprueba conmutación, guarda endpoint previo, valida DNS/TLS, activa API y después workers. Borrar entorno de ensayo conforme a retención.
