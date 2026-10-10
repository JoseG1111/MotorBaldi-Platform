import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  buildIdempotencyScope,
  commitIdempotentCommand,
  commitPreparedCommand,
  readReplay,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  calculateCommissionMinor,
  parseCommissionCommand,
  prepareCommissionCommand,
  adminCommissionOverview,
  type CommissionActor,
  type CommissionOperation,
} from "@motorbaldi/payments";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import core from "../../migrations/0004_vehicle_core.sql?raw";
import access from "../../migrations/0005_vehicle_access.sql?raw";
import history from "../../migrations/0006_vehicle_history.sql?raw";
import commands from "../../migrations/0007_vehicle_commands.sql?raw";
import workshops from "../../migrations/0008_workshop_operations.sql?raw";
import files from "../../migrations/0009_workshop_files.sql?raw";
import media from "../../migrations/0010_inspection_media.sql?raw";
import inspections from "../../migrations/0011_inspection_workflow.sql?raw";
import billing from "../../migrations/0012_billing_membership.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const staff = { accountId: newId(), personId: newId(), mfaEnabled: true };
const customer = { accountId: newId(), personId: newId(), mfaEnabled: false };
const outsider = { accountId: newId(), personId: newId(), mfaEnabled: true };
const organizationId = newId(),
  locationId = newId(),
  vehicleId = newId();
beforeAll(async () => {
  for (const sql of [
    foundation,
    phase1,
    closeout,
    core,
    access,
    history,
    commands,
    workshops,
    files,
    media,
    inspections,
    billing,
  ])
    await db.exec(sql.replace(/\n/g, " "));
  for (const [index, actor] of [staff, customer, outsider].entries()) {
    await db
      .prepare("INSERT INTO auth_users(id,name,email) VALUES(?,?,?)")
      .bind(
        actor.accountId,
        "Commission Test",
        `commission-${index}@example.test`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Commission','Test')",
      )
      .bind(actor.personId)
      .run();
    await db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(actor.accountId, actor.personId)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    )
    .bind(staff.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id) VALUES(?,'WORKSHOP','Commission Partner','Commission Partner','CO',?)",
    )
    .bind(organizationId, staff.personId)
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
    .bind(newId(), vehicleId, customer.personId, staff.accountId)
    .run();
});

