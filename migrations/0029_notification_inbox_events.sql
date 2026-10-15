PRAGMA defer_foreign_keys = ON;
-- Rebuild only the template catalog constraint, preserving every existing immutable row.
CREATE TABLE notification_template_versions_expanded (
 code TEXT NOT NULL CHECK(code IN ('MEMBERSHIP_UPDATE','SUPPORT_UPDATE','VEHICLE_EXPIRY')),
 version INTEGER NOT NULL CHECK(version>0),
 locale TEXT NOT NULL CHECK(locale IN ('es','en')),
 category TEXT NOT NULL CHECK(category IN ('TRANSACTIONAL','SUPPORT')),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 parameter_contract_json TEXT NOT NULL CHECK(json_valid(parameter_contract_json)),
 PRIMARY KEY(code,version,locale)
) STRICT;
INSERT INTO notification_template_versions_expanded SELECT * FROM notification_template_versions;
DROP TABLE notification_template_versions;
ALTER TABLE notification_template_versions_expanded RENAME TO notification_template_versions;
INSERT INTO notification_template_versions VALUES
 ('SUPPORT_UPDATE',1,'es','SUPPORT','Tu caso de soporte tiene una actualización','Revisa el estado y las respuestas de tu caso en la sección de soporte.','{"caseId":"uuid"}'),
 ('SUPPORT_UPDATE',1,'en','SUPPORT','Your support case has an update','Review your case status and replies in the support section.','{"caseId":"uuid"}'),
 ('VEHICLE_EXPIRY',1,'es','TRANSACTIONAL','Tu vehículo tiene un vencimiento próximo','Consulta los vencimientos de SOAT y revisión técnico-mecánica en Mis vehículos y vencimientos. Las fechas registradas son declaradas por ti.','{"entryId":"uuid","daysBefore":"integer"}'),
 ('VEHICLE_EXPIRY',1,'en','TRANSACTIONAL','Your vehicle has an upcoming expiry','Review your vehicle insurance and inspection dates in Vehicles and expiry dates. These dates were declared by you.','{"entryId":"uuid","daysBefore":"integer"}');
