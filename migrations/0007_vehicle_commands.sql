PRAGMA foreign_keys = ON;

INSERT INTO authz_permissions(code) VALUES
 ('platform.vehicle.read'),('platform.vehicle.manage'),('org.vehicle.record.manage');
INSERT INTO authz_role_permissions(role_id,permission_code) VALUES
 ('platform-superadmin','platform.vehicle.read'),
 ('platform-superadmin','platform.vehicle.manage'),
 ('platform-operations','platform.vehicle.read'),
 ('platform-operations','platform.vehicle.manage'),
 ('org-owner','org.vehicle.record.manage'),
 ('org-admin','org.vehicle.record.manage'),
 ('org-mechanic','org.vehicle.record.manage'),
 ('org-inspector','org.vehicle.record.manage');

CREATE TRIGGER vehicle_claims_decision_only BEFORE UPDATE ON vehicle_claims
WHEN OLD.status <> 'PENDING' OR NEW.status = 'PENDING'
 OR NEW.id IS NOT OLD.id OR NEW.vehicle_id IS NOT OLD.vehicle_id
 OR NEW.relationship_type IS NOT OLD.relationship_type
 OR NEW.claimant_person_id IS NOT OLD.claimant_person_id
 OR NEW.claimant_organization_id IS NOT OLD.claimant_organization_id
 OR NEW.submitted_by_person_id IS NOT OLD.submitted_by_person_id
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'vehicle claim permits only one terminal decision'); END;
CREATE TRIGGER vehicle_claims_no_delete BEFORE DELETE ON vehicle_claims
BEGIN SELECT RAISE(ABORT,'vehicle claims retain review history'); END;
CREATE TRIGGER vehicle_relationship_claim_target BEFORE INSERT ON vehicle_relationships
WHEN NEW.source_claim_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM vehicle_claims c WHERE c.id=NEW.source_claim_id
 AND c.claimant_person_id IS NEW.person_id AND c.claimant_organization_id IS NEW.organization_id
)
BEGIN SELECT RAISE(ABORT,'relationship target must match accepted claim'); END;
