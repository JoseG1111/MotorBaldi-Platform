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

type BillingActor = Principal & { personId: string };

/** Advance one UTC calendar period, clamping the day to the destination month. */
export function billingPeriodEnd(start: string, cadence: "MONTHLY" | "ANNUAL") {
  const date = new Date(start);
  if (!Number.isFinite(date.getTime()))
    throw new Problem(400, "INVALID_BILLING_DATE", "Invalid billing date");
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + (cadence === "MONTHLY" ? 1 : 12));
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

const id = z.string().uuid();
const version = z.number().int().positive();
const timestamp = z.iso.datetime({ precision: 3 });
const reason = z.string().trim().min(5).max(1000);
export const billingCommandInputs = {
  "billing.subscription.create": z
    .object({
      planCode: z.enum(["ACOMPANAMIENTO_MONTHLY", "ACOMPANAMIENTO_ANNUAL"]),
    })
    .strict(),
  "billing.subscription.cancel": z
    .object({ subscriptionId: id, version })
    .strict(),
  "billing.vehicle.add": z
    .object({ subscriptionId: id, version, vehicleId: id })
    .strict(),
  "billing.vehicle.remove": z
    .object({ subscriptionId: id, version, vehicleId: id })
    .strict(),
  "billing.admin.grant": z
    .object({
      subscriptionId: id,
      version,
      startsAt: timestamp,
      endsAt: timestamp,
      reason,
    })
    .strict()
    .refine(
      (v) => v.endsAt > v.startsAt && v.endsAt > utcNow(),
      "Grant must have a future end after its start",
    ),
  "billing.admin.suspend": z
    .object({ subscriptionId: id, version, reason })
    .strict(),
} as const;
export type BillingOperation = keyof typeof billingCommandInputs;

export function parseBillingCommand(
  operation: string,
  request: Json,
): Record<string, Json> {
  const schema = billingCommandInputs[operation as BillingOperation];
  if (!schema)
    throw new Problem(
      400,
      "UNKNOWN_BILLING_OPERATION",
      "Unknown billing operation",
    );
  const parsed = schema.safeParse(request);
  if (!parsed.success)
    throw new Problem(
      400,
      "INVALID_BILLING_COMMAND",
      "Invalid billing command",
    );
  return parsed.data;
}

async function requireActiveAccount(db: D1Database, actor: BillingActor) {
  const row = await db
    .prepare(
      "SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
    )
    .bind(actor.accountId, actor.personId)
    .first();
  if (!row)
    throw new Problem(
      403,
      "BILLING_ACCOUNT_UNAVAILABLE",
      "Billing account unavailable",
    );
}

export async function authorizeBillingCommand(
  db: D1Database,
  actor: BillingActor,
  operation: BillingOperation,
  body: Record<string, Json>,
) {
  await requireActiveAccount(db, actor);
  if (operation.startsWith("billing.admin.")) {
    await requirePlatformPermission(db, actor, "platform.billing.manage", {
      mfa: true,
    });
    const target = await db
      .prepare(
        "SELECT 1 FROM billing_subscriptions s JOIN iam_accounts a ON a.id=s.account_id JOIN iam_people p ON p.id=a.person_id WHERE s.id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
      )
      .bind(String(body.subscriptionId))
      .first();
    if (!target)
      throw new Problem(
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription unavailable",
      );
  } else if (operation !== "billing.subscription.create") {
    const subscription = await db
      .prepare(
        "SELECT 1 FROM billing_subscriptions WHERE id=? AND account_id=?",
      )
      .bind(String(body.subscriptionId), actor.accountId)
      .first();
    if (!subscription)
      throw new Problem(
        404,
        "SUBSCRIPTION_NOT_FOUND",
        "Subscription unavailable",
      );
  }
  if (
    operation === "billing.vehicle.add" ||
    operation === "billing.vehicle.remove"
  ) {
    if (
      !(await hasVehiclePermission(
        db,
        actor,
        String(body.vehicleId),
        "vehicle.read",
      ))
    )
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle unavailable");
  }
}

