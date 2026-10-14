import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import { newId, sha256Hex } from "@motorbaldi/shared";
import {
  prepareBillingCommand,
  membershipOverview,
  billingPeriodEnd,
} from "../../packages/payments/src/billing.js";
import {
  applyWompiTransaction,
  expireMemberships,
} from "../../packages/payments/src/payment-lifecycle.js";
import type { WompiTransaction } from "../../packages/payments/src/wompi.js";
import { prepareCheckout } from "../../packages/payments/src/checkout.js";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";

const db = (env as unknown as ApiBindings).DB;
type Actor = { accountId: string; personId: string; mfaEnabled: boolean };
let admin: Actor;
beforeAll(async () => {
  for (const migration of [m1, m2, m3, m4, m5, m6, m7, m8, m12, m13])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
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
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Lifecycle Fixture',?,1)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  return {
    accountId,
    personId: (await ensureMotorBaldiAccount(db, accountId, newId())).personId,
    mfaEnabled: true,
  };
}
async function fixture(planCode = "ACOMPANAMIENTO_MONTHLY") {
  const actor = await member();
  const created = (await commitPreparedCommand(
    db,
    await prepareBillingCommand(
      db,
      actor,
      "billing.subscription.create",
      { planCode },
      newId(),
    ),
  )) as { subscriptionId: string; periodId: string };
  const amountMinor = planCode === "ACOMPANAMIENTO_ANNUAL" ? 28800000 : 2990000;
  const paymentId = newId(),
    reference = `membership_${paymentId.replaceAll("-", "")}`;
  await db
    .prepare(
      "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,?,'COP',?)",
    )
    .bind(paymentId, created.periodId, amountMinor, reference)
    .run();
  const transaction: WompiTransaction = {
    id: `test_${newId().replaceAll("-", "")}`,
    reference,
    amountMinor,
    currency: "COP",
    status: "APPROVED",
  };
  return { ...created, actor, paymentId, transaction };
}
async function apply(t: WompiTransaction, hash?: string, requestId = newId()) {
  return applyWompiTransaction(
    db,
    t,
    hash ?? (await sha256Hex(JSON.stringify(t) + newId())),
    requestId,
    "SANDBOX",
  );
}
async function payment(id: string) {
  return db
    .prepare(
      "SELECT status,version,provider_transaction_id FROM billing_payments WHERE id=?",
    )
    .bind(id)
    .first();
}
async function reservedRenewal(f: Awaited<ReturnType<typeof fixture>>) {
  const reserved = (await commitPreparedCommand(
    db,
    await prepareCheckout(
      db,
      f.actor,
      { subscriptionId: f.subscriptionId },
      newId(),
    ),
  )) as {
    paymentId: string;
    periodId: string;
    reference: string;
    amountMinor: number;
  };
  return {
    ...reserved,
    transaction: {
      ...f.transaction,
      id: "replacement_" + newId(),
      reference: reserved.reference,
      amountMinor: reserved.amountMinor,
    },
  };
}
async function count(table: string, requestId: string) {
  return (await db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`)
    .bind(requestId)
    .first<{ n: number }>())!.n;
}

describe("trusted local provider evidence lifecycle (no remote verification claimed)", () => {
  it("starts initial paid time at verified server observation and permanently deduplicates evidence", async () => {
    const f = await fixture(),
      hash = await sha256Hex("approval " + f.paymentId),
      before = new Date().toISOString();
    const result = await apply(f.transaction, hash);
    expect(result).toMatchObject({
      status: "APPROVED",
      activated: true,
      replayed: false,
    });
    const period = await db
      .prepare(
        "SELECT starts_at,ends_at,status FROM billing_periods WHERE id=?",
      )
      .bind(f.periodId)
      .first<{ starts_at: string; ends_at: string; status: string }>();
    expect(period!.starts_at >= before).toBe(true);
    expect(period!.ends_at).toBe(
      billingPeriodEnd(period!.starts_at, "MONTHLY"),
    );
    expect(period!.status).toBe("PAID");
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
    const replay = await apply(f.transaction, hash);
    expect(replay.replayed).toBe(true);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_payment_confirmations WHERE payment_id=?",
        )
        .bind(f.paymentId)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_provider_events WHERE payment_id=?",
        )
        .bind(f.paymentId)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
  it("rejects amount/currency/environment/reference and hash bindings without effects", async () => {
    const f = await fixture();
    for (const t of [
      { ...f.transaction, amountMinor: 1 },
      { ...f.transaction, reference: "wrong_reference" },
    ])
      await expect(apply(t)).rejects.toMatchObject({
        code: "PROVIDER_EVIDENCE_MISMATCH",
      });
    await expect(
      apply({
        ...f.transaction,
        currency: "USD",
      } as unknown as WompiTransaction),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_EVIDENCE" });
    await expect(
      applyWompiTransaction(
        db,
        f.transaction,
        await sha256Hex("wrong env"),
        newId(),
        "PRODUCTION",
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_MISMATCH" });
    expect(await payment(f.paymentId)).toMatchObject({
      status: "CREATED",
      version: 1,
      provider_transaction_id: null,
    });
    const hash = await sha256Hex("shared evidence");
    await apply(f.transaction, hash);
    const another = await fixture();
    await expect(apply(another.transaction, hash)).rejects.toMatchObject({
      code: "PROVIDER_EVIDENCE_CONFLICT",
    });
    expect((await membershipOverview(db, another.actor)).premium).toBe(false);
  });
  it("keeps approved status on stale pending/declined evidence and removes entitlement on verified void", async () => {
    const f = await fixture();
    await apply(f.transaction);
    for (const status of ["PENDING", "DECLINED", "ERROR"] as const) {
      expect((await apply({ ...f.transaction, status })).status).toBe(
        "APPROVED",
      );
    }
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
    expect((await apply({ ...f.transaction, status: "VOIDED" })).status).toBe(
      "VOIDED",
    );
    expect((await membershipOverview(db, f.actor)).premium).toBe(false);
    expect((await apply(f.transaction)).status).toBe("VOIDED");
    await expect(
      apply({ ...f.transaction, id: "another_transaction" }),
    ).rejects.toMatchObject({ code: "PROVIDER_TRANSACTION_CONFLICT" });
  });

  it("reactivates an annual re-purchase immediately after void and retains immutable history", async () => {
    const f = await fixture("ACOMPANAMIENTO_ANNUAL");
    await apply(f.transaction);
    const historical = await db
      .prepare("SELECT * FROM billing_periods WHERE id=?")
      .bind(f.periodId)
      .first();
    const confirmation = await db
      .prepare("SELECT * FROM billing_payment_confirmations WHERE payment_id=?")
      .bind(f.paymentId)
      .first();
    const evidence = (
      await db
        .prepare("SELECT * FROM billing_provider_events WHERE payment_id=?")
        .bind(f.paymentId)
        .all()
    ).results;
    await apply({ ...f.transaction, status: "VOIDED" });
    expect((await membershipOverview(db, f.actor)).premium).toBe(false);
    const replacement = await reservedRenewal(f),
      before = new Date().toISOString();
    expect(await apply(replacement.transaction)).toMatchObject({
      status: "APPROVED",
      activated: true,
    });
    const after = new Date().toISOString();
    const period = await db
      .prepare(
        "SELECT starts_at,ends_at,status FROM billing_periods WHERE id=?",
      )
      .bind(replacement.periodId)
      .first<{ starts_at: string; ends_at: string; status: string }>();
    expect(period!.starts_at >= before && period!.starts_at <= after).toBe(
      true,
    );
    expect(period!.ends_at).toBe(billingPeriodEnd(period!.starts_at, "ANNUAL"));
    expect(period!.status).toBe("PAID");
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
    expect(
      await db
        .prepare("SELECT * FROM billing_periods WHERE id=?")
        .bind(f.periodId)
        .first(),
    ).toEqual(historical);
    expect(
      await db
        .prepare(
          "SELECT * FROM billing_payment_confirmations WHERE payment_id=?",
        )
        .bind(f.paymentId)
        .first(),
    ).toEqual(confirmation);
    expect(
      (
        await db
          .prepare("SELECT * FROM billing_provider_events WHERE payment_id=?")
          .bind(f.paymentId)
          .all()
      ).results,
    ).toEqual(expect.arrayContaining(evidence));
    expect(await payment(f.paymentId)).toMatchObject({ status: "VOIDED" });
    // Delayed approval of the old transaction must not restore its funding or move the new cutoff.
    expect(await apply(f.transaction)).toMatchObject({
      status: "VOIDED",
      activated: false,
    });
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
    expect(
      await db
        .prepare(
          "SELECT current_period_start,current_period_end FROM billing_subscriptions WHERE id=?",
        )
        .bind(f.subscriptionId)
        .first(),
    ).toEqual({
      current_period_start: period!.starts_at,
      current_period_end: period!.ends_at,
    });
  });

  it("rebases a reserved renewal at approval when its prior paid funding was voided", async () => {
    const f = await fixture();
    await apply(f.transaction);
    const renewal = await reservedRenewal(f);
    const reservation = await db
      .prepare("SELECT starts_at FROM billing_periods WHERE id=?")
      .bind(renewal.periodId)
      .first<{ starts_at: string }>();
    await apply({ ...f.transaction, status: "VOIDED" });
    const before = new Date().toISOString();
    expect(await apply(renewal.transaction)).toMatchObject({ activated: true });
    const after = new Date().toISOString();
    const funded = await db
      .prepare("SELECT starts_at FROM billing_periods WHERE id=?")
      .bind(renewal.periodId)
      .first<{ starts_at: string }>();
    expect(funded!.starts_at >= before && funded!.starts_at <= after).toBe(
      true,
    );
    expect(funded!.starts_at < reservation!.starts_at).toBe(true);
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
  });

  it("rolls back approval when earlier funding is voided after the cutoff read, then retries immediately", async () => {
    const f = await fixture();
    await apply(f.transaction);
    const renewal = await reservedRenewal(f),
      hash = await sha256Hex("cutoff race " + renewal.paymentId),
      requestId = newId();
    // Run a real D1 void between lifecycle preparation and its atomic batch.
    const racingDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await apply({ ...f.transaction, status: "VOIDED" });
        return db.batch(statements);
      },
    } as D1Database;
    await expect(
      applyWompiTransaction(
        racingDb,
        renewal.transaction,
        hash,
        requestId,
        "SANDBOX",
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_STATE_CONFLICT" });
    expect(await payment(renewal.paymentId)).toMatchObject({
      status: "CREATED",
      version: 1,
    });
    expect(
      await db
        .prepare("SELECT status FROM billing_periods WHERE id=?")
        .bind(renewal.periodId)
        .first(),
    ).toEqual({ status: "PENDING" });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM billing_provider_events WHERE evidence_hash=?",
        )
        .bind(hash)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM billing_payment_confirmations WHERE payment_id=?",
        )
        .bind(renewal.paymentId)
        .first(),
    ).toEqual({ n: 0 });
    for (const table of [
      "billing_financial_events",
      "governance_audit_events",
      "integration_outbox_events",
    ])
      expect(await count(table, requestId)).toBe(0);
    expect(await apply(renewal.transaction, hash, requestId)).toMatchObject({
      activated: true,
    });
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
  });

  it("keeps multiple funded renewals sequential even when the subscription pointer is older", async () => {
    const f = await fixture();
    await apply(f.transaction);
    const original = await db
      .prepare("SELECT starts_at,ends_at FROM billing_periods WHERE id=?")
      .bind(f.periodId)
      .first<{ starts_at: string; ends_at: string }>();
    const second = await reservedRenewal(f);
    await apply(second.transaction);
    const funded = await db
      .prepare("SELECT starts_at,ends_at FROM billing_periods WHERE id=?")
      .bind(second.periodId)
      .first<{ starts_at: string; ends_at: string }>();
    expect(funded!.starts_at).toBe(original!.ends_at);
    // An older, still evidenced pointer must not override the latest funded period.
    await db
      .prepare(
        "UPDATE billing_subscriptions SET current_period_start=?,current_period_end=?,version=version+1 WHERE id=?",
      )
      .bind(original!.starts_at, original!.ends_at, f.subscriptionId)
      .run();
    const third = await reservedRenewal(f);
    expect(
      await db
        .prepare("SELECT starts_at FROM billing_periods WHERE id=?")
        .bind(third.periodId)
        .first(),
    ).toEqual({ starts_at: funded!.ends_at });
    await apply(third.transaction);
    expect(
      await db
        .prepare("SELECT starts_at,ends_at FROM billing_periods WHERE id=?")
        .bind(third.periodId)
        .first(),
    ).toEqual({
      starts_at: funded!.ends_at,
      ends_at: billingPeriodEnd(funded!.ends_at, "MONTHLY"),
    });
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
  });

  it("anchors approval to an active finite grant even for the first paid sequence", async () => {
    const f = await fixture(),
      start = new Date(Date.now() - 86400000).toISOString(),
      end = new Date(Date.now() + 86400000).toISOString();
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        admin,
        "billing.admin.grant",
        {
          subscriptionId: f.subscriptionId,
          version: 1,
          startsAt: start,
          endsAt: end,
          reason: "Finite development entitlement",
        },
        newId(),
      ),
    );
    expect(await apply(f.transaction)).toMatchObject({ activated: true });
    expect(
      await db
        .prepare("SELECT starts_at FROM billing_periods WHERE id=?")
        .bind(f.periodId)
        .first(),
    ).toEqual({ starts_at: end });
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
  });

  it("ignores a future grant that provides no current coverage", async () => {
    const f = await fixture(),
      start = new Date(Date.now() + 86400000).toISOString(),
      end = new Date(Date.now() + 172800000).toISOString();
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        admin,
        "billing.admin.grant",
        {
          subscriptionId: f.subscriptionId,
          version: 1,
          startsAt: start,
          endsAt: end,
          reason: "Future development entitlement",
        },
        newId(),
      ),
    );
    const before = new Date().toISOString();
    expect(await apply(f.transaction)).toMatchObject({ activated: true });
    const period = await db
      .prepare("SELECT starts_at FROM billing_periods WHERE id=?")
      .bind(f.periodId)
      .first<{ starts_at: string }>();
    expect(period!.starts_at >= before && period!.starts_at < start).toBe(true);
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
  });
  it("preserves paid access after cancellation but never activates a cancelled pending subscription", async () => {
    const paid = await fixture();
    await apply(paid.transaction);
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        paid.actor,
        "billing.subscription.cancel",
        { subscriptionId: paid.subscriptionId, version: 2 },
        newId(),
      ),
    );
    expect((await membershipOverview(db, paid.actor)).premium).toBe(true);
    const cancelled = await fixture();
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        cancelled.actor,
        "billing.subscription.cancel",
        { subscriptionId: cancelled.subscriptionId, version: 1 },
        newId(),
      ),
    );
    const result = await apply(cancelled.transaction);
    expect(result).toMatchObject({ status: "APPROVED", activated: false });
    expect((await membershipOverview(db, cancelled.actor)).premium).toBe(false);
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_periods WHERE id=?")
          .bind(cancelled.periodId)
          .first()
      )?.status,
    ).toBe("PENDING");
  });
  it("records suspended or inactive account payments without granting premium", async () => {
    const suspended = await fixture();
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        admin,
        "billing.admin.suspend",
        {
          subscriptionId: suspended.subscriptionId,
          version: 1,
          reason: "Security membership review",
        },
        newId(),
      ),
    );
    expect(await apply(suspended.transaction)).toMatchObject({
      status: "APPROVED",
      activated: false,
    });
    expect((await membershipOverview(db, suspended.actor)).premium).toBe(false);
    const inactive = await fixture();
    await db
      .prepare(
        "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(inactive.actor.accountId)
      .run();
    expect(await apply(inactive.transaction)).toMatchObject({
      status: "APPROVED",
      activated: false,
    });
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
          .bind(inactive.subscriptionId)
          .first()
      )?.status,
    ).toBe("PENDING_ACTIVATION");
  });
  it("rolls back all evidence, confirmation, payment, period, audit and activation after final outbox failure", async () => {
    const f = await fixture(),
      requestId = newId(),
      hash = await sha256Hex("rollback " + f.paymentId);
    await db.exec(
      `CREATE TRIGGER reject_payment_event BEFORE INSERT ON integration_outbox_events WHEN NEW.request_id='${requestId}' BEGIN SELECT RAISE(ABORT,'payment event rejected'); END;`,
    );
    try {
      await expect(apply(f.transaction, hash, requestId)).rejects.toThrow(
        "payment event rejected",
      );
    } finally {
      await db.exec("DROP TRIGGER reject_payment_event");
    }
    expect(await payment(f.paymentId)).toMatchObject({
      status: "CREATED",
      version: 1,
    });
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_provider_events WHERE payment_id=?",
        )
        .bind(f.paymentId)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_payment_confirmations WHERE payment_id=?",
        )
        .bind(f.paymentId)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    for (const table of [
      "billing_financial_events",
      "governance_audit_events",
      "integration_outbox_events",
    ])
      expect(await count(table, requestId)).toBe(0);
    expect((await membershipOverview(db, f.actor)).premium).toBe(false);
    expect((await apply(f.transaction, hash, requestId)).activated).toBe(true);
    expect(await count("billing_financial_events", requestId)).toBe(1);
  });
  it("converges simultaneous identical observations and records terminal outcomes without entitlement", async () => {
    const f = await fixture(),
      hash = await sha256Hex("race " + f.paymentId);
    const results = await Promise.all([
      apply(f.transaction, hash),
      apply(f.transaction, hash),
    ]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.status === "APPROVED")).toBe(true);
    for (const status of ["DECLINED", "ERROR", "VOIDED"] as const) {
      const failed = await fixture();
      expect((await apply({ ...failed.transaction, status })).status).toBe(
        status,
      );
      expect((await membershipOverview(db, failed.actor)).premium).toBe(false);
    }
  });
  it("starts an early manual renewal at the existing paid end", async () => {
    const f = await fixture();
    await apply(f.transaction);
    const old = await db
      .prepare(
        "SELECT current_period_end FROM billing_subscriptions WHERE id=?",
      )
      .bind(f.subscriptionId)
      .first<{ current_period_end: string }>();
    const periodId = newId(),
      paymentId = newId(),
      reference = `early_${paymentId.replaceAll("-", "")}`,
      now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) VALUES(?,?,2,?,?,2990000,'COP')",
      )
      .bind(periodId, f.subscriptionId, now, billingPeriodEnd(now, "MONTHLY"))
      .run();
    await db
      .prepare(
        "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,2990000,'COP',?)",
      )
      .bind(paymentId, periodId, reference)
      .run();
    expect(
      (
        await apply({
          ...f.transaction,
          id: "early_renewal_transaction",
          reference,
        })
      ).activated,
    ).toBe(true);
    const period = await db
      .prepare("SELECT starts_at,ends_at FROM billing_periods WHERE id=?")
      .bind(periodId)
      .first<{ starts_at: string; ends_at: string }>();
    expect(period).toEqual({
      starts_at: old!.current_period_end,
      ends_at: billingPeriodEnd(old!.current_period_end, "MONTHLY"),
    });
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
  });

  it("captures a late approval without overlapping an account's newer open subscription", async () => {
    const f = await fixture(),
      now = Date.now(),
      start = new Date(now - 86400000).toISOString(),
      end = new Date(now - 1000).toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,?,?,?,'Historical expiry fixture')",
        )
        .bind(newId(), f.subscriptionId, start, end, admin.accountId),
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=?,current_period_end=?,version=version+1 WHERE id=?",
        )
        .bind(start, end, f.subscriptionId),
    ]);
    await expireMemberships(db, newId());
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        f.actor,
        "billing.subscription.create",
        { planCode: "ACOMPANAMIENTO_MONTHLY" },
        newId(),
      ),
    );
    expect(await apply(f.transaction)).toMatchObject({
      status: "APPROVED",
      activated: false,
    });
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
          .bind(f.subscriptionId)
          .first()
      )?.status,
    ).toBe("EXPIRED");
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_periods WHERE id=?")
          .bind(f.periodId)
          .first()
      )?.status,
    ).toBe("PENDING");
    expect((await membershipOverview(db, f.actor)).premium).toBe(false);
  });

  it("keeps suspended overlapping grants until the last real cutoff, then expires exactly once", async () => {
    const f = await fixture(),
      now = Date.now(),
      start = new Date(now - 86400000).toISOString(),
      oldEnd = new Date(now - 1000).toISOString(),
      lastEnd = new Date(now + 1500).toISOString();
    // Historical and short finite local grants model stored administrative evidence.
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,?,?,?,'Historical administrative grant')",
        )
        .bind(newId(), f.subscriptionId, start, oldEnd, admin.accountId),
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=?,current_period_end=?,version=version+1 WHERE id=?",
        )
        .bind(start, oldEnd, f.subscriptionId),
      db
        .prepare(
          "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,?,?,?,'Overlapping finite administrative grant')",
        )
        .bind(newId(), f.subscriptionId, start, lastEnd, admin.accountId),
    ]);
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        admin,
        "billing.admin.suspend",
        {
          subscriptionId: f.subscriptionId,
          version: 2,
          reason: "Suspend local membership verification",
        },
        newId(),
      ),
    );
    expect((await membershipOverview(db, f.actor)).premium).toBe(false);
    expect((await expireMemberships(db, newId())).expired).toBe(0);
    await expect(
      commitPreparedCommand(
        db,
        await prepareBillingCommand(
          db,
          f.actor,
          "billing.subscription.create",
          { planCode: "ACOMPANAMIENTO_MONTHLY" },
          newId(),
        ),
      ),
    ).rejects.toMatchObject({ code: "BILLING_COMMAND_CONFLICT" });
    expect(
      await db
        .prepare("SELECT status,version FROM billing_subscriptions WHERE id=?")
        .bind(f.subscriptionId)
        .first(),
    ).toMatchObject({ status: "SUSPENDED", version: 3 });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(lastEnd) - Date.now() + 50)),
    );
    const requestId = newId();
    expect((await expireMemberships(db, requestId)).expired).toBe(1);
    expect((await expireMemberships(db, newId())).expired).toBe(0);
    expect(
      await db
        .prepare("SELECT status,version FROM billing_subscriptions WHERE id=?")
        .bind(f.subscriptionId)
        .first(),
    ).toMatchObject({ status: "EXPIRED", version: 4 });
    expect(await count("billing_financial_events", requestId)).toBe(1);
    expect(await count("integration_outbox_events", requestId)).toBe(1);
    const replacement = await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        f.actor,
        "billing.subscription.create",
        { planCode: "ACOMPANAMIENTO_MONTHLY" },
        newId(),
      ),
    );
    expect(replacement).toMatchObject({ status: "PENDING_ACTIVATION" });
  });

  it.each([
    [
      "ACOMPANAMIENTO_MONTHLY",
      "2024-01-31T13:14:15.123Z",
      "2024-02-29T13:14:15.123Z",
    ],
    [
      "ACOMPANAMIENTO_ANNUAL",
      "2024-02-29T13:14:15.123Z",
      "2025-02-28T13:14:15.123Z",
    ],
  ])("accepts the SQL calendar clamp for %s", async (planCode, start, end) => {
    const f = await fixture(planCode),
      hash = await sha256Hex("calendar " + f.paymentId);
    // Isolated local provider-evidence fixture tests D1 calendar constraints, not remote settlement.
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_provider_events(id,evidence_hash,payment_id,provider_transaction_id,provider_environment,provider_status,amount_minor,currency,reference) VALUES(?,?,?,?,'SANDBOX','APPROVED',?,'COP',?)",
        )
        .bind(
          newId(),
          hash,
          f.paymentId,
          f.transaction.id,
          f.transaction.amountMinor,
          f.transaction.reference,
        ),
      db
        .prepare(
          "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',?,'COP',?)",
        )
        .bind(
          newId(),
          f.paymentId,
          f.transaction.id,
          f.transaction.amountMinor,
          hash,
        ),
      db
        .prepare(
          "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=version+1 WHERE id=?",
        )
        .bind(f.transaction.id, f.paymentId),
      db
        .prepare(
          "UPDATE billing_periods SET status='PAID',starts_at=?,ends_at=? WHERE id=?",
        )
        .bind(start, end, f.periodId),
    ]);
    expect(
      await db
        .prepare(
          "SELECT starts_at,ends_at,status FROM billing_periods WHERE id=?",
        )
        .bind(f.periodId)
        .first(),
    ).toEqual({ starts_at: start, ends_at: end, status: "PAID" });
  });

  it("expires a suspended historical paid period only with retained matching provider confirmation", async () => {
    const f = await fixture(),
      now = Date.now(),
      start = new Date(now - 62 * 86400000).toISOString(),
      end = billingPeriodEnd(start, "MONTHLY"),
      hash = await sha256Hex("historical paid " + f.paymentId);
    await expect(
      db
        .prepare("UPDATE billing_periods SET status='PAID' WHERE id=?")
        .bind(f.periodId)
        .run(),
    ).rejects.toThrow("PAYMENT_CONFIRMATION_REQUIRED");
    // Synthetic trusted local provider observations are fixtures, never claims of remote payment verification.
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_provider_events(id,evidence_hash,payment_id,provider_transaction_id,provider_environment,provider_status,amount_minor,currency,reference) VALUES(?,?,?,?,'SANDBOX','APPROVED',2990000,'COP',?)",
        )
        .bind(
          newId(),
          hash,
          f.paymentId,
          f.transaction.id,
          f.transaction.reference,
        ),
      db
        .prepare(
          "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',2990000,'COP',?)",
        )
        .bind(newId(), f.paymentId, f.transaction.id, hash),
      db
        .prepare(
          "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=version+1 WHERE id=?",
        )
        .bind(f.transaction.id, f.paymentId),
      db
        .prepare(
          "UPDATE billing_periods SET status='PAID',starts_at=?,ends_at=? WHERE id=?",
        )
        .bind(start, end, f.periodId),
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=?,current_period_end=?,version=version+1 WHERE id=?",
        )
        .bind(start, end, f.subscriptionId),
    ]);
    await commitPreparedCommand(
      db,
      await prepareBillingCommand(
        db,
        admin,
        "billing.admin.suspend",
        {
          subscriptionId: f.subscriptionId,
          version: 2,
          reason: "Suspended historical paid membership",
        },
        newId(),
      ),
    );
    expect((await expireMemberships(db, newId())).expired).toBe(1);
    expect((await expireMemberships(db, newId())).expired).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_periods WHERE id=?")
          .bind(f.periodId)
          .first()
      )?.status,
    ).toBe("PAID");
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM billing_payment_confirmations WHERE payment_id=?",
        )
        .bind(f.paymentId)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    expect((await membershipOverview(db, f.actor)).premium).toBe(false);
  });

  it("expires ended grants without touching vehicle data and renews from the later boundary", async () => {
    const f = await fixture(),
      now = Date.now(),
      startsAt = new Date(now - 2 * 86400000).toISOString(),
      endsAt = new Date(now - 86400000).toISOString();
    // Historical finite admin grant is isolated local state, not fictitious provider confirmation.
    await db.batch([
      db
        .prepare(
          "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,?,?,?,'Historical expiry fixture')",
        )
        .bind(newId(), f.subscriptionId, startsAt, endsAt, admin.accountId),
      db
        .prepare(
          "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=?,current_period_end=?,version=version+1 WHERE id=?",
        )
        .bind(startsAt, endsAt, f.subscriptionId),
    ]);
    const vehicleId = newId();
    await db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
      .bind(vehicleId)
      .run();
    expect((await expireMemberships(db, newId())).expired).toBe(1);
    expect((await expireMemberships(db, newId())).expired).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT id FROM vehicle_vehicles WHERE id=?")
          .bind(vehicleId)
          .first()
      )?.id,
    ).toBe(vehicleId);
    const renewalId = newId(),
      renewalPayId = newId(),
      reference = `renewal_${renewalPayId.replaceAll("-", "")}`;
    await db
      .prepare(
        "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) VALUES(?,?,2,?,?,2990000,'COP')",
      )
      .bind(
        renewalId,
        f.subscriptionId,
        new Date(now).toISOString(),
        billingPeriodEnd(new Date(now).toISOString(), "MONTHLY"),
      )
      .run();
    await db
      .prepare(
        "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,2990000,'COP',?)",
      )
      .bind(renewalPayId, renewalId, reference)
      .run();
    expect(
      (await apply({ ...f.transaction, id: "renewal_transaction", reference }))
        .activated,
    ).toBe(true);
    expect((await membershipOverview(db, f.actor)).premium).toBe(true);
    const renewed = await db
      .prepare("SELECT starts_at FROM billing_periods WHERE id=?")
      .bind(renewalId)
      .first<{ starts_at: string }>();
    expect(renewed!.starts_at >= new Date(now).toISOString()).toBe(true);
  });
});
