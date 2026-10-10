PRAGMA foreign_keys = ON;

INSERT INTO authz_permissions(code) VALUES ('platform.billing.read'),('platform.billing.manage'),('platform.commission.read'),('platform.commission.manage');
INSERT INTO authz_role_permissions(role_id,permission_code) SELECT r.id,p.code FROM authz_roles r CROSS JOIN authz_permissions p WHERE r.code IN ('PLATFORM_SUPERADMIN','FINANCE_ADMIN') AND p.code IN ('platform.billing.read','platform.billing.manage','platform.commission.read','platform.commission.manage');

CREATE TABLE billing_plans (
 code TEXT PRIMARY KEY CHECK(code IN ('ACOMPANAMIENTO_MONTHLY','ACOMPANAMIENTO_ANNUAL')),
 name TEXT NOT NULL,
 period TEXT NOT NULL CHECK(period IN ('MONTH','YEAR')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991),
 currency TEXT NOT NULL CHECK(currency='COP'),
 vehicle_limit INTEGER NOT NULL DEFAULT 2 CHECK(vehicle_limit BETWEEN 1 AND 100),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
INSERT INTO billing_plans(code,name,period,amount_minor,currency) VALUES
 ('ACOMPANAMIENTO_MONTHLY','ACOMPAÑAMIENTO MOTORBALDI','MONTH',2990000,'COP'),
 ('ACOMPANAMIENTO_ANNUAL','ACOMPAÑAMIENTO MOTORBALDI','YEAR',28800000,'COP');
CREATE TABLE billing_policies (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 production_approved INTEGER NOT NULL DEFAULT 0 CHECK(production_approved IN (0,1)),
 tax_approved INTEGER NOT NULL DEFAULT 0 CHECK(tax_approved IN (0,1)),
 refund_approved INTEGER NOT NULL DEFAULT 0 CHECK(refund_approved IN (0,1)),
 recurring_approved INTEGER NOT NULL DEFAULT 0 CHECK(recurring_approved IN (0,1)),
 vehicle_limit_approved INTEGER NOT NULL DEFAULT 0 CHECK(vehicle_limit_approved IN (0,1)),
 grace_seconds INTEGER NOT NULL DEFAULT 0 CHECK(grace_seconds>=0),
 automatic_retries INTEGER NOT NULL DEFAULT 0 CHECK(automatic_retries>=0),
 policy_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy_json)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
INSERT INTO billing_policies(singleton) VALUES(1);
CREATE TABLE billing_subscriptions (
 id TEXT PRIMARY KEY CHECK(length(id)=36 AND substr(id,15,1)='7'),
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 plan_code TEXT NOT NULL REFERENCES billing_plans(code) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'PENDING_ACTIVATION' CHECK(status IN ('PENDING_ACTIVATION','ACTIVE','PENDING_RENEWAL','PAST_DUE','CANCELLED','EXPIRED','SUSPENDED')),
 auto_renew INTEGER NOT NULL DEFAULT 0 CHECK(auto_renew IN (0,1)),
 cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
 current_period_start TEXT,
 current_period_end TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK((current_period_start IS NULL)=(current_period_end IS NULL)),
 CHECK(current_period_end IS NULL OR current_period_start<current_period_end)
) STRICT;
CREATE UNIQUE INDEX billing_subscription_open_account ON billing_subscriptions(account_id) WHERE status NOT IN ('CANCELLED','EXPIRED');
CREATE INDEX billing_subscription_account ON billing_subscriptions(account_id,id);
CREATE TABLE billing_periods (
 id TEXT PRIMARY KEY,
 subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL CHECK(ends_at>starts_at),
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991),
 currency TEXT NOT NULL CHECK(currency='COP'),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','FAILED','VOIDED')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(subscription_id,sequence)
) STRICT;
CREATE TABLE billing_payments (
 id TEXT PRIMARY KEY,
 period_id TEXT NOT NULL REFERENCES billing_periods(id) ON DELETE RESTRICT,
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991),
 currency TEXT NOT NULL CHECK(currency='COP'),
 reference TEXT NOT NULL UNIQUE,
 provider_environment TEXT NOT NULL DEFAULT 'SANDBOX' CHECK(provider_environment IN ('SANDBOX','PRODUCTION')),
 provider_transaction_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','PENDING','APPROVED','DECLINED','ERROR','VOIDED','UNKNOWN')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
) STRICT;
CREATE TABLE billing_payment_attempts (
 id TEXT PRIMARY KEY,
 payment_id TEXT NOT NULL REFERENCES billing_payments(id) ON DELETE RESTRICT,
 attempt INTEGER NOT NULL CHECK(attempt>0),
 state TEXT NOT NULL CHECK(state IN ('CREATED','SUBMITTED','UNKNOWN','RESOLVED')),
 provider_reference TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(payment_id,attempt)
) STRICT;
CREATE TABLE billing_payment_confirmations (
 id TEXT PRIMARY KEY,
 payment_id TEXT NOT NULL UNIQUE REFERENCES billing_payments(id) ON DELETE RESTRICT,
 provider_transaction_id TEXT NOT NULL UNIQUE,
 provider_environment TEXT NOT NULL CHECK(provider_environment IN ('SANDBOX','PRODUCTION')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL CHECK(currency='COP'),
 evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
 confirmed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE billing_admin_grants (
 id TEXT PRIMARY KEY,
 subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL CHECK(ends_at>starts_at),
 authorized_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE billing_membership_vehicles (
 id TEXT PRIMARY KEY,
 subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
 vehicle_id TEXT NOT NULL REFERENCES vehicle_vehicles(id) ON DELETE RESTRICT,
 added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 removed_at TEXT
) STRICT;
CREATE UNIQUE INDEX billing_membership_vehicle_active ON billing_membership_vehicles(subscription_id,vehicle_id) WHERE removed_at IS NULL;
CREATE TRIGGER billing_membership_vehicle_limit BEFORE INSERT ON billing_membership_vehicles
WHEN (SELECT count(*) FROM billing_membership_vehicles WHERE subscription_id=NEW.subscription_id AND removed_at IS NULL)>=(SELECT p.vehicle_limit FROM billing_subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.id=NEW.subscription_id)
BEGIN SELECT RAISE(ABORT,'MEMBERSHIP_VEHICLE_LIMIT'); END;
CREATE TRIGGER billing_membership_vehicle_remove_only BEFORE UPDATE ON billing_membership_vehicles
WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.vehicle_id IS NOT OLD.vehicle_id OR NEW.added_at IS NOT OLD.added_at
BEGIN SELECT RAISE(ABORT,'MEMBERSHIP_VEHICLE_IMMUTABLE'); END;
CREATE TABLE billing_financial_events (
 id TEXT PRIMARY KEY,
 domain TEXT NOT NULL CHECK(domain IN ('SUBSCRIPTION','PAYMENT','COMMISSION')),
 aggregate_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 actor_account_id TEXT REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 request_id TEXT NOT NULL,
 data_json TEXT NOT NULL CHECK(json_valid(data_json) AND length(data_json)<=8192),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX billing_financial_aggregate ON billing_financial_events(domain,aggregate_id,id);

CREATE TABLE commission_agreements (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL REFERENCES org_organizations(id) ON DELETE RESTRICT,
 agreement_version INTEGER NOT NULL CHECK(agreement_version>0),
 valid_from TEXT NOT NULL,
 valid_until TEXT CHECK(valid_until IS NULL OR valid_until>valid_from),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','SUSPENDED')),
 settlement_rules_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(settlement_rules_json)),
 settlement_approved INTEGER NOT NULL DEFAULT 0 CHECK(settlement_approved IN (0,1)),
 approved_by_account_id TEXT REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 approved_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(organization_id,agreement_version),
 CHECK(status<>'APPROVED' OR (approved_by_account_id IS NOT NULL AND approved_at IS NOT NULL))
) STRICT;
CREATE TABLE commission_rules (
 id TEXT PRIMARY KEY,
 agreement_id TEXT NOT NULL REFERENCES commission_agreements(id) ON DELETE RESTRICT,
 service_code TEXT NOT NULL CHECK(length(service_code) BETWEEN 1 AND 80),
 calculation TEXT NOT NULL CHECK(calculation IN ('PERCENTAGE','FIXED')),
 basis_points INTEGER CHECK(basis_points BETWEEN 0 AND 10000),
 fixed_minor INTEGER CHECK(fixed_minor BETWEEN 0 AND 9007199254740991),
 currency TEXT NOT NULL CHECK(currency='COP'),
 rounding TEXT NOT NULL CHECK(rounding IN ('FLOOR','CEIL','HALF_UP')),
 CHECK((calculation='PERCENTAGE' AND basis_points IS NOT NULL AND fixed_minor IS NULL) OR (calculation='FIXED' AND fixed_minor IS NOT NULL AND basis_points IS NULL)),
 UNIQUE(agreement_id,service_code)
) STRICT;
CREATE TABLE commission_consent_events (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 order_id TEXT NOT NULL REFERENCES workshop_orders(id) ON DELETE RESTRICT,
 agreement_id TEXT NOT NULL REFERENCES commission_agreements(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('GRANTED','REVOKED')),
 policy_version TEXT NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 64),
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX commission_consent_scope ON commission_consent_events(account_id,order_id,agreement_id,id);
CREATE TABLE commission_referrals (
 id TEXT PRIMARY KEY,
 agreement_id TEXT NOT NULL REFERENCES commission_agreements(id) ON DELETE RESTRICT,
 order_id TEXT NOT NULL UNIQUE REFERENCES workshop_orders(id) ON DELETE RESTRICT,
 customer_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 consent_event_id TEXT NOT NULL REFERENCES commission_consent_events(id) ON DELETE RESTRICT,
 service_code TEXT NOT NULL,
 attributed_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE commission_entries (
 id TEXT PRIMARY KEY,
 referral_id TEXT NOT NULL REFERENCES commission_referrals(id) ON DELETE RESTRICT,
 rule_id TEXT NOT NULL REFERENCES commission_rules(id) ON DELETE RESTRICT,
 base_minor INTEGER NOT NULL CHECK(base_minor BETWEEN 0 AND 9007199254740991),
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
 currency TEXT NOT NULL CHECK(currency='COP'),
 completion_record_id TEXT NOT NULL REFERENCES vehicle_professional_records(id) ON DELETE RESTRICT,
 evidence_reference TEXT NOT NULL CHECK(length(trim(evidence_reference)) BETWEEN 5 AND 500),
 status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK(status IN ('PENDING_APPROVAL','APPROVED','DISPUTED','REVERSED','SETTLED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 approved_by_account_id TEXT REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(referral_id,rule_id)
) STRICT;
CREATE TABLE commission_adjustments (
 id TEXT PRIMARY KEY,
 commission_id TEXT NOT NULL REFERENCES commission_entries(id) ON DELETE RESTRICT,
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN -9007199254740991 AND 9007199254740991 AND amount_minor<>0),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
 kind TEXT NOT NULL CHECK(kind IN ('ADJUSTMENT','REVERSAL')),
 actor_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE commission_settlements (
 id TEXT PRIMARY KEY,
 commission_id TEXT NOT NULL UNIQUE REFERENCES commission_entries(id) ON DELETE RESTRICT,
 amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
 currency TEXT NOT NULL CHECK(currency='COP'),
 external_reference TEXT NOT NULL UNIQUE CHECK(length(trim(external_reference)) BETWEEN 5 AND 160),
 status TEXT NOT NULL CHECK(status IN ('RECORDED','RECONCILED','DISPUTED')),
 recorded_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE UNIQUE INDEX billing_payment_approved_period ON billing_payments(period_id) WHERE status='APPROVED';
CREATE TRIGGER billing_subscription_initial_state BEFORE INSERT ON billing_subscriptions
WHEN NEW.status<>'PENDING_ACTIVATION' OR NEW.auto_renew<>0 OR NEW.current_period_start IS NOT NULL
BEGIN SELECT RAISE(ABORT,'SUBSCRIPTION_INITIAL_STATE'); END;
CREATE TRIGGER billing_subscription_update_guard BEFORE UPDATE ON billing_subscriptions
WHEN NEW.version<>OLD.version+1 OR NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.plan_code IS NOT OLD.plan_code OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.status<>OLD.status AND NOT (
 (OLD.status='PENDING_ACTIVATION' AND NEW.status IN ('ACTIVE','CANCELLED','SUSPENDED')) OR
 (OLD.status='ACTIVE' AND NEW.status IN ('PENDING_RENEWAL','PAST_DUE','EXPIRED','CANCELLED','SUSPENDED')) OR
 (OLD.status IN ('PENDING_RENEWAL','PAST_DUE') AND NEW.status IN ('ACTIVE','EXPIRED','CANCELLED','SUSPENDED')) OR
 (OLD.status='SUSPENDED' AND NEW.status IN ('ACTIVE','EXPIRED','CANCELLED'))))
BEGIN SELECT RAISE(ABORT,'SUBSCRIPTION_INVALID_CHANGE'); END;
CREATE TRIGGER billing_subscription_activation_evidence BEFORE UPDATE ON billing_subscriptions
WHEN NEW.status='ACTIVE' AND (OLD.status<>'ACTIVE' OR NEW.current_period_end IS NOT OLD.current_period_end)
 AND NOT EXISTS(SELECT 1 FROM billing_periods p WHERE p.subscription_id=NEW.id AND p.status='PAID' AND p.starts_at=NEW.current_period_start AND p.ends_at=NEW.current_period_end)
 AND NOT EXISTS(SELECT 1 FROM billing_admin_grants g WHERE g.subscription_id=NEW.id AND g.starts_at=NEW.current_period_start AND g.ends_at=NEW.current_period_end)
BEGIN SELECT RAISE(ABORT,'SUBSCRIPTION_PAYMENT_EVIDENCE_REQUIRED'); END;
CREATE TRIGGER billing_subscription_recurring_policy BEFORE UPDATE ON billing_subscriptions
WHEN NEW.auto_renew=1 AND NOT EXISTS(SELECT 1 FROM billing_policies WHERE singleton=1 AND recurring_approved=1)
BEGIN SELECT RAISE(ABORT,'RECURRING_POLICY_NOT_APPROVED'); END;
CREATE TRIGGER billing_period_update_guard BEFORE UPDATE ON billing_periods
WHEN NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.sequence IS NOT OLD.sequence OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.created_at IS NOT OLD.created_at OR OLD.status<>'PENDING' OR NEW.status='PENDING'
BEGIN SELECT RAISE(ABORT,'BILLING_PERIOD_IMMUTABLE'); END;
CREATE TRIGGER billing_period_paid_evidence BEFORE UPDATE ON billing_periods
WHEN NEW.status='PAID' AND NOT EXISTS(SELECT 1 FROM billing_payments p JOIN billing_payment_confirmations c ON c.payment_id=p.id WHERE p.period_id=NEW.id AND p.status='APPROVED' AND p.amount_minor=NEW.amount_minor AND p.currency=NEW.currency AND c.provider_transaction_id=p.provider_transaction_id AND c.amount_minor=p.amount_minor AND c.currency=p.currency AND c.provider_environment=p.provider_environment)
BEGIN SELECT RAISE(ABORT,'PAYMENT_CONFIRMATION_REQUIRED'); END;
CREATE TRIGGER billing_payment_amount_guard BEFORE INSERT ON billing_payments
WHEN NOT EXISTS(SELECT 1 FROM billing_periods p WHERE p.id=NEW.period_id AND p.amount_minor=NEW.amount_minor AND p.currency=NEW.currency AND p.status='PENDING') OR NEW.status<>'CREATED' OR NEW.provider_transaction_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'PAYMENT_PERIOD_MISMATCH'); END;
CREATE TRIGGER billing_payment_update_guard BEFORE UPDATE ON billing_payments
WHEN NEW.version<>OLD.version+1 OR NEW.id IS NOT OLD.id OR NEW.period_id IS NOT OLD.period_id OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.reference IS NOT OLD.reference OR NEW.provider_environment IS NOT OLD.provider_environment OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.provider_transaction_id IS NOT NULL AND NEW.provider_transaction_id IS NOT OLD.provider_transaction_id)
 OR (NEW.status<>OLD.status AND NOT ((OLD.status IN ('CREATED','PENDING','UNKNOWN') AND NEW.status IN ('PENDING','APPROVED','DECLINED','ERROR','VOIDED','UNKNOWN')) OR (OLD.status='APPROVED' AND NEW.status='VOIDED')))
BEGIN SELECT RAISE(ABORT,'PAYMENT_INVALID_CHANGE'); END;
CREATE TRIGGER billing_payment_approval_evidence BEFORE UPDATE ON billing_payments
WHEN NEW.status='APPROVED' AND NOT EXISTS(SELECT 1 FROM billing_payment_confirmations c WHERE c.payment_id=NEW.id AND c.provider_transaction_id=NEW.provider_transaction_id AND c.amount_minor=NEW.amount_minor AND c.currency=NEW.currency AND c.provider_environment=NEW.provider_environment)
BEGIN SELECT RAISE(ABORT,'PAYMENT_CONFIRMATION_REQUIRED'); END;
CREATE TRIGGER billing_confirmation_binding BEFORE INSERT ON billing_payment_confirmations
WHEN NOT EXISTS(SELECT 1 FROM billing_payments p WHERE p.id=NEW.payment_id AND p.amount_minor=NEW.amount_minor AND p.currency=NEW.currency AND p.provider_environment=NEW.provider_environment AND (p.provider_transaction_id IS NULL OR p.provider_transaction_id=NEW.provider_transaction_id))
BEGIN SELECT RAISE(ABORT,'PAYMENT_CONFIRMATION_MISMATCH'); END;
CREATE TRIGGER commission_agreement_update_guard BEFORE UPDATE ON commission_agreements
WHEN NEW.version<>OLD.version+1 OR NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.agreement_version IS NOT OLD.agreement_version OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_until IS NOT OLD.valid_until OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.status<>'DRAFT' AND (NEW.settlement_rules_json IS NOT OLD.settlement_rules_json OR NEW.settlement_approved IS NOT OLD.settlement_approved OR NEW.approved_by_account_id IS NOT OLD.approved_by_account_id OR NEW.approved_at IS NOT OLD.approved_at))
 OR NOT ((OLD.status='DRAFT' AND NEW.status='APPROVED') OR (OLD.status='APPROVED' AND NEW.status='SUSPENDED'))
BEGIN SELECT RAISE(ABORT,'COMMISSION_AGREEMENT_IMMUTABLE'); END;
CREATE TRIGGER commission_rule_draft_only BEFORE INSERT ON commission_rules
WHEN NOT EXISTS(SELECT 1 FROM commission_agreements WHERE id=NEW.agreement_id AND status='DRAFT')
BEGIN SELECT RAISE(ABORT,'COMMISSION_RULE_IMMUTABLE'); END;
CREATE TRIGGER commission_entry_update_guard BEFORE UPDATE ON commission_entries
WHEN NEW.version<>OLD.version+1 OR NEW.id IS NOT OLD.id OR NEW.referral_id IS NOT OLD.referral_id OR NEW.rule_id IS NOT OLD.rule_id OR NEW.base_minor IS NOT OLD.base_minor OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.completion_record_id IS NOT OLD.completion_record_id OR NEW.evidence_reference IS NOT OLD.evidence_reference OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.status<>OLD.status AND NOT ((OLD.status='PENDING_APPROVAL' AND NEW.status IN ('APPROVED','DISPUTED','REVERSED')) OR (OLD.status='APPROVED' AND NEW.status IN ('SETTLED','DISPUTED','REVERSED')) OR (OLD.status='DISPUTED' AND NEW.status IN ('APPROVED','REVERSED')) OR (OLD.status='SETTLED' AND NEW.status='DISPUTED')))
BEGIN SELECT RAISE(ABORT,'COMMISSION_ENTRY_IMMUTABLE'); END;
CREATE TRIGGER commission_settlement_update_guard BEFORE UPDATE ON commission_settlements
WHEN NEW.id IS NOT OLD.id OR NEW.commission_id IS NOT OLD.commission_id OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.external_reference IS NOT OLD.external_reference OR NEW.recorded_by_account_id IS NOT OLD.recorded_by_account_id OR NEW.created_at IS NOT OLD.created_at OR NOT ((OLD.status='RECORDED' AND NEW.status IN ('RECONCILED','DISPUTED')) OR (OLD.status='RECONCILED' AND NEW.status='DISPUTED'))
BEGIN SELECT RAISE(ABORT,'COMMISSION_SETTLEMENT_IMMUTABLE'); END;

CREATE TRIGGER billing_payment_confirmations_no_update BEFORE UPDATE ON billing_payment_confirmations BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;

CREATE TRIGGER billing_admin_grants_no_update BEFORE UPDATE ON billing_admin_grants BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;

CREATE TRIGGER billing_financial_events_no_update BEFORE UPDATE ON billing_financial_events BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;

CREATE TRIGGER commission_rules_no_update BEFORE UPDATE ON commission_rules BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;

CREATE TRIGGER commission_referrals_no_update BEFORE UPDATE ON commission_referrals BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;

CREATE TRIGGER commission_adjustments_no_update BEFORE UPDATE ON commission_adjustments BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;

CREATE TRIGGER commission_consent_events_no_update BEFORE UPDATE ON commission_consent_events BEGIN SELECT RAISE(ABORT,'financial history is append-only'); END;
CREATE TRIGGER billing_payment_confirmations_no_delete BEFORE DELETE ON billing_payment_confirmations BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_admin_grants_no_delete BEFORE DELETE ON billing_admin_grants BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_financial_events_no_delete BEFORE DELETE ON billing_financial_events BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_rules_no_delete BEFORE DELETE ON commission_rules BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_referrals_no_delete BEFORE DELETE ON commission_referrals BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_adjustments_no_delete BEFORE DELETE ON commission_adjustments BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_consent_events_no_delete BEFORE DELETE ON commission_consent_events BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_subscriptions_no_delete BEFORE DELETE ON billing_subscriptions BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_periods_no_delete BEFORE DELETE ON billing_periods BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_payments_no_delete BEFORE DELETE ON billing_payments BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_payment_attempts_no_delete BEFORE DELETE ON billing_payment_attempts BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER billing_membership_vehicles_no_delete BEFORE DELETE ON billing_membership_vehicles BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_agreements_no_delete BEFORE DELETE ON commission_agreements BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_entries_no_delete BEFORE DELETE ON commission_entries BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;
CREATE TRIGGER commission_settlements_no_delete BEFORE DELETE ON commission_settlements BEGIN SELECT RAISE(ABORT,'financial history cannot be deleted'); END;

CREATE TRIGGER billing_plan_identity_immutable BEFORE UPDATE ON billing_plans
WHEN NEW.code IS NOT OLD.code OR NEW.period IS NOT OLD.period OR NEW.currency IS NOT OLD.currency OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'BILLING_PLAN_INVALID_CHANGE'); END;
CREATE TRIGGER billing_financial_actor_boundary BEFORE INSERT ON billing_financial_events
WHEN NEW.actor_account_id IS NOT NULL AND (
 NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=NEW.actor_account_id AND a.status='ACTIVE' AND p.status='ACTIVE')
 OR (NEW.domain='COMMISSION' AND NEW.event_type<>'commission.consent.record' AND NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN platform_person_roles r ON r.person_id=a.person_id JOIN authz_role_permissions rp ON rp.role_id=r.role_id WHERE a.id=NEW.actor_account_id AND rp.permission_code='platform.commission.manage'))
 OR (NEW.domain='SUBSCRIPTION' AND NEW.event_type LIKE 'billing.admin.%' AND NOT EXISTS(SELECT 1 FROM iam_accounts a JOIN platform_person_roles r ON r.person_id=a.person_id JOIN authz_role_permissions rp ON rp.role_id=r.role_id WHERE a.id=NEW.actor_account_id AND rp.permission_code='platform.billing.manage')))
