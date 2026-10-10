import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import { requirePlatformPermission } from "@motorbaldi/authz";
import { hasVehiclePermission } from "@motorbaldi/vehicles";
import {
  outboxStatement,
  type EventRegistry,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";

export type CommissionRoundingMode = "FLOOR" | "CEIL" | "HALF_UP";

/** All multiplication happens in BigInt; the contract explicitly chooses rounding. */
export function calculateCommissionMinor(
  baseMinor: number,
  basisPoints: number,
  roundingMode: CommissionRoundingMode,
): number {
  if (
    !Number.isSafeInteger(baseMinor) ||
    baseMinor < 0 ||
    !Number.isSafeInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000 ||
    !["FLOOR", "CEIL", "HALF_UP"].includes(roundingMode)
  )
    throw new Problem(
      400,
      "INVALID_COMMISSION_MONEY",
      "Invalid commission calculation inputs",
    );
  const numerator = BigInt(baseMinor) * BigInt(basisPoints);
  const denominator = 10000n;
  let amount = numerator / denominator;
  const remainder = numerator % denominator;
  if (
    (roundingMode === "CEIL" && remainder > 0n) ||
    (roundingMode === "HALF_UP" && remainder * 2n >= denominator)
  )
    amount += 1n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Problem(
      400,
      "COMMISSION_MONEY_OVERFLOW",
      "Commission amount exceeds safe money precision",
    );
  return Number(amount);
}

const id = z.string().uuid();
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const version = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
const reason = z.string().trim().min(5).max(1000);
const rules = z.record(z.string().max(80), z.json());
const ruleInput = z
  .object({
    serviceCode: z.string().trim().min(1).max(80),
    calculation: z.enum(["PERCENTAGE", "FIXED"]),
    basisPoints: z.number().int().min(0).max(10000).optional(),
    fixedMinor: minor.optional(),
    currency: z.literal("COP"),
    rounding: z.enum(["FLOOR", "CEIL", "HALF_UP"]),
  })
  .strict()
  .refine((v) =>
    v.calculation === "PERCENTAGE"
      ? v.basisPoints !== undefined && v.fixedMinor === undefined
      : v.fixedMinor !== undefined && v.basisPoints === undefined,
  );
export const commissionCommandInputs = {
  "commission.agreement.create": z
    .object({
      organizationId: id,
      agreementVersion: version,
      validFrom: z.iso.datetime(),
      validUntil: z.iso.datetime().nullable(),
      settlementRulesJson: rules.optional(),
      rules: z.array(ruleInput).min(1).max(40),
      reason,
    })
    .strict()
    .refine(
      (v) =>
        (!v.validUntil || v.validUntil > v.validFrom) &&
        new Set(v.rules.map((r) => r.serviceCode)).size === v.rules.length,
    ),
  "commission.agreement.approve": z
    .object({
      agreementId: id,
      version,
      settlementApproved: z.boolean(),
      reason,
    })
    .strict(),
  "commission.consent.record": z
    .object({
      orderId: id,
      agreementId: id,
      status: z.enum(["GRANTED", "REVOKED"]),
      policyVersion: z.string().trim().min(1).max(64),
    })
    .strict(),
  "commission.referral.create": z
    .object({
      agreementId: id,
      orderId: id,
      customerAccountId: id,
      consentEventId: id,
      serviceCode: z.string().trim().min(1).max(80),
      reason,
    })
    .strict(),
  "commission.recognize": z
    .object({
      referralId: id,
      ruleId: id,
      baseMinor: minor,
      evidenceReference: z.string().trim().min(5).max(500),
      reason,
    })
    .strict(),
  "commission.approve": z
    .object({ commissionId: id, version, reason })
    .strict(),
  "commission.adjust": z
    .object({
      commissionId: id,
      version,
      amountMinor: z
        .number()
        .int()
        .min(-Number.MAX_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER)
        .refine((v) => v !== 0),
      kind: z.enum(["ADJUSTMENT", "REVERSAL"]),
      reason,
    })
    .strict(),
  "commission.settlement.record": z
    .object({
      commissionId: id,
      version,
      externalReference: z.string().trim().min(5).max(160),
      reason,
    })
    .strict(),
  "commission.dispute": z
    .object({ commissionId: id, version, reason })
    .strict(),
  "commission.settlement.reconcile": z
    .object({
      settlementId: id,
      status: z.enum(["RECONCILED", "DISPUTED"]),
      reason,
    })
    .strict(),
} as const;
export type CommissionOperation = keyof typeof commissionCommandInputs;
export type CommissionActor = Principal & { personId: string };
export function parseCommissionCommand(
  operation: string,
  input: unknown,
): Record<string, Json> {
  const schema = commissionCommandInputs[operation as CommissionOperation];
  if (!schema)
    throw new Problem(
      400,
      "UNKNOWN_COMMISSION_OPERATION",
      "Unknown commission operation",
    );
  const parsed = schema.parse(input) as Record<string, Json>;
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 16000)
    throw new Problem(
      400,
      "COMMISSION_INPUT_TOO_LARGE",
      "Commission terms exceed bounds",
    );
  return parsed;
}
async function activeActor(db: D1Database, actor: CommissionActor) {
  const active = await db
    .prepare(
      "SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
    )
    .bind(actor.accountId, actor.personId)
    .first();
  if (!active) throw new Problem(403, "FORBIDDEN", "Active account required");
}
type Agreement = {
  id: string;
  organization_id: string;
  status: string;
  valid_from: string;
  valid_until: string | null;
  settlement_approved: number;
  settlement_rules_json: string;
  version: number;
};
type Order = {
  id: string;
  vehicle_id: string;
  organization_id: string;
  location_id: string;
  status: string;
  final_record_id: string | null;
};
async function one<T>(
  db: D1Database,
  sql: string,
  ...values: (string | number)[]
): Promise<T> {
  const row = await db
    .prepare(sql)
    .bind(...values)
    .first<T>();
  if (!row)
    throw new Problem(
      404,
      "COMMISSION_NOT_FOUND",
      "Commission resource not found",
    );
  return row;
}
async function agreement(db: D1Database, agreementId: string) {
  return one<Agreement>(
    db,
    "SELECT * FROM commission_agreements WHERE id=?",
    agreementId,
  );
}
async function order(db: D1Database, orderId: string) {
  return one<Order>(db, "SELECT * FROM workshop_orders WHERE id=?", orderId);
}
export async function authorizeCommissionCommand(
  db: D1Database,
  actor: CommissionActor,
  operation: CommissionOperation,
  body: Record<string, Json>,
) {
  await activeActor(db, actor);
  if (operation === "commission.consent.record") {
    const partner = await agreement(db, String(body.agreementId));
    const work = await order(db, String(body.orderId));
    if (
      partner.organization_id !== work.organization_id ||
      !(await hasVehiclePermission(db, actor, work.vehicle_id, "vehicle.read"))
    )
      throw new Problem(
        403,
        "FORBIDDEN",
        "Customer vehicle access and partner order required",
      );
  } else
    await requirePlatformPermission(db, actor, "platform.commission.manage", {
      mfa: true,
    });
}
async function consent(
  db: D1Database,
  consentEventId: string,
  accountId: string,
  orderId: string,
  agreementId: string,
) {
  const latest = await db
    .prepare(
      "SELECT id,status FROM commission_consent_events WHERE account_id=? AND order_id=? AND agreement_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(accountId, orderId, agreementId)
    .first<{ id: string; status: string }>();
  if (!latest || latest.id !== consentEventId || latest.status !== "GRANTED")
    throw new Problem(
      409,
      "COMMISSION_CONSENT_REQUIRED",
      "Current explicit customer consent required",
    );
  const customer = await one<{ person_id: string }>(
    db,
    "SELECT a.person_id FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
    accountId,
  );
  const work = await order(db, orderId);
  if (
    !(await hasVehiclePermission(
      db,
      { accountId, personId: customer.person_id },
      work.vehicle_id,
      "vehicle.read",
    ))
  )
    throw new Problem(
      403,
      "COMMISSION_CUSTOMER_BOUNDARY",
      "Customer vehicle access required",
    );
}
export const commissionEventContracts: EventRegistry = new Map([
  [
    "commission.changed.v1:1",
    {
      aggregateType: "commission",
      version: 1,
      payload: z
        .object({
          id,
          operation: z.enum(
            Object.keys(commissionCommandInputs) as [
              CommissionOperation,
              ...CommissionOperation[],
            ],
          ),
        })
        .strict(),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
type Entry = {
  id: string;
  amount_minor: number;
  status: string;
  version: number;
  agreement_id: string;
  currency: string;
  organization_id: string;
  settlement_approved: number;
  settlement_rules_json: string;
  agreement_status: string;
};
async function entry(db: D1Database, entryId: string) {
  return one<Entry>(
    db,
    `SELECT e.*,r.agreement_id,a.organization_id,a.settlement_approved,a.settlement_rules_json,a.status AS agreement_status FROM commission_entries e JOIN commission_referrals r ON r.id=e.referral_id JOIN commission_agreements a ON a.id=r.agreement_id WHERE e.id=?`,
    entryId,
  );
}
async function remaining(db: D1Database, value: Entry): Promise<number> {
  const changes = await db
    .prepare(
      "SELECT amount_minor FROM commission_adjustments WHERE commission_id=?",
    )
    .bind(value.id)
    .all<{ amount_minor: number }>();
  const total = changes.results.reduce(
    (sum, row) => sum + BigInt(row.amount_minor),
    BigInt(value.amount_minor),
  );
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Problem(
      409,
      "COMMISSION_MONEY_OVERFLOW",
      "Commission balance exceeds safe bounds",
    );
  return Number(total);
}

export async function prepareCommissionCommand(
  db: D1Database,
  actor: CommissionActor,
  operation: CommissionOperation,
  input: Record<string, Json>,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = parseCommissionCommand(operation, input);
  await authorizeCommissionCommand(db, actor, operation, body);
  const statements: D1PreparedStatement[] = [];
  let resourceId = newId();
  let organizationId: string | null = null;
  let nextVersion = 1;
  let response: Record<string, Json> = {};
  const now = utcNow();
  if (operation === "commission.agreement.create") {
    organizationId = String(body.organizationId);
    await one(
      db,
      "SELECT id FROM org_organizations WHERE id=? AND status='ACTIVE'",
      organizationId,
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO commission_agreements(id,organization_id,agreement_version,valid_from,valid_until,settlement_rules_json) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          resourceId,
          organizationId,
          body.agreementVersion,
          body.validFrom,
          body.validUntil,
          JSON.stringify(body.settlementRulesJson ?? {}),
        ),
    );
    for (const rule of body.rules as Record<string, Json>[])
      statements.push(
        db
          .prepare(
            "INSERT INTO commission_rules(id,agreement_id,service_code,calculation,basis_points,fixed_minor,currency,rounding) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            newId(),
            resourceId,
            rule.serviceCode,
            rule.calculation,
            rule.basisPoints ?? null,
            rule.fixedMinor ?? null,
            rule.currency,
            rule.rounding,
          ),
      );
  } else if (operation === "commission.agreement.approve") {
    const value = await agreement(db, String(body.agreementId));
    if (value.status !== "DRAFT")
      throw new Problem(
        409,
        "COMMISSION_AGREEMENT_IMMUTABLE",
        "Only draft agreement may be approved",
      );
    if (
      body.settlementApproved &&
      Object.keys(JSON.parse(value.settlement_rules_json) as object).length ===
        0
    )
      throw new Problem(
        409,
        "COMMISSION_SETTLEMENT_TERMS_REQUIRED",
        "Explicit settlement rules required",
      );
    resourceId = value.id;
    organizationId = value.organization_id;
    nextVersion = Number(body.version) + 1;
    statements.push(
      db
        .prepare(
          "UPDATE commission_agreements SET status='APPROVED',settlement_approved=?,approved_by_account_id=?,approved_at=?,version=version+1 WHERE id=? AND version=? AND status='DRAFT'",
        )
        .bind(
          body.settlementApproved ? 1 : 0,
          actor.accountId,
          now,
          resourceId,
          body.version,
        ),
    );
  } else if (operation === "commission.consent.record") {
    const partner = await agreement(db, String(body.agreementId));
    organizationId = partner.organization_id;
    statements.push(
      db
        .prepare(
          "INSERT INTO commission_consent_events(id,account_id,order_id,agreement_id,status,policy_version,request_id) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          resourceId,
          actor.accountId,
          body.orderId,
          body.agreementId,
          body.status,
          body.policyVersion,
          requestId,
        ),
    );
  } else if (operation === "commission.referral.create") {
    const partner = await agreement(db, String(body.agreementId));
    const work = await order(db, String(body.orderId));
    organizationId = partner.organization_id;
    if (
      partner.status !== "APPROVED" ||
      work.organization_id !== partner.organization_id
    )
      throw new Problem(
        409,
        "COMMISSION_AGREEMENT_REQUIRED",
        "Approved partner-specific agreement required",
      );
    await one(
      db,
      "SELECT id FROM commission_rules WHERE agreement_id=? AND service_code=?",
      partner.id,
      String(body.serviceCode),
    );
    await consent(
      db,
      String(body.consentEventId),
      String(body.customerAccountId),
      work.id,
      partner.id,
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO commission_referrals(id,agreement_id,order_id,customer_account_id,consent_event_id,service_code,attributed_by_account_id) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          resourceId,
          partner.id,
          work.id,
          body.customerAccountId,
          body.consentEventId,
          body.serviceCode,
          actor.accountId,
        ),
    );
  } else if (operation === "commission.recognize") {
    const referral = await one<{
      agreement_id: string;
      order_id: string;
      customer_account_id: string;
      consent_event_id: string;
      service_code: string;
    }>(
      db,
      "SELECT * FROM commission_referrals WHERE id=?",
      String(body.referralId),
    );
    const partner = await agreement(db, referral.agreement_id);
    const work = await order(db, referral.order_id);
    organizationId = partner.organization_id;
    await consent(
      db,
      referral.consent_event_id,
      referral.customer_account_id,
      work.id,
      partner.id,
    );
    const rule = await one<{
      calculation: string;
      basis_points: number | null;
      fixed_minor: number | null;
      rounding: CommissionRoundingMode;
      currency: string;
    }>(
      db,
      "SELECT * FROM commission_rules WHERE id=? AND agreement_id=? AND service_code=?",
      String(body.ruleId),
      partner.id,
      referral.service_code,
    );
    if (
      !["COMPLETED", "CLOSED"].includes(work.status) ||
      !work.final_record_id ||
      partner.status !== "APPROVED" ||
      work.organization_id !== partner.organization_id
    )
      throw new Problem(
        409,
        "COMMISSION_COMPLETED_SERVICE_REQUIRED",
        "Completed partner service and final record required",
      );
    const record = await one<{ finalized_at: string | null }>(
      db,
      "SELECT finalized_at FROM vehicle_professional_records WHERE id=? AND status='FINAL' AND vehicle_id=? AND organization_id=? AND location_id=?",
      work.final_record_id,
      work.vehicle_id,
      work.organization_id,
      work.location_id,
    );
    if (
      !record.finalized_at ||
      record.finalized_at < partner.valid_from ||
      (partner.valid_until && record.finalized_at >= partner.valid_until)
    )
      throw new Problem(
        409,
        "COMMISSION_AGREEMENT_OUTSIDE_VALIDITY",
        "Agreement must cover actual service completion",
      );
    const amount =
      rule.calculation === "PERCENTAGE"
        ? calculateCommissionMinor(
            Number(body.baseMinor),
            rule.basis_points!,
            rule.rounding,
          )
        : rule.fixed_minor!;
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new Problem(
        409,
        "COMMISSION_MONEY_OVERFLOW",
        "Invalid commission amount",
      );
    statements.push(
      db
        .prepare(
          "INSERT INTO commission_entries(id,referral_id,rule_id,base_minor,amount_minor,currency,completion_record_id,evidence_reference) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          resourceId,
          body.referralId,
          body.ruleId,
          body.baseMinor,
          amount,
          rule.currency,
          work.final_record_id,
          body.evidenceReference,
        ),
    );
    response.amountMinor = amount;
  } else if (operation === "commission.settlement.reconcile") {
    const settlement = await one<{
      id: string;
      commission_id: string;
      status: string;
    }>(
      db,
      "SELECT id,commission_id,status FROM commission_settlements WHERE id=?",
      String(body.settlementId),
    );
    const value = await entry(db, settlement.commission_id);
    if (body.status === "RECONCILED" && value.status !== "SETTLED")
      throw new Problem(
        409,
        "COMMISSION_INVALID_STATE",
        "Only an undisputed settled commission may be reconciled",
      );
    if (
      body.status === "DISPUTED" &&
      !["PENDING_APPROVAL", "APPROVED", "SETTLED", "DISPUTED"].includes(
        value.status,
      )
    )
      throw new Problem(
        409,
        "COMMISSION_INVALID_STATE",
        "Commission cannot enter dispute from current state",
      );
    if (!(
      settlement.status === "RECORDED" ||
      (settlement.status === "RECONCILED" && body.status === "DISPUTED")
    ))
      throw new Problem(
        409,
        "COMMISSION_INVALID_STATE",
        "Settlement reconciliation transition is not available",
      );
    resourceId = value.id;
    organizationId = value.organization_id;
    nextVersion = value.version;
    statements.push(
      db
        .prepare(
          "UPDATE commission_settlements SET status=? WHERE id=? AND status=?",
        )
        .bind(body.status, settlement.id, settlement.status),
    );
    statements.push(
      casReceipt(
        db,
        actor,
        operation,
        resourceId,
        requestId,
        String(body.reason),
        organizationId,
      ),
    );
    if (body.status === "DISPUTED" && value.status !== "DISPUTED") {
      statements.push(
        db
          .prepare(
            "UPDATE commission_entries SET status='DISPUTED',version=version+1 WHERE id=? AND version=? AND status=?",
          )
          .bind(value.id, value.version, value.status),
      );
      statements.push(
        casReceipt(
          db,
          actor,
          operation,
          resourceId,
          requestId,
          String(body.reason),
          organizationId,
        ),
      );
      nextVersion++;
    }
    response.settlementId = settlement.id;
    response.settlementStatus = String(body.status);
  } else {
    const value = await entry(db, String(body.commissionId));
    resourceId = value.id;
    organizationId = value.organization_id;
    nextVersion = Number(body.version) + 1;
    const balance = await remaining(db, value);
    if (operation === "commission.approve") {
      if (!["PENDING_APPROVAL", "DISPUTED"].includes(value.status))
        throw new Problem(
          409,
          "COMMISSION_INVALID_STATE",
          "Pending commission approval required",
        );
      statements.push(
        db
          .prepare(
            "UPDATE commission_entries SET status='APPROVED',approved_by_account_id=?,version=version+1 WHERE id=? AND version=? AND status=?",
          )
          .bind(actor.accountId, resourceId, body.version, value.status),
      );
    } else if (operation === "commission.dispute") {
      if (!["PENDING_APPROVAL", "APPROVED", "SETTLED"].includes(value.status))
        throw new Problem(
          409,
          "COMMISSION_INVALID_STATE",
          "Commission cannot enter dispute from current state",
        );
      statements.push(
        db
          .prepare(
            "UPDATE commission_entries SET status='DISPUTED',version=version+1 WHERE id=? AND version=? AND status=?",
          )
          .bind(resourceId, body.version, value.status),
      );
      statements.push(
        casReceipt(
          db,
          actor,
          operation,
          resourceId,
          requestId,
          String(body.reason),
          organizationId,
        ),
      );
      statements.push(
        db
          .prepare(
            "UPDATE commission_settlements SET status='DISPUTED' WHERE commission_id=? AND status IN ('RECORDED','RECONCILED')",
          )
          .bind(resourceId),
      );
    } else if (operation === "commission.adjust") {
      if (["REVERSED", "SETTLED"].includes(value.status))
        throw new Problem(
          409,
          "COMMISSION_INVALID_STATE",
          "Settled or reversed commission cannot be adjusted",
        );
      const delta = BigInt(Number(body.amountMinor));
      const adjusted = BigInt(balance) + delta;
      if (adjusted < 0n || adjusted > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Problem(
          409,
          "COMMISSION_MONEY_OVERFLOW",
          "Adjusted commission balance exceeds bounds",
        );
      if (
        body.kind === "REVERSAL" &&
        (delta >= 0n || delta !== -BigInt(balance))
      )
        throw new Problem(
          409,
          "COMMISSION_FULL_REVERSAL_REQUIRED",
          "Reversal must negate full remaining commission",
        );
      statements.push(
        db
          .prepare(
            "UPDATE commission_entries SET status=?,version=version+1 WHERE id=? AND version=? AND status=?",
          )
          .bind(
            body.kind === "REVERSAL" ? "REVERSED" : "DISPUTED",
            resourceId,
            body.version,
            value.status,
          ),
      );
      // Guard the CAS before recording the immutable adjustment.
      statements.push(
        casReceipt(
          db,
          actor,
          operation,
          resourceId,
          requestId,
          String(body.reason),
          organizationId,
        ),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO commission_adjustments(id,commission_id,amount_minor,reason,kind,actor_account_id) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            newId(),
            resourceId,
            body.amountMinor,
            body.reason,
            body.kind,
            actor.accountId,
          ),
      );
      response.amountMinor = Number(adjusted);
    } else {
      if (
        value.status !== "APPROVED" ||
        value.agreement_status !== "APPROVED" ||
        value.settlement_approved !== 1 ||
        Object.keys(JSON.parse(value.settlement_rules_json) as object)
          .length === 0
      )
        throw new Problem(
          409,
          "COMMISSION_SETTLEMENT_DISABLED",
          "Approved commission and explicit settlement terms required",
        );
      statements.push(
        db
          .prepare(
            "UPDATE commission_entries SET status='SETTLED',version=version+1 WHERE id=? AND version=? AND status='APPROVED'",
          )
          .bind(resourceId, body.version),
      );
      statements.push(
        casReceipt(
          db,
          actor,
          operation,
          resourceId,
          requestId,
          String(body.reason),
          organizationId,
        ),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO commission_settlements(id,commission_id,amount_minor,currency,external_reference,status,recorded_by_account_id) VALUES(?,?,?,?,?,'RECORDED',?)",
          )
          .bind(
            newId(),
            resourceId,
            balance,
            value.currency,
            body.externalReference,
            actor.accountId,
          ),
      );
      response.amountMinor = balance;
    }
  }
  if (
    operation !== "commission.adjust" &&
    operation !== "commission.settlement.record" &&
    operation !== "commission.dispute" &&
    operation !== "commission.settlement.reconcile"
  )
    statements.push(
      casReceipt(
        db,
        actor,
        operation,
        resourceId,
        requestId,
        typeof body.reason === "string"
          ? body.reason
          : "Customer consent recorded",
        organizationId,
      ),
    );
  response = { ...response, id: resourceId, version: nextVersion };
  statements.push(
    db
      .prepare(
        "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'COMMISSION',?,?,?,?,?)",
      )
      .bind(
        newId(),
        resourceId,
        operation,
        actor.accountId,
        requestId,
        JSON.stringify(response),
      ),
  );
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "commission",
        aggregateId: resourceId,
        eventType: "commission.changed.v1",
        eventVersion: 1,
        payload: { id: resourceId, operation },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      commissionEventContracts,
    ).statement,
  );
  return {
    statements,
    response,
    guard: {
      table: "governance_audit_events",
      column: "resource_id",
      code: "COMMISSION_VERSION_CONFLICT",
      message: "Commission state changed",
    },
  };
}
function casReceipt(
  db: D1Database,
  actor: CommissionActor,
  operation: string,
  resourceId: string,
  requestId: string,
  reason: string,
  organizationId: string | null,
) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason,organization_id) VALUES(?,?,?,'commission',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?)",
    )
    .bind(
      newId(),
      actor.accountId,
      operation,
      resourceId,
      requestId,
      reason,
      organizationId,
    );
}
export async function adminCommissionOverview(
  db: D1Database,
  actor: CommissionActor,
): Promise<Json> {
  await activeActor(db, actor);
  await requirePlatformPermission(db, actor, "platform.commission.read", {
    mfa: true,
  });
  const agreements = (
    await db
      .prepare(
        "SELECT id,organization_id,agreement_version,status,settlement_approved,version FROM commission_agreements ORDER BY id DESC LIMIT 100",
      )
      .all()
  ).results;
  const entries = (
    await db
      .prepare(
        "SELECT id,referral_id,amount_minor,currency,status,version FROM commission_entries ORDER BY id DESC LIMIT 100",
      )
      .all()
  ).results;
  return {
    agreements,
    entries,
    automaticPaymentsEnabled: false,
    settlementMode: "MANUAL_TRACKING_ONLY",
  } as Json;
}
