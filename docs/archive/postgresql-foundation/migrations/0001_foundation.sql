CREATE SCHEMA iam;
CREATE SCHEMA crm;
CREATE SCHEMA org;
CREATE SCHEMA professional;
CREATE SCHEMA vehicle;
CREATE SCHEMA service;
CREATE SCHEMA inspection;
CREATE SCHEMA billing;
CREATE SCHEMA communication;
CREATE SCHEMA notification;
CREATE SCHEMA support;
CREATE SCHEMA integration;
CREATE SCHEMA governance;

CREATE TABLE governance.audit_events (
 id uuid PRIMARY KEY, actor_id uuid, action text NOT NULL CHECK(length(action) BETWEEN 1 AND 128),
 resource_type text NOT NULL, resource_id text NOT NULL, organization_id uuid,
 request_id uuid NOT NULL, reason text CHECK(length(reason)<=1000),
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_resource_date ON governance.audit_events(resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_actor_date ON governance.audit_events(actor_id, occurred_at DESC);
CREATE TABLE governance.security_events (
 id uuid PRIMARY KEY, code text NOT NULL, actor_id uuid, request_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_code_date ON governance.security_events(code, occurred_at DESC);
CREATE FUNCTION governance.prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Append-only relation' USING ERRCODE='42501'; END;
$$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON governance.audit_events
 FOR EACH STATEMENT EXECUTE FUNCTION governance.prevent_mutation();
CREATE TRIGGER security_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON governance.security_events
 FOR EACH STATEMENT EXECUTE FUNCTION governance.prevent_mutation();

CREATE TABLE governance.feature_flags (
 id uuid PRIMARY KEY, key text NOT NULL, environment text NOT NULL CHECK(environment IN ('local','test','staging','production')),
 enabled boolean NOT NULL DEFAULT false, percentage smallint NOT NULL DEFAULT 0 CHECK(percentage BETWEEN 0 AND 100),
 person_ids uuid[] NOT NULL DEFAULT '{}', organization_ids uuid[] NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(key,environment)
);
CREATE TABLE governance.idempotency_records (
 scope varchar(256) NOT NULL, key varchar(128) NOT NULL, request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope,key)
);
CREATE TABLE integration.outbox_events (
 id uuid PRIMARY KEY, event_type text NOT NULL, aggregate_id uuid NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'), request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, processed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), available_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','QUEUED','PROCESSED','DEAD'))
);
CREATE INDEX outbox_pending ON integration.outbox_events(available_at,created_at) WHERE status IN ('PENDING','QUEUED');
CREATE TABLE integration.inbound_events (
 id uuid PRIMARY KEY, provider text NOT NULL, provider_event_id text NOT NULL,
 payload jsonb NOT NULL, request_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSED','DEAD')),
 UNIQUE(provider,provider_event_id)
);
CREATE TABLE integration.dead_letters (
 id uuid PRIMARY KEY, outbox_id uuid NOT NULL UNIQUE REFERENCES integration.outbox_events(id) ON DELETE RESTRICT,
 error_code text NOT NULL, attempts integer NOT NULL CHECK(attempts>0), request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolution text,
 CHECK((resolved_at IS NULL)=(resolution IS NULL))
);
CREATE TABLE governance.files (
 id uuid PRIMARY KEY, owner_account_id uuid NOT NULL,
 object_key text NOT NULL UNIQUE, active_key text UNIQUE,
 declared_mime text NOT NULL CHECK(declared_mime IN ('image/png','image/jpeg','application/pdf')),
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
 sha256 char(64) CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'PENDING_UPLOAD' CHECK(status IN ('PENDING_UPLOAD','QUARANTINED','SCANNING','ACTIVE','REJECTED','DELETED')),
 classification text NOT NULL DEFAULT 'RESTRICTED' CHECK(classification IN ('CONFIDENTIAL','RESTRICTED')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status <> 'ACTIVE' OR (sha256 IS NOT NULL AND active_key IS NOT NULL))
);
CREATE INDEX files_owner_date ON governance.files(owner_account_id,created_at DESC);
COMMENT ON TABLE governance.files IS 'RESTRICTED metadata; private bucket; purge policy requires domain retention review';
COMMENT ON TABLE governance.audit_events IS 'CONFIDENTIAL append-only; retention controlled by governance, never runtime deletion';
COMMENT ON TABLE governance.idempotency_records IS 'CONFIDENTIAL; retain until operation-specific safe replay horizon is defined';
