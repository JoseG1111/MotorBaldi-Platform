PRAGMA foreign_keys = ON;
INSERT INTO authz_permissions(code) VALUES ('platform.catalog.manage'),('org.parts.manage');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT id,'platform.catalog.manage' FROM authz_roles WHERE scope='PLATFORM' AND code IN ('PLATFORM_SUPERADMIN','CATALOG_ADMIN');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT id,'org.parts.manage' FROM authz_roles WHERE scope='ORGANIZATION' AND code IN ('OWNER','ADMIN');
CREATE TABLE parts_canonical (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,15,1)='7'),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 category TEXT NOT NULL CHECK(length(trim(category)) BETWEEN 1 AND 100),
 brand TEXT NOT NULL CHECK(length(trim(brand)) BETWEEN 1 AND 160),
 manufacturer_reference TEXT NOT NULL CHECK(length(trim(manufacturer_reference)) BETWEEN 1 AND 160),
 brand_key TEXT NOT NULL CHECK(length(brand_key) BETWEEN 1 AND 480),
 reference_key TEXT NOT NULL CHECK(length(reference_key) BETWEEN 1 AND 480),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 unit TEXT NOT NULL CHECK(length(trim(unit)) BETWEEN 1 AND 40),
 compatibility_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(compatibility_json) AND json_type(compatibility_json)='array' AND json_array_length(compatibility_json)<=30),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 last_actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ACTIVE','ARCHIVED')),
 UNIQUE(brand_key,reference_key)
) STRICT;
CREATE INDEX parts_canonical_status ON parts_canonical(status,id);
CREATE TABLE parts_offerings (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,15,1)='7'),
 organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
 location_id TEXT,
 canonical_part_id TEXT REFERENCES parts_canonical(id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 category TEXT NOT NULL CHECK(length(trim(category)) BETWEEN 1 AND 100),
 brand TEXT NOT NULL CHECK(length(trim(brand)) BETWEEN 1 AND 160),
 manufacturer_reference TEXT NOT NULL CHECK(length(trim(manufacturer_reference)) BETWEEN 1 AND 160),
 brand_key TEXT NOT NULL CHECK(length(brand_key) BETWEEN 1 AND 480),
 reference_key TEXT NOT NULL CHECK(length(reference_key) BETWEEN 1 AND 480),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 unit TEXT NOT NULL CHECK(length(trim(unit)) BETWEEN 1 AND 40),
 compatibility_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(compatibility_json) AND json_type(compatibility_json)='array' AND json_array_length(compatibility_json)<=30),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 last_actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 partner_sku TEXT CHECK(partner_sku IS NULL OR length(trim(partner_sku)) BETWEEN 1 AND 160),
 price_minor INTEGER CHECK(price_minor IS NULL OR price_minor BETWEEN 0 AND 9007199254740991),
 currency TEXT NOT NULL DEFAULT 'COP' CHECK(currency='COP'),
 availability TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(availability IN ('UNKNOWN','AVAILABLE','UNAVAILABLE')),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ACTIVE','INACTIVE')),
 FOREIGN KEY(organization_id,location_id) REFERENCES org_locations(organization_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX parts_offering_scope ON parts_offerings(organization_id,location_id,id);
CREATE TABLE parts_change_history (
 id TEXT PRIMARY KEY,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('canonical','offering')),
 resource_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 status TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(resource_type,resource_id,version)
) STRICT;
CREATE TABLE parts_workshop_snapshots (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES workshop_orders(id) ON DELETE RESTRICT,
 organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
 location_id TEXT NOT NULL,
 offering_id TEXT NOT NULL REFERENCES parts_offerings(id) ON DELETE RESTRICT,
 canonical_part_id TEXT REFERENCES parts_canonical(id) ON DELETE RESTRICT,
 offering_version INTEGER NOT NULL CHECK(offering_version>0),
 canonical_version INTEGER,
 order_version INTEGER NOT NULL CHECK(order_version>0),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(organization_id,location_id) REFERENCES org_locations(organization_id,id) ON DELETE RESTRICT,
 UNIQUE(order_id,order_version)
) STRICT;
CREATE TRIGGER parts_canonical_insert_guard BEFORE INSERT ON parts_canonical WHEN NEW.status<>'DRAFT' OR NEW.version<>1 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN platform_person_roles pr ON pr.person_id=p.id JOIN authz_roles r ON r.id=pr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=NEW.last_actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND r.scope='PLATFORM' AND r.code IN ('PLATFORM_SUPERADMIN','CATALOG_ADMIN') AND rp.permission_code='platform.catalog.manage') OR EXISTS(SELECT 1 FROM json_each(NEW.compatibility_json) c WHERE json_type(c.value)<>'object' OR json_type(c.value,'$.verified') IS NOT 'false' OR json_type(c.value,'$.vehicleKind') IS NOT 'text' OR length(json_extract(c.value,'$.vehicleKind')) NOT BETWEEN 1 AND 40 OR EXISTS(SELECT 1 FROM json_each(c.value) field WHERE field.key NOT IN ('vehicleKind','brand','model','note','verified'))) BEGIN SELECT RAISE(ABORT,'PARTS_BOUNDARY'); END;
CREATE TRIGGER parts_canonical_update_guard BEFORE UPDATE ON parts_canonical WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN platform_person_roles pr ON pr.person_id=p.id JOIN authz_roles r ON r.id=pr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=NEW.last_actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND r.scope='PLATFORM' AND r.code IN ('PLATFORM_SUPERADMIN','CATALOG_ADMIN') AND rp.permission_code='platform.catalog.manage') OR EXISTS(SELECT 1 FROM json_each(NEW.compatibility_json) c WHERE json_type(c.value)<>'object' OR json_type(c.value,'$.verified') IS NOT 'false' OR json_type(c.value,'$.vehicleKind') IS NOT 'text' OR length(json_extract(c.value,'$.vehicleKind')) NOT BETWEEN 1 AND 40 OR EXISTS(SELECT 1 FROM json_each(c.value) field WHERE field.key NOT IN ('vehicleKind','brand','model','note','verified'))) BEGIN SELECT RAISE(ABORT,'PARTS_BOUNDARY'); END;
CREATE TRIGGER parts_canonical_no_delete BEFORE DELETE ON parts_canonical BEGIN SELECT RAISE(ABORT,'parts retain historical references'); END;
CREATE TRIGGER parts_offerings_insert_guard BEFORE INSERT ON parts_offerings WHEN NEW.status<>'DRAFT' OR NEW.version<>1 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN org_memberships m ON m.person_id=p.id JOIN org_organizations o ON o.id=m.organization_id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=NEW.last_actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND o.id=NEW.organization_id AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.scope='ORGANIZATION' AND r.code IN ('OWNER','ADMIN') AND rp.permission_code='org.parts.manage' AND ((NEW.location_id IS NULL AND m.location_scope_type='ALL_LOCATIONS') OR (NEW.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_locations l WHERE l.id=NEW.location_id AND l.organization_id=o.id AND l.status='ACTIVE') AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=NEW.location_id)))) AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='PARTS') OR (NEW.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=NEW.location_id AND c.code='PARTS')))) OR EXISTS(SELECT 1 FROM json_each(NEW.compatibility_json) c WHERE json_type(c.value)<>'object' OR json_type(c.value,'$.verified') IS NOT 'false' OR json_type(c.value,'$.vehicleKind') IS NOT 'text' OR length(json_extract(c.value,'$.vehicleKind')) NOT BETWEEN 1 AND 40 OR EXISTS(SELECT 1 FROM json_each(c.value) field WHERE field.key NOT IN ('vehicleKind','brand','model','note','verified'))) OR (NEW.canonical_part_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM parts_canonical p WHERE p.id=NEW.canonical_part_id AND p.brand_key=NEW.brand_key AND p.reference_key=NEW.reference_key AND (NEW.status<>'ACTIVE' OR p.status='ACTIVE'))) BEGIN SELECT RAISE(ABORT,'PARTS_BOUNDARY'); END;
CREATE TRIGGER parts_offerings_update_guard BEFORE UPDATE ON parts_offerings WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN org_memberships m ON m.person_id=p.id JOIN org_organizations o ON o.id=m.organization_id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=NEW.last_actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND o.id=NEW.organization_id AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.scope='ORGANIZATION' AND r.code IN ('OWNER','ADMIN') AND rp.permission_code='org.parts.manage' AND ((NEW.location_id IS NULL AND m.location_scope_type='ALL_LOCATIONS') OR (NEW.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_locations l WHERE l.id=NEW.location_id AND l.organization_id=o.id AND l.status='ACTIVE') AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=NEW.location_id)))) AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='PARTS') OR (NEW.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=NEW.location_id AND c.code='PARTS')))) OR EXISTS(SELECT 1 FROM json_each(NEW.compatibility_json) c WHERE json_type(c.value)<>'object' OR json_type(c.value,'$.verified') IS NOT 'false' OR json_type(c.value,'$.vehicleKind') IS NOT 'text' OR length(json_extract(c.value,'$.vehicleKind')) NOT BETWEEN 1 AND 40 OR EXISTS(SELECT 1 FROM json_each(c.value) field WHERE field.key NOT IN ('vehicleKind','brand','model','note','verified'))) OR NEW.organization_id IS NOT OLD.organization_id OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN org_memberships m ON m.person_id=p.id JOIN org_organizations o ON o.id=m.organization_id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=NEW.last_actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND o.id=OLD.organization_id AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.scope='ORGANIZATION' AND r.code IN ('OWNER','ADMIN') AND rp.permission_code='org.parts.manage' AND ((OLD.location_id IS NULL AND m.location_scope_type='ALL_LOCATIONS') OR (OLD.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_locations l WHERE l.id=OLD.location_id AND l.organization_id=o.id AND l.status='ACTIVE') AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=OLD.location_id)))) AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='PARTS') OR (OLD.location_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=OLD.location_id AND c.code='PARTS')))) OR (NEW.canonical_part_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM parts_canonical p WHERE p.id=NEW.canonical_part_id AND p.brand_key=NEW.brand_key AND p.reference_key=NEW.reference_key AND (NEW.status<>'ACTIVE' OR p.status='ACTIVE'))) BEGIN SELECT RAISE(ABORT,'PARTS_BOUNDARY'); END;
CREATE TRIGGER parts_offerings_no_delete BEFORE DELETE ON parts_offerings BEGIN SELECT RAISE(ABORT,'parts retain historical references'); END;
CREATE TRIGGER parts_history_guard BEFORE INSERT ON parts_change_history WHEN
 (NEW.resource_type='canonical' AND NOT EXISTS(SELECT 1 FROM parts_canonical p WHERE p.id=NEW.resource_id AND p.version=NEW.version AND p.status=NEW.status AND p.last_actor_account_id=NEW.actor_account_id AND json_extract(NEW.snapshot_json,'$.id') IS p.id AND json_extract(NEW.snapshot_json,'$.name') IS p.name AND json_extract(NEW.snapshot_json,'$.category') IS p.category AND json_extract(NEW.snapshot_json,'$.brand') IS p.brand AND json_extract(NEW.snapshot_json,'$.manufacturerReference') IS p.manufacturer_reference AND json_extract(NEW.snapshot_json,'$.description') IS p.description AND json_extract(NEW.snapshot_json,'$.unit') IS p.unit AND json_extract(NEW.snapshot_json,'$.compatibility') IS json(p.compatibility_json) AND json_extract(NEW.snapshot_json,'$.version') IS p.version AND json_extract(NEW.snapshot_json,'$.status') IS p.status)) OR
 (NEW.resource_type='offering' AND NOT EXISTS(SELECT 1 FROM parts_offerings p WHERE p.id=NEW.resource_id AND p.version=NEW.version AND p.status=NEW.status AND p.last_actor_account_id=NEW.actor_account_id AND json_extract(NEW.snapshot_json,'$.id') IS p.id AND json_extract(NEW.snapshot_json,'$.name') IS p.name AND json_extract(NEW.snapshot_json,'$.category') IS p.category AND json_extract(NEW.snapshot_json,'$.brand') IS p.brand AND json_extract(NEW.snapshot_json,'$.manufacturerReference') IS p.manufacturer_reference AND json_extract(NEW.snapshot_json,'$.description') IS p.description AND json_extract(NEW.snapshot_json,'$.unit') IS p.unit AND json_extract(NEW.snapshot_json,'$.compatibility') IS json(p.compatibility_json) AND json_extract(NEW.snapshot_json,'$.version') IS p.version AND json_extract(NEW.snapshot_json,'$.status') IS p.status AND json_extract(NEW.snapshot_json,'$.organizationId') IS p.organization_id AND json_extract(NEW.snapshot_json,'$.locationId') IS p.location_id AND json_extract(NEW.snapshot_json,'$.canonicalPartId') IS p.canonical_part_id AND json_extract(NEW.snapshot_json,'$.partnerSku') IS p.partner_sku AND json_extract(NEW.snapshot_json,'$.priceMinor') IS p.price_minor AND json_extract(NEW.snapshot_json,'$.currency') IS p.currency AND json_extract(NEW.snapshot_json,'$.availability') IS p.availability))
 BEGIN SELECT RAISE(ABORT,'PARTS_HISTORY_BOUNDARY'); END;