CREATE TRIGGER notification_templates_no_update BEFORE UPDATE ON notification_template_versions BEGIN SELECT RAISE(ABORT,'notification templates are immutable'); END;
CREATE TRIGGER notification_templates_no_delete BEFORE DELETE ON notification_template_versions BEGIN SELECT RAISE(ABORT,'notification templates cannot be deleted'); END;
CREATE UNIQUE INDEX notification_inbox_vehicle_expiry ON notification_inbox(account_id,json_extract(parameters_json,'$.entryId'),json_extract(parameters_json,'$.daysBefore')) WHERE template_code='VEHICLE_EXPIRY';
CREATE TABLE notification_inapp_vehicle_scan (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 calendar_date TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 account_id TEXT NOT NULL
) STRICT;
INSERT INTO notification_inapp_vehicle_scan VALUES(1,'','','');
DROP TRIGGER notification_inbox_initial_guard;
CREATE TRIGGER notification_inbox_initial_guard BEFORE INSERT ON notification_inbox
WHEN NEW.read_at IS NOT NULL OR NEW.version<>1
 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR EXISTS(SELECT 1 FROM notification_preferences pref JOIN notification_template_versions t ON t.code=NEW.template_code AND t.version=NEW.template_version AND t.locale=NEW.locale WHERE pref.account_id=NEW.account_id AND pref.category=t.category AND pref.channel='IN_APP' AND pref.enabled=0)
 OR NOT EXISTS(SELECT 1 FROM integration_outbox_events e WHERE e.id=NEW.source_event_id AND e.event_version=1 AND e.external_effect_policy='IDEMPOTENT' AND json_type(e.payload_json)='object' AND json_type(NEW.parameters_json)='object' AND (
  (NEW.template_code='MEMBERSHIP_UPDATE' AND e.aggregate_type='billing' AND (SELECT count(*) FROM json_each(NEW.parameters_json))=1 AND EXISTS(
   SELECT 1 FROM billing_subscriptions s WHERE s.id=json_extract(e.payload_json,'$.subscriptionId') AND s.id=json_extract(NEW.parameters_json,'$.subscriptionId') AND s.account_id=NEW.account_id AND (
    (e.event_type IN ('billing.subscription.changed.v1','billing.subscription.expired.v1') AND e.aggregate_id=s.id AND (SELECT count(*) FROM json_each(e.payload_json))=1)
    OR (e.event_type='billing.payment.changed.v1' AND (SELECT count(*) FROM json_each(e.payload_json))=2 AND EXISTS(SELECT 1 FROM billing_payments payment JOIN billing_periods period ON period.id=payment.period_id WHERE payment.id=e.aggregate_id AND payment.id=json_extract(e.payload_json,'$.paymentId') AND period.subscription_id=s.id))
   )))
  OR (NEW.template_code='SUPPORT_UPDATE' AND e.aggregate_type='support' AND e.event_type IN ('support.case.reply.v1','support.case.assign.v1','support.case.close.v1') AND (SELECT count(*) FROM json_each(e.payload_json))=2 AND (SELECT count(*) FROM json_each(NEW.parameters_json))=1 AND EXISTS(
   SELECT 1 FROM support_cases c JOIN governance_audit_events audit ON audit.resource_id=c.id AND audit.resource_type='support' AND audit.action=replace(e.event_type,'.v1','') AND audit.request_id=e.request_id WHERE c.id=e.aggregate_id AND c.id=json_extract(e.payload_json,'$.caseId') AND c.id=json_extract(NEW.parameters_json,'$.caseId') AND c.account_id=NEW.account_id AND c.account_id=json_extract(e.payload_json,'$.accountId') AND (e.event_type<>'support.case.reply.v1' OR audit.actor_id<>c.account_id)
  ))
  OR (NEW.template_code='VEHICLE_EXPIRY' AND e.event_type='notification.vehicle.inapp.reminder.v1' AND e.aggregate_type='notification' AND (SELECT count(*) FROM json_each(e.payload_json))=4 AND (SELECT count(*) FROM json_each(NEW.parameters_json))=2 AND json_extract(e.payload_json,'$.accountId')=NEW.account_id AND json_type(NEW.parameters_json,'$.daysBefore')='integer' AND json_extract(NEW.parameters_json,'$.daysBefore') IN (30,15,7,1) AND json_extract(NEW.parameters_json,'$.daysBefore')=json_extract(e.payload_json,'$.daysBefore') AND EXISTS(
   SELECT 1 FROM vehicle_compliance_entries entry JOIN iam_accounts a ON a.id=NEW.account_id WHERE entry.id=e.aggregate_id AND entry.id=json_extract(e.payload_json,'$.entryId') AND entry.id=json_extract(NEW.parameters_json,'$.entryId') AND CAST(julianday(entry.expires_on)-julianday(json_extract(e.payload_json,'$.calendarDate')) AS INTEGER)=json_extract(NEW.parameters_json,'$.daysBefore')
   AND NOT EXISTS(SELECT 1 FROM vehicle_compliance_entries newer WHERE newer.vehicle_id=entry.vehicle_id AND newer.document_type=entry.document_type AND (newer.created_at,newer.id)>(entry.created_at,entry.id))
   AND EXISTS(SELECT 1 FROM vehicle_relationships owner WHERE owner.vehicle_id=entry.vehicle_id AND owner.person_id=a.person_id AND owner.relationship_type='OWNER' AND owner.ended_at IS NULL AND owner.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ))
 ))
BEGIN SELECT RAISE(ABORT,'NOTIFICATION_INBOX_BOUNDARY'); END;
PRAGMA defer_foreign_keys = OFF;
