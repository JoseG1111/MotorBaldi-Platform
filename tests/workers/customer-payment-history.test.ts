import { beforeAll, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { customerPaymentHistory } from "@motorbaldi/payments";
import { billingRoutes } from "../../apps/api/src/billing-routes.js";
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
beforeAll(async () => {
  for (const migration of [m1, m2, m3, m4, m5, m6, m7, m8, m12, m13])
    await db.exec(migration.replace(/^\s*--.*$/gm, "").replace(/\n/g, " "));
});
async function fixture(count: number) {
  const actor = { accountId: newId(), personId: newId(), mfaEnabled: false };
  await db
    .prepare("INSERT INTO auth_users(id,name,email) VALUES(?,'History',?)")
    .bind(actor.accountId, actor.accountId + "@example.test")
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','History','Fixture')",
    )
    .bind(actor.personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(actor.accountId, actor.personId)
    .run();
  const subscription = newId();
  await db
    .prepare(
      "INSERT INTO billing_subscriptions(id,account_id,plan_code) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY')",
    )
    .bind(subscription, actor.accountId)
    .run();
  const entries: { id: string; created_at: string }[] = [];
  for (let index = 0; index < count; index++) {
    const period = newId(),
      payment = newId();
    // Reverse dates deliberately: UUID creation order does not describe payment chronology.
    const created = new Date(
      Date.UTC(2026, 0, Math.floor((count - index) / 2) + 1),
    ).toISOString();
    await db
      .prepare(
        "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) VALUES(?,?,?,'2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z',2990000,'COP')",
      )
      .bind(period, subscription, index + 1)
      .run();
    await db
      .prepare(
        "INSERT INTO billing_payments(id,period_id,reference,amount_minor,currency,status,created_at) VALUES(?,?,?,2990000,'COP','CREATED',?)",
      )
      .bind(payment, period, "history-" + payment, created)
      .run();
    await db
      .prepare(
        "UPDATE billing_payments SET status=?,version=version+1 WHERE id=?",
      )
      .bind(index % 2 ? "DECLINED" : "PENDING", payment)
      .run();
    entries.push({ id: payment, created_at: created });
  }
  return {
    actor,
    entries: entries.sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    ),
  };
}
async function route(
  actor: Awaited<ReturnType<typeof fixture>>["actor"],
  suffix = "",
) {
  return billingRoutes(
    new Request("https://api.test/api/v1/billing/payments" + suffix),
    db,
    async () => actor,
    async () => {
      throw new Error("Unexpected mutation");
    },
    async () => ({}),
    {},
  );
}
it("paginates persisted payment history chronologically with a private owned cursor, including equal timestamps", async () => {
  const own = await fixture(31),
    other = await fixture(1);
  const response = await route(own.actor);
  expect(response!.headers.get("cache-control")).toBe("no-store");
  const first = (await response!.json()) as {
    items: { id: string }[];
    nextCursor: string;
  };
  expect(first.items.map((row) => row.id)).toEqual(
    own.entries.slice(0, 30).map((row) => row.id),
  );
  expect(first.nextCursor).toBe(own.entries[29]!.id);
  const second = (await (await route(
    own.actor,
    "?cursor=" + first.nextCursor,
  ))!.json()) as { items: { id: string }[]; nextCursor: null };
  expect(second.items.map((row) => row.id)).toEqual([own.entries[30]!.id]);
  expect(second.nextCursor).toBeNull();
  expect(
    (await customerPaymentHistory(db, other.actor)).items.map((row) => row.id),
  ).toEqual([other.entries[0]!.id]);
  expect(
    (await customerPaymentHistory(db, own.actor)).items.map((row) => row.id),
  ).toEqual(first.items.map((row) => row.id));
  for (const cursor of [other.entries[0]!.id, newId(), "malformed", ""])
    await expect(
      customerPaymentHistory(db, own.actor, cursor),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
  await expect(
    route(own.actor, "?cursor=" + other.entries[0]!.id),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    route(
      own.actor,
      "?cursor=" + first.nextCursor + "&cursor=" + first.nextCursor,
    ),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    route(own.actor, "?accountId=" + other.actor.accountId),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
});
it("rejects inactive identities and mismatched person/account history access", async () => {
  const own = await fixture(1),
    other = await fixture(0);
  await expect(
    customerPaymentHistory(db, {
      ...own.actor,
      personId: other.actor.personId,
    }),
  ).rejects.toMatchObject({ code: "BILLING_ACCOUNT_UNAVAILABLE" });
  await db
    .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
    .bind(own.actor.accountId)
    .run();
  await expect(route(own.actor)).rejects.toMatchObject({
    code: "BILLING_ACCOUNT_UNAVAILABLE",
  });
  await db
    .prepare("UPDATE iam_accounts SET status='ACTIVE' WHERE id=?")
    .bind(own.actor.accountId)
    .run();
  await db
    .prepare("UPDATE iam_people SET status='PROVISIONAL' WHERE id=?")
    .bind(own.actor.personId)
    .run();
  await expect(customerPaymentHistory(db, own.actor)).rejects.toMatchObject({
    code: "BILLING_ACCOUNT_UNAVAILABLE",
  });
});
