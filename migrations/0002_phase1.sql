PRAGMA foreign_keys = ON;

CREATE TABLE iam_people (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PROVISIONAL' CHECK(status IN ('PROVISIONAL','ACTIVE','MERGED')),
  given_name TEXT NOT NULL CHECK(length(given_name) BETWEEN 1 AND 120),
  middle_name TEXT,
  family_name TEXT NOT NULL CHECK(length(family_name) BETWEEN 1 AND 120),
  second_family_name TEXT,
  display_name TEXT,
  preferred_locale TEXT NOT NULL DEFAULT 'es' CHECK(length(preferred_locale) BETWEEN 2 AND 20),
  country_code TEXT CHECK(country_code IS NULL OR (length(country_code)=2 AND country_code=upper(country_code))),
  merged_into_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  CHECK((status='MERGED')=(merged_into_person_id IS NOT NULL)),
  CHECK(merged_into_person_id IS NULL OR merged_into_person_id<>id)
) STRICT;
CREATE INDEX iam_people_name ON iam_people(family_name,given_name,id);
CREATE TABLE iam_accounts (
  id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE INDEX iam_accounts_person ON iam_accounts(person_id);
CREATE TABLE iam_signup_consents (
  auth_user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE RESTRICT,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  request_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE integration_local_email_sink (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('VERIFY_EMAIL','PASSWORD_RESET')),
  action_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE iam_contact_methods (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK(type IN ('EMAIL','PHONE')),
  raw_value TEXT NOT NULL CHECK(length(raw_value) BETWEEN 1 AND 320),
  normalized_value TEXT NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 320),
  label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED')),
  verified_at TEXT,
  source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(person_id,type,normalized_value),
  CHECK((verification_status='VERIFIED')=(verified_at IS NOT NULL))
) STRICT;
CREATE INDEX iam_contact_lookup ON iam_contact_methods(type,normalized_value,person_id);
CREATE UNIQUE INDEX iam_contact_primary ON iam_contact_methods(person_id,type) WHERE is_primary=1;
CREATE TABLE iam_consent_events (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK(purpose IN ('TERMS','PRIVACY','MARKETING_EMAIL','MARKETING_SMS','MARKETING_WHATSAPP')),
  policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK(status IN ('GRANTED','REVOKED')),
  source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 64),
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX iam_consent_history ON iam_consent_events(person_id,purpose,occurred_at DESC);
CREATE TRIGGER iam_consent_no_update BEFORE UPDATE ON iam_consent_events BEGIN SELECT RAISE(ABORT,'consent history is append-only'); END;
CREATE TRIGGER iam_consent_no_delete BEFORE DELETE ON iam_consent_events BEGIN SELECT RAISE(ABORT,'consent history is append-only'); END;
CREATE TABLE iam_duplicate_candidates (
  id TEXT PRIMARY KEY,
  source_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  destination_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(reason IN ('SAME_VERIFIED_EMAIL','SAME_NORMALIZED_EMAIL','SAME_PHONE','MANUAL_REPORT')),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','MERGED','NOT_DUPLICATE','DISMISSED')),
  reviewed_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  reviewed_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_person_id,destination_person_id,reason),
  CHECK(source_person_id<>destination_person_id)
) STRICT;

CREATE TABLE org_organizations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('WORKSHOP','PARTS_SUPPLIER','DEALERSHIP','INSPECTION_CENTER','ROADSIDE_PROVIDER','FLEET','OTHER')),
  legal_name TEXT NOT NULL CHECK(length(legal_name) BETWEEN 1 AND 240),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 240),
  country_code TEXT NOT NULL CHECK(length(country_code)=2 AND country_code=upper(country_code)),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','CLOSED')),
  verification_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(verification_status IN ('DRAFT','PENDING_VERIFICATION','UNDER_REVIEW','NEEDS_INFORMATION','VERIFIED','REJECTED','SUSPENDED','CLOSED')),
  created_by_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE INDEX org_search ON org_organizations(display_name,id);
