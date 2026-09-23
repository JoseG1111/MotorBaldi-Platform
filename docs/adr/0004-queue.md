# ADR 0004 — BullMQ + outbox PostgreSQL

Status: SUPERSEDED by ADR 0018 and ADR 0019.

**Superseded execution model:** Fase 0.1 [ADR 0008](0008-outbox-effects.md) replaces the transaction-held handler/relay and BullMQ retry design below. PostgreSQL leases and retry state are now authoritative; all Redis/provider I/O occurs outside database transactions. The original decision is retained only as historical context.

BullMQ sobre Redis para ejecución; PostgreSQL conserva evento/estado/intentos/DLQ. Entrega al menos una vez. Relay con FOR UPDATE SKIP LOCKED, jobId=event UUID; reconciliación QUEUED permite recuperar pérdida Redis. Consumidor bloquea evento y hace efecto SQL/PROCESSED en misma transacción. Desconocido → DLQ; máximo cinco intentos, exponential backoff+jitter. Handler falla → SAVEPOINT rollback antes de persistir intento. Conexión bloqueante worker separada de productor con timeout.

Handlers foundation solo SQL transaccional, sin pagos/email externos. Los adapters futuros deben emplear claves de proveedor, reconciliation y timeout/AbortSignal; un timeout externo no equivale a fallo definitivo. No prometer exactly-once externo. Fixture vive en tests, no se registra en worker runtime. DLQ interna recuperable con razón y auditoría; UI administrativa requiere Fase 1.

Fuentes: [retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [idempotencia](https://docs.bullmq.io/patterns/idempotent-jobs).
