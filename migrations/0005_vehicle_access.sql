PRAGMA foreign_keys = ON;

CREATE TABLE vehicle_identifiers (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  identifier_type TEXT NOT NULL CHECK(length(identifier_type) BETWEEN 1 AND 64),
  country_code TEXT CHECK(country_code IS NULL OR (length(country_code) = 2 AND country_code = upper(country_code))),
  raw_value TEXT NOT NULL CHECK(length(raw_value) BETWEEN 1 AND 256),
  normalized_value TEXT NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retired_at TEXT,
  CHECK(retired_at IS NULL OR retired_at >= recorded_at)
) STRICT;
CREATE INDEX vehicle_identifiers_history ON vehicle_identifiers(vehicle_id,identifier_type,recorded_at DESC,id);
CREATE TRIGGER vehicle_identifiers_retire_only BEFORE UPDATE ON vehicle_identifiers
WHEN NEW.id IS NOT OLD.id OR NEW.vehicle_id IS NOT OLD.vehicle_id
  OR NEW.identifier_type IS NOT OLD.identifier_type OR NEW.country_code IS NOT OLD.country_code
  OR NEW.raw_value IS NOT OLD.raw_value OR NEW.normalized_value IS NOT OLD.normalized_value
  OR NEW.recorded_at IS NOT OLD.recorded_at OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
BEGIN SELECT RAISE(ABORT,'vehicle identifier history may only be retired once'); END;
CREATE TRIGGER vehicle_identifiers_no_delete BEFORE DELETE ON vehicle_identifiers
BEGIN SELECT RAISE(ABORT,'vehicle identifier history is append-only'); END;

CREATE UNIQUE INDEX org_locations_organization_id ON org_locations(organization_id,id);

CREATE TABLE vehicle_relationships (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('OWNER','DRIVER','WORKSHOP')),
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  location_id TEXT,
  effective_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  source_claim_id TEXT REFERENCES vehicle_claims(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((person_id IS NOT NULL) <> (organization_id IS NOT NULL)),
  CHECK(relationship_type <> 'DRIVER' OR person_id IS NOT NULL),
  CHECK(relationship_type <> 'WORKSHOP' OR organization_id IS NOT NULL),
  CHECK(location_id IS NULL OR organization_id IS NOT NULL),
  CHECK(ended_at IS NULL OR ended_at >= effective_at),
  FOREIGN KEY(organization_id,location_id) REFERENCES org_locations(organization_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX vehicle_relationships_vehicle ON vehicle_relationships(vehicle_id,relationship_type,ended_at,id);
CREATE INDEX vehicle_relationships_person ON vehicle_relationships(person_id,ended_at,id);
CREATE INDEX vehicle_relationships_organization ON vehicle_relationships(organization_id,ended_at,id);

CREATE TABLE vehicle_claims (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('OWNER','DRIVER','WORKSHOP')),
  claimant_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  claimant_organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','REJECTED','WITHDRAWN')),
  submitted_by_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  reviewed_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((claimant_person_id IS NOT NULL) <> (claimant_organization_id IS NOT NULL)),
  CHECK(relationship_type <> 'DRIVER' OR claimant_person_id IS NOT NULL),
  CHECK(relationship_type <> 'WORKSHOP' OR claimant_organization_id IS NOT NULL),
  CHECK((reviewed_by_person_id IS NULL) = (reviewed_at IS NULL)),
  CHECK(status NOT IN ('ACCEPTED','REJECTED') OR reviewed_at IS NOT NULL)
) STRICT;
CREATE INDEX vehicle_claims_review ON vehicle_claims(status,created_at,id);
CREATE INDEX vehicle_claims_vehicle ON vehicle_claims(vehicle_id,created_at,id);
CREATE TRIGGER vehicle_relationship_claim_match BEFORE INSERT ON vehicle_relationships
WHEN NEW.source_claim_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM vehicle_claims c WHERE c.id=NEW.source_claim_id AND c.vehicle_id=NEW.vehicle_id
    AND c.relationship_type=NEW.relationship_type AND c.status='ACCEPTED'
)
BEGIN SELECT RAISE(ABORT,'accepted matching vehicle claim required'); END;
CREATE TRIGGER vehicle_relationships_end_only BEFORE UPDATE ON vehicle_relationships
WHEN NEW.id IS NOT OLD.id OR NEW.vehicle_id IS NOT OLD.vehicle_id
  OR NEW.relationship_type IS NOT OLD.relationship_type OR NEW.person_id IS NOT OLD.person_id
  OR NEW.organization_id IS NOT OLD.organization_id OR NEW.location_id IS NOT OLD.location_id
  OR NEW.effective_at IS NOT OLD.effective_at OR NEW.source_claim_id IS NOT OLD.source_claim_id
  OR NEW.created_at IS NOT OLD.created_at OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
BEGIN SELECT RAISE(ABORT,'vehicle relationship may only be ended once'); END;
CREATE TRIGGER vehicle_relationships_no_delete BEFORE DELETE ON vehicle_relationships
BEGIN SELECT RAISE(ABORT,'vehicle relationship history is append-only'); END;

CREATE TABLE vehicle_access_grants (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  location_id TEXT,
  permission_code TEXT NOT NULL CHECK(length(permission_code) BETWEEN 1 AND 128),
  granted_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  revoked_at TEXT,
  CHECK((person_id IS NOT NULL) <> (organization_id IS NOT NULL)),
  CHECK(location_id IS NULL OR organization_id IS NOT NULL),
  CHECK(expires_at IS NULL OR expires_at > granted_at),
  CHECK(revoked_at IS NULL OR revoked_at >= granted_at),
  FOREIGN KEY(organization_id,location_id) REFERENCES org_locations(organization_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX vehicle_access_grants_person ON vehicle_access_grants(vehicle_id,person_id,permission_code,revoked_at);
CREATE INDEX vehicle_access_grants_organization ON vehicle_access_grants(vehicle_id,organization_id,permission_code,revoked_at);
CREATE TRIGGER vehicle_access_grants_revoke_only BEFORE UPDATE ON vehicle_access_grants
WHEN NEW.id IS NOT OLD.id OR NEW.vehicle_id IS NOT OLD.vehicle_id
  OR NEW.person_id IS NOT OLD.person_id OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.location_id IS NOT OLD.location_id OR NEW.permission_code IS NOT OLD.permission_code
  OR NEW.granted_by_account_id IS NOT OLD.granted_by_account_id OR NEW.granted_at IS NOT OLD.granted_at
  OR NEW.expires_at IS NOT OLD.expires_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'vehicle grant may only be revoked once'); END;
CREATE TRIGGER vehicle_access_grants_no_delete BEFORE DELETE ON vehicle_access_grants
BEGIN SELECT RAISE(ABORT,'vehicle grants retain revocation history'); END;

CREATE TABLE vehicle_garage_entries (
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(person_id,vehicle_id)
) STRICT;
CREATE INDEX vehicle_garage_entries_vehicle ON vehicle_garage_entries(vehicle_id,person_id);