CREATE INDEX org_verification_queue ON org_organizations(verification_status,created_at,id);
CREATE TABLE org_identifiers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  country_code TEXT NOT NULL CHECK(length(country_code)=2 AND country_code=upper(country_code)),
  identifier_type TEXT NOT NULL CHECK(length(identifier_type) BETWEEN 1 AND 64),
  raw_value TEXT NOT NULL CHECK(length(raw_value) BETWEEN 1 AND 256),
  normalized_value TEXT NOT NULL CHECK(length(normalized_value) BETWEEN 1 AND 256),
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(organization_id,country_code,identifier_type,normalized_value)
) STRICT;
CREATE TABLE org_locations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  location_type TEXT NOT NULL CHECK(location_type IN ('HEADQUARTERS','BRANCH','SERVICE_SITE','OTHER')),
  country_code TEXT NOT NULL CHECK(length(country_code)=2 AND country_code=upper(country_code)),
  administrative_area TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT,
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT,
  latitude REAL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL CHECK(longitude BETWEEN -180 AND 180),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(id,organization_id)
) STRICT;
CREATE INDEX org_locations_org ON org_locations(organization_id,status,id);
CREATE TABLE org_capability_codes (code TEXT PRIMARY KEY) STRICT;
INSERT INTO org_capability_codes(code) VALUES ('CAR_SERVICE'),('MOTORCYCLE_SERVICE'),('GENERAL_MAINTENANCE'),('ELECTRICAL'),('DIAGNOSTICS'),('TIRES'),('BODYWORK'),('INSPECTION'),('TOWING'),('PARTS');
CREATE TABLE org_capabilities (
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL REFERENCES org_capability_codes(code) ON DELETE RESTRICT,
  PRIMARY KEY(organization_id,code)
) STRICT;
CREATE TABLE org_location_capabilities (
  organization_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  code TEXT NOT NULL REFERENCES org_capability_codes(code) ON DELETE RESTRICT,
  PRIMARY KEY(organization_id,location_id,code),
  FOREIGN KEY(location_id,organization_id) REFERENCES org_locations(id,organization_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE authz_permissions (code TEXT PRIMARY KEY) STRICT;
CREATE TABLE authz_roles (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('ORGANIZATION','PLATFORM')),
  code TEXT NOT NULL,
  system_role INTEGER NOT NULL DEFAULT 1 CHECK(system_role IN (0,1)),
  UNIQUE(scope,code)
) STRICT;
CREATE TABLE authz_role_permissions (
  role_id TEXT NOT NULL REFERENCES authz_roles(id) ON DELETE RESTRICT,
  permission_code TEXT NOT NULL REFERENCES authz_permissions(code) ON DELETE RESTRICT,
  PRIMARY KEY(role_id,permission_code)
) STRICT;
CREATE TABLE org_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','ENDED')),
  location_scope_type TEXT NOT NULL DEFAULT 'ALL_LOCATIONS' CHECK(location_scope_type IN ('ALL_LOCATIONS','SELECTED_LOCATIONS')),
  valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(id,organization_id),
  CHECK((status='ENDED')=(valid_to IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX org_active_member ON org_memberships(organization_id,person_id) WHERE status='ACTIVE';
CREATE INDEX org_member_list ON org_memberships(organization_id,status,id);
CREATE INDEX org_person_memberships ON org_memberships(person_id,status,organization_id);
CREATE TABLE org_membership_roles (
  membership_id TEXT NOT NULL REFERENCES org_memberships(id) ON DELETE RESTRICT,
  role_id TEXT NOT NULL REFERENCES authz_roles(id) ON DELETE RESTRICT,
  PRIMARY KEY(membership_id,role_id)
) STRICT;
CREATE TRIGGER org_membership_role_scope BEFORE INSERT ON org_membership_roles
WHEN NOT EXISTS (SELECT 1 FROM authz_roles WHERE id=NEW.role_id AND scope='ORGANIZATION')
BEGIN SELECT RAISE(ABORT,'organization role required'); END;
CREATE TRIGGER org_membership_role_scope_update BEFORE UPDATE OF role_id ON org_membership_roles
WHEN NOT EXISTS (SELECT 1 FROM authz_roles WHERE id=NEW.role_id AND scope='ORGANIZATION')
BEGIN SELECT RAISE(ABORT,'organization role required'); END;
CREATE TABLE org_membership_locations (
  membership_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  PRIMARY KEY(membership_id,location_id),
  FOREIGN KEY(membership_id,organization_id) REFERENCES org_memberships(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(location_id,organization_id) REFERENCES org_locations(id,organization_id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER org_last_owner_status BEFORE UPDATE OF status ON org_memberships
WHEN OLD.status='ACTIVE' AND NEW.status<>'ACTIVE' AND EXISTS (SELECT 1 FROM org_membership_roles mr JOIN authz_roles r ON r.id=mr.role_id WHERE mr.membership_id=OLD.id AND r.code='OWNER' AND r.scope='ORGANIZATION') AND NOT EXISTS (SELECT 1 FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id WHERE m.organization_id=OLD.organization_id AND m.id<>OLD.id AND m.status='ACTIVE' AND r.code='OWNER' AND r.scope='ORGANIZATION')
BEGIN SELECT RAISE(ABORT,'LAST_OWNER_REQUIRED'); END;
CREATE TRIGGER org_last_owner_role BEFORE DELETE ON org_membership_roles
WHEN EXISTS (SELECT 1 FROM authz_roles r WHERE r.id=OLD.role_id AND r.code='OWNER' AND r.scope='ORGANIZATION') AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.id=OLD.membership_id AND m.status='ACTIVE') AND NOT EXISTS (SELECT 1 FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id WHERE m.organization_id=(SELECT organization_id FROM org_memberships WHERE id=OLD.membership_id) AND m.id<>OLD.membership_id AND m.status='ACTIVE' AND r.code='OWNER' AND r.scope='ORGANIZATION')
BEGIN SELECT RAISE(ABORT,'LAST_OWNER_REQUIRED'); END;
CREATE TRIGGER org_last_owner_role_update BEFORE UPDATE OF role_id ON org_membership_roles
WHEN OLD.role_id<>NEW.role_id AND EXISTS (SELECT 1 FROM authz_roles r WHERE r.id=OLD.role_id AND r.code='OWNER' AND r.scope='ORGANIZATION') AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.id=OLD.membership_id AND m.status='ACTIVE') AND NOT EXISTS (SELECT 1 FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id WHERE m.organization_id=(SELECT organization_id FROM org_memberships WHERE id=OLD.membership_id) AND m.status='ACTIVE' AND r.code='OWNER' AND r.scope='ORGANIZATION' AND (m.id<>OLD.membership_id OR mr.role_id<>OLD.role_id))
BEGIN SELECT RAISE(ABORT,'LAST_OWNER_REQUIRED'); END;
CREATE TABLE platform_person_roles (
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  role_id TEXT NOT NULL REFERENCES authz_roles(id) ON DELETE RESTRICT,
  assigned_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(person_id,role_id)
) STRICT;
CREATE TRIGGER platform_role_scope BEFORE INSERT ON platform_person_roles
WHEN NOT EXISTS (SELECT 1 FROM authz_roles WHERE id=NEW.role_id AND scope='PLATFORM')
BEGIN SELECT RAISE(ABORT,'platform role required'); END;
CREATE TRIGGER platform_role_scope_update BEFORE UPDATE OF role_id ON platform_person_roles
WHEN NOT EXISTS (SELECT 1 FROM authz_roles WHERE id=NEW.role_id AND scope='PLATFORM')
BEGIN SELECT RAISE(ABORT,'platform role required'); END;
CREATE TRIGGER platform_last_superadmin BEFORE DELETE ON platform_person_roles
WHEN OLD.role_id='platform-superadmin' AND NOT EXISTS(SELECT 1 FROM platform_person_roles WHERE role_id='platform-superadmin' AND person_id<>OLD.person_id)
BEGIN SELECT RAISE(ABORT,'LAST_PLATFORM_SUPERADMIN_REQUIRED'); END;
CREATE TABLE org_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  target_email TEXT NOT NULL,
  proposed_roles_json TEXT NOT NULL CHECK(json_valid(proposed_roles_json)),
  location_scope_type TEXT NOT NULL CHECK(location_scope_type IN ('ALL_LOCATIONS','SELECTED_LOCATIONS')),
  proposed_locations_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(proposed_locations_json)),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  created_by_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  accepted_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
) STRICT;
CREATE INDEX org_invitation_list ON org_invitations(organization_id,status,created_at DESC,id);
CREATE TABLE org_membership_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  requested_roles_json TEXT NOT NULL CHECK(json_valid(requested_roles_json)),
  location_scope_type TEXT NOT NULL CHECK(location_scope_type IN ('ALL_LOCATIONS','SELECTED_LOCATIONS')),
  requested_locations_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(requested_locations_json)),
  message TEXT CHECK(message IS NULL OR length(message)<=2000),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  reviewed_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  reviewed_at TEXT,
  decision_reason TEXT
) STRICT;
CREATE INDEX org_request_queue ON org_membership_requests(organization_id,status,created_at,id);
CREATE TABLE org_verification_cases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('PENDING_VERIFICATION','UNDER_REVIEW','NEEDS_INFORMATION','VERIFIED','REJECTED')),
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  review_started_at TEXT,
  reviewed_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  decision_at TEXT,
  decision_reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX org_case_queue ON org_verification_cases(status,submitted_at,id);
