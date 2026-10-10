import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import { newId, sha256Hex, type Json } from "@motorbaldi/shared";
import {
  prepareBillingCommand,
  prepareCheckout,
  membershipOverview,
  wompiIntegritySignature,
} from "@motorbaldi/payments";
import {
  buildHostedCheckout,
  reconcilePaymentWebhook,
  reconcileStoredPayment,
  paymentGatewayCapabilities,
  sandboxPaymentsConfigured,
  type PaymentGatewayBindings,
} from "../../apps/api/src/payment-gateway.js";
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
const bindings: PaymentGatewayBindings = {
  DB: db,
  ENVIRONMENT: "local",
  WOMPI_ENVIRONMENT: "SANDBOX",
  WOMPI_PUBLIC_KEY: "pub_test_LOCAL_FIXTURE",
  WOMPI_PRIVATE_KEY: "prv_test_LOCAL_FIXTURE",
  WOMPI_INTEGRITY_SECRET: "test_integrity_LOCAL_FIXTURE",
  WOMPI_EVENTS_SECRET: "test_events_LOCAL_FIXTURE",
};
type Actor = { accountId: string; personId: string; mfaEnabled: boolean };
beforeAll(async () => {
  for (const migration of [m1, m2, m3, m4, m5, m6, m7, m8, m12, m13])
    await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/\n/g, " "));
});
async function actor(): Promise<Actor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Gateway fixture',?,1)",
    )
    .bind(accountId, accountId + "@example.test")
    .run();
  return {
    accountId,
    personId: (await ensureMotorBaldiAccount(db, accountId, newId())).personId,
    mfaEnabled: false,
  };
}
async function reservation() {
  const owner = await actor();
  const subscription = (await commitPreparedCommand(
    db,
    await prepareBillingCommand(
      db,
      owner,
      "billing.subscription.create",
      { planCode: "ACOMPANAMIENTO_MONTHLY" },
      newId(),
    ),
  )) as Record<string, Json>;
  const subscriptionId = String(subscription.subscriptionId);
  const payment = (await commitPreparedCommand(
    db,
    await prepareCheckout(db, owner, { subscriptionId }, newId()),
  )) as Record<string, Json>;
  return {
    owner,
    subscriptionId,
    paymentId: String(payment.paymentId),
    reference: String(payment.reference),
    amountMinor: Number(payment.amountMinor),
  };
}
type Transaction = {
  id: string;
  reference: string;
  amount_in_cents: number;
  currency: string;
  status: string;
};
async function event(
  transaction: Transaction,
  properties = [
    "transaction.id",
    "transaction.status",
    "transaction.amount_in_cents",
  ],
  timestamp = 1530291411,
) {
  const checksum = await sha256Hex(
    properties
      .map((path) =>
        String(transaction[path.split(".")[1] as keyof Transaction]),
      )
      .join("") +
      timestamp +
      bindings.WOMPI_EVENTS_SECRET,
  );
  return {
    event: "transaction.updated",
    environment: "test",
    data: {
      transaction: {
        ...transaction,
        customer_email: "do-not-return@example.test",
      },
    },
    signature: { properties, checksum },
    timestamp,
  };
}
function transport(transaction: Transaction) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return Response.json({
        data: {
          ...transaction,
          customer_email: "private-customer@example.test",
          payment_method: { last_four: "4242" },
        },
      });
    }) as typeof fetch,
  };
}
async function rows(fixture: Awaited<ReturnType<typeof reservation>>) {
  return {
    payment: await db
      .prepare("SELECT status FROM billing_payments WHERE id=?")
      .bind(fixture.paymentId)
      .first(),
    subscription: await db
      .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
      .bind(fixture.subscriptionId)
      .first(),
    evidence: (
      await db
        .prepare(
          "SELECT count(*) AS n FROM billing_provider_events WHERE payment_id=?",
        )
        .bind(fixture.paymentId)
        .first<{ n: number }>()
    )?.n,
    confirmations: (
      await db
        .prepare(
          "SELECT count(*) AS n FROM billing_payment_confirmations WHERE payment_id=?",
        )
        .bind(fixture.paymentId)
        .first<{ n: number }>()
    )?.n,
  };
}