export const billingEventRegistry: EventRegistry = new Map([
  [
    "billing.subscription.changed.v1:1",
    {
      aggregateType: "billing",
      version: 1,
      payload: z.object({ subscriptionId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);

/** Direct or exact organization/location vehicle.read grants; garage/claims never confer access. */
const vehicleReadPredicate = `EXISTS (
 SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id
 WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE'
 AND EXISTS (SELECT 1 FROM vehicle_access_grants g WHERE g.vehicle_id=? AND g.permission_code='vehicle.read'
 AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.revoked_at IS NULL
 AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND (g.person_id=p.id OR (g.organization_id IS NOT NULL AND EXISTS (
 SELECT 1 FROM org_memberships m JOIN org_organizations o ON o.id=m.organization_id
 WHERE m.person_id=p.id AND m.organization_id=g.organization_id AND m.status='ACTIVE' AND o.status='ACTIVE'
 AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 AND (g.location_id IS NULL OR (m.location_scope_type='ALL_LOCATIONS' AND EXISTS(SELECT 1 FROM org_locations l WHERE l.id=g.location_id AND l.organization_id=g.organization_id AND l.status='ACTIVE'))
 OR EXISTS(SELECT 1 FROM org_membership_locations ml JOIN org_locations l ON l.id=ml.location_id AND l.organization_id=ml.organization_id WHERE ml.membership_id=m.id AND ml.organization_id=m.organization_id AND ml.location_id=g.location_id AND l.status='ACTIVE'))
 )))) )`;

const activeActorPredicate = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE')`;
const adminPermissionPredicate = `EXISTS(SELECT 1 FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id AND r.scope='PLATFORM' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE pr.person_id=? AND rp.permission_code='platform.billing.manage')`;

function casAudit(
  db: D1Database,
  actor: BillingActor,
  subscriptionId: string,
  operation: string,
  requestId: string,
  note: string | null,
) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason) VALUES(?,?,?,'billing_subscription',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)",
    )
    .bind(newId(), actor.accountId, operation, subscriptionId, requestId, note);
}

export async function prepareBillingCommand(
  db: D1Database,
  actor: BillingActor,
  operation: BillingOperation,
  request: Record<string, Json>,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = parseBillingCommand(operation, request);
  await authorizeBillingCommand(db, actor, operation, body);
  const now = utcNow();
  const subscriptionId =
    operation === "billing.subscription.create"
      ? newId()
      : String(body.subscriptionId);
  const statements: D1PreparedStatement[] = [];
  let response: Record<string, Json> = {
    subscriptionId,
    version: Number(body.version) + 1,
  };
  const note = typeof body.reason === "string" ? body.reason : null;
  if (operation === "billing.subscription.create") {
    const plan = await db
      .prepare("SELECT * FROM billing_plans WHERE code=? AND active=1")
      .bind(String(body.planCode))
      .first<{
        code: string;
        period: "MONTH" | "YEAR";
        amount_minor: number;
        currency: string;
      }>();
    if (!plan)
      throw new Problem(404, "BILLING_PLAN_UNAVAILABLE", "Plan unavailable");
    const periodId = newId();
    const endsAt = billingPeriodEnd(
      now,
      plan.period === "MONTH" ? "MONTHLY" : "ANNUAL",
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO billing_subscriptions(id,account_id,plan_code) SELECT ?,?,p.code FROM billing_plans p WHERE p.code=? AND p.active=1 AND p.period=? AND ${activeActorPredicate}`,
        )
        .bind(
          subscriptionId,
          actor.accountId,
          plan.code,
          plan.period,
          actor.accountId,
          actor.personId,
        ),
    );
    statements.push(
      casAudit(db, actor, subscriptionId, operation, requestId, note),
    );
    // Snapshot the server-side price in the transaction; clients cannot submit an amount.
    statements.push(
      db
        .prepare(
          "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) SELECT ?,s.id,1,?,?,p.amount_minor,p.currency FROM billing_subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.id=?",
        )
        .bind(periodId, now, endsAt, subscriptionId),
    );
    response = {
      subscriptionId,
      periodId,
      status: "PENDING_ACTIVATION",
      version: 1,
      checkoutAvailable: false,
    };
  } else {
    const admin = operation.startsWith("billing.admin.");
    const owner = admin
      ? `EXISTS(SELECT 1 FROM iam_accounts target JOIN iam_people tp ON tp.id=target.person_id WHERE target.id=billing_subscriptions.account_id AND target.status='ACTIVE' AND tp.status='ACTIVE') AND ${adminPermissionPredicate}`
      : "account_id=?";
    const ownershipBindings = admin ? [actor.personId] : [actor.accountId];
    let change = "version=version+1,updated_at=?";
    const bindings: (string | number)[] = [now];
    let eligibility = "";
    if (operation === "billing.subscription.cancel") {
      change +=
        ",auto_renew=0,cancel_at_period_end=1,status=CASE WHEN status='PENDING_ACTIVATION' THEN 'CANCELLED' ELSE status END";
      eligibility = " AND status NOT IN ('SUSPENDED','EXPIRED')";
    } else if (operation === "billing.admin.suspend") {
      change += ",status='SUSPENDED',auto_renew=0";
    } else if (operation === "billing.admin.grant") {
      // Insert the explicit evidence before activation; it is rolled back if the CAS fails.
      statements.push(
        db
          .prepare(
            `INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) SELECT ?,id,?,?,?,? FROM billing_subscriptions WHERE id=? AND version=? AND ${activeActorPredicate} AND ${adminPermissionPredicate}`,
          )
          .bind(
            newId(),
            String(body.startsAt),
            String(body.endsAt),
            actor.accountId,
            note,
            subscriptionId,
            Number(body.version),
            actor.accountId,
            actor.personId,
            actor.personId,
          ),
      );
      change +=
        ",status='ACTIVE',current_period_start=?,current_period_end=?,auto_renew=0,cancel_at_period_end=0";
      bindings.push(String(body.startsAt), String(body.endsAt));
    } else {
      eligibility = " AND status NOT IN ('SUSPENDED','EXPIRED','CANCELLED')";
    }
    statements.push(
      db
        .prepare(
          `UPDATE billing_subscriptions SET ${change} WHERE id=? AND version=? AND ${owner} AND ${activeActorPredicate}${eligibility}`,
        )
        .bind(
          ...bindings,
          subscriptionId,
          Number(body.version),
          ...ownershipBindings,
          actor.accountId,
          actor.personId,
        ),
    );
    statements.push(
      casAudit(db, actor, subscriptionId, operation, requestId, note),
    );
    if (operation === "billing.vehicle.add")
      statements.push(
        db
          .prepare(
            `INSERT INTO billing_membership_vehicles(id,subscription_id,vehicle_id) SELECT ?,?,? WHERE ${vehicleReadPredicate}`,
          )
          .bind(
            newId(),
            subscriptionId,
            String(body.vehicleId),
            actor.accountId,
            actor.personId,
            String(body.vehicleId),
          ),
      );
    if (operation === "billing.vehicle.remove")
      statements.push(
        db
          .prepare(
            `UPDATE billing_membership_vehicles SET removed_at=? WHERE subscription_id=? AND vehicle_id=? AND removed_at IS NULL AND ${vehicleReadPredicate}`,
          )
          .bind(
            now,
            subscriptionId,
            String(body.vehicleId),
            actor.accountId,
            actor.personId,
            String(body.vehicleId),
          ),
      );
  }
  // Audit is the immediately previous successful insert for simple CAS-only commands;
  // vehicle commands and creation guard the immediately preceding domain insert/update.
  statements.push(
    db
      .prepare(
        "INSERT INTO billing_financial_events(id,domain,aggregate_id,event_type,actor_account_id,request_id,data_json) VALUES(?,'SUBSCRIPTION',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?,?)",
      )
      .bind(
        newId(),
        subscriptionId,
        operation,
        actor.accountId,
        requestId,
        JSON.stringify({ subscriptionId }),
      ),
  );
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "billing",
        aggregateId: subscriptionId,
        eventType: "billing.subscription.changed.v1",
        eventVersion: 1,
        payload: { subscriptionId },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      billingEventRegistry,
    ).statement,
  );
  return {
    statements,
    response,
    recover: async (error) => {
      const message = String(error);
      if (message.includes("MEMBERSHIP_VEHICLE_LIMIT"))
        throw new Problem(
          409,
          "MEMBERSHIP_VEHICLE_LIMIT",
          "Membership vehicle limit reached",
        );
      if (
        message.includes("constraint failed") ||
        message.includes("SUBSCRIPTION_")
      )
        throw new Problem(
          409,
          "BILLING_COMMAND_CONFLICT",
          "Billing state changed; refresh and retry",
        );
      return null;
    },
    guard: {
      table: "billing_financial_events",
      column: "aggregate_id",
      code: "BILLING_COMMAND_CONFLICT",
      message: "Billing state changed; refresh and retry",
    },
  };
}

export async function listPlans(db: D1Database) {
  return (
    await db
      .prepare(
        "SELECT code,name,period,amount_minor,currency,vehicle_limit FROM billing_plans WHERE active=1 ORDER BY amount_minor",
      )
      .all()
  ).results;
}

const benefitDefinitions = [
  ["support_whatsapp", "Soporte por WhatsApp"],
  ["history_enhanced", "Historial mejorado"],
  ["maintenance_reminders", "Recordatorios de mantenimiento"],
  ["workshop_assistance", "Acompañamiento con talleres"],
  ["service_assistance", "Acompañamiento en servicios"],
  ["service_followup", "Seguimiento de servicios"],
  ["expenses", "Control de gastos"],
  ["partner_benefits", "Beneficios de aliados"],
] as const;

export async function membershipOverview(db: D1Database, actor: BillingActor) {
  await requireActiveAccount(db, actor);
  const subscriptions = (
    await db
      .prepare(
        "SELECT s.*,p.vehicle_limit FROM billing_subscriptions s JOIN billing_plans p ON p.code=s.plan_code WHERE s.account_id=? ORDER BY s.created_at DESC,s.id DESC",
      )
      .bind(actor.accountId)
      .all<{
        id: string;
        status: string;
        vehicle_limit: number;
        [key: string]: string | number | null;
      }>()
  ).results;
  const subscription =
    subscriptions.find(
      (s) => s.status !== "EXPIRED" && s.status !== "CANCELLED",
    ) ??
    subscriptions[0] ??
    null;
  let premium = false;
  const vehicles: { vehicle_id: string }[] = [];
  if (subscription) {
    const now = utcNow();
    if (!["SUSPENDED", "EXPIRED"].includes(subscription.status)) {
      const evidence = await db
        .prepare(
          `SELECT 1 FROM billing_subscriptions s WHERE s.id=? AND (
      EXISTS(SELECT 1 FROM billing_admin_grants g WHERE g.subscription_id=s.id AND g.starts_at<=? AND g.ends_at>?)
      OR EXISTS(SELECT 1 FROM billing_periods p WHERE p.subscription_id=s.id AND p.status='PAID' AND p.starts_at<=? AND p.ends_at>?
        AND EXISTS(SELECT 1 FROM billing_payments pay JOIN billing_payment_confirmations c ON c.payment_id=pay.id WHERE pay.period_id=p.id AND pay.status='APPROVED' AND c.amount_minor=p.amount_minor AND c.currency=p.currency AND c.provider_environment=pay.provider_environment AND c.provider_transaction_id=pay.provider_transaction_id))
      )`,
        )
        .bind(subscription.id, now, now, now, now)
        .first();
      premium = !!evidence;
    }
    const selected = (
      await db
        .prepare(
          "SELECT vehicle_id FROM billing_membership_vehicles WHERE subscription_id=? AND removed_at IS NULL ORDER BY added_at,id",
        )
        .bind(subscription.id)
        .all<{ vehicle_id: string }>()
    ).results;
    for (const vehicle of selected)
      if (
        await hasVehiclePermission(
          db,
          actor,
          vehicle.vehicle_id,
          "vehicle.read",
        )
      )
        vehicles.push(vehicle);
  }
  return {
    subscription,
    premium,
    vehicleLimit: subscription?.vehicle_limit ?? 2,
    vehicles,
    entitlements: premium ? benefitDefinitions.map(([code]) => code) : [],
    benefits: [
      ...benefitDefinitions,
      ["preventive_recommendations", "Recomendaciones preventivas"],
      ["monthly_summaries", "Resúmenes mensuales"],
      ["parts_assistance", "Acompañamiento en repuestos"],
      ["future_vehicle_feature", "Funciones futuras del vehículo"],
    ].map(([code, label]) => ({
      code,
      label,
      available: false,
    })),
    checkoutAvailable: false,
  };
}

export async function adminBillingOverview(
  db: D1Database,
  actor: BillingActor,
) {
  await requireActiveAccount(db, actor);
  await requirePlatformPermission(db, actor, "platform.billing.read", {
    mfa: true,
  });
  const subscriptions = (
    await db
      .prepare(
        "SELECT * FROM billing_subscriptions ORDER BY created_at DESC,id DESC LIMIT 100",
      )
      .all()
  ).results;
  const payments = (
    await db
      .prepare(
        "SELECT id,period_id,amount_minor,currency,reference,provider_environment,status,created_at,updated_at,version FROM billing_payments ORDER BY created_at DESC,id DESC LIMIT 100",
      )
      .all()
  ).results;
  const policies = await db
    .prepare(
      "SELECT production_approved,tax_approved,refund_approved,recurring_approved,vehicle_limit_approved,grace_seconds,automatic_retries,version FROM billing_policies WHERE singleton=1",
    )
    .first();
  return { subscriptions, payments, policies };
}
