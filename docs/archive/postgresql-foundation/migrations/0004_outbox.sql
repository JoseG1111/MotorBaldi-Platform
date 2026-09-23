ALTER TABLE integration.outbox_events DROP CONSTRAINT outbox_events_status_check;
UPDATE integration.outbox_events SET status='PENDING' WHERE status='QUEUED';
ALTER TABLE integration.outbox_events
 ADD COLUMN aggregate_type text NOT NULL DEFAULT 'legacy.foundation' CHECK(length(aggregate_type) BETWEEN 1 AND 128),
 ADD COLUMN event_version integer NOT NULL DEFAULT 1 CHECK(event_version>0),
 ADD COLUMN last_enqueued_at timestamptz,
 ADD COLUMN processing_token uuid,
 ADD COLUMN lease_until timestamptz,
 ADD COLUMN last_error_code text,
 ADD COLUMN external_effect_policy text NOT NULL DEFAULT 'RECONCILE' CHECK(external_effect_policy IN ('IDEMPOTENT','RECONCILE')),
 ADD CONSTRAINT outbox_state CHECK(status IN ('PENDING','PROCESSING','PROCESSED','DEAD')),
 ADD CONSTRAINT outbox_lease CHECK(
   (status='PROCESSING' AND processing_token IS NOT NULL AND lease_until IS NOT NULL)
   OR (status<>'PROCESSING' AND processing_token IS NULL AND lease_until IS NULL));
UPDATE integration.outbox_events SET last_enqueued_at=published_at;
DROP INDEX integration.outbox_pending;
CREATE INDEX outbox_pending ON integration.outbox_events(available_at,created_at) WHERE status='PENDING';
CREATE INDEX outbox_expired_leases ON integration.outbox_events(lease_until) WHERE status='PROCESSING';
COMMENT ON TABLE integration.outbox_events IS 'PostgreSQL authoritative attempts and leases; DEAD unknown outcome requires reconciliation before recovery.';
