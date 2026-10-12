PRAGMA foreign_keys = ON;
CREATE TABLE notification_vehicle_reminders_expanded (
 id TEXT PRIMARY KEY,
 compliance_entry_id TEXT NOT NULL REFERENCES vehicle_compliance_entries(id) ON DELETE RESTRICT,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 channel TEXT NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP')),
 days_before INTEGER NOT NULL CHECK(days_before IN (30,15,7,1)),
 source_event_id TEXT NOT NULL UNIQUE REFERENCES integration_outbox_events(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','UNAVAILABLE','CANCELLED','ACCEPTED','REJECTED','UNKNOWN')),
 reason_code TEXT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 processed_at TEXT,
 UNIQUE(compliance_entry_id,account_id,channel,days_before)
) STRICT;
INSERT INTO notification_vehicle_reminders_expanded SELECT * FROM notification_vehicle_reminders;
DROP TABLE notification_vehicle_reminders;
ALTER TABLE notification_vehicle_reminders_expanded RENAME TO notification_vehicle_reminders;
CREATE INDEX notification_vehicle_reminders_pending ON notification_vehicle_reminders(status,created_at);
