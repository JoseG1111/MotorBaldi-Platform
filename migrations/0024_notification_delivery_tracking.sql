PRAGMA foreign_keys = ON;
CREATE TABLE notification_external_deliveries (
 id TEXT PRIMARY KEY,
 source_event_id TEXT NOT NULL UNIQUE REFERENCES integration_outbox_events(id) ON DELETE RESTRICT,
 provider TEXT NOT NULL CHECK(provider IN ('RESEND','META_WHATSAPP')),
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP')),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 status TEXT NOT NULL CHECK(status IN ('RESERVED','ACCEPTED','REJECTED','UNAVAILABLE','UNKNOWN')),
 provider_reference TEXT,
 outcome_code TEXT,
 delivery_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(delivery_status IN ('PENDING','SENT','DELIVERED','READ','FAILED')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(provider,provider_reference)
) STRICT;
CREATE TABLE notification_provider_status_events (
 id TEXT PRIMARY KEY,
 delivery_id TEXT NOT NULL REFERENCES notification_external_deliveries(id) ON DELETE RESTRICT,
 provider TEXT NOT NULL CHECK(provider IN ('RESEND','META_WHATSAPP')),
 evidence_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('SENT','DELIVERED','READ','FAILED')),
 occurred_at TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(provider,evidence_id)
) STRICT;
CREATE TRIGGER notification_provider_status_immutable_update BEFORE UPDATE ON notification_provider_status_events
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_STATUS'); END;
CREATE TRIGGER notification_provider_status_immutable_delete BEFORE DELETE ON notification_provider_status_events
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROVIDER_STATUS'); END;
