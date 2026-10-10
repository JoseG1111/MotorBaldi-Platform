PRAGMA foreign_keys = ON;

CREATE TABLE notification_preferences (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 category TEXT NOT NULL CHECK(category IN ('TRANSACTIONAL','SUPPORT','MARKETING')),
 channel TEXT NOT NULL CHECK(channel IN ('IN_APP','EMAIL','SMS','WHATSAPP')),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 contact_method_id TEXT REFERENCES iam_contact_methods(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(account_id,category,channel),
 CHECK(category<>'MARKETING' OR channel<>'IN_APP'),
 CHECK((channel='IN_APP' AND contact_method_id IS NULL) OR (channel<>'IN_APP' AND (enabled=0 OR contact_method_id IS NOT NULL)))
) STRICT;
CREATE TABLE notification_template_versions (
 code TEXT NOT NULL CHECK(code IN ('MEMBERSHIP_UPDATE')),
 version INTEGER NOT NULL CHECK(version>0),
 locale TEXT NOT NULL CHECK(locale IN ('es','en')),
 category TEXT NOT NULL CHECK(category IN ('TRANSACTIONAL','SUPPORT')),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 parameter_contract_json TEXT NOT NULL CHECK(json_valid(parameter_contract_json)),
 PRIMARY KEY(code,version,locale)
) STRICT;
INSERT INTO notification_template_versions(code,version,locale,category,title,body,parameter_contract_json) VALUES
 ('MEMBERSHIP_UPDATE',1,'es','TRANSACTIONAL','Tu membresía tiene una actualización','Revisa el estado de tu membresía en tu cuenta. Este aviso no confirma un pago ni activa beneficios.','{"subscriptionId":"uuid"}'),
 ('MEMBERSHIP_UPDATE',1,'en','TRANSACTIONAL','Your membership has an update','Review your membership status in your account. This notice does not confirm a payment or activate benefits.','{"subscriptionId":"uuid"}');
CREATE TABLE notification_inbox (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 template_code TEXT NOT NULL,
 template_version INTEGER NOT NULL,
 locale TEXT NOT NULL DEFAULT 'es' CHECK(locale IN ('es','en')),
 source_event_id TEXT NOT NULL REFERENCES integration_outbox_events(id) ON DELETE RESTRICT,
 parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json) AND length(parameters_json)<=1024),
 read_at TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(template_code,template_version,locale) REFERENCES notification_template_versions(code,version,locale) ON DELETE RESTRICT,
 UNIQUE(account_id,source_event_id,template_code)
) STRICT;
CREATE INDEX notification_inbox_account ON notification_inbox(account_id,created_at,id);
CREATE TABLE notification_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 external_delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK(external_delivery_enabled=0),
 retention_seconds INTEGER CHECK(retention_seconds>0),
 retention_approved INTEGER NOT NULL DEFAULT 0 CHECK(retention_approved IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(retention_approved=0 OR retention_seconds IS NOT NULL)
) STRICT;
INSERT INTO notification_policy(singleton) VALUES(1);

CREATE TRIGGER notification_preference_initial_version BEFORE INSERT ON notification_preferences
WHEN NEW.version<>1
BEGIN SELECT RAISE(ABORT,'NOTIFICATION_PREFERENCE_INITIAL_VERSION'); END;
CREATE TRIGGER notification_preference_insert_boundary BEFORE INSERT ON notification_preferences
WHEN NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR (NEW.contact_method_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM iam_contact_methods c JOIN iam_accounts a ON a.person_id=c.person_id
 WHERE a.id=NEW.account_id AND c.id=NEW.contact_method_id AND c.type=CASE WHEN NEW.channel='EMAIL' THEN 'EMAIL' ELSE 'PHONE' END))
 OR (NEW.enabled=1 AND NEW.channel<>'IN_APP' AND NOT EXISTS(SELECT 1 FROM iam_contact_methods c JOIN iam_accounts a ON a.person_id=c.person_id
 WHERE a.id=NEW.account_id AND c.id=NEW.contact_method_id AND c.verification_status='VERIFIED' AND c.verified_at IS NOT NULL
 AND (c.source<>'AUTH' OR EXISTS(SELECT 1 FROM auth_users u WHERE u.id=a.id AND u.email_verified=1 AND lower(trim(u.email))=c.normalized_value))))
 OR (NEW.enabled=1 AND NEW.category='MARKETING' AND NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_consent_events c ON c.person_id=a.person_id
 WHERE a.id=NEW.account_id AND c.purpose='MARKETING_'||NEW.channel AND c.status='GRANTED' AND c.occurred_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND c.id=(SELECT latest.id FROM iam_consent_events latest WHERE latest.person_id=a.person_id AND latest.purpose=c.purpose ORDER BY latest.occurred_at DESC,latest.id DESC LIMIT 1)))
