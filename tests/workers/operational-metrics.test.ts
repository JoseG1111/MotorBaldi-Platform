import { beforeAll, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { queryOperationalMetrics } from "../../packages/observability/src/metrics.js";
import m0 from "../../migrations/0001_foundation.sql?raw";
import m1 from "../../migrations/0002_phase1.sql?raw";
import m2 from "../../migrations/0003_phase1_closeout.sql?raw";
import m11 from "../../migrations/0012_billing_membership.sql?raw";
import m23 from "../../migrations/0024_notification_delivery_tracking.sql?raw";
const db = (env as unknown as ApiBindings).DB;
async function migrate(sql: string) {
  await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
}
beforeAll(async () => {
  await migrate(m0);
});

it("preserves foundation-only metrics and omits unavailable domain evidence", async () => {
  const metrics = await queryOperationalMetrics(db);
  expect(metrics).toEqual({
    outboxPendingCount: 0,
    processingLeaseCount: 0,
    unresolvedDeadLetterCount: 0,
  });
  expect(metrics).not.toHaveProperty("paymentUnknownCount");
  expect(metrics).not.toHaveProperty("notificationUnknownCount");
});

it("counts current canonical failure and UNKNOWN states without double counting failed notifications", async () => {
  for (const sql of [m1, m2, m11, m23]) await migrate(sql);
  const accountId = newId(),
    personId = newId(),
    subscriptionId = newId(),
    periodId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Metrics fixture',?,1)",
      )
      .bind(accountId, `${accountId}@example.test`),
    db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Metrics','Fixture')",
      )
      .bind(personId),
    db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(accountId, personId),
    db
      .prepare(
        "INSERT INTO billing_subscriptions(id,account_id,plan_code) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY')",
      )
      .bind(subscriptionId, accountId),
    db
      .prepare(
        "INSERT INTO billing_periods(id,subscription_id,sequence,starts_at,ends_at,amount_minor,currency) VALUES(?,?,1,'2026-01-01T00:00:00Z','2026-02-01T00:00:00Z',2990000,'COP')",
      )
      .bind(periodId, subscriptionId),
    ...["CREATED", "PENDING", "DECLINED", "ERROR", "VOIDED", "UNKNOWN"].flatMap(
      (status) => {
        const paymentId = newId();
        return [
          db
            .prepare(
              "INSERT INTO billing_payments(id,period_id,amount_minor,currency,reference) VALUES(?,?,2990000,'COP',?)",
            )
            .bind(paymentId, periodId, newId()),
          ...(status === "CREATED"
            ? []
            : [
                db
                  .prepare(
                    "UPDATE billing_payments SET status=?,version=version+1 WHERE id=?",
                  )
                  .bind(status, paymentId),
              ]),
        ];
      },
    ),
  ]);
  for (const [status, deliveryStatus] of [
    ["REJECTED", "PENDING"],
    ["REJECTED", "FAILED"],
    ["ACCEPTED", "FAILED"],
    ["UNKNOWN", "PENDING"],
    ["UNAVAILABLE", "PENDING"],
  ]) {
    const eventId = newId();
    await db.batch([
      db
        .prepare(
          "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES(?,'notification',?,'notification.fixture.v1',1,'{}',?,'IDEMPOTENT')",
        )
        .bind(eventId, eventId, newId()),
      db
        .prepare(
          "INSERT INTO notification_external_deliveries(id,source_event_id,provider,channel,payload_sha256,status,delivery_status) VALUES(?,?,'META_WHATSAPP','WHATSAPP',?,?,?)",
        )
        .bind(eventId, eventId, "0".repeat(64), status, deliveryStatus),
    ]);
  }
  expect(await queryOperationalMetrics(db)).toEqual({
    outboxPendingCount: 5,
    processingLeaseCount: 0,
    unresolvedDeadLetterCount: 0,
    paymentFailureCount: 2,
    paymentUnknownCount: 1,
    notificationFailureCount: 3,
    notificationUnknownCount: 1,
  });
});

it("propagates existing-domain query errors instead of fabricating zero metrics", async () => {
  const brokenDb = {
    prepare: (sql: string) =>
      db.prepare(sql.replaceAll("delivery_status", "fixture_missing_column")),
  } as unknown as D1Database;
  await expect(queryOperationalMetrics(brokenDb)).rejects.toThrow(
    "no such column: fixture_missing_column",
  );
});

it("propagates schema availability read failures", async () => {
  const brokenDb = {
    prepare: () => ({
      all: async () => {
        throw new Error("fixture availability read failed");
      },
    }),
  } as unknown as D1Database;
  await expect(queryOperationalMetrics(brokenDb)).rejects.toThrow(
    "fixture availability read failed",
  );
});
