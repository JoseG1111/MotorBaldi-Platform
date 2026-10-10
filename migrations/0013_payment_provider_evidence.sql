PRAGMA foreign_keys = ON;

-- Internal provider evidence is permanent business deduplication, independent of generic replay TTL.
CREATE TABLE billing_provider_events (
 id TEXT PRIMARY KEY,
 evidence_hash TEXT NOT NULL UNIQUE CHECK(length(evidence_hash)=64),
 payment_id TEXT NOT NULL REFERENCES billing_payments(id) ON DELETE RESTRICT,
 provider_transaction_id TEXT NOT NULL,
 provider_environment TEXT NOT NULL CHECK(provider_environment IN ('SANDBOX','PRODUCTION')),
 provider_status TEXT NOT NULL CHECK(provider_status IN ('PENDING','APPROVED','DECLINED','ERROR','VOIDED')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL CHECK(currency='COP'),
 reference TEXT NOT NULL,
 observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE billing_recurring_consents (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('GRANTED','REVOKED')),
 terms_version TEXT NOT NULL CHECK(length(terms_version) BETWEEN 1 AND 64),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL CHECK(currency='COP'),
 cadence TEXT NOT NULL CHECK(cadence IN ('MONTH','YEAR')),
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE billing_payment_sources (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 provider_source_id INTEGER NOT NULL CHECK(provider_source_id>0),
 provider_environment TEXT NOT NULL CHECK(provider_environment IN ('SANDBOX','PRODUCTION')),
 method TEXT NOT NULL CHECK(method IN ('CARD','NEQUI')),
 consent_id TEXT REFERENCES billing_recurring_consents(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN ('AVAILABLE','REVOKED')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(provider_environment,provider_source_id)
) STRICT;
CREATE UNIQUE INDEX billing_payment_open_period ON billing_payments(period_id) WHERE status IN ('CREATED','PENDING','UNKNOWN','APPROVED');
DROP TRIGGER billing_period_update_guard;
CREATE TRIGGER billing_period_update_guard BEFORE UPDATE ON billing_periods
WHEN NEW.id IS NOT OLD.id OR NEW.subscription_id IS NOT OLD.subscription_id OR NEW.sequence IS NOT OLD.sequence OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.created_at IS NOT OLD.created_at OR OLD.status<>'PENDING' OR NEW.status='PENDING'
 OR ((NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at) AND NEW.status<>'PAID')
BEGIN SELECT RAISE(ABORT,'BILLING_PERIOD_IMMUTABLE'); END;
CREATE TRIGGER billing_provider_event_binding BEFORE INSERT ON billing_provider_events
WHEN NOT EXISTS(SELECT 1 FROM billing_payments p WHERE p.id=NEW.payment_id AND p.reference=NEW.reference AND p.amount_minor=NEW.amount_minor AND p.currency=NEW.currency AND p.provider_environment=NEW.provider_environment AND (p.provider_transaction_id IS NULL OR p.provider_transaction_id=NEW.provider_transaction_id))
BEGIN SELECT RAISE(ABORT,'PROVIDER_EVIDENCE_MISMATCH'); END;
CREATE TRIGGER billing_attempt_update_guard BEFORE UPDATE ON billing_payment_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.payment_id IS NOT OLD.payment_id OR NEW.attempt IS NOT OLD.attempt OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS NOT OLD.provider_reference)
 OR NOT ((OLD.state='CREATED' AND NEW.state IN ('SUBMITTED','UNKNOWN')) OR (OLD.state='SUBMITTED' AND NEW.state IN ('UNKNOWN','RESOLVED')) OR (OLD.state='UNKNOWN' AND NEW.state='RESOLVED'))
BEGIN SELECT RAISE(ABORT,'PAYMENT_ATTEMPT_INVALID_CHANGE'); END;
CREATE TRIGGER billing_source_revoke_only BEFORE UPDATE ON billing_payment_sources
WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.provider_source_id IS NOT OLD.provider_source_id OR NEW.provider_environment IS NOT OLD.provider_environment OR NEW.method IS NOT OLD.method OR NEW.consent_id IS NOT OLD.consent_id OR NEW.created_at IS NOT OLD.created_at OR OLD.status<>'AVAILABLE' OR NEW.status<>'REVOKED'
BEGIN SELECT RAISE(ABORT,'PAYMENT_SOURCE_IMMUTABLE'); END;
CREATE TRIGGER commission_recognition_amount BEFORE INSERT ON commission_entries
WHEN NOT EXISTS(SELECT 1 FROM commission_rules r WHERE r.id=NEW.rule_id AND NEW.amount_minor=(CASE WHEN r.calculation='FIXED' THEN r.fixed_minor ELSE
 (NEW.base_minor/10000)*r.basis_points + ((NEW.base_minor%10000)*r.basis_points)/10000 +
 CASE WHEN r.rounding='CEIL' AND ((NEW.base_minor%10000)*r.basis_points)%10000>0 THEN 1
 WHEN r.rounding='HALF_UP' AND ((NEW.base_minor%10000)*r.basis_points)%10000>=5000 THEN 1 ELSE 0 END END))
BEGIN SELECT RAISE(ABORT,'COMMISSION_AMOUNT_MISMATCH'); END;
CREATE TRIGGER commission_settlement_amount BEFORE INSERT ON commission_settlements
WHEN NEW.amount_minor<>(SELECT e.amount_minor+coalesce((SELECT sum(amount_minor) FROM commission_adjustments WHERE commission_id=e.id),0) FROM commission_entries e WHERE e.id=NEW.commission_id)
BEGIN SELECT RAISE(ABORT,'COMMISSION_SETTLEMENT_AMOUNT_MISMATCH'); END;
CREATE TRIGGER billing_provider_events_no_update BEFORE UPDATE ON billing_provider_events BEGIN SELECT RAISE(ABORT,'provider observations are append-only'); END;
CREATE TRIGGER billing_provider_events_no_delete BEFORE DELETE ON billing_provider_events BEGIN SELECT RAISE(ABORT,'provider observations cannot be deleted'); END;
CREATE TRIGGER billing_recurring_consents_no_update BEFORE UPDATE ON billing_recurring_consents BEGIN SELECT RAISE(ABORT,'financial consent is append-only'); END;
CREATE TRIGGER billing_recurring_consents_no_delete BEFORE DELETE ON billing_recurring_consents BEGIN SELECT RAISE(ABORT,'financial consent cannot be deleted'); END;
CREATE TRIGGER billing_payment_sources_no_delete BEFORE DELETE ON billing_payment_sources BEGIN SELECT RAISE(ABORT,'payment source metadata cannot be deleted'); END;

DROP TRIGGER billing_subscription_update_guard;
CREATE TRIGGER billing_subscription_update_guard BEFORE UPDATE ON billing_subscriptions
WHEN NEW.version<>OLD.version+1 OR NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.plan_code IS NOT OLD.plan_code OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.status<>OLD.status AND NOT (
 (OLD.status='PENDING_ACTIVATION' AND NEW.status IN ('ACTIVE','CANCELLED','SUSPENDED')) OR
 (OLD.status='ACTIVE' AND NEW.status IN ('PENDING_RENEWAL','PAST_DUE','EXPIRED','CANCELLED','SUSPENDED')) OR
 (OLD.status IN ('PENDING_RENEWAL','PAST_DUE') AND NEW.status IN ('ACTIVE','EXPIRED','CANCELLED','SUSPENDED')) OR
 (OLD.status='SUSPENDED' AND NEW.status IN ('ACTIVE','EXPIRED','CANCELLED')) OR
 (OLD.status='EXPIRED' AND NEW.status IN ('PENDING_RENEWAL','ACTIVE'))))
BEGIN SELECT RAISE(ABORT,'SUBSCRIPTION_INVALID_CHANGE'); END;

CREATE TRIGGER billing_period_initial_pending BEFORE INSERT ON billing_periods
WHEN NEW.status<>'PENDING'
BEGIN SELECT RAISE(ABORT,'BILLING_PERIOD_INITIAL_STATE'); END;
CREATE TRIGGER billing_confirmation_provider_evidence BEFORE INSERT ON billing_payment_confirmations
WHEN NOT EXISTS(SELECT 1 FROM billing_provider_events e JOIN billing_payments p ON p.id=e.payment_id
 WHERE e.payment_id=NEW.payment_id AND e.evidence_hash=NEW.evidence_hash AND e.provider_status='APPROVED'
 AND e.provider_transaction_id=NEW.provider_transaction_id AND e.provider_environment=NEW.provider_environment
 AND e.amount_minor=NEW.amount_minor AND e.currency=NEW.currency AND e.reference=p.reference)
BEGIN SELECT RAISE(ABORT,'VERIFIED_PROVIDER_OBSERVATION_REQUIRED'); END;

CREATE TRIGGER commission_entry_initial_approval BEFORE INSERT ON commission_entries
WHEN NEW.status<>'PENDING_APPROVAL' OR NEW.version<>1 OR NEW.approved_by_account_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'COMMISSION_INITIAL_APPROVAL_REQUIRED'); END;
CREATE TRIGGER commission_settlement_initial_record BEFORE INSERT ON commission_settlements
WHEN NEW.status<>'RECORDED'
BEGIN SELECT RAISE(ABORT,'COMMISSION_SETTLEMENT_INITIAL_STATE'); END;
CREATE TRIGGER billing_recurring_consent_owner BEFORE INSERT ON billing_recurring_consents
WHEN NOT EXISTS(SELECT 1 FROM billing_subscriptions s WHERE s.id=NEW.subscription_id AND s.account_id=NEW.account_id)
BEGIN SELECT RAISE(ABORT,'RECURRING_CONSENT_ACCOUNT_MISMATCH'); END;
CREATE TRIGGER billing_payment_source_owner BEFORE INSERT ON billing_payment_sources
WHEN NOT EXISTS(SELECT 1 FROM billing_recurring_consents c WHERE c.id=NEW.consent_id AND c.account_id=NEW.account_id AND c.status='GRANTED')
BEGIN SELECT RAISE(ABORT,'PAYMENT_SOURCE_CONSENT_ACCOUNT_MISMATCH'); END;