BEGIN SELECT RAISE(ABORT,'NOTIFICATION_PREFERENCE_BOUNDARY'); END;
CREATE TRIGGER notification_preference_update_guard BEFORE UPDATE ON notification_preferences
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.category IS NOT OLD.category OR NEW.channel IS NOT OLD.channel OR NEW.version<>OLD.version+1
 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR (NEW.contact_method_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM iam_contact_methods c JOIN iam_accounts a ON a.person_id=c.person_id
 WHERE a.id=NEW.account_id AND c.id=NEW.contact_method_id AND c.type=CASE WHEN NEW.channel='EMAIL' THEN 'EMAIL' ELSE 'PHONE' END))
 OR (NEW.enabled=1 AND NEW.channel<>'IN_APP' AND NOT EXISTS(SELECT 1 FROM iam_contact_methods c JOIN iam_accounts a ON a.person_id=c.person_id
 WHERE a.id=NEW.account_id AND c.id=NEW.contact_method_id AND c.verification_status='VERIFIED' AND c.verified_at IS NOT NULL
 AND (c.source<>'AUTH' OR EXISTS(SELECT 1 FROM auth_users u WHERE u.id=a.id AND u.email_verified=1 AND lower(trim(u.email))=c.normalized_value))))
 OR (NEW.enabled=1 AND NEW.category='MARKETING' AND NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_consent_events c ON c.person_id=a.person_id
 WHERE a.id=NEW.account_id AND c.purpose='MARKETING_'||NEW.channel AND c.status='GRANTED' AND c.occurred_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND c.id=(SELECT latest.id FROM iam_consent_events latest WHERE latest.person_id=a.person_id AND latest.purpose=c.purpose ORDER BY latest.occurred_at DESC,latest.id DESC LIMIT 1)))
BEGIN SELECT RAISE(ABORT,'NOTIFICATION_PREFERENCE_BOUNDARY'); END;
CREATE TRIGGER notification_inbox_initial_guard BEFORE INSERT ON notification_inbox
WHEN NEW.read_at IS NOT NULL OR NEW.version<>1
 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR NOT EXISTS(SELECT 1 FROM integration_outbox_events e JOIN billing_subscriptions s ON s.id=json_extract(e.payload_json,'$.subscriptionId')
 WHERE e.id=NEW.source_event_id AND e.event_type='billing.subscription.changed.v1' AND e.event_version=1 AND e.external_effect_policy='IDEMPOTENT' AND e.aggregate_type='billing' AND e.aggregate_id=s.id
 AND s.account_id=NEW.account_id AND NEW.template_code='MEMBERSHIP_UPDATE'
 AND json_type(e.payload_json)='object' AND (SELECT count(*) FROM json_each(e.payload_json))=1
 AND json_type(NEW.parameters_json)='object' AND json_extract(NEW.parameters_json,'$.subscriptionId')=s.id
 AND (SELECT count(*) FROM json_each(NEW.parameters_json))=1)
 OR EXISTS(SELECT 1 FROM notification_preferences pref WHERE pref.account_id=NEW.account_id AND pref.category='TRANSACTIONAL' AND pref.channel='IN_APP' AND pref.enabled=0)
BEGIN SELECT RAISE(ABORT,'NOTIFICATION_INBOX_BOUNDARY'); END;
CREATE TRIGGER notification_inbox_read_only BEFORE UPDATE ON notification_inbox
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.template_code IS NOT OLD.template_code OR NEW.template_version IS NOT OLD.template_version OR NEW.locale IS NOT OLD.locale OR NEW.source_event_id IS NOT OLD.source_event_id OR NEW.parameters_json IS NOT OLD.parameters_json OR NEW.created_at IS NOT OLD.created_at
 OR NEW.version<>OLD.version+1 OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
BEGIN SELECT RAISE(ABORT,'NOTIFICATION_INBOX_IMMUTABLE'); END;
CREATE TRIGGER notification_templates_no_update BEFORE UPDATE ON notification_template_versions BEGIN SELECT RAISE(ABORT,'notification templates are immutable'); END;
CREATE TRIGGER notification_templates_no_delete BEFORE DELETE ON notification_template_versions BEGIN SELECT RAISE(ABORT,'notification templates cannot be deleted'); END;
CREATE TRIGGER notification_preferences_no_delete BEFORE DELETE ON notification_preferences BEGIN SELECT RAISE(ABORT,'notification preferences cannot be deleted'); END;
CREATE TRIGGER notification_inbox_no_delete BEFORE DELETE ON notification_inbox BEGIN SELECT RAISE(ABORT,'notification history cannot be deleted'); END;
