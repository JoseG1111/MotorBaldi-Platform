import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  commitPreparedCommand,
  commitIdempotentCommand,
  buildIdempotencyScope,
  readReplay,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import { hasVehiclePermission } from "@motorbaldi/vehicles";
import {
  billingPeriodEnd,
  parseBillingCommand,
  prepareBillingCommand,
  authorizeBillingCommand,
  membershipOverview,
  listPlans,
  adminBillingOverview,
  type BillingOperation,
} from "../../packages/payments/src/billing.js";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import billing from "../../migrations/0012_billing_membership.sql?raw";

const db = (env as unknown as ApiBindings).DB;
type Actor = { accountId: string; personId: string; mfaEnabled: boolean };
let admin: Actor;
beforeAll(async () => {
  for (const migration of [m1, m2, m3, m4, m5, m6, m7, m8, billing])
    await db.exec(migration.replace(/\n/g, " "));
  admin = await member();
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    )
    .bind(admin.personId)
    .run();
});
async function member(): Promise<Actor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Billing Member',?,1)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  return {
    accountId,
    personId: (await ensureMotorBaldiAccount(db, accountId, newId())).personId,
    mfaEnabled: true,
  };
}
async function command(
  actor: Actor,
  operation: BillingOperation,
  body: Record<string, Json>,
  requestId = newId(),
) {
  return commitPreparedCommand(
    db,
    await prepareBillingCommand(db, actor, operation, body, requestId),
  ) as Promise<Record<string, Json>>;
}
async function subscription(actor: Actor, planCode = "ACOMPANAMIENTO_MONTHLY") {
  return (await command(actor, "billing.subscription.create", { planCode }))
    .subscriptionId as string;
}
async function vehicle(actor: Actor, grant = true) {
  const vehicleId = newId();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(vehicleId)
    .run();
  if (grant)
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
      )
      .bind(newId(), vehicleId, actor.personId, admin.accountId)
      .run();
  return vehicleId;
}
async function count(table: string, requestId: string) {
  return (await db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`)
    .bind(requestId)
    .first<{ n: number }>())!.n;
}
async function grant(
  subscriptionId: string,
  version = 1,
  startsAt = new Date(Date.now() - 1000).toISOString(),
  endsAt = new Date(Date.now() + 86400000).toISOString(),
) {
  return command(admin, "billing.admin.grant", {
    subscriptionId,
    version,
    startsAt,
    endsAt,
    reason: "Explicit administrator membership authorization",
  });
}

describe("account billing domain", () => {
  it("clamps UTC calendar month/year ends and keeps cents as server integers", async () => {
    expect(billingPeriodEnd("2024-01-31T13:14:15.000Z", "MONTHLY")).toBe(
      "2024-02-29T13:14:15.000Z",
    );
    expect(billingPeriodEnd("2023-01-31T13:14:15.000Z", "MONTHLY")).toBe(
      "2023-02-28T13:14:15.000Z",
    );
    expect(billingPeriodEnd("2024-02-29T13:14:15.000Z", "ANNUAL")).toBe(
      "2025-02-28T13:14:15.000Z",
    );
    const plans = await listPlans(db);
    expect(plans.map((p) => p.amount_minor)).toEqual([2990000, 28800000]);
    expect(() =>
      parseBillingCommand("billing.subscription.create", {
        planCode: "ACOMPANAMIENTO_MONTHLY",
        amountMinor: 1,
      }),
    ).toThrow();
    expect(() =>
      parseBillingCommand("billing.payment.confirm", { approved: true }),
    ).toThrow();
    expect(() =>
      parseBillingCommand("billing.admin.grant", {
        subscriptionId: newId(),
        version: 1,
        startsAt: "2020-01-01T00:00:00.000Z",
        endsAt: "2020-02-01T00:00:00.000Z",
        reason: "Expired grant",
      }),
    ).toThrow();
  });
  it("creates a pending snapshot without activating membership or making a payment", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor);
    const overview = await membershipOverview(db, actor);
    expect(overview).toMatchObject({
      premium: false,
      entitlements: [],
      vehicleLimit: 2,
      checkoutAvailable: false,
      subscription: {
        id: subscriptionId,
        status: "PENDING_ACTIVATION",
        auto_renew: 0,
      },
    });
    expect(
      await db
        .prepare(
          "SELECT amount_minor,currency,status FROM billing_periods WHERE subscription_id=?",
        )
        .bind(subscriptionId)
        .first(),
    ).toEqual({ amount_minor: 2990000, currency: "COP", status: "PENDING" });
    expect(
      (await db
        .prepare("SELECT count(*) AS n FROM billing_payments")
        .first<{ n: number }>())!.n,
    ).toBe(0);
    await expect(
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',version=version+1 WHERE id=?",
        )
        .bind(subscriptionId)
        .run(),
    ).rejects.toThrow("SUBSCRIPTION_PAYMENT_EVIDENCE_REQUIRED");
    await expect(
      db
        .prepare(
          "UPDATE billing_periods SET status='PAID' WHERE subscription_id=?",
        )
        .bind(subscriptionId)
        .run(),
    ).rejects.toThrow("PAYMENT_CONFIRMATION_REQUIRED");
  });
  it("rejects other accounts and requires current admin authority plus MFA", async () => {
    const owner = await member(),
      other = await member(),
      subscriptionId = await subscription(owner);
    await expect(
      authorizeBillingCommand(db, other, "billing.subscription.cancel", {
        subscriptionId,
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_NOT_FOUND" });
    await expect(grantWith(other)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      grantWith({ ...admin, mfaEnabled: false }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(adminBillingOverview(db, other)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    async function grantWith(actor: Actor) {
      return command(actor, "billing.admin.grant", {
        subscriptionId,
        version: 1,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        reason: "Explicit grant authorization",
      });
    }
  });
  it("activates only with matching verified payment evidence and preserves the paid period on cancellation", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor);
    const period = await db
      .prepare("SELECT * FROM billing_periods WHERE subscription_id=?")
      .bind(subscriptionId)
      .first<{
        id: string;
        amount_minor: number;
        currency: string;
        starts_at: string;
        ends_at: string;
      }>();
    const paymentId = newId(),
      providerTransactionId = newId();
    // These are isolated local D1 provider-evidence fixtures; no remote confirmation is claimed.
    await db
      .prepare(
        "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,?,?,?)",
      )
      .bind(
        paymentId,
        period!.id,
        period!.amount_minor,
        period!.currency,
        newId(),
      )
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',?,'COP',?)",
        )
        .bind(newId(), paymentId, providerTransactionId, 1, "a".repeat(64))
        .run(),
    ).rejects.toThrow("PAYMENT_CONFIRMATION_MISMATCH");
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',?,?,?)",
        )
        .bind(
          newId(),
          paymentId,
          providerTransactionId,
          period!.amount_minor,
          period!.currency,
          "a".repeat(64),
        ),
      db
        .prepare(
          "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=version+1 WHERE id=?",
        )
        .bind(providerTransactionId, paymentId),
      db
        .prepare("UPDATE billing_periods SET status='PAID' WHERE id=?")
        .bind(period!.id),
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=?,current_period_end=?,version=version+1 WHERE id=?",
        )
        .bind(period!.starts_at, period!.ends_at, subscriptionId),
    ]);
    expect((await membershipOverview(db, actor)).premium).toBe(true);
    await command(actor, "billing.subscription.cancel", {
      subscriptionId,
      version: 2,
    });
    expect(await membershipOverview(db, actor)).toMatchObject({
      premium: true,
      subscription: {
        current_period_end: period!.ends_at,
        cancel_at_period_end: 1,
      },
    });
  });

  it("cancels unpaid pending activation without creating premium rights", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor);
    await command(actor, "billing.subscription.cancel", {
      subscriptionId,
      version: 1,
    });
    expect(await membershipOverview(db, actor)).toMatchObject({
      premium: false,
      entitlements: [],
      subscription: { status: "CANCELLED", auto_renew: 0 },
    });
  });

  it("keeps finite granted access after cancellation and hides unimplemented benefits", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor);
    await grant(subscriptionId);
    const active = await membershipOverview(db, actor);
    expect(active.premium).toBe(true);
    expect(active.entitlements).toHaveLength(8);
    expect(active.benefits.every((b) => b.available === false)).toBe(true);
    const end = active.subscription!.current_period_end;
    await command(actor, "billing.subscription.cancel", {
      subscriptionId,
      version: 2,
    });
    const cancelled = await membershipOverview(db, actor);
    expect(cancelled).toMatchObject({
      premium: true,
      subscription: {
        cancel_at_period_end: 1,
        auto_renew: 0,
        current_period_end: end,
      },
    });
  });
  it("expires entitlement at its UTC cutoff and denies suspended premium without removing free vehicle access", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor),
      vehicleId = await vehicle(actor);
    await command(actor, "billing.vehicle.add", {
      subscriptionId,
      version: 1,
      vehicleId,
    });
    const now = Date.now();
    // Historical local D1 fixture models a once-valid grant, not provider payment evidence.
    await db
      .prepare(
        "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,?,?,?,'Historical expired membership fixture')",
      )
      .bind(
        newId(),
        subscriptionId,
        new Date(now - 86400000).toISOString(),
        new Date(now - 1000).toISOString(),
        admin.accountId,
      )
      .run();
    expect((await membershipOverview(db, actor)).premium).toBe(false);
    await grant(subscriptionId, 2);
    expect((await membershipOverview(db, actor)).premium).toBe(true);
    await command(admin, "billing.admin.suspend", {
      subscriptionId,
      version: 3,
      reason: "Account membership suspension review",
    });
    expect((await membershipOverview(db, actor)).premium).toBe(false);
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(true);
  });
  it("enforces two vehicles, exact grants, CAS and removal history", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor);
    const a = await vehicle(actor),
      b = await vehicle(actor),
      c = await vehicle(actor),
      ungranted = await vehicle(actor, false);
    await expect(
      command(actor, "billing.vehicle.add", {
        subscriptionId,
        version: 1,
        vehicleId: ungranted,
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_NOT_FOUND" });
    await command(actor, "billing.vehicle.add", {
      subscriptionId,
      version: 1,
      vehicleId: a,
    });
    await expect(
      command(actor, "billing.vehicle.add", {
        subscriptionId,
        version: 1,
        vehicleId: b,
      }),
    ).rejects.toMatchObject({ code: "BILLING_COMMAND_CONFLICT" });
    await command(actor, "billing.vehicle.add", {
      subscriptionId,
      version: 2,
      vehicleId: b,
    });
    await expect(
      command(actor, "billing.vehicle.add", {
        subscriptionId,
        version: 3,
        vehicleId: c,
      }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_VEHICLE_LIMIT" });
    expect(
      (await membershipOverview(db, actor)).vehicles.map((v) => v.vehicle_id),
    ).toEqual([a, b]);
    await command(actor, "billing.vehicle.remove", {
      subscriptionId,
      version: 3,
      vehicleId: a,
    });
    await command(actor, "billing.vehicle.add", {
      subscriptionId,
      version: 4,
      vehicleId: c,
    });
    expect(
      (await membershipOverview(db, actor)).vehicles.map((v) => v.vehicle_id),
    ).toEqual([b, c]);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_membership_vehicles WHERE subscription_id=? AND removed_at IS NOT NULL",
        )
        .bind(subscriptionId)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("rechecks grant revocation and account suspension at commit time", async () => {
    const actor = await member(),
      subscriptionId = await subscription(actor),
      vehicleId = await vehicle(actor);
    const prepared = await prepareBillingCommand(
      db,
      actor,
      "billing.vehicle.add",
      { subscriptionId, version: 1, vehicleId },
      newId(),
    );
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
      )
      .bind(vehicleId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      code: "BILLING_COMMAND_CONFLICT",
    });
    expect((await membershipOverview(db, actor)).subscription!.version).toBe(1);
    const pending = await prepareBillingCommand(
      db,
      actor,
      "billing.subscription.cancel",
      { subscriptionId, version: 1 },
      newId(),
    );
    await db
      .prepare(
        "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(actor.accountId)
      .run();
    await expect(commitPreparedCommand(db, pending)).rejects.toMatchObject({
      code: "BILLING_COMMAND_CONFLICT",
    });
    await expect(membershipOverview(db, actor)).rejects.toMatchObject({
      code: "BILLING_ACCOUNT_UNAVAILABLE",
    });
  });
  it("rolls back subscription, period, financial event, audit and replay after final outbox failure", async () => {
    const actor = await member(),
      requestId = newId(),
      key = newId();
    const operation = "billing.subscription.create" as const;
    const scope = buildIdempotencyScope({
      accountId: actor.accountId,
      operation,
    });
    const request = { planCode: "ACOMPANAMIENTO_ANNUAL" };
    const prepare = () =>
      prepareBillingCommand(db, actor, operation, request, requestId);
    await db.exec(
      `CREATE TRIGGER reject_billing_outbox BEFORE INSERT ON integration_outbox_events WHEN NEW.request_id='${requestId}' BEGIN SELECT RAISE(ABORT,'billing outbox failure'); END;`,
    );
    try {
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          key,
          request,
          requestId,
          await prepare(),
        ),
      ).rejects.toThrow("billing outbox failure");
    } finally {
      await db.exec("DROP TRIGGER reject_billing_outbox");
    }
    expect(await readReplay(db, scope, key, request)).toBe(null);
    for (const table of [
      "governance_audit_events",
      "billing_financial_events",
      "integration_outbox_events",
    ])
      expect(await count(table, requestId)).toBe(0);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_subscriptions WHERE account_id=?",
        )
        .bind(actor.accountId)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    const response = await commitIdempotentCommand(
      db,
      scope,
      key,
      request,
      requestId,
      await prepare(),
    );
    expect((await readReplay(db, scope, key, request))?.response).toEqual(
      response,
    );
    expect(await count("billing_financial_events", requestId)).toBe(1);
    expect(await count("integration_outbox_events", requestId)).toBe(1);
  });
});