CREATE TRIGGER parts_change_history_no_update BEFORE UPDATE ON parts_change_history BEGIN SELECT RAISE(ABORT,'parts snapshots are immutable'); END;
CREATE TRIGGER parts_change_history_no_delete BEFORE DELETE ON parts_change_history BEGIN SELECT RAISE(ABORT,'parts snapshots are immutable'); END;
CREATE TRIGGER parts_workshop_snapshots_no_update BEFORE UPDATE ON parts_workshop_snapshots BEGIN SELECT RAISE(ABORT,'parts snapshots are immutable'); END;
CREATE TRIGGER parts_workshop_snapshots_no_delete BEFORE DELETE ON parts_workshop_snapshots BEGIN SELECT RAISE(ABORT,'parts snapshots are immutable'); END;
CREATE TRIGGER parts_workshop_snapshot_guard BEFORE INSERT ON parts_workshop_snapshots WHEN NOT EXISTS(
 SELECT 1 FROM workshop_orders w JOIN parts_offerings f ON f.id=NEW.offering_id JOIN iam_accounts a ON a.id=NEW.actor_account_id JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN org_memberships m ON m.person_id=p.id AND m.organization_id=w.organization_id JOIN org_organizations o ON o.id=m.organization_id JOIN org_locations l ON l.id=w.location_id AND l.organization_id=o.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_role_permissions rp ON rp.role_id=mr.role_id JOIN authz_roles r ON r.id=mr.role_id
 WHERE w.id=NEW.order_id AND w.organization_id=NEW.organization_id AND w.location_id=NEW.location_id AND w.version=NEW.order_version AND w.status IN ('DRAFT','OPEN','IN_PROGRESS')
 AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1)
 AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.status='ACTIVE' AND r.scope='ORGANIZATION' AND rp.permission_code='org.workshop.manage'
 AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=l.id))
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK')) OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK')))
 AND EXISTS(SELECT 1 FROM vehicle_access_grants g WHERE g.vehicle_id=w.vehicle_id AND g.permission_code='vehicle.workshop.write' AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (g.person_id=p.id OR (g.organization_id=o.id AND (g.location_id IS NULL OR g.location_id=l.id))))
 AND f.organization_id=o.id AND (f.location_id IS NULL OR f.location_id=l.id) AND f.status='ACTIVE' AND f.version=NEW.offering_version AND f.canonical_part_id IS NEW.canonical_part_id
 AND (f.canonical_part_id IS NULL OR EXISTS(SELECT 1 FROM parts_canonical c WHERE c.id=f.canonical_part_id AND c.status='ACTIVE' AND c.version=NEW.canonical_version AND c.brand_key=f.brand_key AND c.reference_key=f.reference_key))
 AND json_extract(NEW.snapshot_json,'$.name') IS f.name AND json_extract(NEW.snapshot_json,'$.brand') IS f.brand AND json_extract(NEW.snapshot_json,'$.manufacturerReference') IS f.manufacturer_reference AND json_extract(NEW.snapshot_json,'$.priceMinor') IS f.price_minor AND json_extract(NEW.snapshot_json,'$.currency') IS f.currency AND json_extract(NEW.snapshot_json,'$.unit') IS f.unit
) BEGIN SELECT RAISE(ABORT,'PARTS_SNAPSHOT_BOUNDARY'); END;

