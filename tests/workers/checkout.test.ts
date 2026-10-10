import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  prepareBillingCommand,
  membershipOverview,
} from "../../packages/payments/src/billing.js";
import {
  authorizeCheckout,
  checkoutInput,
  prepareCheckout,
} from "../../packages/payments/src/checkout.js";
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
beforeAll(async () => {
  for (const migration of [m1, m2, m3, m4, m5, m6, m7, m8, m12, m13])
    await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/\n/g, " "));
});
async function actor(): Promise<Actor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Checkout fixture',?,1)",
    )
    .bind(accountId, accountId + "@example.test")
    .run();
  return {
    accountId,
    personId: (await ensureMotorBaldiAccount(db, accountId, newId())).personId,
    mfaEnabled: false,
  };
}
async function subscription(owner: Actor, annual = false) {
  const response = (await commitPreparedCommand(
    db,
    await prepareBillingCommand(
      db,
      owner,
      "billing.subscription.create",
      { planCode: annual ? "ACOMPANAMIENTO_ANNUAL" : "ACOMPANAMIENTO_MONTHLY" },
      newId(),
    ),
  )) as Record<string, Json>;
  return String(response.subscriptionId);
}
async function checkout(
  owner: Actor,
  subscriptionId: string,
  requestId = newId(),
) {
  return (await commitPreparedCommand(
    db,
    await prepareCheckout(db, owner, { subscriptionId }, requestId),
  )) as Record<string, Json>;
}
async function count(sql: string, ...args: string[]) {
  return (
    await db
      .prepare(sql)
      .bind(...args)
      .first<{ n: number }>()
  )?.n;
}
function providerEvidence(
  payment: Record<string, Json>,
  transactionId: string,
  hash: string,
) {
  // Local synthetic provider evidence exercises the actual ledger guards; no remote payment is claimed.
  return db
    .prepare(
      "INSERT INTO billing_provider_events(id,evidence_hash,payment_id,provider_transaction_id,provider_environment,provider_status,amount_minor,currency,reference) VALUES(?,?,?,?,'SANDBOX','APPROVED',?,'COP',?)",
    )
    .bind(
      newId(),
      hash,
      payment.paymentId,
      transactionId,
      payment.amountMinor,
      payment.reference,
    );
}
async function markPaid(
  owner: Actor,
  subscriptionId: string,
  payment: Record<string, Json>,
) {
  const transactionId = "local-" + newId();
  const evidenceHash = newId().replace(/-/g, "").padEnd(64, "a");
  await db.batch([
    providerEvidence(payment, transactionId, evidenceHash),
    db
      .prepare(
        "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',?,'COP',?)",
      )
      .bind(
        newId(),
        payment.paymentId,
        transactionId,
        payment.amountMinor,
        evidenceHash,
      ),
    db
      .prepare(
        "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=version+1 WHERE id=?",
      )
      .bind(transactionId, payment.paymentId),
    db
      .prepare("UPDATE billing_periods SET status='PAID' WHERE id=?")
      .bind(payment.periodId),
    db
      .prepare(
        "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start=(SELECT starts_at FROM billing_periods WHERE id=?),current_period_end=(SELECT ends_at FROM billing_periods WHERE id=?),version=version+1 WHERE id=? AND account_id=?",
      )
      .bind(
        payment.periodId,
        payment.periodId,
        subscriptionId,
        owner.accountId,
      ),
  ]);
}

