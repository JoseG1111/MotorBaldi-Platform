PRAGMA foreign_keys = ON;
CREATE TABLE workshop_contact_requests (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
 vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
 created_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
 data_sharing_consent INTEGER NOT NULL CHECK(data_sharing_consent=1),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1200),
 response_message TEXT CHECK(response_message IS NULL OR length(response_message) BETWEEN 1 AND 1200),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 closed_at TEXT,
 closed_by_account_id TEXT REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 CHECK((status='OPEN' AND closed_at IS NULL AND closed_by_account_id IS NULL AND response_message IS NULL) OR (status='CLOSED' AND closed_at IS NOT NULL AND closed_by_account_id IS NOT NULL AND response_message IS NOT NULL))
) STRICT;
CREATE INDEX workshop_contact_customer ON workshop_contact_requests(created_by_account_id,created_at,id);
CREATE INDEX workshop_contact_organization ON workshop_contact_requests(organization_id,created_at,id);
CREATE TABLE workshop_contact_request_history (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES workshop_contact_requests(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0),
 status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
 response_message TEXT,
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 correlation_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(request_id,version)
) STRICT;
CREATE TRIGGER workshop_contact_history_immutable_update BEFORE UPDATE ON workshop_contact_request_history
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORKSHOP_CONTACT_HISTORY'); END;
CREATE TRIGGER workshop_contact_history_immutable_delete BEFORE DELETE ON workshop_contact_request_history
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORKSHOP_CONTACT_HISTORY'); END;