async function assertRaceRollback(
  operation: CommissionOperation,
  body: Record<string, Json>,
  prepared: PreparedCommand<Json>,
  requestId: string,
  expected: RegExp,
  table:
    "commission_referrals" | "commission_entries" | "commission_consent_events",
  actor: CommissionActor = staff,
) {
  const key = newId();
  const scope = buildIdempotencyScope({
    accountId: actor.accountId,
    operation,
  });
  await expect(
    commitIdempotentCommand(db, scope, key, body, requestId, prepared),
  ).rejects.toThrow(expected);
  expect(await readReplay(db, scope, key, body)).toBeNull();
  const resourceId = (prepared.response as { id: string }).id;
  expect(
    (
      await db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE id=?`)
        .bind(resourceId)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
  for (const tableName of [
    "governance_audit_events",
    "billing_financial_events",
    "integration_outbox_events",
  ]) {
    expect(
      (
        await db
          .prepare(`SELECT count(*) AS n FROM ${tableName} WHERE request_id=?`)
          .bind(requestId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  }
  expect(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM governance_idempotency_records WHERE scope=? AND key=?",
        )
        .bind(scope.scope, key)
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
}

describe("commission prepare-to-commit authority races", () => {
  for (const operation of [
    "commission.referral.create",
    "commission.recognize",
  ] as const) {
    it(`rolls ${operation} back when latest consent is revoked after preparation`, async () => {
      const terms =
        operation === "commission.recognize"
          ? await referral()
          : await (async () => {
              const terms = await agreement();
              const orderId = await order();
              const granted = await execute(
                "commission.consent.record",
                {
                  orderId,
                  agreementId: terms.agreementId,
                  status: "GRANTED",
                  policyVersion: "race-v1",
                },
                customer,
              );
              return {
                ...terms,
                orderId,
                consentEventId: granted.id,
                referralId: "",
              };
            })();
      const body: Record<string, Json> =
        operation === "commission.recognize"
          ? {
              referralId: terms.referralId,
              ruleId: terms.ruleId,
              baseMinor: 10000,
              evidenceReference: "synthetic-race-service-attestation",
              reason: "Consent race recognition",
            }
          : {
              agreementId: terms.agreementId,
              orderId: terms.orderId,
              customerAccountId: customer.accountId,
              consentEventId: terms.consentEventId,
              serviceCode: "MAINTENANCE",
              reason: "Consent race referral",
            };
      const requestId = newId();
      const prepared = await prepareCommissionCommand(
        db,
        staff,
        operation,
        body,
        requestId,
      );
      await execute(
        "commission.consent.record",
        {
          orderId: terms.orderId,
          agreementId: terms.agreementId,
          status: "REVOKED",
          policyVersion: "race-v2",
        },
        customer,
      );
      await assertRaceRollback(
        operation,
        body,
        prepared,
        requestId,
        operation === "commission.recognize"
          ? /COMMISSION_COMPLETION_OR_AUTHORITY_CHANGED/
          : /COMMISSION_REFERRAL_AUTHORITY_CHANGED/,
        operation === "commission.recognize"
          ? "commission_entries"
          : "commission_referrals",
      );
    });
  }
  it("rolls business, replay and all receipts back when the admin role is revoked after prepare", async () => {
    const referred = await referral();
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-finance')",
      )
      .bind(outsider.personId)
      .run();
    const body = {
      referralId: referred.referralId,
      ruleId: referred.ruleId,
      baseMinor: 10000,
      evidenceReference: "synthetic-role-race-attestation",
      reason: "Admin role revocation race",
    };
    const requestId = newId();
    const prepared = await prepareCommissionCommand(
      db,
      outsider,
      "commission.recognize",
      body,
      requestId,
    );
    await db
      .prepare(
        "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-finance'",
      )
      .bind(outsider.personId)
      .run();
    try {
      await assertRaceRollback(
        "commission.recognize",
        body,
        prepared,
        requestId,
        /FINANCIAL_ACTOR_AUTHORIZATION_CHANGED/,
        "commission_entries",
        outsider,
      );
    } finally {
      await db
        .prepare(
          "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-finance'",
        )
        .bind(outsider.personId)
        .run();
    }
  });
  it("rolls recognition back when its approved agreement is suspended after prepare", async () => {
    const referred = await referral();
    const body = {
      referralId: referred.referralId,
      ruleId: referred.ruleId,
      baseMinor: 10000,
      evidenceReference: "synthetic-agreement-race-attestation",
      reason: "Agreement suspension race",
    };
    const requestId = newId();
    const prepared = await prepareCommissionCommand(
      db,
      staff,
      "commission.recognize",
      body,
      requestId,
    );
    await db
      .prepare(
        "UPDATE commission_agreements SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(referred.agreementId)
      .run();
    await assertRaceRollback(
      "commission.recognize",
      body,
      prepared,
      requestId,
      /COMMISSION_COMPLETION_OR_AUTHORITY_CHANGED/,
      "commission_entries",
    );
  });
  it("rolls recognition back when customer vehicle access is revoked after prepare", async () => {
    const referred = await referral();
    const body = {
      referralId: referred.referralId,
      ruleId: referred.ruleId,
      baseMinor: 10000,
      evidenceReference: "synthetic-grant-race-attestation",
      reason: "Customer grant revocation race",
    };
    const requestId = newId();
    const prepared = await prepareCommissionCommand(
      db,
      staff,
      "commission.recognize",
      body,
      requestId,
    );
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND person_id=? AND revoked_at IS NULL",
      )
      .bind(vehicleId, customer.personId)
      .run();
    try {
      await assertRaceRollback(
        "commission.recognize",
        body,
        prepared,
        requestId,
        /COMMISSION_COMPLETION_OR_AUTHORITY_CHANGED/,
        "commission_entries",
      );
    } finally {
      await db
        .prepare(
          "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
        )
        .bind(newId(), vehicleId, customer.personId, staff.accountId)
        .run();
    }
  });
});
async function execute(
  operation: CommissionOperation,
  input: Record<string, Json>,
  actor: CommissionActor = staff,
) {
  const prepared = await prepareCommissionCommand(
    db,
    actor,
    operation,
    input,
    newId(),
  );
  return (await commitPreparedCommand(db, prepared)) as {
    id: string;
    version: number;
    amountMinor?: number;
  };
}
async function agreement(
  settlement = false,
  validFrom = "2020-01-01T00:00:00.000Z",
  validUntil: string | null = null,
) {
  const organization = await db
    .prepare(
      "SELECT coalesce(max(agreement_version),0)+1 AS n FROM commission_agreements WHERE organization_id=?",
    )
    .bind(organizationId)
    .first<{ n: number }>();
  const created = await execute("commission.agreement.create", {
    organizationId,
    agreementVersion: organization!.n,
    validFrom,
    validUntil,
    settlementRulesJson: settlement
      ? { approvedTermsReference: "synthetic-owner-approved-manual-terms" }
      : {},
    rules: [
      {
        serviceCode: "MAINTENANCE",
        calculation: "PERCENTAGE",
        basisPoints: 1250,
        currency: "COP",
        rounding: "FLOOR",
      },
    ],
    reason: "Synthetic approved agreement",
  });
  await execute("commission.agreement.approve", {
    agreementId: created.id,
    version: 1,
    settlementApproved: settlement,
    reason: "Explicit owner agreement approval",
  });
  const rule = await db
    .prepare("SELECT id FROM commission_rules WHERE agreement_id=?")
    .bind(created.id)
    .first<{ id: string }>();
  return { agreementId: created.id, ruleId: rule!.id };
}
async function order(completed = true) {
  const id = newId();
  await db
    .prepare(
      "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,assigned_person_id,created_by_account_id) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      vehicleId,
      organizationId,
      locationId,
      "Synthetic completed service",
      staff.personId,
      staff.accountId,
    )
    .run();
  if (completed) {
    const recordId = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,'MAINTENANCE','{}')",
      )
      .bind(recordId, vehicleId, organizationId, locationId, staff.personId)
      .run();
    await db
      .prepare(
        "UPDATE vehicle_professional_records SET status='FINAL',finalized_at='2026-10-09T12:00:00.000Z',version=version+1 WHERE id=?",
      )
      .bind(recordId)
      .run();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='OPEN',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='IN_PROGRESS',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='COMPLETED',final_record_id=?,version=version+1 WHERE id=?",
      )
      .bind(recordId, id)
      .run();
  }
  return id;
}
async function referral(
  options: {
    completed?: boolean;
    settlement?: boolean;
    validFrom?: string;
    validUntil?: string;
  } = {},
) {
  const terms = await agreement(
    options.settlement,
    options.validFrom,
    options.validUntil,
  );
  const orderId = await order(options.completed);
  const consent = await execute(
    "commission.consent.record",
    {
      orderId,
      agreementId: terms.agreementId,
      status: "GRANTED",
      policyVersion: "test-v1",
    },
    customer,
  );
  const attributed = await execute("commission.referral.create", {
    agreementId: terms.agreementId,
    orderId,
    customerAccountId: customer.accountId,
    consentEventId: consent.id,
    serviceCode: "MAINTENANCE",
    reason: "Explicit referral attribution",
  });
  return {
    ...terms,
    orderId,
    consentEventId: consent.id,
    referralId: attributed.id,
  };
}
async function recognized(settlement = false) {
  const referred = await referral({ settlement });
  const value = await execute("commission.recognize", {
    referralId: referred.referralId,
    ruleId: referred.ruleId,
    baseMinor: 10001,
    evidenceReference: "synthetic-completed-service-base-attestation",
    reason: "Recognize completed service",
  });
  return {
    ...referred,
    commissionId: value.id,
    amountMinor: value.amountMinor!,
  };
}
describe("partner commission financial invariants", () => {
  it("tracks manual reconciliation and later disputes with immutable financial corrections and no refund execution", async () => {
    const value = await recognized(true);
    await execute("commission.approve", {
      commissionId: value.commissionId,
      version: 1,
      reason: "Approve manual settlement",
    });
    await execute("commission.settlement.record", {
      commissionId: value.commissionId,
      version: 2,
      externalReference: "synthetic-reconciliation-record",
      reason: "Manual transfer evidence recorded",
    });
    const settlement = await db
      .prepare("SELECT id FROM commission_settlements WHERE commission_id=?")
      .bind(value.commissionId)
      .first<{ id: string }>();
    await execute("commission.settlement.reconcile", {
      settlementId: settlement!.id,
      status: "RECONCILED",
      reason: "Manual reference reconciliation evidence",
    });
    expect(
      await db
        .prepare(
          "SELECT status,amount_minor FROM commission_settlements WHERE id=?",
        )
        .bind(settlement!.id)
        .first(),
    ).toMatchObject({ status: "RECONCILED", amount_minor: 1250 });
    await execute("commission.dispute", {
      commissionId: value.commissionId,
      version: 3,
      reason: "Settled service entitlement disputed",
    });
    expect(
      await db
        .prepare(
          "SELECT status,amount_minor FROM commission_settlements WHERE id=?",
        )
        .bind(settlement!.id)
        .first(),
    ).toMatchObject({ status: "DISPUTED", amount_minor: 1250 });
    expect(
      (
        await execute("commission.adjust", {
          commissionId: value.commissionId,
          version: 4,
          amountMinor: -250,
          kind: "ADJUSTMENT",
          reason: "Immutable settled entitlement correction",
        })
      ).amountMinor,
    ).toBe(1000);
    expect(
      (
        await db
          .prepare("SELECT amount_minor FROM commission_entries WHERE id=?")
          .bind(value.commissionId)
          .first<{ amount_minor: number }>()
      )?.amount_minor,
    ).toBe(1250);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payments")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payment_attempts")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM billing_financial_events WHERE aggregate_id=? AND event_type IN ('commission.dispute','commission.settlement.reconcile')",
          )
          .bind(value.commissionId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("rolls stale reconciliation CAS back and supports a reconciled manual record entering dispute", async () => {
    const value = await recognized(true);
    await execute("commission.approve", {
      commissionId: value.commissionId,
      version: 1,
      reason: "Approve reconciliation fixture",
    });
    await execute("commission.settlement.record", {
      commissionId: value.commissionId,
      version: 2,
      externalReference: "synthetic-reconcile-cas-record",
      reason: "Manual record for reconciliation race",
    });
    const settlement = await db
      .prepare("SELECT id FROM commission_settlements WHERE commission_id=?")
      .bind(value.commissionId)
      .first<{ id: string }>();
    const body = {
      settlementId: settlement!.id,
      status: "RECONCILED",
      reason: "Concurrent manual reconciliation",
    };
    const requestId = newId();
    const stale = await prepareCommissionCommand(
      db,
      staff,
      "commission.settlement.reconcile",
      body,
      requestId,
    );
    await execute("commission.settlement.reconcile", body);
    await expect(commitPreparedCommand(db, stale)).rejects.toMatchObject({
      code: "COMMISSION_VERSION_CONFLICT",
    });
    for (const table of [
      "governance_audit_events",
      "billing_financial_events",
      "integration_outbox_events",
    ])
      expect(
        (
          await db
            .prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`)
            .bind(requestId)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
    await execute("commission.settlement.reconcile", {
      ...body,
      status: "DISPUTED",
      reason: "Reconciled reference disputed later",
    });
    expect(
      await db
        .prepare("SELECT status,version FROM commission_entries WHERE id=?")
        .bind(value.commissionId)
        .first(),
    ).toMatchObject({ status: "DISPUTED", version: 4 });
    expect(
      await db
        .prepare("SELECT status FROM commission_settlements WHERE id=?")
        .bind(settlement!.id)
        .first(),
    ).toMatchObject({ status: "DISPUTED" });
  });
  it("requires a matching service rule and rechecks consent before recognition", async () => {
    const referred = await referral();
    const unrelated = await agreement();
    const command = {
      referralId: referred.referralId,
      ruleId: unrelated.ruleId,
      baseMinor: 10000,
      evidenceReference: "synthetic-service-attestation",
      reason: "Service rule boundary test",
    };
    await expect(
      execute("commission.recognize", command),
    ).rejects.toMatchObject({ code: "COMMISSION_NOT_FOUND" });
    await execute(
      "commission.consent.record",
      {
        orderId: referred.orderId,
        agreementId: referred.agreementId,
        status: "REVOKED",
        policyVersion: "test-v2",
      },
      customer,
    );
    await expect(
      execute("commission.recognize", { ...command, ruleId: referred.ruleId }),
    ).rejects.toMatchObject({ code: "COMMISSION_CONSENT_REQUIRED" });
  });
  it("rejects adjustment balance overflow and negative entitlement", async () => {
    const value = await recognized();
    const command = {
      commissionId: value.commissionId,
      version: 1,
      amountMinor: Number.MAX_SAFE_INTEGER,
      kind: "ADJUSTMENT",
      reason: "Overflow cannot be booked",
    };
    await expect(execute("commission.adjust", command)).rejects.toMatchObject({
      code: "COMMISSION_MONEY_OVERFLOW",
    });
    await expect(
      execute("commission.adjust", { ...command, amountMinor: -1251 }),
    ).rejects.toMatchObject({ code: "COMMISSION_MONEY_OVERFLOW" });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM commission_adjustments WHERE commission_id=?",
          )
          .bind(value.commissionId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("cannot approve settlement with absent explicit terms", async () => {
    const current = await db
      .prepare(
        "SELECT coalesce(max(agreement_version),0)+1 AS n FROM commission_agreements WHERE organization_id=?",
      )
      .bind(organizationId)
      .first<{ n: number }>();
    const created = await execute("commission.agreement.create", {
      organizationId,
      agreementVersion: current!.n,
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: null,
      rules: [
        {
          serviceCode: "EXPLICIT_FIXED",
          calculation: "FIXED",
          fixedMinor: 200,
          currency: "COP",
          rounding: "FLOOR",
        },
      ],
      reason: "Explicit fixed commission terms",
    });
    await expect(
      execute("commission.agreement.approve", {
        agreementId: created.id,
        version: 1,
        settlementApproved: true,
        reason: "Missing settlement terms rejected",
      }),
    ).rejects.toMatchObject({ code: "COMMISSION_SETTLEMENT_TERMS_REQUIRED" });
    expect(
      await db
        .prepare(
          "SELECT status,settlement_approved FROM commission_agreements WHERE id=?",
        )
        .bind(created.id)
        .first(),
    ).toMatchObject({ status: "DRAFT", settlement_approved: 0 });
  });
  it("uses exact integer basis points and explicit rounding without floating point loss", () => {
    expect(calculateCommissionMinor(1, 5000, "FLOOR")).toBe(0);
    expect(calculateCommissionMinor(1, 5000, "CEIL")).toBe(1);
    expect(calculateCommissionMinor(1, 5000, "HALF_UP")).toBe(1);
    expect(calculateCommissionMinor(1, 4999, "HALF_UP")).toBe(0);
    expect(
      calculateCommissionMinor(Number.MAX_SAFE_INTEGER, 10000, "FLOOR"),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateCommissionMinor(Number.MAX_SAFE_INTEGER, 1, "FLOOR")).toBe(
      Number(BigInt(Number.MAX_SAFE_INTEGER) / 10000n),
    );
    expect(() =>
      calculateCommissionMinor(Number.MAX_SAFE_INTEGER + 1, 10000, "FLOOR"),
    ).toThrow();
    expect(() => calculateCommissionMinor(100, 1.5, "FLOOR")).toThrow();
  });
  it("requires explicit immutable rates and rejects unsupported money inputs", () => {
    expect(() =>
      parseCommissionCommand("commission.recognize", {
        referralId: newId(),
        ruleId: newId(),
        baseMinor: Number.MAX_SAFE_INTEGER + 1,
        evidenceReference: "synthetic-test",
        reason: "Synthetic reason",
      }),
    ).toThrow();
    expect(() =>
      parseCommissionCommand("commission.agreement.create", {
        organizationId,
        agreementVersion: 1,
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: null,
        rules: [
          {
            serviceCode: "MAINTENANCE",
            calculation: "PERCENTAGE",
            currency: "COP",
            rounding: "FLOOR",
          },
        ],
        reason: "No default rate",
      }),
    ).toThrow();
  });
  it("requires live staff permission and MFA while own consent needs no admin MFA", async () => {
    await expect(
      adminCommissionOverview(db, { ...staff, mfaEnabled: false }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(adminCommissionOverview(db, outsider)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const terms = await agreement();
    const orderId = await order(false);
    await expect(
      execute(
        "commission.consent.record",
        {
          orderId,
          agreementId: terms.agreementId,
          status: "GRANTED",
          policyVersion: "test-v1",
        },
        outsider,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (
        await execute(
          "commission.consent.record",
          {
            orderId,
            agreementId: terms.agreementId,
            status: "GRANTED",
            policyVersion: "test-v1",
          },
          customer,
        )
      ).id,
    ).toBeTruthy();
  });
  it("rejects revoked consent and attribution to another customer account", async () => {
    const terms = await agreement();
    const orderId = await order();
    const granted = await execute(
      "commission.consent.record",
      {
        orderId,
        agreementId: terms.agreementId,
        status: "GRANTED",
        policyVersion: "test-v1",
      },
      customer,
    );
    const input = {
      agreementId: terms.agreementId,
      orderId,
      customerAccountId: outsider.accountId,
      consentEventId: granted.id,
      serviceCode: "MAINTENANCE",
      reason: "Synthetic referral",
    };
    await expect(
      execute("commission.referral.create", input),
    ).rejects.toMatchObject({ code: "COMMISSION_CONSENT_REQUIRED" });
    await execute(
      "commission.consent.record",
      {
        orderId,
        agreementId: terms.agreementId,
        status: "REVOKED",
        policyVersion: "test-v1",
      },
      customer,
    );
    await expect(
      execute("commission.referral.create", {
        ...input,
        customerAccountId: customer.accountId,
      }),
    ).rejects.toMatchObject({ code: "COMMISSION_CONSENT_REQUIRED" });
  });
  it("requires an actual completed order with its FINAL record and agreement validity", async () => {
    const unfinished = await referral({ completed: false });
    await expect(
      execute("commission.recognize", {
        referralId: unfinished.referralId,
        ruleId: unfinished.ruleId,
        baseMinor: 10000,
        evidenceReference: "synthetic-base-reference",
        reason: "Incomplete work test",
      }),
    ).rejects.toMatchObject({ code: "COMMISSION_COMPLETED_SERVICE_REQUIRED" });
    const expired = await referral({ validUntil: "2026-01-01T00:00:00.000Z" });
    await expect(
      execute("commission.recognize", {
        referralId: expired.referralId,
        ruleId: expired.ruleId,
        baseMinor: 10000,
        evidenceReference: "synthetic-base-reference",
        reason: "Expired agreement test",
      }),
    ).rejects.toMatchObject({ code: "COMMISSION_AGREEMENT_OUTSIDE_VALIDITY" });
  });
  it("recognizes once per order/rule and prevents duplicate financial effects", async () => {
    const value = await recognized();
    expect(value.amountMinor).toBe(1250);
    await expect(
      execute("commission.recognize", {
        referralId: value.referralId,
        ruleId: value.ruleId,
        baseMinor: 10001,
        evidenceReference: "duplicate-synthetic-reference",
        reason: "Duplicate recognition test",
      }),
    ).rejects.toBeTruthy();
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM commission_entries WHERE referral_id=? AND rule_id=?",
          )
          .bind(value.referralId, value.ruleId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await expect(
      db
        .prepare("UPDATE commission_rules SET basis_points=9000 WHERE id=?")
        .bind(value.ruleId)
        .run(),
    ).rejects.toBeTruthy();
  });
  it("rolls stale approval CAS back before financial events and outbox", async () => {
    const value = await recognized();
    const command = await prepareCommissionCommand(
      db,
      staff,
      "commission.approve",
      {
        commissionId: value.commissionId,
        version: 1,
        reason: "Concurrent approval test",
      },
      newId(),
    );
    await execute("commission.approve", {
      commissionId: value.commissionId,
      version: 1,
      reason: "First approval wins",
    });
    await expect(commitPreparedCommand(db, command)).rejects.toMatchObject({
      code: "COMMISSION_VERSION_CONFLICT",
    });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM billing_financial_events WHERE aggregate_id=? AND event_type='commission.approve'",
          )
          .bind(value.commissionId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM integration_outbox_events WHERE aggregate_id=? AND json_extract(payload_json,'$.operation')='commission.approve'",
          )
          .bind(value.commissionId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("records immutable signed adjustments and full reversals without payouts", async () => {
    const value = await recognized();
    await execute("commission.approve", {
      commissionId: value.commissionId,
      version: 1,
      reason: "Explicit initial approval",
    });
    expect(
      (
        await execute("commission.adjust", {
          commissionId: value.commissionId,
          version: 2,
          amountMinor: -50,
          kind: "ADJUSTMENT",
          reason: "Correct service evidence",
        })
      ).amountMinor,
    ).toBe(1200);
    await expect(
      execute("commission.adjust", {
        commissionId: value.commissionId,
        version: 3,
        amountMinor: -100,
        kind: "REVERSAL",
        reason: "Partial reversal rejected",
      }),
    ).rejects.toMatchObject({ code: "COMMISSION_FULL_REVERSAL_REQUIRED" });
    await execute("commission.adjust", {
      commissionId: value.commissionId,
      version: 3,
      amountMinor: -1200,
      kind: "REVERSAL",
      reason: "Reverse remaining entitlement",
    });
    expect(
      (
        await db
          .prepare("SELECT status FROM commission_entries WHERE id=?")
          .bind(value.commissionId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("REVERSED");
    await expect(
      db
        .prepare("DELETE FROM commission_adjustments WHERE commission_id=?")
        .bind(value.commissionId)
        .run(),
    ).rejects.toBeTruthy();
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payments")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("disables settlement by default and requires explicit approved rules for manual tracking", async () => {
    const disabled = await recognized();
    await execute("commission.approve", {
      commissionId: disabled.commissionId,
      version: 1,
      reason: "Approve recognized entitlement",
    });
    await expect(
      execute("commission.settlement.record", {
        commissionId: disabled.commissionId,
        version: 2,
        externalReference: "synthetic-manual-record-disabled",
        reason: "Default disabled settlement",
      }),
    ).rejects.toMatchObject({ code: "COMMISSION_SETTLEMENT_DISABLED" });
    const enabled = await recognized(true);
    await execute("commission.approve", {
      commissionId: enabled.commissionId,
      version: 1,
      reason: "Approve manual entitlement",
    });
    await execute("commission.settlement.record", {
      commissionId: enabled.commissionId,
      version: 2,
      externalReference: "synthetic-manual-owner-approved-record",
      reason: "Manual external settlement attested",
    });
    expect(
      await db
        .prepare(
          "SELECT amount_minor,status FROM commission_settlements WHERE commission_id=?",
        )
        .bind(enabled.commissionId)
        .first(),
    ).toMatchObject({ amount_minor: 1250, status: "RECORDED" });
    expect(await adminCommissionOverview(db, staff)).toMatchObject({
      automaticPaymentsEnabled: false,
      settlementMode: "MANUAL_TRACKING_ONLY",
    });
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payments")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
});
