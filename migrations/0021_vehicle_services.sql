PRAGMA foreign_keys = ON;
CREATE TABLE vehicle_compliance_entries (
 id TEXT PRIMARY KEY,
 vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
 document_type TEXT NOT NULL CHECK(document_type IN ('SOAT','RTM')),
 expires_on TEXT NOT NULL CHECK(length(expires_on)=10 AND expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 provider TEXT CHECK(provider IS NULL OR length(provider)<=200),
 information_source TEXT NOT NULL CHECK(information_source IN ('USER_ENTERED','VERIFIED','UNKNOWN')),
 verification_status TEXT NOT NULL CHECK(verification_status IN ('USER_ENTERED','VERIFIED','UNKNOWN')),
 recorded_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX vehicle_compliance_latest ON vehicle_compliance_entries(vehicle_id,document_type,created_at DESC,id DESC);
CREATE TRIGGER vehicle_compliance_no_update BEFORE UPDATE ON vehicle_compliance_entries BEGIN SELECT RAISE(ABORT,'vehicle compliance history is append-only'); END;
CREATE TRIGGER vehicle_compliance_no_delete BEFORE DELETE ON vehicle_compliance_entries BEGIN SELECT RAISE(ABORT,'vehicle compliance history is append-only'); END;
CREATE TABLE vehicle_manual_maintenance (
 id TEXT PRIMARY KEY,
 vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
 recorded_by_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
 performed_on TEXT NOT NULL CHECK(length(performed_on)=10),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 notes TEXT NOT NULL CHECK(length(notes)<=2000),
 mileage INTEGER CHECK(mileage IS NULL OR mileage>=0),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX vehicle_manual_maintenance_history ON vehicle_manual_maintenance(vehicle_id,performed_on DESC,id DESC);
CREATE TRIGGER vehicle_manual_maintenance_no_update BEFORE UPDATE ON vehicle_manual_maintenance BEGIN SELECT RAISE(ABORT,'manual maintenance history is append-only'); END;
CREATE TRIGGER vehicle_manual_maintenance_no_delete BEFORE DELETE ON vehicle_manual_maintenance BEGIN SELECT RAISE(ABORT,'manual maintenance history is append-only'); END;
