PRAGMA foreign_keys = ON;

CREATE TABLE vehicle_odometer_readings (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  reading_value INTEGER NOT NULL CHECK(reading_value >= 0),
  unit TEXT NOT NULL CHECK(unit IN ('KILOMETERS','MILES')),
  observed_at TEXT NOT NULL,
  recorded_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
  corrects_reading_id TEXT REFERENCES vehicle_odometer_readings(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(corrects_reading_id IS NULL OR corrects_reading_id <> id),
  CHECK((corrects_reading_id IS NULL) = (correction_reason IS NULL)),
  CHECK(correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 5 AND 1000)
) STRICT;
CREATE INDEX vehicle_odometer_history ON vehicle_odometer_readings(vehicle_id,observed_at DESC,id);
CREATE TRIGGER vehicle_odometer_correction_match BEFORE INSERT ON vehicle_odometer_readings
WHEN NEW.corrects_reading_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM vehicle_odometer_readings r
  WHERE r.id=NEW.corrects_reading_id AND r.vehicle_id=NEW.vehicle_id
)
BEGIN SELECT RAISE(ABORT,'corrected odometer reading must belong to vehicle'); END;
CREATE TRIGGER vehicle_odometer_no_update BEFORE UPDATE ON vehicle_odometer_readings
BEGIN SELECT RAISE(ABORT,'odometer history is append-only'); END;
CREATE TRIGGER vehicle_odometer_no_delete BEFORE DELETE ON vehicle_odometer_readings
BEGIN SELECT RAISE(ABORT,'odometer history is append-only'); END;

CREATE TABLE vehicle_professional_records (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  location_id TEXT,
  author_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  record_type TEXT NOT NULL CHECK(
    length(record_type) BETWEEN 1 AND 64
    AND substr(record_type,1,1) GLOB '[A-Z]'
    AND record_type NOT GLOB '*[^A-Z0-9_]*'
  ),
  content_json TEXT NOT NULL CHECK(
    length(content_json) <= 65536
    AND CASE WHEN json_valid(content_json)
      THEN json_type(content_json) = 'object'
      ELSE 0
    END
  ),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','FINAL')),
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK((status='FINAL') = (finalized_at IS NOT NULL)),
  FOREIGN KEY(organization_id,location_id) REFERENCES org_locations(organization_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX vehicle_professional_records_vehicle ON vehicle_professional_records(vehicle_id,status,created_at,id);
CREATE TRIGGER vehicle_professional_records_final_immutable BEFORE UPDATE ON vehicle_professional_records
WHEN OLD.status='FINAL' OR NEW.version<>OLD.version+1
  OR NEW.id IS NOT OLD.id OR NEW.vehicle_id IS NOT OLD.vehicle_id
  OR NEW.organization_id IS NOT OLD.organization_id OR NEW.location_id IS NOT OLD.location_id
  OR NEW.author_person_id IS NOT OLD.author_person_id OR NEW.record_type IS NOT OLD.record_type
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status='DRAFT' AND NEW.status='DRAFT' AND NEW.finalized_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'final professional record is immutable'); END;
CREATE TRIGGER vehicle_professional_records_no_delete BEFORE DELETE ON vehicle_professional_records
BEGIN SELECT RAISE(ABORT,'professional records retain history'); END;

CREATE TABLE vehicle_professional_amendments (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES vehicle_professional_records(id) ON DELETE RESTRICT,
  author_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
  content_json TEXT NOT NULL CHECK(
    length(content_json) <= 65536
    AND CASE WHEN json_valid(content_json)
      THEN json_type(content_json) = 'object'
      ELSE 0
    END
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX vehicle_professional_amendments_record ON vehicle_professional_amendments(record_id,created_at,id);
CREATE TRIGGER vehicle_professional_amendments_final_only BEFORE INSERT ON vehicle_professional_amendments
WHEN NOT EXISTS (
  SELECT 1 FROM vehicle_professional_records r WHERE r.id=NEW.record_id AND r.status='FINAL'
)
BEGIN SELECT RAISE(ABORT,'amendment requires a final record'); END;
CREATE TRIGGER vehicle_professional_amendments_no_update BEFORE UPDATE ON vehicle_professional_amendments
BEGIN SELECT RAISE(ABORT,'professional amendments are append-only'); END;
CREATE TRIGGER vehicle_professional_amendments_no_delete BEFORE DELETE ON vehicle_professional_amendments
BEGIN SELECT RAISE(ABORT,'professional amendments are append-only'); END;
