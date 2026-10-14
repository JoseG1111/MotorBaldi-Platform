PRAGMA foreign_keys = ON;
-- Register authority only. No role grants or activated permits are installed.
INSERT INTO authz_permissions(code) VALUES('platform.notifications.controlled-test');
CREATE TABLE notification_controlled_delivery_permits (
 id TEXT PRIMARY KEY,
 reminder_id TEXT NOT NULL REFERENCES notification_vehicle_reminders(id) ON DELETE RESTRICT,
 source_event_id TEXT NOT NULL REFERENCES integration_outbox_events(id) ON DELETE RESTRICT,
 channel TEXT NOT NULL DEFAULT 'WHATSAPP' CHECK(channel='WHATSAPP'),
 recipient_sha256 TEXT NOT NULL CHECK(length(recipient_sha256)=64 AND recipient_sha256 NOT GLOB '*[^a-f0-9]*'),
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 actor_session_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 expires_at TEXT NOT NULL,
 reserved_at TEXT,
 revoked_at TEXT,
 CHECK(julianday(expires_at) IS NOT NULL AND julianday(expires_at)>julianday(created_at) AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+15 minutes')),
 CHECK(reserved_at IS NULL OR (reserved_at>=created_at AND reserved_at<expires_at)),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
) STRICT;
CREATE INDEX notification_controlled_permit_target ON notification_controlled_delivery_permits(reminder_id,source_event_id,recipient_sha256);
CREATE TRIGGER notification_controlled_permit_dev BEFORE INSERT ON notification_controlled_delivery_permits
 WHEN NOT EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development')
 OR NOT EXISTS(SELECT 1 FROM notification_vehicle_reminders r WHERE r.id=NEW.reminder_id AND r.source_event_id=NEW.source_event_id AND r.channel='WHATSAPP' AND r.status='QUEUED')
 BEGIN SELECT RAISE(ABORT,'CONTROLLED_DELIVERY_BOUNDARY'); END;
CREATE TRIGGER notification_controlled_permit_immutable BEFORE UPDATE ON notification_controlled_delivery_permits
 WHEN NEW.id IS NOT OLD.id OR NEW.reminder_id IS NOT OLD.reminder_id OR NEW.source_event_id IS NOT OLD.source_event_id
 OR NEW.channel IS NOT OLD.channel OR NEW.recipient_sha256 IS NOT OLD.recipient_sha256 OR NEW.actor_account_id IS NOT OLD.actor_account_id
 OR NEW.actor_session_id IS NOT OLD.actor_session_id OR NEW.reason IS NOT OLD.reason OR NEW.request_id IS NOT OLD.request_id
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.reserved_at IS NOT NULL AND NEW.reserved_at IS NOT OLD.reserved_at)
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
 BEGIN SELECT RAISE(ABORT,'CONTROLLED_DELIVERY_IMMUTABLE'); END;
CREATE TRIGGER notification_controlled_permit_no_delete BEFORE DELETE ON notification_controlled_delivery_permits
 BEGIN SELECT RAISE(ABORT,'CONTROLLED_DELIVERY_IMMUTABLE'); END;

CREATE TRIGGER notification_controlled_permit_human_staff BEFORE INSERT ON notification_controlled_delivery_permits
 WHEN NOT EXISTS(SELECT 1 FROM iam_accounts staff JOIN iam_people person ON person.id=staff.person_id
 JOIN auth_users u ON u.id=staff.id JOIN auth_sessions s ON s.user_id=u.id
 JOIN platform_person_roles pr ON pr.person_id=person.id
 JOIN authz_roles role ON role.id=pr.role_id AND role.scope='PLATFORM'
 JOIN authz_role_permissions rp ON rp.role_id=role.id
 WHERE staff.id=NEW.actor_account_id AND s.id=NEW.actor_session_id AND staff.status='ACTIVE' AND person.status='ACTIVE'
 AND u.email_verified=1 AND u.two_factor_enabled=1
 AND EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=u.id AND f.verified=1)
 AND s.created_at>=u.updated_at AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND rp.permission_code='platform.notifications.controlled-test'
 AND NOT EXISTS(SELECT 1 FROM development_automation_identities d WHERE d.account_id=staff.id))
 BEGIN SELECT RAISE(ABORT,'CONTROLLED_DELIVERY_STAFF_REQUIRED'); END;