CREATE UNIQUE INDEX org_case_active ON org_verification_cases(organization_id) WHERE status IN ('PENDING_VERIFICATION','UNDER_REVIEW');
CREATE TABLE org_verification_case_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES org_verification_cases(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  reason TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE UNIQUE INDEX org_case_transition_once ON org_verification_case_events(case_id,from_status,to_status);
CREATE TABLE org_verification_files (
  case_id TEXT NOT NULL REFERENCES org_verification_cases(id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES storage_files(id) ON DELETE RESTRICT,
  attached_by_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  attached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(case_id,file_id)
) STRICT;

CREATE TABLE professional_mechanic_profiles (
  person_id TEXT PRIMARY KEY REFERENCES iam_people(id) ON DELETE RESTRICT,
  professional_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(professional_status IN ('ACTIVE','INACTIVE')),
  bio TEXT CHECK(bio IS NULL OR length(bio)<=2000),
  years_experience INTEGER CHECK(years_experience BETWEEN 0 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE TABLE professional_specialty_codes (code TEXT PRIMARY KEY) STRICT;
INSERT INTO professional_specialty_codes(code) VALUES ('GENERAL_MAINTENANCE'),('ENGINE'),('BRAKES'),('SUSPENSION'),('ELECTRICAL'),('DIAGNOSTICS'),('TIRES'),('BODYWORK'),('AIR_CONDITIONING'),('MOTORCYCLE');
CREATE TABLE professional_person_specialties (
  person_id TEXT NOT NULL REFERENCES professional_mechanic_profiles(person_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  code TEXT NOT NULL REFERENCES professional_specialty_codes(code) ON DELETE RESTRICT,
  PRIMARY KEY(person_id,code)
) STRICT;
CREATE TABLE professional_credentials (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES professional_mechanic_profiles(person_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  credential_type TEXT NOT NULL CHECK(length(credential_type) BETWEEN 1 AND 64),
  country_code TEXT CHECK(country_code IS NULL OR (length(country_code)=2 AND country_code=upper(country_code))),
  issuer TEXT NOT NULL CHECK(length(issuer) BETWEEN 1 AND 240),
  identifier TEXT,
  issued_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED','EXPIRED','REVOKED')),
  evidence_file_id TEXT REFERENCES storage_files(id) ON DELETE RESTRICT,
  reviewed_by_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  reviewed_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE INDEX professional_credentials_person ON professional_credentials(person_id,status,id);
CREATE TABLE professional_credential_decisions (
  credential_id TEXT PRIMARY KEY REFERENCES professional_credentials(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('VERIFIED','REJECTED')),
  actor_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE crm_sources (code TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE'))) STRICT;
INSERT INTO crm_sources(code) VALUES ('WEBSITE'),('PORTAL'),('MANUAL'),('REFERRAL'),('CAMPAIGN'),('ORGANIZATION_ONBOARDING'),('OTHER');
CREATE TABLE crm_pipelines (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE crm_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK(is_terminal IN (0,1)),
  terminal_outcome TEXT CHECK(terminal_outcome IN ('WON','LOST')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  UNIQUE(pipeline_id,code), UNIQUE(id,pipeline_id), UNIQUE(pipeline_id,position)
) STRICT;
INSERT INTO crm_pipelines(id,code,name_key) VALUES ('customer-acquisition','CUSTOMER_ACQUISITION','crm.pipeline.customer'),('workshop-onboarding','WORKSHOP_ONBOARDING','crm.pipeline.workshop'),('partner-development','PARTNER_DEVELOPMENT','crm.pipeline.partner');
INSERT INTO crm_stages(id,pipeline_id,code,name_key,position,is_terminal,terminal_outcome) VALUES
 ('customer-new','customer-acquisition','NEW','crm.stage.new',0,0,NULL),('customer-contacted','customer-acquisition','CONTACTED','crm.stage.contacted',1,0,NULL),('customer-qualified','customer-acquisition','QUALIFIED','crm.stage.qualified',2,0,NULL),('customer-registered','customer-acquisition','REGISTERED','crm.stage.registered',3,0,NULL),('customer-activated','customer-acquisition','ACTIVATED','crm.stage.activated',4,1,'WON'),('customer-lost','customer-acquisition','LOST','crm.stage.lost',5,1,'LOST'),
 ('workshop-prospect','workshop-onboarding','PROSPECT','crm.stage.prospect',0,0,NULL),('workshop-contacted','workshop-onboarding','CONTACTED','crm.stage.contacted',1,0,NULL),('workshop-documentation','workshop-onboarding','DOCUMENTATION','crm.stage.documentation',2,0,NULL),('workshop-review','workshop-onboarding','REVIEW','crm.stage.review',3,0,NULL),('workshop-verified','workshop-onboarding','VERIFIED','crm.stage.verified',4,0,NULL),('workshop-active','workshop-onboarding','ACTIVE','crm.stage.active',5,1,'WON'),('workshop-lost','workshop-onboarding','LOST','crm.stage.lost',6,1,'LOST'),
 ('partner-prospect','partner-development','PROSPECT','crm.stage.prospect',0,0,NULL),('partner-contacted','partner-development','CONTACTED','crm.stage.contacted',1,0,NULL),('partner-negotiation','partner-development','NEGOTIATION','crm.stage.negotiation',2,0,NULL),('partner-documentation','partner-development','DOCUMENTATION','crm.stage.documentation',3,0,NULL),('partner-agreement','partner-development','AGREEMENT','crm.stage.agreement',4,0,NULL),('partner-active','partner-development','ACTIVE','crm.stage.active',5,1,'WON'),('partner-lost','partner-development','LOST','crm.stage.lost',6,1,'LOST');
CREATE TABLE crm_lead_intakes (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','TRIAGED','CONVERTED','REJECTED','SPAM')),
  source_id TEXT NOT NULL REFERENCES crm_sources(code) ON DELETE RESTRICT,
  given_name TEXT,
  family_name TEXT,
  email TEXT,
  phone TEXT,
  organization_name TEXT,
  message TEXT,
  country_code TEXT CHECK(country_code IS NULL OR (length(country_code)=2 AND country_code=upper(country_code))),
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT, referrer TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  triaged_at TEXT, converted_at TEXT,
  assigned_to_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE INDEX crm_lead_queue ON crm_lead_intakes(status,received_at,id);
CREATE INDEX crm_lead_email ON crm_lead_intakes(email);
CREATE TABLE crm_lead_triage_events (
  lead_id TEXT PRIMARY KEY REFERENCES crm_lead_intakes(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('TRIAGED','REJECTED','SPAM')),
  actor_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE crm_opportunities (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE RESTRICT,
  stage_id TEXT NOT NULL,
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  lead_intake_id TEXT UNIQUE REFERENCES crm_lead_intakes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  owner_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','WON','LOST')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  FOREIGN KEY(stage_id,pipeline_id) REFERENCES crm_stages(id,pipeline_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX crm_opportunity_stage ON crm_opportunities(pipeline_id,stage_id,status,id);
CREATE INDEX crm_opportunity_person ON crm_opportunities(person_id,id);
CREATE INDEX crm_opportunity_org ON crm_opportunities(organization_id,id);
CREATE TABLE crm_opportunity_stage_events (
  opportunity_id TEXT NOT NULL REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  from_version INTEGER NOT NULL,
  stage_id TEXT NOT NULL REFERENCES crm_stages(id) ON DELETE RESTRICT,
  actor_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(opportunity_id,from_version)
) STRICT;
CREATE TABLE crm_activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('CALL','EMAIL','WHATSAPP','MEETING','NOTE','TASK','SYSTEM_EVENT')),
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  actor_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
) STRICT;
CREATE INDEX crm_activity_person ON crm_activities(person_id,occurred_at DESC,id);
CREATE INDEX crm_activity_org ON crm_activities(organization_id,occurred_at DESC,id);
CREATE INDEX crm_activity_opportunity ON crm_activities(opportunity_id,occurred_at DESC,id);
CREATE TABLE crm_notes (
  id TEXT PRIMARY KEY,
  author_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE crm_tasks (
  id TEXT PRIMARY KEY,
  owner_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  assigned_by_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED')),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES org_organizations(id) ON DELETE RESTRICT,
  opportunity_id TEXT REFERENCES crm_opportunities(id) ON DELETE RESTRICT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE INDEX crm_task_owner ON crm_tasks(owner_person_id,status,due_at,id);
CREATE TABLE crm_tags (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80)) STRICT;
CREATE TABLE crm_tag_assignments (
  tag_id TEXT NOT NULL REFERENCES crm_tags(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('PERSON','ORGANIZATION','LEAD','OPPORTUNITY')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY(tag_id,entity_type,entity_id)
) STRICT;
CREATE TABLE crm_assignment_history (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('LEAD','OPPORTUNITY','TASK')),
  entity_id TEXT NOT NULL,
  from_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
  to_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  actor_person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO authz_permissions(code) VALUES
 ('org.read'),('org.update'),('org.location.read'),('org.location.manage'),('org.capability.manage'),('org.member.read'),('org.member.invite'),('org.member.manage'),('org.member.role.manage'),('org.owner.manage'),('org.membership_request.review'),('org.verification.submit'),('professional.member.read'),
 ('platform.people.read'),('platform.people.merge'),('platform.account.suspend'),('platform.organization.read'),('platform.organization.verify'),('platform.organization.suspend'),('platform.crm.read'),('platform.crm.manage'),('platform.professional.read'),('platform.professional.verify'),('platform.audit.read'),('platform.roles.manage');
INSERT INTO authz_roles(id,scope,code) VALUES
 ('org-owner','ORGANIZATION','OWNER'),('org-admin','ORGANIZATION','ADMIN'),('org-service-advisor','ORGANIZATION','SERVICE_ADVISOR'),('org-mechanic','ORGANIZATION','MECHANIC'),('org-inspector','ORGANIZATION','INSPECTOR'),('org-finance','ORGANIZATION','FINANCE'),('org-viewer','ORGANIZATION','VIEWER'),
 ('platform-superadmin','PLATFORM','PLATFORM_SUPERADMIN'),('platform-operations','PLATFORM','OPERATIONS_ADMIN'),('platform-verification','PLATFORM','VERIFICATION_AGENT'),('platform-support','PLATFORM','SUPPORT_AGENT'),('platform-finance','PLATFORM','FINANCE_ADMIN'),('platform-crm','PLATFORM','CRM_AGENT'),('platform-catalog','PLATFORM','CATALOG_ADMIN'),('platform-auditor','PLATFORM','AUDITOR');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT 'org-owner',code FROM authz_permissions WHERE code LIKE 'org.%' OR code='professional.member.read';
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT 'org-admin',code FROM authz_permissions WHERE code IN ('org.read','org.update','org.location.read','org.location.manage','org.capability.manage','org.member.read','org.member.invite','org.member.manage','org.membership_request.review','org.verification.submit','professional.member.read');
INSERT INTO authz_role_permissions(role_id,permission_code) VALUES
 ('org-service-advisor','org.read'),('org-service-advisor','org.member.read'),('org-mechanic','org.read'),('org-inspector','org.read'),('org-finance','org.read'),('org-viewer','org.read');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT 'platform-superadmin',code FROM authz_permissions WHERE code LIKE 'platform.%';
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT 'platform-operations',code FROM authz_permissions WHERE code IN ('platform.people.read','platform.account.suspend','platform.organization.read','platform.organization.suspend','platform.professional.read','platform.crm.read');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT 'platform-verification',code FROM authz_permissions WHERE code IN ('platform.people.read','platform.organization.read','platform.organization.verify','platform.professional.read','platform.professional.verify');
INSERT INTO authz_role_permissions(role_id,permission_code) VALUES
 ('platform-support','platform.people.read'),('platform-support','platform.organization.read'),
 ('platform-crm','platform.people.read'),('platform-crm','platform.organization.read'),('platform-crm','platform.crm.read'),('platform-crm','platform.crm.manage'),
 ('platform-auditor','platform.people.read'),('platform-auditor','platform.organization.read'),('platform-auditor','platform.professional.read'),('platform-auditor','platform.crm.read'),('platform-auditor','platform.audit.read');