DROP TRIGGER billing_subscription_activation_evidence;
CREATE TRIGGER billing_subscription_activation_evidence BEFORE UPDATE ON billing_subscriptions
WHEN NEW.status='ACTIVE' AND (OLD.status<>'ACTIVE' OR NEW.current_period_end IS NOT OLD.current_period_end OR NEW.current_period_start IS NOT OLD.current_period_start)
 AND NOT EXISTS(SELECT 1 FROM billing_periods period JOIN billing_payments pay ON pay.period_id=period.id JOIN billing_payment_confirmations c ON c.payment_id=pay.id
 WHERE period.subscription_id=NEW.id AND period.status='PAID' AND period.starts_at=NEW.current_period_start AND period.ends_at=NEW.current_period_end
 AND pay.status='APPROVED' AND pay.amount_minor=period.amount_minor AND pay.currency=period.currency
 AND c.provider_transaction_id=pay.provider_transaction_id AND c.provider_environment=pay.provider_environment AND c.amount_minor=pay.amount_minor AND c.currency=pay.currency)
 AND NOT EXISTS(SELECT 1 FROM billing_admin_grants g WHERE g.subscription_id=NEW.id AND g.starts_at=NEW.current_period_start AND g.ends_at=NEW.current_period_end)
BEGIN SELECT RAISE(ABORT,'SUBSCRIPTION_PAYMENT_EVIDENCE_REQUIRED'); END;

CREATE TRIGGER billing_paid_period_calendar BEFORE UPDATE ON billing_periods
WHEN NEW.status='PAID' AND NOT EXISTS(
 SELECT 1 FROM billing_subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.id=NEW.subscription_id
 AND NEW.starts_at LIKE '____-__-__T__:__:__.___Z'
 AND NEW.ends_at = strftime('%Y-%m-',NEW.starts_at,'start of month',CASE WHEN p.period='MONTH' THEN '+1 month' ELSE '+12 months' END)
 || printf('%02d',min(CAST(strftime('%d',NEW.starts_at) AS INTEGER),CAST(strftime('%d',NEW.starts_at,'start of month',CASE WHEN p.period='MONTH' THEN '+2 months' ELSE '+13 months' END,'-1 day') AS INTEGER)))
 || substr(NEW.starts_at,11))
BEGIN SELECT RAISE(ABORT,'BILLING_PAID_PERIOD_CALENDAR_MISMATCH'); END;