describe("sandbox payment gateway boundary", () => {
  it("signs only the committed ledger snapshot with fixed hosted URL and no secrets/PII", async () => {
    const fixture = await reservation();
    const result = await buildHostedCheckout(bindings, fixture.owner, {
      subscriptionId: fixture.subscriptionId,
      paymentId: fixture.paymentId,
    });
    expect(result.checkoutAvailable).toBe(true);
    expect("checkoutUrl" in result).toBe(true);
    if (!("checkoutUrl" in result)) throw new Error("Hosted checkout missing");
    const url = new URL(result.checkoutUrl);
    expect(url.origin + url.pathname).toBe("https://checkout.wompi.co/p/");
    expect(url.searchParams.get("amount-in-cents")).toBe(
      String(fixture.amountMinor),
    );
    expect(url.searchParams.get("reference")).toBe(fixture.reference);
    expect(url.searchParams.get("public-key")).toBe(bindings.WOMPI_PUBLIC_KEY);
    expect(url.searchParams.get("signature:integrity")).toBe(
      await wompiIntegritySignature({
        environment: "SANDBOX",
        reference: fixture.reference,
        amountMinor: fixture.amountMinor,
        currency: "COP",
        expirationTime: url.searchParams.get("expiration-time")!,
        integritySecret: bindings.WOMPI_INTEGRITY_SECRET!,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(bindings.WOMPI_PRIVATE_KEY);
    expect(JSON.stringify(result)).not.toContain(bindings.WOMPI_EVENTS_SECRET);
    expect(JSON.stringify(result)).not.toContain(
      bindings.WOMPI_INTEGRITY_SECRET,
    );
    expect(url.searchParams.has("customer-data:email")).toBe(false);
    expect((await membershipOverview(db, fixture.owner)).premium).toBe(false);
  });

  it.each(["PENDING", "UNKNOWN"])(
    "re-reads a cached reservation and refuses hosted checkout after it becomes %s",
    async (status) => {
      const fixture = await reservation();
      await db
        .prepare(
          "UPDATE billing_payments SET status=?,version=version+1 WHERE id=?",
        )
        .bind(status, fixture.paymentId)
        .run();
      const result = await buildHostedCheckout(bindings, fixture.owner, {
        subscriptionId: fixture.subscriptionId,
        paymentId: fixture.paymentId,
      });
      expect(result).toMatchObject({ status, checkoutAvailable: false });
      expect(result).not.toHaveProperty("checkoutUrl");
    },
  );

  it("rechecks cancellation and current identity/ownership before signing an old reservation", async () => {
    const fixture = await reservation(),
      other = await actor();
    await expect(
      buildHostedCheckout(bindings, other, {
        subscriptionId: fixture.subscriptionId,
        paymentId: fixture.paymentId,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_NOT_FOUND" });
    await db
      .prepare(
        "UPDATE billing_subscriptions SET cancel_at_period_end=1,version=version+1 WHERE id=?",
      )
      .bind(fixture.subscriptionId)
      .run();
    await expect(
      buildHostedCheckout(bindings, fixture.owner, {
        subscriptionId: fixture.subscriptionId,
        paymentId: fixture.paymentId,
      }),
    ).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNAVAILABLE" });
  });

  it.each([
    "WOMPI_PUBLIC_KEY",
    "WOMPI_PRIVATE_KEY",
    "WOMPI_INTEGRITY_SECRET",
    "WOMPI_EVENTS_SECRET",
  ] as const)(
    "returns 503 when required secret/key %s is absent",
    async (key) => {
      const fixture = await reservation(),
        missing = { ...bindings, [key]: undefined };
      expect(sandboxPaymentsConfigured(missing)).toBe(false);
      await expect(
        buildHostedCheckout(missing, fixture.owner, {
          subscriptionId: fixture.subscriptionId,
          paymentId: fixture.paymentId,
        }),
      ).rejects.toMatchObject({ status: 503, code: "PAYMENTS_UNAVAILABLE" });
    },
  );

  it("rejects production configuration regardless of approval flags or sandbox-looking credentials", async () => {
    const fixture = await reservation();
    for (const configuration of [
      { ...bindings, ENVIRONMENT: "production" as const },
      { ...bindings, WOMPI_ENVIRONMENT: "PRODUCTION" },
      { ...bindings, WOMPI_PRIVATE_KEY: "prv_prod_LOCAL_FIXTURE" },
    ]) {
      expect(sandboxPaymentsConfigured(configuration)).toBe(false);
      await expect(
        buildHostedCheckout(configuration, fixture.owner, {
          subscriptionId: fixture.subscriptionId,
          paymentId: fixture.paymentId,
        }),
      ).rejects.toMatchObject({ status: 503 });
    }
  });

  it("rejects an invalid webhook signature before any outbound call or activation", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      };
    const hook = await event(transaction),
      { calls, fetcher } = transport(transaction);
    hook.signature.checksum = "0".repeat(64);
    await expect(
      reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_WEBHOOK" });
    expect(calls).toHaveLength(0);
    expect(await rows(fixture)).toEqual({
      payment: { status: "CREATED" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });

  it.each(["id", "status", "amount_in_cents"])(
    "rejects signed %s mismatch with authoritative provider evidence without activation",
    async (field) => {
      const fixture = await reservation(),
        transaction = {
          id: "local-" + newId(),
          reference: fixture.reference,
          amount_in_cents: fixture.amountMinor,
          currency: "COP",
          status: "APPROVED",
        };
      const hook = await event(transaction);
      const mismatched = {
        ...transaction,
        [field]:
          field === "amount_in_cents"
            ? 1
            : field === "status"
              ? "DECLINED"
              : "different-id",
      };
      const { calls, fetcher } = transport(mismatched);
      await expect(
        reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
      ).rejects.toMatchObject({
        code:
          field === "id"
            ? "PAYMENT_RECONCILIATION_UNAVAILABLE"
            : "PROVIDER_EVIDENCE_MISMATCH",
      });
      expect(calls).toHaveLength(1);
      expect(await rows(fixture)).toEqual({
        payment: { status: "CREATED" },
        subscription: { status: "PENDING_ACTIVATION" },
        evidence: 0,
        confirmations: 0,
      });
    },
  );

  it("uses provider reference/currency rather than unsigned claimed webhook fields", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      };
    const hook = await event(transaction);
    hook.data.transaction.reference = "forged-reference";
    hook.data.transaction.currency = "USD";
    const { calls, fetcher } = transport(transaction);
    expect(
      await reconcilePaymentWebhook(bindings, hook, newId(), {
        fetch: fetcher,
      }),
    ).toMatchObject({
      paymentId: fixture.paymentId,
      status: "APPROVED",
      activated: true,
    });
    expect(calls[0]?.url).toBe(
      "https://sandbox.wompi.co/v1/transactions/" + transaction.id,
    );
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer " + bindings.WOMPI_PRIVATE_KEY,
    );
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("rejects authoritative amount/reference mismatches against the internal ledger", async () => {
    const fixture = await reservation();
    for (const [reference, amount] of [
      [fixture.reference, 1],
      ["unknown-reference", fixture.amountMinor],
    ] as const) {
      const transaction = {
        id: "local-" + newId(),
        reference,
        amount_in_cents: amount,
        currency: "COP",
        status: "APPROVED",
      };
      const hook = await event(transaction),
        { fetcher } = transport(transaction);
      await expect(
        reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
      ).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_MISMATCH" });
    }
    expect(await rows(fixture)).toEqual({
      payment: { status: "CREATED" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });

  it("activates from actual reconciled evidence and converges across duplicate deliveries with different timestamps", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { calls, fetcher } = transport(transaction);
    const first = await reconcilePaymentWebhook(
      bindings,
      await event(transaction),
      newId(),
      { fetch: fetcher },
    );
    const second = await reconcilePaymentWebhook(
      bindings,
      await event(transaction, undefined, 1530291412),
      newId(),
      { fetch: fetcher },
    );
    expect(first).toMatchObject({
      status: "APPROVED",
      activated: true,
      replayed: false,
    });
    expect(second).toMatchObject({
      status: "APPROVED",
      activated: false,
      replayed: true,
    });
    expect(calls).toHaveLength(2);
    expect(await rows(fixture)).toEqual({
      payment: { status: "APPROVED" },
      subscription: { status: "ACTIVE" },
      evidence: 1,
      confirmations: 1,
    });
    expect((await membershipOverview(db, fixture.owner)).premium).toBe(true);
    const evidence = await db
      .prepare("SELECT * FROM billing_provider_events WHERE payment_id=?")
      .bind(fixture.paymentId)
      .first();
    expect(JSON.stringify(evidence)).not.toContain("customer_email");
    expect(JSON.stringify(evidence)).not.toContain("private-customer");
  });

  it("rejects replayed transaction status that no longer agrees with the provider instead of downgrading access", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { fetcher } = transport(transaction);
    await reconcilePaymentWebhook(bindings, await event(transaction), newId(), {
      fetch: fetcher,
    });
    await expect(
      reconcilePaymentWebhook(
        bindings,
        await event({ ...transaction, status: "PENDING" }),
        newId(),
        { fetch: fetcher },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_MISMATCH" });
    expect(await rows(fixture)).toEqual({
      payment: { status: "APPROVED" },
      subscription: { status: "ACTIVE" },
      evidence: 1,
      confirmations: 1,
    });
  });
  it("rejects a foreign or prod webhook environment before any network reconciliation", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      };
    const hook = await event(transaction),
      { calls, fetcher } = transport(transaction);
    hook.environment = "prod";
    await expect(
      reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_WEBHOOK" });
    expect(calls).toHaveLength(0);
  });

  it("never activates on provider downtime and returns a safe error without provider PII", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      };
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json(
        { privatePayload: "provider customer details" },
        { status: 503 },
      );
    }) as typeof fetch;
    await expect(
      reconcilePaymentWebhook(bindings, await event(transaction), newId(), {
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "PAYMENT_RECONCILIATION_UNAVAILABLE",
      message: "Provider reconciliation unavailable",
    });
    expect(calls).toBe(1);
    expect(await rows(fixture)).toEqual({
      payment: { status: "CREATED" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });

  it("rejects a changed signed reference in a dynamic webhook without accepting evidence", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      };
    const hook = await event(
      { ...transaction, reference: "signed-wrong-reference" },
      [
        "transaction.amount_in_cents",
        "transaction.currency",
        "transaction.reference",
        "transaction.status",
        "transaction.id",
      ],
    );
    const { fetcher } = transport(transaction);
    await expect(
      reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
    ).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_MISMATCH" });
    expect(await rows(fixture)).toEqual({
      payment: { status: "CREATED" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });

  it("converges concurrent verified duplicate deliveries through the permanent evidence guard", async () => {
    const fixture = await reservation(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { fetcher } = transport(transaction);
    const hook = await event(transaction);
    const results = await Promise.all([
      reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
      reconcilePaymentWebhook(bindings, hook, newId(), { fetch: fetcher }),
    ]);
    expect(results.map((result) => result.activated).sort()).toEqual([
      false,
      true,
    ]);
    expect(await rows(fixture)).toEqual({
      payment: { status: "APPROVED" },
      subscription: { status: "ACTIVE" },
      evidence: 1,
      confirmations: 1,
    });
  });
  it("exposes only safe sandbox capability flags and never credential values", () => {
    expect(paymentGatewayCapabilities(bindings)).toEqual({
      environment: "SANDBOX",
      checkoutAvailable: true,
      manualReconciliationAvailable: true,
      recurringAvailable: false,
      productionAvailable: false,
    });
    expect(JSON.stringify(paymentGatewayCapabilities(bindings))).not.toContain(
      "LOCAL_FIXTURE",
    );
    expect(
      paymentGatewayCapabilities({
        ...bindings,
        WOMPI_EVENTS_SECRET: undefined,
      }),
    ).toMatchObject({
      checkoutAvailable: false,
      manualReconciliationAvailable: false,
      productionAvailable: false,
    });
  });

  it("requires current platform billing management permission and MFA before manual reconciliation", async () => {
    const fixture = await reservation(),
      staff = await actor(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { calls, fetcher } = transport(transaction);
    await expect(
      reconcileStoredPayment(bindings, staff, fixture.paymentId, newId(), {
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-finance')",
      )
      .bind(staff.personId)
      .run();
    await expect(
      reconcileStoredPayment(bindings, staff, fixture.paymentId, newId(), {
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect(calls).toHaveLength(0);
  });

  it("refuses unknown transaction binding without attempting another charge or requesting a frontend id", async () => {
    const fixture = await reservation(),
      staff = await actor(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { calls, fetcher } = transport(transaction);
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-finance')",
      )
      .bind(staff.personId)
      .run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='UNKNOWN',version=version+1 WHERE id=?",
      )
      .bind(fixture.paymentId)
      .run();
    await expect(
      reconcileStoredPayment(
        bindings,
        { ...staff, mfaEnabled: true },
        fixture.paymentId,
        newId(),
        { fetch: fetcher },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "PAYMENT_TRANSACTION_UNKNOWN",
    });
    expect(calls).toHaveLength(0);
    expect(await rows(fixture)).toEqual({
      payment: { status: "UNKNOWN" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });

  it("reconciles the stored provider id only and shares permanent deduplication with subsequent webhooks", async () => {
    const fixture = await reservation(),
      staff = await actor(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { calls, fetcher } = transport(transaction);
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-finance')",
      )
      .bind(staff.personId)
      .run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='UNKNOWN',provider_transaction_id=?,version=version+1 WHERE id=?",
      )
      .bind(transaction.id, fixture.paymentId)
      .run();
    expect(
      await reconcileStoredPayment(
        bindings,
        { ...staff, mfaEnabled: true },
        fixture.paymentId,
        newId(),
        { fetch: fetcher },
      ),
    ).toMatchObject({ activated: true, status: "APPROVED", replayed: false });
    expect(
      await reconcilePaymentWebhook(
        bindings,
        await event(transaction),
        newId(),
        { fetch: fetcher },
      ),
    ).toMatchObject({ activated: false, status: "APPROVED", replayed: true });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual(
      Array(2).fill(
        "https://sandbox.wompi.co/v1/transactions/" + transaction.id,
      ),
    );
    expect(calls.every((call) => (call.init?.method ?? "GET") === "GET")).toBe(
      true,
    );
    expect(await rows(fixture)).toEqual({
      payment: { status: "APPROVED" },
      subscription: { status: "ACTIVE" },
      evidence: 1,
      confirmations: 1,
    });
  });

  it("rejects authoritative evidence that would redirect manual reconciliation to another ledger payment", async () => {
    const fixture = await reservation(),
      staff = await actor(),
      transaction = {
        id: "local-" + newId(),
        reference: "wrong-payment-reference",
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      },
      { calls, fetcher } = transport(transaction);
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-finance')",
      )
      .bind(staff.personId)
      .run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='PENDING',provider_transaction_id=?,version=version+1 WHERE id=?",
      )
      .bind(transaction.id, fixture.paymentId)
      .run();
    await expect(
      reconcileStoredPayment(
        bindings,
        { ...staff, mfaEnabled: true },
        fixture.paymentId,
        newId(),
        { fetch: fetcher },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_MISMATCH" });
    expect(calls).toHaveLength(1);
    expect(await rows(fixture)).toEqual({
      payment: { status: "PENDING" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });

  it("rechecks management authority after the GET and refuses application if the role was revoked", async () => {
    const fixture = await reservation(),
      staff = await actor(),
      transaction = {
        id: "local-" + newId(),
        reference: fixture.reference,
        amount_in_cents: fixture.amountMinor,
        currency: "COP",
        status: "APPROVED",
      };
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-finance')",
      )
      .bind(staff.personId)
      .run();
    await db
      .prepare(
        "UPDATE billing_payments SET status='PENDING',provider_transaction_id=?,version=version+1 WHERE id=?",
      )
      .bind(transaction.id, fixture.paymentId)
      .run();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      await db
        .prepare(
          "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-finance'",
        )
        .bind(staff.personId)
        .run();
      return Response.json({ data: transaction });
    }) as typeof fetch;
    await expect(
      reconcileStoredPayment(
        bindings,
        { ...staff, mfaEnabled: true },
        fixture.paymentId,
        newId(),
        { fetch: fetcher },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toBe(1);
    expect(await rows(fixture)).toEqual({
      payment: { status: "PENDING" },
      subscription: { status: "PENDING_ACTIVATION" },
      evidence: 0,
      confirmations: 0,
    });
  });
});