describe("sandbox checkout ledger reservation", () => {
  it("uses the immutable server period snapshot and reserves one SANDBOX payment without activating membership", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner),
      requestId = newId();
    await db
      .prepare(
        "UPDATE billing_plans SET amount_minor=3990000,version=version+1 WHERE code='ACOMPANAMIENTO_MONTHLY'",
      )
      .run();
    const command = await prepareCheckout(
      db,
      owner,
      { subscriptionId },
      requestId,
    );
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_payments p JOIN billing_periods per ON per.id=p.period_id WHERE per.subscription_id=?",
        subscriptionId,
      ),
    ).toBe(0);
    const response = (await commitPreparedCommand(db, command)) as Record<
      string,
      Json
    >;
    expect(response).toMatchObject({
      amountMinor: 2990000,
      currency: "COP",
      status: "CREATED",
    });
    expect(response.reference).toMatch(/^mb-[0-9a-f-]{36}$/);
    expect(response).not.toHaveProperty("checkoutUrl");
    expect(response).not.toHaveProperty("signature");
    expect(
      await db
        .prepare(
          "SELECT amount_minor,provider_environment,provider_transaction_id,status FROM billing_payments WHERE id=?",
        )
        .bind(response.paymentId)
        .first(),
    ).toEqual({
      amount_minor: 2990000,
      provider_environment: "SANDBOX",
      provider_transaction_id: null,
      status: "CREATED",
    });
    expect((await membershipOverview(db, owner)).premium).toBe(false);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_payment_confirmations WHERE payment_id=?",
        String(response.paymentId),
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_financial_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(1);
    const outbox = await db
      .prepare(
        "SELECT payload_json FROM integration_outbox_events WHERE request_id=?",
      )
      .bind(requestId)
      .first<{ payload_json: string }>();
    expect(JSON.parse(outbox!.payload_json)).toEqual({
      subscriptionId,
      paymentId: response.paymentId,
      periodId: response.periodId,
    });
  });

  it("reuses a permanent business reservation across independent requests without generic replay", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner);
    const first = await checkout(owner, subscriptionId);
    const next = await prepareCheckout(db, owner, { subscriptionId }, newId());
    expect(next.statements).toHaveLength(0);
    expect(await commitPreparedCommand(db, next)).toEqual(first);
    expect(await checkout(owner, subscriptionId)).toEqual(first);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_payments WHERE period_id=?",
        String(first.periodId),
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_periods WHERE subscription_id=?",
        subscriptionId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_financial_events WHERE aggregate_id=?",
        String(first.paymentId),
      ),
    ).toBe(1);
  });

  it.each(["PENDING", "UNKNOWN"])(
    "returns %s without creating a fresh charge or permitting checkout",
    async (status) => {
      const owner = await actor(),
        subscriptionId = await subscription(owner),
        first = await checkout(owner, subscriptionId);
      await db
        .prepare(
          "UPDATE billing_payments SET status=?,version=version+1 WHERE id=?",
        )
        .bind(status, first.paymentId)
        .run();
      const command = await prepareCheckout(
        db,
        owner,
        { subscriptionId },
        newId(),
      );
      expect(command.statements).toHaveLength(0);
      expect(command.response).toEqual({
        ...first,
        status,
        checkoutAvailable: false,
      });
      expect(
        await count(
          "SELECT count(*) AS n FROM billing_payments WHERE period_id=?",
          String(first.periodId),
        ),
      ).toBe(1);
    },
  );

  it("refuses a new charge when the pending period already has an approved payment", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner),
      first = await checkout(owner, subscriptionId);
    const providerTransactionId = "local-" + newId();
    const evidenceHash = newId().replace(/-/g, "").padEnd(64, "a");
    await db.batch([
      providerEvidence(first, providerTransactionId, evidenceHash),
      db
        .prepare(
          "INSERT INTO billing_payment_confirmations(id,payment_id,provider_transaction_id,provider_environment,amount_minor,currency,evidence_hash) VALUES(?,?,?,'SANDBOX',?,'COP',?)",
        )
        .bind(
          newId(),
          first.paymentId,
          providerTransactionId,
          first.amountMinor,
          evidenceHash,
        ),
      db
        .prepare(
          "UPDATE billing_payments SET status='APPROVED',provider_transaction_id=?,version=version+1 WHERE id=?",
        )
        .bind(providerTransactionId, first.paymentId),
    ]);
    expect(
      (await prepareCheckout(db, owner, { subscriptionId }, newId())).response,
    ).toEqual({ ...first, status: "APPROVED", checkoutAvailable: false });
  });

  it("creates one annual renewal period at the paid end and prices it from the current server plan", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner, true),
      first = await checkout(owner, subscriptionId);
    await markPaid(owner, subscriptionId, first);
    const previous = await db
      .prepare("SELECT ends_at FROM billing_periods WHERE id=?")
      .bind(first.periodId)
      .first<{ ends_at: string }>();
    await db
      .prepare(
        "UPDATE billing_plans SET amount_minor=30000000,version=version+1 WHERE code='ACOMPANAMIENTO_ANNUAL'",
      )
      .run();
    const next = await checkout(owner, subscriptionId);
    expect(next.amountMinor).toBe(30000000);
    const period = await db
      .prepare(
        "SELECT sequence,starts_at,ends_at FROM billing_periods WHERE id=?",
      )
      .bind(next.periodId)
      .first<{ sequence: number; starts_at: string; ends_at: string }>();
    expect(period?.sequence).toBe(2);
    expect(period?.starts_at).toBe(previous?.ends_at);
    expect(
      new Date(period!.ends_at).getUTCFullYear() -
        new Date(period!.starts_at).getUTCFullYear(),
    ).toBe(1);
    expect(await checkout(owner, subscriptionId)).toEqual(next);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_periods WHERE subscription_id=?",
        subscriptionId,
      ),
    ).toBe(2);
    expect(
      await db
        .prepare(
          "SELECT status,auto_renew FROM billing_subscriptions WHERE id=?",
        )
        .bind(subscriptionId)
        .first(),
    ).toEqual({ status: "PENDING_RENEWAL", auto_renew: 0 });
  });

  it("denies another account and a mismatched or suspended identity without returning ledger metadata", async () => {
    const owner = await actor(),
      other = await actor(),
      subscriptionId = await subscription(owner);
    await expect(
      authorizeCheckout(db, other, { subscriptionId }),
    ).rejects.toMatchObject({ status: 404, code: "SUBSCRIPTION_NOT_FOUND" });
    await expect(
      prepareCheckout(
        db,
        { ...owner, personId: other.personId },
        { subscriptionId },
        newId(),
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: "BILLING_ACCOUNT_UNAVAILABLE",
    });
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(owner.accountId)
      .run();
    await expect(
      authorizeCheckout(db, owner, { subscriptionId }),
    ).rejects.toMatchObject({
      status: 403,
      code: "BILLING_ACCOUNT_UNAVAILABLE",
    });
  });

  it("denies checkout after cancellation, including reuse of a reserved payment", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner);
    await checkout(owner, subscriptionId);
    await db
      .prepare(
        "UPDATE billing_subscriptions SET cancel_at_period_end=1,version=version+1 WHERE id=?",
      )
      .bind(subscriptionId)
      .run();
    await expect(
      authorizeCheckout(db, owner, { subscriptionId }),
    ).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNAVAILABLE" });
    await expect(
      prepareCheckout(db, owner, { subscriptionId }, newId()),
    ).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNAVAILABLE" });
  });

  it("rolls back a prepared command if subscription authority changes before its CAS commits", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner),
      requestId = newId();
    const command = await prepareCheckout(
      db,
      owner,
      { subscriptionId },
      requestId,
    );
    await db
      .prepare(
        "UPDATE billing_subscriptions SET cancel_at_period_end=1,version=version+1 WHERE id=?",
      )
      .bind(subscriptionId)
      .run();
    await expect(commitPreparedCommand(db, command)).rejects.toMatchObject({
      code: "BILLING_CHECKOUT_CONFLICT",
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_payments p JOIN billing_periods per ON per.id=p.period_id WHERE per.subscription_id=?",
        subscriptionId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_financial_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(0);
  });

  it("serializes independent prepared reservations with permanent business deduplication", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner);
    const a = await prepareCheckout(db, owner, { subscriptionId }, newId()),
      b = await prepareCheckout(db, owner, { subscriptionId }, newId());
    const first = await commitPreparedCommand(db, a);
    await expect(commitPreparedCommand(db, b)).rejects.toMatchObject({
      code: "BILLING_CHECKOUT_CONFLICT",
    });
    expect(await checkout(owner, subscriptionId)).toEqual(first);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_payments p JOIN billing_periods per ON per.id=p.period_id WHERE per.subscription_id=?",
        subscriptionId,
      ),
    ).toBe(1);
  });

  it("rejects client prices, sources, provider statuses and transaction IDs in its strict input", () => {
    for (const extra of [
      "amountMinor",
      "planCode",
      "sourceId",
      "status",
      "providerTransactionId",
      "currency",
    ])
      expect(() =>
        checkoutInput.parse({ subscriptionId: newId(), [extra]: "forbidden" }),
      ).toThrow();
  });
  it("permits explicitly requested expired renewal without enabling automatic charging", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner),
      first = await checkout(owner, subscriptionId);
    await markPaid(owner, subscriptionId, first);
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='EXPIRED',version=version+1 WHERE id=?",
      )
      .bind(subscriptionId)
      .run();
    const renewed = await checkout(owner, subscriptionId);
    expect(renewed.status).toBe("CREATED");
    expect(renewed.periodId).not.toBe(first.periodId);
    expect(
      await db
        .prepare(
          "SELECT status,auto_renew,cancel_at_period_end FROM billing_subscriptions WHERE id=?",
        )
        .bind(subscriptionId)
        .first(),
    ).toEqual({
      status: "PENDING_RENEWAL",
      auto_renew: 0,
      cancel_at_period_end: 0,
    });
  });

  it("refuses expired renewal when the account has another open subscription", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner),
      first = await checkout(owner, subscriptionId);
    await markPaid(owner, subscriptionId, first);
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='EXPIRED',version=version+1 WHERE id=?",
      )
      .bind(subscriptionId)
      .run();
    await subscription(owner);
    await expect(
      authorizeCheckout(db, owner, { subscriptionId }),
    ).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNAVAILABLE" });
  });

  it("rolls back a renewal when the plan snapshot changes between preparation and commit", async () => {
    const owner = await actor(),
      subscriptionId = await subscription(owner),
      first = await checkout(owner, subscriptionId);
    await markPaid(owner, subscriptionId, first);
    const requestId = newId(),
      prepared = await prepareCheckout(
        db,
        owner,
        { subscriptionId },
        requestId,
      );
    await db
      .prepare(
        "UPDATE billing_plans SET amount_minor=amount_minor+100,version=version+1 WHERE code='ACOMPANAMIENTO_MONTHLY'",
      )
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      code: "BILLING_CHECKOUT_CONFLICT",
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_periods WHERE subscription_id=?",
        subscriptionId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_payments p JOIN billing_periods per ON per.id=p.period_id WHERE per.subscription_id=?",
        subscriptionId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM billing_financial_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(0);
  });

  it.each(["SUSPENDED", "CANCELLED"])(
    "denies %s subscriptions before returning an old checkout reservation",
    async (status) => {
      const owner = await actor(),
        subscriptionId = await subscription(owner);
      await checkout(owner, subscriptionId);
      await db
        .prepare(
          "UPDATE billing_subscriptions SET status=?,version=version+1 WHERE id=?",
        )
        .bind(status, subscriptionId)
        .run();
      await expect(
        authorizeCheckout(db, owner, { subscriptionId }),
      ).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNAVAILABLE" });
    },
  );
});
