import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m9 from "../../migrations/0009_workshop_files.sql?raw";
import m10 from "../../migrations/0010_inspection_media.sql?raw";
import m11 from "../../migrations/0011_inspection_workflow.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const accountId = newId(),
  personId = newId();
beforeAll(async () => {
  for (const migration of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m9,
    m10,
    m11,
    m12,
    m13,
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email) VALUES(?,'Schema Finance',?)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Schema','Finance')",
    )
    .bind(personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(accountId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    )
    .bind(personId)
    .run();
});
async function payment() {
  await db
    .prepare(
      "UPDATE billing_subscriptions SET status='CANCELLED',version=version+1 WHERE account_id=? AND status NOT IN ('CANCELLED','EXPIRED')",
    )
    .bind(accountId)
    .run();
  const subscriptionId = newId(),
    periodId = newId(),
    paymentId = newId();
  const reference = `schema-${paymentId}`;
  await db
    .prepare(
      "INSERT INTO billing_subscriptions(id,account_id,plan_code) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY')",
    )
    .bind(subscriptionId, accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) VALUES(?,?,1,'2026-10-09T00:00:00.000Z','2026-11-09T00:00:00.000Z',2990000,'COP')",
    )
    .bind(periodId, subscriptionId)
    .run();
  await db
    .prepare(
      "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,2990000,'COP',?)",
    )
    .bind(paymentId, periodId, reference)
    .run();
  return {
    subscriptionId,
    periodId,
    paymentId,
    reference,
    transactionId: `transaction-${paymentId}`,
  };
}
function observation(
  value: Awaited<ReturnType<typeof payment>>,
  overrides: { amount?: number; reference?: string; environment?: string } = {},
) {
  return db
    .prepare(
      "INSERT INTO billing_provider_events(id,evidence_hash,payment_id,provider_transaction_id,provider_environment,provider_status,amount_minor,currency,reference) VALUES(?,?,?,?,?,'APPROVED',?,'COP',?)",
    )
    .bind(
      newId(),
      newId().replaceAll("-", "").padEnd(64, "a"),
      value.paymentId,
      value.transactionId,
      overrides.environment ?? "SANDBOX",
      overrides.amount ?? 2990000,
      overrides.reference ?? value.reference,
    );
}
function confirmation(
  value: Awaited<ReturnType<typeof payment>>,
  hash: string,
) {
  return db
    .prepare(
      "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',2990000,'COP',?)",
    )
    .bind(newId(), value.paymentId, value.transactionId, hash);
}
async function commission() {
  const organizationId = newId(),
    locationId = newId(),
    vehicleId = newId(),
    orderId = newId(),
    recordId = newId(),
    agreementId = newId(),
    ruleId = newId(),
    consentId = newId(),
    referralId = newId();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id) VALUES(?,'WORKSHOP','Schema Partner','Schema Partner','CO',?)",
    )
    .bind(organizationId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Test','BRANCH','CO','Test','Test','Synthetic')",
    )
    .bind(locationId, organizationId)
    .run();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(vehicleId)
    .run();
  await db
    .prepare(
      "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
    )
    .bind(newId(), vehicleId, personId, accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,assigned_person_id,created_by_account_id) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      orderId,
      vehicleId,
      organizationId,
      locationId,
      "Synthetic service evidence",
      personId,
      accountId,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,'MAINTENANCE','{}')",
    )
    .bind(recordId, vehicleId, organizationId, locationId, personId)
    .run();
  await db
    .prepare(
      "UPDATE vehicle_professional_records SET status='FINAL',finalized_at='2026-10-09T12:00:00.000Z',version=2 WHERE id=?",
    )
    .bind(recordId)
    .run();
  for (const status of ["OPEN", "IN_PROGRESS"])
    await db
      .prepare(
        "UPDATE workshop_orders SET status=?,version=version+1 WHERE id=?",
      )
      .bind(status, orderId)
      .run();
  await db
    .prepare(
      "UPDATE workshop_orders SET status='COMPLETED',final_record_id=?,version=version+1 WHERE id=?",
    )
    .bind(recordId, orderId)
    .run();
  await db
    .prepare(
      "INSERT INTO commission_agreements(id,organization_id,agreement_version,valid_from,settlement_rules_json) VALUES(?,?,1,'2020-01-01T00:00:00.000Z','{\"approvedTermsReference\":\"synthetic-manual-terms\"}')",
    )
    .bind(agreementId, organizationId)
    .run();
  await db
    .prepare(
      "INSERT INTO commission_rules(id,agreement_id,service_code,calculation,basis_points,currency,rounding) VALUES(?,?,'MAINTENANCE','PERCENTAGE',9999,'COP','HALF_UP')",
    )
    .bind(ruleId, agreementId)
    .run();
  await db
    .prepare(
      "UPDATE commission_agreements SET status='APPROVED',approved_by_account_id=?,approved_at='2026-10-09T00:00:00.000Z',settlement_approved=1,version=2 WHERE id=?",
    )
    .bind(accountId, agreementId)
    .run();
  await db
    .prepare(
      "INSERT INTO commission_consent_events(id,account_id,order_id,agreement_id,status,policy_version,request_id) VALUES(?,?,?,?,'GRANTED','schema-v1',?)",
    )
    .bind(consentId, accountId, orderId, agreementId, newId())
    .run();
  await db
    .prepare(
      "INSERT INTO commission_referrals(id,agreement_id,order_id,customer_account_id,consent_event_id,service_code,attributed_by_account_id) VALUES(?,?,?,?,?,'MAINTENANCE',?)",
    )
    .bind(referralId, agreementId, orderId, accountId, consentId, accountId)
    .run();
  const numerator = BigInt(Number.MAX_SAFE_INTEGER) * 9999n;
  const expected = Number(
    numerator / 10000n + (numerator % 10000n >= 5000n ? 1n : 0n),
  );
  return { referralId, ruleId, recordId, expected, consentId };
}
function recognition(
  value: Awaited<ReturnType<typeof commission>>,
  id: string,
  amount = value.expected,
) {
  return db
    .prepare(
      "INSERT INTO commission_entries(id,referral_id,rule_id,base_minor,amount_minor,currency,completion_record_id,evidence_reference) VALUES(?,?,?,?,?,'COP',?,'synthetic-service-base-proof')",
    )
    .bind(
      id,
      value.referralId,
      value.ruleId,
      Number.MAX_SAFE_INTEGER,
      amount,
      value.recordId,
    );
}
async function anotherAccount() {
  const id = newId(),
    person = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email) VALUES(?,'Consent Boundary',?)",
    )
    .bind(id, `${id}@example.test`)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Consent','Boundary')",
    )
    .bind(person)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(id, person)
    .run();
  return id;
}
describe("billing database security through migration 0013", () => {
  it("cannot record another account's recurring consent for a subscription", async () => {
    const value = await payment(),
      other = await anotherAccount();
    await expect(
      db
        .prepare(
          "INSERT INTO billing_recurring_consents(id,account_id,subscription_id,status,terms_version,amount_minor,currency,cadence,request_id) VALUES(?,?,?,'GRANTED','schema-v1',2990000,'COP','MONTH',?)",
        )
        .bind(newId(), other, value.subscriptionId, newId())
        .run(),
    ).rejects.toThrow(/RECURRING_CONSENT_ACCOUNT_MISMATCH/);
  });
  it("cannot bind a payment source to another account's consent", async () => {
    const value = await payment(),
      other = await anotherAccount(),
      consentId = newId();
    await db
      .prepare(
        "INSERT INTO billing_recurring_consents(id,account_id,subscription_id,status,terms_version,amount_minor,currency,cadence,request_id) VALUES(?,?,?,'GRANTED','schema-v1',2990000,'COP','MONTH',?)",
      )
      .bind(consentId, accountId, value.subscriptionId, newId())
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO billing_payment_sources(id,account_id,provider_source_id,provider_environment,method,consent_id,status) VALUES(?,?,999,'SANDBOX','CARD',?,'AVAILABLE')",
        )
        .bind(newId(), other, consentId)
        .run(),
    ).rejects.toThrow(/PAYMENT_SOURCE_CONSENT_ACCOUNT_MISMATCH/);
  });
  it("requires commission recognition to begin pending explicit approval", async () => {
    const value = await commission();
    await expect(
      db
        .prepare(
          "INSERT INTO commission_entries(id,referral_id,rule_id,base_minor,amount_minor,currency,completion_record_id,evidence_reference,status,approved_by_account_id) VALUES(?,?,?,?,?,'COP',?,'synthetic-service-proof','APPROVED',?)",
        )
        .bind(
          newId(),
          value.referralId,
          value.ruleId,
          Number.MAX_SAFE_INTEGER,
          value.expected,
          value.recordId,
          accountId,
        )
        .run(),
    ).rejects.toThrow(/COMMISSION_INITIAL_APPROVAL_REQUIRED/);
  });
  it("requires a manual settlement to begin recorded before separate reconciliation", async () => {
    const value = await commission(),
      entryId = newId();
    await recognition(value, entryId).run();
    await db
      .prepare(
        "UPDATE commission_entries SET status='APPROVED',approved_by_account_id=?,version=2 WHERE id=?",
      )
      .bind(accountId, entryId)
      .run();
    await expect(
      db.batch([
        db
          .prepare(
            "UPDATE commission_entries SET status='SETTLED',version=3 WHERE id=?",
          )
          .bind(entryId),
        db
          .prepare(
            "INSERT INTO commission_settlements(id,commission_id,amount_minor,currency,external_reference,status,recorded_by_account_id) VALUES(?,?,?,'COP',?,'RECONCILED',?)",
          )
          .bind(
            newId(),
            entryId,
            value.expected,
            `synthetic-forged-reconciliation-${entryId}`,
            accountId,
          ),
      ]),
    ).rejects.toThrow(/COMMISSION_SETTLEMENT_INITIAL_STATE/);
    expect(
      await db
        .prepare("SELECT status,version FROM commission_entries WHERE id=?")
        .bind(entryId)
        .first(),
    ).toMatchObject({ status: "APPROVED", version: 2 });
  });
  it("denies initial activation forgery and payment/period approval without immutable proof", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO billing_subscriptions(id,account_id,plan_code,status,current_period_start,current_period_end) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY','ACTIVE','2026-10-09','2026-11-09')",
        )
        .bind(newId(), accountId)
        .run(),
    ).rejects.toBeTruthy();
    const value = await payment();
    await expect(
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start='2026-10-09T00:00:00.000Z',current_period_end='2026-11-09T00:00:00.000Z',version=2 WHERE id=?",
        )
        .bind(value.subscriptionId)
        .run(),
    ).rejects.toThrow(/SUBSCRIPTION_PAYMENT_EVIDENCE_REQUIRED/);
    await expect(
      db
        .prepare(
          "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=2 WHERE id=?",
        )
        .bind(value.transactionId, value.paymentId)
        .run(),
    ).rejects.toThrow(/PAYMENT_CONFIRMATION_REQUIRED/);
    await expect(
      db
        .prepare("UPDATE billing_periods SET status='PAID' WHERE id=?")
        .bind(value.periodId)
        .run(),
    ).rejects.toThrow(/PAYMENT_CONFIRMATION_REQUIRED/);
  });
  it("rejects extending the purchased paid calendar period beyond its recorded plan cadence", async () => {
    const value = await payment();
    await observation(value).run();
    const proof = await db
      .prepare(
        "SELECT evidence_hash FROM billing_provider_events WHERE payment_id=?",
      )
      .bind(value.paymentId)
      .first<{ evidence_hash: string }>();
    await confirmation(value, proof!.evidence_hash).run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=2 WHERE id=?",
      )
      .bind(value.transactionId, value.paymentId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_periods SET status='PAID',starts_at='2026-10-09T00:00:00.000Z',ends_at='2099-10-09T00:00:00.000Z' WHERE id=?",
        )
        .bind(value.periodId)
        .run(),
    ).rejects.toThrow(/BILLING_PAID_PERIOD_CALENDAR_MISMATCH/);
    expect(
      await db
        .prepare("SELECT status,ends_at FROM billing_periods WHERE id=?")
        .bind(value.periodId)
        .first(),
    ).toMatchObject({ status: "PENDING", ends_at: "2026-11-09T00:00:00.000Z" });
  });
  it("cannot activate from a formerly paid period whose approved payment is now voided", async () => {
    const value = await payment();
    await observation(value).run();
    const proof = await db
      .prepare(
        "SELECT evidence_hash FROM billing_provider_events WHERE payment_id=?",
      )
      .bind(value.paymentId)
      .first<{ evidence_hash: string }>();
    await confirmation(value, proof!.evidence_hash).run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=2 WHERE id=?",
      )
      .bind(value.transactionId, value.paymentId)
      .run();
    await db
      .prepare("UPDATE billing_periods SET status='PAID' WHERE id=?")
      .bind(value.periodId)
      .run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='VOIDED',version=3 WHERE id=?",
      )
      .bind(value.paymentId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start='2026-10-09T00:00:00.000Z',current_period_end='2026-11-09T00:00:00.000Z',version=2 WHERE id=?",
        )
        .bind(value.subscriptionId)
        .run(),
    ).rejects.toBeTruthy();
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
          .bind(value.subscriptionId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("PENDING_ACTIVATION");
  });
  it("rejects forged confirmation without the matching immutable approved provider observation", async () => {
    const value = await payment();
    await expect(
      confirmation(value, "f".repeat(64)).run(),
    ).rejects.toBeTruthy();
    const event = observation(value);
    await event.run();
    await expect(
      confirmation(value, "e".repeat(64)).run(),
    ).rejects.toBeTruthy();
  });
  it("rejects an initially paid period forged to activate a subscription without payment proof", async () => {
    const value = await payment();
    await expect(
      db
        .prepare(
          "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency,status) VALUES(?,?,2,'2026-11-09T00:00:00.000Z','2026-12-09T00:00:00.000Z',2990000,'COP','PAID')",
        )
        .bind(newId(), value.subscriptionId)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("does not reuse another period's valid provider observation as payment confirmation", async () => {
    const first = await payment();
    await observation(first).run();
    const evidence = await db
      .prepare(
        "SELECT evidence_hash FROM billing_provider_events WHERE payment_id=?",
      )
      .bind(first.paymentId)
      .first<{ evidence_hash: string }>();
    const second = await payment();
    await expect(
      confirmation(second, evidence!.evidence_hash).run(),
    ).rejects.toBeTruthy();
  });
  it("binds immutable provider evidence to exact amount, reference, payment and environment", async () => {
    const value = await payment();
    for (const wrong of [
      { amount: 1 },
      { reference: "other-period-reference" },
      { environment: "PRODUCTION" },
    ])
      await expect(observation(value, wrong).run()).rejects.toThrow(
        /PROVIDER_EVIDENCE_MISMATCH/,
      );
    await observation(value).run();
    await expect(
      db
        .prepare(
          "UPDATE billing_provider_events SET provider_status='DECLINED' WHERE payment_id=?",
        )
        .bind(value.paymentId)
        .run(),
    ).rejects.toBeTruthy();
    await expect(
      db
        .prepare("DELETE FROM billing_provider_events WHERE payment_id=?")
        .bind(value.paymentId)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("permits activation only after the correctly bound provider proof and paid period", async () => {
    const value = await payment();
    await observation(value).run();
    const row = await db
      .prepare(
        "SELECT evidence_hash FROM billing_provider_events WHERE payment_id=?",
      )
      .bind(value.paymentId)
      .first<{ evidence_hash: string }>();
    await confirmation(value, row!.evidence_hash).run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=2 WHERE id=?",
      )
      .bind(value.transactionId, value.paymentId)
      .run();
    await db
      .prepare("UPDATE billing_periods SET status='PAID' WHERE id=?")
      .bind(value.periodId)
      .run();
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start='2026-10-09T00:00:00.000Z',current_period_end='2026-11-09T00:00:00.000Z',version=2 WHERE id=?",
      )
      .bind(value.subscriptionId)
      .run();
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
          .bind(value.subscriptionId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("ACTIVE");
    await expect(
      db
        .prepare(
          "UPDATE billing_payment_confirmations SET amount_minor=1 WHERE payment_id=?",
        )
        .bind(value.paymentId)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("enforces forward attempts and preserves the first provider reference", async () => {
    const value = await payment(),
      id = newId();
    await db
      .prepare(
        "INSERT INTO billing_payment_attempts(id,payment_id,attempt,state) VALUES(?,?,1,'CREATED')",
      )
      .bind(id, value.paymentId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_payment_attempts SET state='RESOLVED' WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow(/PAYMENT_ATTEMPT_INVALID_CHANGE/);
    await db
      .prepare(
        "UPDATE billing_payment_attempts SET state='SUBMITTED',provider_reference='synthetic-reference' WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_payment_attempts SET state='UNKNOWN',provider_reference='different-reference' WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toBeTruthy();
    await db
      .prepare("UPDATE billing_payment_attempts SET state='UNKNOWN' WHERE id=?")
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE billing_payment_attempts SET state='RESOLVED' WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_payment_attempts SET state='SUBMITTED' WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("allows only CARD and NEQUI sources and retains immutable recurring consent", async () => {
    const value = await payment(),
      consentId = newId();
    await db
      .prepare(
        "INSERT INTO billing_recurring_consents(id,account_id,subscription_id,status,terms_version,amount_minor,currency,cadence,request_id) VALUES(?,?,?,'GRANTED','schema-v1',2990000,'COP','MONTH',?)",
      )
      .bind(consentId, accountId, value.subscriptionId, newId())
      .run();
    for (const [index, method] of ["CARD", "NEQUI"].entries())
      await db
        .prepare(
          "INSERT INTO billing_payment_sources(id,account_id,provider_source_id,provider_environment,method,consent_id,status) VALUES(?,?,?,'SANDBOX',?,?,'AVAILABLE')",
        )
        .bind(newId(), accountId, index + 1, method, consentId)
        .run();
    await expect(
      db
        .prepare(
          "INSERT INTO billing_payment_sources(id,account_id,provider_source_id,provider_environment,method,consent_id,status) VALUES(?,?,3,'SANDBOX','PSE',?,'AVAILABLE')",
        )
        .bind(newId(), accountId, consentId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db
        .prepare(
          "UPDATE billing_recurring_consents SET status='REVOKED' WHERE id=?",
        )
        .bind(consentId)
        .run(),
    ).rejects.toBeTruthy();
    await expect(
      db
        .prepare("DELETE FROM billing_recurring_consents WHERE id=?")
        .bind(consentId)
        .run(),
    ).rejects.toBeTruthy();
    await expect(
      db
        .prepare(
          "UPDATE billing_payment_sources SET method='NEQUI' WHERE provider_source_id=1",
        )
        .run(),
    ).rejects.toBeTruthy();
  });
  it("retains immutable finite admin grants and financial events", async () => {
    const value = await payment(),
      id = newId();
    await expect(
      db
        .prepare(
          "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,'2026-11-01','2026-10-01',?,'Invalid inverted finite grant')",
        )
        .bind(newId(), value.subscriptionId, accountId)
        .run(),
    ).rejects.toBeTruthy();
    await db
      .prepare(
        "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,'2026-10-01','2026-11-01',?,'Explicit finite synthetic grant')",
      )
      .bind(id, value.subscriptionId, accountId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_admin_grants SET ends_at='2099-01-01' WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toBeTruthy();
    await expect(
      db.prepare("DELETE FROM billing_admin_grants WHERE id=?").bind(id).run(),
    ).rejects.toBeTruthy();
    const eventId = newId();
    await db
      .prepare(
        "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'SUBSCRIPTION',?,'billing.admin.grant',?,?,'{}')",
      )
      .bind(eventId, value.subscriptionId, accountId, newId())
      .run();
    await expect(
      db
        .prepare(
          "UPDATE billing_financial_events SET data_json='{}' WHERE id=?",
        )
        .bind(eventId)
        .run(),
    ).rejects.toBeTruthy();
    await expect(
      db
        .prepare("DELETE FROM billing_financial_events WHERE id=?")
        .bind(eventId)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("enforces MAX_SAFE_INTEGER commission math with integer division and rollback for mismatched amounts", async () => {
    const value = await commission(),
      entryId = newId(),
      eventId = newId();
    await expect(
      db.batch([
        db
          .prepare(
            "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'COMMISSION',?,'commission.recognize',?,?,'{}')",
          )
          .bind(eventId, entryId, accountId, newId()),
        recognition(value, entryId, value.expected + 1),
      ]),
    ).rejects.toThrow(/COMMISSION_AMOUNT_MISMATCH/);
    expect(
      await db
        .prepare("SELECT id FROM billing_financial_events WHERE id=?")
        .bind(eventId)
        .first(),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT id FROM commission_entries WHERE id=?")
        .bind(entryId)
        .first(),
    ).toBeNull();
    await recognition(value, entryId).run();
    expect(
      await db
        .prepare(
          "SELECT amount_minor,typeof(amount_minor) AS storage_type FROM commission_entries WHERE id=?",
        )
        .bind(entryId)
        .first(),
    ).toMatchObject({ amount_minor: value.expected, storage_type: "integer" });
    await expect(
      db
        .prepare("DELETE FROM commission_consent_events WHERE id=?")
        .bind(value.consentId)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("rejects mismatched manual settlement amounts and rolls status changes back", async () => {
    const value = await commission(),
      entryId = newId();
    await recognition(value, entryId).run();
    await db
      .prepare(
        "UPDATE commission_entries SET status='APPROVED',approved_by_account_id=?,version=2 WHERE id=?",
      )
      .bind(accountId, entryId)
      .run();
    await expect(
      db.batch([
        db
          .prepare(
            "UPDATE commission_entries SET status='SETTLED',version=3 WHERE id=?",
          )
          .bind(entryId),
        db
          .prepare(
            "INSERT INTO commission_settlements(id,commission_id,amount_minor,currency,external_reference,status,recorded_by_account_id) VALUES(?,?,1,'COP',?,'RECORDED',?)",
          )
          .bind(newId(), entryId, `synthetic-${entryId}`, accountId),
      ]),
    ).rejects.toThrow(/COMMISSION_SETTLEMENT_AMOUNT_MISMATCH/);
    expect(
      await db
        .prepare("SELECT status,version FROM commission_entries WHERE id=?")
        .bind(entryId)
        .first(),
    ).toMatchObject({ status: "APPROVED", version: 2 });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM commission_settlements WHERE commission_id=?",
          )
          .bind(entryId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
});
