PRAGMA foreign_keys = ON;

CREATE TABLE governance_environment_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  environment TEXT NOT NULL CHECK (environment IN ('local','development','staging','production')),
  initialized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TRIGGER governance_environment_metadata_no_update BEFORE UPDATE ON governance_environment_metadata
BEGIN SELECT RAISE(ABORT, 'environment metadata is immutable'); END;
CREATE TRIGGER governance_environment_metadata_no_delete BEFORE DELETE ON governance_environment_metadata
BEGIN SELECT RAISE(ABORT, 'environment metadata is immutable'); END;

CREATE TABLE governance_audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 128),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  organization_id TEXT,
  request_id TEXT NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX governance_audit_resource_date ON governance_audit_events(resource_type, resource_id, occurred_at DESC);
CREATE INDEX governance_audit_actor_date ON governance_audit_events(actor_id, occurred_at DESC);
CREATE TRIGGER governance_audit_events_no_update BEFORE UPDATE ON governance_audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER governance_audit_events_no_delete BEFORE DELETE ON governance_audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TABLE governance_security_events (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 128),
  actor_id TEXT,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX governance_security_code_date ON governance_security_events(code, occurred_at DESC);
CREATE TRIGGER governance_security_events_no_update BEFORE UPDATE ON governance_security_events
BEGIN SELECT RAISE(ABORT, 'security events are append-only'); END;
CREATE TRIGGER governance_security_events_no_delete BEFORE DELETE ON governance_security_events
BEGIN SELECT RAISE(ABORT, 'security events are append-only'); END;

CREATE TABLE governance_feature_flags (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (environment IN ('local','development','staging','production')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  percentage INTEGER NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
  person_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(person_ids_json)),
  organization_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(organization_ids_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(key, environment)
) STRICT;

CREATE TABLE governance_idempotency_records (
  scope TEXT NOT NULL CHECK (length(scope) <= 256),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL,
  organization_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PROCESSING','COMPLETED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(scope, key)
) STRICT;
CREATE INDEX governance_idempotency_expires_at ON governance_idempotency_records(expires_at);

CREATE TABLE integration_outbox_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 128),
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PROCESSED','DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  last_error_code TEXT,
  request_id TEXT NOT NULL,
  processing_token TEXT,
  lease_until TEXT,
  last_enqueued_at TEXT,
  external_effect_policy TEXT NOT NULL CHECK (external_effect_policy IN ('IDEMPOTENT','RECONCILE')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (status = 'PROCESSING' AND processing_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'PROCESSING' AND processing_token IS NULL AND lease_until IS NULL)
  )
) STRICT;
CREATE INDEX integration_outbox_pending ON integration_outbox_events(status, available_at, created_at);
CREATE INDEX integration_outbox_expired_leases ON integration_outbox_events(status, lease_until);

CREATE TABLE integration_inbound_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
  provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  request_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSED','DEAD')),
  UNIQUE(provider, provider_event_id)
) STRICT;

CREATE TABLE integration_dead_letters (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE REFERENCES integration_outbox_events(id) ON DELETE RESTRICT,
  error_code TEXT NOT NULL CHECK (length(error_code) BETWEEN 1 AND 128),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolution TEXT,
  CHECK ((resolved_at IS NULL AND resolution IS NULL) OR (resolved_at IS NOT NULL AND resolution IS NOT NULL))
) STRICT;

CREATE TABLE auth_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  image TEXT,
  two_factor_enabled INTEGER NOT NULL DEFAULT 0 CHECK (two_factor_enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE auth_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(provider_id, account_id)
) STRICT;
CREATE INDEX auth_credentials_user ON auth_credentials(user_id);

CREATE TABLE auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX auth_verifications_identifier ON auth_verifications(identifier);

CREATE TABLE auth_two_factors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE RESTRICT,
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0,1)),
  failed_verification_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
  locked_until TEXT
) STRICT;

CREATE TABLE storage_files (
  id TEXT PRIMARY KEY,
  uploaded_by_account_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  active_key TEXT UNIQUE,
  declared_mime TEXT NOT NULL CHECK (declared_mime IN ('image/png','image/jpeg','application/pdf')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  status TEXT NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK(status IN ('PENDING_UPLOAD','QUARANTINED','SCANNING','ACTIVE','REJECTED','DELETED')),
  classification TEXT NOT NULL DEFAULT 'RESTRICTED' CHECK(classification IN ('CONFIDENTIAL','RESTRICTED')),
  scan_token TEXT,
  scan_started_at TEXT,
  scan_lease_until TEXT,
  scan_attempts INTEGER NOT NULL DEFAULT 0 CHECK(scan_attempts >= 0),
  last_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(status <> 'ACTIVE' OR (sha256 IS NOT NULL AND active_key IS NOT NULL)),
  CHECK(
    (status = 'SCANNING' AND scan_token IS NOT NULL AND scan_started_at IS NOT NULL AND scan_lease_until IS NOT NULL)
    OR (status <> 'SCANNING' AND scan_token IS NULL AND scan_lease_until IS NULL)
  )
) STRICT;
CREATE INDEX storage_files_uploader_date ON storage_files(uploaded_by_account_id, created_at DESC);
CREATE INDEX storage_files_stale_scan ON storage_files(status, scan_lease_until);

CREATE TABLE storage_file_promotions (
  object_key TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES storage_files(id) ON DELETE RESTRICT,
  scan_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','REFERENCED','CLEANUP','DELETED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX storage_file_promotions_cleanup ON storage_file_promotions(status, created_at);
