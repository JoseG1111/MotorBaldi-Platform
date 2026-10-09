PRAGMA foreign_keys = ON;

INSERT INTO authz_permissions(code) VALUES ('org.workshop.read'),('org.workshop.manage'),('org.workshop.execute'),('platform.workshop.read');
INSERT INTO authz_role_permissions(role_id,permission_code) VALUES
 ('org-owner','org.workshop.read'),('org-owner','org.workshop.manage'),('org-owner','org.workshop.execute'),
 ('org-admin','org.workshop.read'),('org-admin','org.workshop.manage'),('org-admin','org.workshop.execute'),
 ('org-service-advisor','org.workshop.read'),('org-service-advisor','org.workshop.manage'),
 ('org-mechanic','org.workshop.read'),('org-mechanic','org.workshop.execute'),('org-viewer','org.workshop.read'),
 ('platform-superadmin','platform.workshop.read'),('platform-operations','platform.workshop.read');

CREATE TABLE workshop_orders (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,15,1)='7'),
 vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
 organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
 location_id TEXT NOT NULL,
 description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 5 AND 4000),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','OPEN','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED')),
 assigned_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
 final_record_id TEXT UNIQUE REFERENCES vehicle_professional_records(id) ON DELETE RESTRICT,
 created_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(status NOT IN ('IN_PROGRESS','COMPLETED','CLOSED') OR assigned_person_id IS NOT NULL),
 CHECK((status IN ('COMPLETED','CLOSED'))=(final_record_id IS NOT NULL)),
 FOREIGN KEY(organization_id,location_id) REFERENCES org_locations(organization_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX workshop_order_scope ON workshop_orders(organization_id,location_id,id);
CREATE INDEX workshop_order_vehicle ON workshop_orders(vehicle_id,id);
CREATE TRIGGER workshop_order_update_invariants BEFORE UPDATE ON workshop_orders
WHEN OLD.status IN ('CLOSED','CANCELLED') OR NEW.version<>OLD.version+1
 OR NEW.id IS NOT OLD.id OR NEW.vehicle_id IS NOT OLD.vehicle_id OR NEW.organization_id IS NOT OLD.organization_id
 OR NEW.location_id IS NOT OLD.location_id OR NEW.created_by_account_id IS NOT OLD.created_by_account_id OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.status<>OLD.status AND NOT (
  (OLD.status='DRAFT' AND NEW.status IN ('OPEN','CANCELLED')) OR
  (OLD.status='OPEN' AND NEW.status IN ('IN_PROGRESS','CANCELLED')) OR
  (OLD.status='IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED')) OR
  (OLD.status='COMPLETED' AND NEW.status='CLOSED')
 ))
 OR (OLD.status='COMPLETED' AND (NEW.status<>'CLOSED' OR NEW.description IS NOT OLD.description OR NEW.assigned_person_id IS NOT OLD.assigned_person_id))
 OR (NEW.final_record_id IS NOT OLD.final_record_id AND NOT (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETED'))
BEGIN SELECT RAISE(ABORT,'WORKSHOP_ORDER_INVALID_CHANGE'); END;
CREATE TRIGGER workshop_order_completion_record BEFORE UPDATE ON workshop_orders
WHEN NEW.final_record_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM vehicle_professional_records r WHERE r.id=NEW.final_record_id
 AND r.vehicle_id=NEW.vehicle_id AND r.organization_id=NEW.organization_id AND r.location_id=NEW.location_id
 AND r.author_person_id=NEW.assigned_person_id AND r.status='FINAL'
)
BEGIN SELECT RAISE(ABORT,'WORKSHOP_FINAL_RECORD_REQUIRED'); END;
CREATE TRIGGER workshop_order_draft_creation BEFORE INSERT ON workshop_orders
WHEN NEW.status<>'DRAFT' OR NEW.final_record_id IS NOT NULL OR NEW.version<>1
BEGIN SELECT RAISE(ABORT,'WORKSHOP_DRAFT_REQUIRED'); END;
CREATE TRIGGER workshop_order_no_delete BEFORE DELETE ON workshop_orders
BEGIN SELECT RAISE(ABORT,'workshop orders retain operational history'); END;

CREATE TABLE workshop_order_events (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES workshop_orders(id) ON DELETE RESTRICT,
 from_status TEXT,
 to_status TEXT NOT NULL CHECK(to_status IN ('DRAFT','OPEN','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED')),
 version INTEGER NOT NULL CHECK(version>0),
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(order_id,version)
) STRICT;
CREATE INDEX workshop_order_event_history ON workshop_order_events(order_id,version);
CREATE TRIGGER workshop_order_event_no_update BEFORE UPDATE ON workshop_order_events
BEGIN SELECT RAISE(ABORT,'workshop order events are append-only'); END;
CREATE TRIGGER workshop_order_event_no_delete BEFORE DELETE ON workshop_order_events
BEGIN SELECT RAISE(ABORT,'workshop order events are append-only'); END;