BEGIN SELECT RAISE(ABORT,'FINANCIAL_ACTOR_AUTHORIZATION_CHANGED'); END;

CREATE TRIGGER commission_consent_order_boundary BEFORE INSERT ON commission_consent_events
WHEN NOT EXISTS(SELECT 1 FROM workshop_orders w JOIN commission_agreements a ON a.id=NEW.agreement_id JOIN org_organizations o ON o.id=a.organization_id WHERE w.id=NEW.order_id AND w.organization_id=a.organization_id AND o.status='ACTIVE' AND EXISTS(SELECT 1 FROM iam_accounts ca JOIN iam_people cp ON cp.id=ca.person_id JOIN vehicle_access_grants g ON g.vehicle_id=w.vehicle_id
 WHERE ca.id=NEW.account_id AND ca.status='ACTIVE' AND cp.status='ACTIVE' AND g.permission_code='vehicle.read'
 AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND (g.person_id=cp.id OR (g.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_memberships m JOIN org_organizations mo ON mo.id=m.organization_id WHERE m.person_id=cp.id AND m.organization_id=g.organization_id AND m.status='ACTIVE' AND mo.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (g.location_id IS NULL OR m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=g.organization_id AND ml.location_id=g.location_id))))) ))
BEGIN SELECT RAISE(ABORT,'COMMISSION_CONSENT_ACCESS_CHANGED'); END;
CREATE TRIGGER commission_referral_authority BEFORE INSERT ON commission_referrals
WHEN NOT EXISTS(SELECT 1 FROM commission_agreements a JOIN workshop_orders w ON w.organization_id=a.organization_id JOIN org_organizations o ON o.id=a.organization_id JOIN commission_consent_events c ON c.id=NEW.consent_event_id
 WHERE a.id=NEW.agreement_id AND a.status='APPROVED' AND o.status='ACTIVE' AND w.id=NEW.order_id
 AND c.account_id=NEW.customer_account_id AND c.order_id=NEW.order_id AND c.agreement_id=NEW.agreement_id AND c.status='GRANTED'
 AND c.id=(SELECT id FROM commission_consent_events WHERE account_id=NEW.customer_account_id AND order_id=NEW.order_id AND agreement_id=NEW.agreement_id ORDER BY created_at DESC,id DESC LIMIT 1)
 AND EXISTS(SELECT 1 FROM commission_rules r WHERE r.agreement_id=a.id AND r.service_code=NEW.service_code)
 AND EXISTS(SELECT 1 FROM iam_accounts ca JOIN iam_people cp ON cp.id=ca.person_id JOIN vehicle_access_grants g ON g.vehicle_id=w.vehicle_id
 WHERE ca.id=NEW.customer_account_id AND ca.status='ACTIVE' AND cp.status='ACTIVE' AND g.permission_code='vehicle.read'
 AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND (g.person_id=cp.id OR (g.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_memberships m JOIN org_organizations mo ON mo.id=m.organization_id WHERE m.person_id=cp.id AND m.organization_id=g.organization_id AND m.status='ACTIVE' AND mo.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (g.location_id IS NULL OR m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=g.organization_id AND ml.location_id=g.location_id))))) ))