-- Keep content validation separate to stay below D1's bounded expression depth.
CREATE TRIGGER parts_workshop_snapshot_content_guard BEFORE INSERT ON parts_workshop_snapshots WHEN NOT EXISTS(
 SELECT 1 FROM workshop_orders w JOIN parts_offerings f ON f.id=NEW.offering_id JOIN org_locations l ON l.id=w.location_id AND l.organization_id=w.organization_id
 WHERE w.id=NEW.order_id
 AND json_extract(NEW.snapshot_json,'$.category') IS f.category AND json_extract(NEW.snapshot_json,'$.description') IS f.description AND json_extract(NEW.snapshot_json,'$.compatibility') IS json(f.compatibility_json) AND json_extract(NEW.snapshot_json,'$.availability') IS f.availability AND json_extract(NEW.snapshot_json,'$.partnerSku') IS f.partner_sku AND json_extract(NEW.snapshot_json,'$.status') IS f.status
 AND json_extract(NEW.snapshot_json,'$.id') IS f.id AND json_extract(NEW.snapshot_json,'$.offeringId') IS f.id AND json_extract(NEW.snapshot_json,'$.organizationId') IS f.organization_id AND json_extract(NEW.snapshot_json,'$.locationId') IS f.location_id AND json_extract(NEW.snapshot_json,'$.canonicalPartId') IS f.canonical_part_id
 AND json_extract(NEW.snapshot_json,'$.version') IS f.version AND json_extract(NEW.snapshot_json,'$.offeringVersion') IS NEW.offering_version AND json_extract(NEW.snapshot_json,'$.canonicalVersion') IS NEW.canonical_version AND json_extract(NEW.snapshot_json,'$.orderId') IS w.id AND json_extract(NEW.snapshot_json,'$.orderVersion') IS w.version AND json_extract(NEW.snapshot_json,'$.orderLocationId') IS l.id
 AND (f.canonical_part_id IS NOT NULL OR NEW.canonical_version IS NULL)
) BEGIN SELECT RAISE(ABORT,'PARTS_SNAPSHOT_BOUNDARY'); END;
