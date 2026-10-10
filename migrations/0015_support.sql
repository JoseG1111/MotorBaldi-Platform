PRAGMA foreign_keys = ON;
INSERT INTO authz_permissions(code) VALUES ('platform.support.read'),('platform.support.manage');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT r.id,p.code FROM authz_roles r CROSS JOIN authz_permissions p WHERE r.scope='PLATFORM' AND r.code IN ('SUPPORT_AGENT','PLATFORM_SUPERADMIN') AND p.code IN ('platform.support.read','platform.support.manage');
CREATE TABLE support_cases (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 previous_case_id TEXT REFERENCES support_cases(id) ON DELETE RESTRICT,
 subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 1 AND 200),
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ASSIGNED','CLOSED')),
 assignee_person_id TEXT REFERENCES iam_people(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 closed_at TEXT,
 closed_by_account_id TEXT REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 resolution TEXT CHECK(resolution IS NULL OR length(resolution)<=2000),
 last_actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 last_action_staff INTEGER NOT NULL DEFAULT 0 CHECK(last_action_staff IN(0,1)),
 CHECK(status<>'ASSIGNED' OR assignee_person_id IS NOT NULL),
 CHECK(status<>'OPEN' OR assignee_person_id IS NULL),
 CHECK((status='CLOSED' AND closed_at IS NOT NULL AND closed_by_account_id IS NOT NULL) OR (status<>'CLOSED' AND closed_at IS NULL AND closed_by_account_id IS NULL AND resolution IS NULL))
) STRICT;
CREATE INDEX support_cases_owner ON support_cases(account_id,created_at,id);
CREATE INDEX support_cases_staff ON support_cases(status,created_at,id);
CREATE TABLE support_messages (
 id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX support_messages_case ON support_messages(case_id,created_at,id);
CREATE TABLE support_case_history (
 id TEXT PRIMARY KEY,
 case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('CREATE','REPLY','ASSIGN','CLOSE')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX support_history_case ON support_case_history(case_id,created_at,id);
CREATE TRIGGER support_case_insert_guard BEFORE INSERT ON support_cases
WHEN NEW.status<>'OPEN' OR NEW.version<>1 OR NEW.last_action_staff<>0 OR NEW.last_actor_account_id<>NEW.account_id
 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR (NEW.previous_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM support_cases prior WHERE prior.id=NEW.previous_case_id AND prior.account_id=NEW.account_id AND prior.status='CLOSED'))
BEGIN SELECT RAISE(ABORT,'SUPPORT_CASE_BOUNDARY'); END;
CREATE TRIGGER support_case_update_guard BEFORE UPDATE ON support_cases
WHEN OLD.status='CLOSED' OR NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.previous_case_id IS NOT OLD.previous_case_id OR NEW.subject IS NOT OLD.subject OR NEW.created_at IS NOT OLD.created_at
 OR NEW.version<>OLD.version+1 OR (OLD.status='ASSIGNED' AND NEW.status='OPEN')
 OR (NEW.status='CLOSED' AND NEW.closed_by_account_id<>NEW.last_actor_account_id)
 OR (NEW.last_action_staff=0 AND (NEW.last_actor_account_id<>NEW.account_id OR NEW.assignee_person_id IS NOT OLD.assignee_person_id OR (NEW.status IS NOT OLD.status AND NEW.status<>'CLOSED')))
 OR NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.last_actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR (NEW.last_action_staff=1 AND NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN auth_users u ON u.id=a.id JOIN platform_person_roles pr ON pr.person_id=a.person_id JOIN authz_roles r ON r.id=pr.role_id WHERE a.id=NEW.last_actor_account_id AND r.scope='PLATFORM' AND r.code IN ('SUPPORT_AGENT','PLATFORM_SUPERADMIN') AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=u.id AND f.verified=1)))
 OR (NEW.assignee_person_id IS NOT NULL AND NEW.status<>'CLOSED' AND NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN platform_person_roles pr ON pr.person_id=p.id JOIN authz_roles r ON r.id=pr.role_id WHERE p.id=NEW.assignee_person_id AND a.status='ACTIVE' AND p.status='ACTIVE' AND r.scope='PLATFORM' AND r.code IN ('SUPPORT_AGENT','PLATFORM_SUPERADMIN') AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=u.id AND f.verified=1)))
BEGIN SELECT RAISE(ABORT,'SUPPORT_CASE_BOUNDARY'); END;
CREATE TRIGGER support_message_insert_guard BEFORE INSERT ON support_messages
WHEN NOT EXISTS(SELECT 1 FROM support_cases c WHERE c.id=NEW.case_id AND c.status<>'CLOSED' AND c.last_actor_account_id=NEW.actor_account_id)
BEGIN SELECT RAISE(ABORT,'SUPPORT_MESSAGE_BOUNDARY'); END;
CREATE TRIGGER support_history_insert_guard BEFORE INSERT ON support_case_history
WHEN NOT EXISTS(SELECT 1 FROM support_cases c WHERE c.id=NEW.case_id AND c.last_actor_account_id=NEW.actor_account_id AND ((NEW.action='CLOSE' AND c.status='CLOSED') OR (NEW.action<>'CLOSE' AND c.status<>'CLOSED')))
BEGIN SELECT RAISE(ABORT,'SUPPORT_HISTORY_BOUNDARY'); END;
CREATE TRIGGER support_cases_no_delete BEFORE DELETE ON support_cases BEGIN SELECT RAISE(ABORT,'support cases cannot be deleted'); END;
CREATE TRIGGER support_messages_no_update BEFORE UPDATE ON support_messages BEGIN SELECT RAISE(ABORT,'support messages are immutable'); END;
CREATE TRIGGER support_messages_no_delete BEFORE DELETE ON support_messages BEGIN SELECT RAISE(ABORT,'support messages cannot be deleted'); END;
CREATE TRIGGER support_history_no_update BEFORE UPDATE ON support_case_history BEGIN SELECT RAISE(ABORT,'support history is immutable'); END;
CREATE TRIGGER support_history_no_delete BEFORE DELETE ON support_case_history BEGIN SELECT RAISE(ABORT,'support history cannot be deleted'); END;