BEGIN SELECT RAISE(ABORT,'COMMISSION_REFERRAL_AUTHORITY_CHANGED'); END;
CREATE TRIGGER commission_recognition_evidence BEFORE INSERT ON commission_entries
WHEN NOT EXISTS(SELECT 1 FROM commission_referrals f JOIN commission_agreements a ON a.id=f.agreement_id JOIN org_organizations o ON o.id=a.organization_id JOIN commission_rules r ON r.id=NEW.rule_id AND r.agreement_id=a.id AND r.service_code=f.service_code JOIN workshop_orders w ON w.id=f.order_id JOIN vehicle_professional_records p ON p.id=w.final_record_id JOIN commission_consent_events c ON c.id=f.consent_event_id
 WHERE f.id=NEW.referral_id AND a.status='APPROVED' AND o.status='ACTIVE' AND w.organization_id=a.organization_id AND w.status IN ('COMPLETED','CLOSED')
 AND p.id=NEW.completion_record_id AND p.status='FINAL' AND p.vehicle_id=w.vehicle_id AND p.organization_id=w.organization_id AND p.location_id=w.location_id AND p.finalized_at>=a.valid_from AND (a.valid_until IS NULL OR p.finalized_at<a.valid_until)
 AND c.status='GRANTED' AND c.id=(SELECT id FROM commission_consent_events WHERE account_id=f.customer_account_id AND order_id=f.order_id AND agreement_id=f.agreement_id ORDER BY created_at DESC,id DESC LIMIT 1)
 AND NEW.currency=r.currency AND EXISTS(SELECT 1 FROM iam_accounts ca JOIN iam_people cp ON cp.id=ca.person_id JOIN vehicle_access_grants g ON g.vehicle_id=w.vehicle_id
 WHERE ca.id=f.customer_account_id AND ca.status='ACTIVE' AND cp.status='ACTIVE' AND g.permission_code='vehicle.read'
 AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND (g.person_id=cp.id OR (g.organization_id IS NOT NULL AND EXISTS(SELECT 1 FROM org_memberships m JOIN org_organizations mo ON mo.id=m.organization_id WHERE m.person_id=cp.id AND m.organization_id=g.organization_id AND m.status='ACTIVE' AND mo.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (g.location_id IS NULL OR m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=g.organization_id AND ml.location_id=g.location_id))))) ))
BEGIN SELECT RAISE(ABORT,'COMMISSION_COMPLETION_OR_AUTHORITY_CHANGED'); END;
CREATE TRIGGER commission_settlement_agreement_boundary BEFORE INSERT ON commission_settlements
WHEN NOT EXISTS(SELECT 1 FROM commission_entries e JOIN commission_referrals f ON f.id=e.referral_id JOIN commission_agreements a ON a.id=f.agreement_id JOIN org_organizations o ON o.id=a.organization_id WHERE e.id=NEW.commission_id AND e.status='SETTLED' AND a.status='APPROVED' AND a.settlement_approved=1 AND a.settlement_rules_json<>'{}' AND o.status='ACTIVE' AND NEW.currency=e.currency)
BEGIN SELECT RAISE(ABORT,'COMMISSION_SETTLEMENT_NOT_APPROVED'); END;
