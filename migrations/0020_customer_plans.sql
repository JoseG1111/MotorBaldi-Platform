PRAGMA foreign_keys = ON;

UPDATE billing_plans SET name='MOTORBALDI PREMIUM', vehicle_limit=3, version=version+1
 WHERE code IN ('ACOMPANAMIENTO_MONTHLY','ACOMPANAMIENTO_ANNUAL');
UPDATE billing_policies SET vehicle_limit_approved=1, version=version+1 WHERE singleton=1;

ALTER TABLE support_cases ADD COLUMN purpose TEXT NOT NULL DEFAULT 'TECHNICAL'
 CHECK(purpose IN ('TECHNICAL','VEHICLE_ASSISTANCE','PRIVACY','SECURITY','ACCOUNT','COMPLAINT'));
CREATE TRIGGER support_purpose_immutable BEFORE UPDATE OF purpose ON support_cases
 WHEN NEW.purpose IS NOT OLD.purpose
 BEGIN SELECT RAISE(ABORT,'support purpose is immutable'); END;

ALTER TABLE support_cases ADD COLUMN vehicle_id TEXT REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT;
CREATE TRIGGER support_vehicle_immutable BEFORE UPDATE OF vehicle_id ON support_cases
 WHEN NEW.vehicle_id IS NOT OLD.vehicle_id
 BEGIN SELECT RAISE(ABORT,'support vehicle context is immutable'); END;
