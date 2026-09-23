ALTER TABLE governance.idempotency_records
 ADD COLUMN operation text NOT NULL DEFAULT 'legacy.foundation' CHECK(length(operation) BETWEEN 1 AND 128),
 ADD COLUMN account_id uuid,
 ADD COLUMN organization_id uuid,
 ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours');

UPDATE governance.idempotency_records
 SET expires_at = created_at + interval '24 hours'
 WHERE expires_at IS NULL;

ALTER TABLE governance.idempotency_records
 ALTER COLUMN operation DROP DEFAULT,
 ALTER COLUMN expires_at DROP DEFAULT;

CREATE INDEX idempotency_records_expires_at ON governance.idempotency_records(expires_at);

ALTER TABLE integration.outbox_events
 ALTER COLUMN aggregate_type DROP DEFAULT,
 ALTER COLUMN event_version DROP DEFAULT,
 ALTER COLUMN external_effect_policy DROP DEFAULT;

COMMENT ON TABLE governance.idempotency_records IS 'CONFIDENTIAL; server-built operation scope with per-operation expiry. Cleanup deletes only expired rows.';
