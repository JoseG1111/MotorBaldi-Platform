import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { commitPreparedCommand, type Event } from "@motorbaldi/db";
import { prepareBillingCommand } from "@motorbaldi/payments";
import { createMembershipNotification } from "@motorbaldi/messaging";
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
import m14 from "../../migrations/0014_notifications.sql?raw";

const bindings = env as unknown as ApiBindings;
const db = bindings.DB;
// The native Workers test pool exposes the running Worker through exports.default.
const SELF = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
function call(path: string, init: RequestInit = {}) {
  return SELF.fetch!(
    new Request(`https://api.test${path}`, init) as never,
    bindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}
type Session = {
  cookie: string;
  accountId: string;
  personId: string;
  contactId: string;
  mfaEnabled: false;
};
let owner: Session, stranger: Session;
async function signup(email: string, ip: string): Promise<Session> {
  const password = "notification-test-password-123";
  const headers = {
    "content-type": "application/json",
    origin: "https://api.test",
    "cf-connecting-ip": ip,
  };
  const registered = await call("/api/v1/auth/sign-up/email", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Notification Member",
      email,
      password,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "test-v1",
      privacyVersion: "test-v1",
    }),
  });
  expect(registered.status).toBe(202);
  const user = await db
    .prepare("SELECT id,email_verified FROM auth_users WHERE email=?")
    .bind(email)
    .first<{ id: string; email_verified: number }>();
  expect(user?.email_verified).toBe(0);
  const sink = await db
    .prepare(
      "SELECT action_url FROM integration_local_email_sink WHERE auth_user_id=? AND kind='VERIFY_EMAIL'",
    )
    .bind(user!.id)
    .first<{ action_url: string }>();
  const verification = new URL(sink!.action_url);
  expect(
    (
      await call(verification.pathname + verification.search, {
        redirect: "manual",
      })
    ).status,
  ).toBe(302);
  const signedIn = await call("/api/v1/auth/sign-in/email", {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const profile = await call("/api/v1/me", { headers: { cookie } });
  expect(profile.status).toBe(200);
  const personId = ((await profile.json()) as { personId: string }).personId;
  const contact = await db
    .prepare(
      "SELECT id FROM iam_contact_methods WHERE person_id=? AND source='AUTH'",
    )
    .bind(personId)
    .first<{ id: string }>();
  return {
    cookie,
    accountId: user!.id,
    personId,
    contactId: contact!.id,
    mfaEnabled: false,
  };
}
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
    m14,
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO governance_feature_flags(id,key,environment,enabled) VALUES(?,'PUBLIC_SIGNUP','local',1)",
    )
    .bind(newId())
    .run();
  owner = await signup("notification-owner@example.test", "192.0.2.21");
  stranger = await signup("notification-stranger@example.test", "192.0.2.22");
}, 30000);
function post(
  path: string,
  body: Record<string, unknown>,
  options: {
    session?: Session;
    key?: string | null;
    origin?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {
    cookie: (options.session ?? owner).cookie,
    "content-type": "application/json",
  };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? newId();
  if (options.origin !== null)
    headers.origin = options.origin ?? "https://portal.test";
  return call(path, { method: "POST", headers, body: JSON.stringify(body) });
}
const prefs = "/api/v1/me/notification-preferences",
  inbox = "/api/v1/me/notifications";
async function notificationFixture() {
  const result = (await commitPreparedCommand(
    db,
    await prepareBillingCommand(
      db,
      owner,
      "billing.subscription.create",
      { planCode: "ACOMPANAMIENTO_MONTHLY" },
      newId(),
    ),
  )) as { subscriptionId: string };
  const event = await db
    .prepare(
      "SELECT * FROM integration_outbox_events WHERE aggregate_id=? AND event_type='billing.subscription.changed.v1'",
    )
    .bind(result.subscriptionId)
    .first<Event>();
  expect(event).toBeTruthy();
  const saved = await createMembershipNotification(db, event!);
  expect(saved.disposition).toBe("created");
  const row = await db
    .prepare(
      "SELECT id FROM notification_inbox WHERE source_event_id=? AND account_id=?",
    )
    .bind(event!.id, owner.accountId)
    .first<{ id: string }>();
  return { notificationId: row!.id, subscriptionId: result.subscriptionId };
}
describe("notification API with real verified non-MFA sessions", () => {
  it("rejects anonymous preferences and inbox reads", async () => {
    for (const path of [prefs, inbox])
      expect((await call(path)).status).toBe(401);
  });
  it("preserves free account preferences and inbox access without MFA or a paid membership", async () => {
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM billing_subscriptions WHERE account_id=?",
          )
          .bind(owner.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    const principal = await call("/api/v1/principal", {
      headers: { cookie: owner.cookie },
    });
    expect(await principal.json()).toMatchObject({ mfaEnabled: false });
    const preferences = await call(prefs, {
      headers: { cookie: owner.cookie },
    });
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toMatchObject({
      externalDeliveryAvailable: false,
      items: expect.arrayContaining([
        expect.objectContaining({
          category: "TRANSACTIONAL",
          channel: "IN_APP",
          enabled: true,
          version: 0,
        }),
      ]),
    });
    const list = await call(inbox, { headers: { cookie: owner.cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [], nextCursor: null });
  });
  it("requires trusted Origin, an idempotency key and a strict preference request", async () => {
    const body = {
      category: "SUPPORT",
      channel: "IN_APP",
      enabled: true,
      version: 0,
    };
    expect((await post(prefs, body, { origin: null })).status).toBe(403);
    expect(
      (await post(prefs, body, { origin: "https://untrusted.example.test" }))
        .status,
    ).toBe(403);
    expect((await post(prefs, body, { key: null })).status).toBe(400);
    expect(
      (await post(prefs, { ...body, accountId: stranger.accountId })).status,
    ).toBe(400);
    expect((await post(prefs, { ...body, version: -1 })).status).toBe(400);
    expect(
      (
        await post(prefs, {
          category: "MARKETING",
          channel: "IN_APP",
          enabled: false,
          version: 0,
        })
      ).status,
    ).toBe(400);
  });
  it("replays the same preference key and rejects changed requests, stale versions and another contact", async () => {
    const key = newId(),
      body = {
        category: "SUPPORT",
        channel: "IN_APP",
        enabled: true,
        version: 0,
      };
    const first = await post(prefs, body, { key });
    expect(first.status).toBe(200);
    const accepted = (await first.json()) as Record<string, unknown>;
    const replay = await post(prefs, body, { key });
    expect(replay.status).toBe(200);
    expect(accepted.replayed).toBe(false);
    expect(await replay.json()).toEqual({ ...accepted, replayed: true });
    expect(
      (await post(prefs, { ...body, enabled: false }, { key })).status,
    ).toBe(409);
    expect((await post(prefs, body)).status).toBe(409);
    expect(
      (
        await post(prefs, {
          category: "TRANSACTIONAL",
          channel: "EMAIL",
          enabled: true,
          contactMethodId: stranger.contactId,
          version: 0,
        })
      ).status,
    ).toBe(404);
    const current = await post(prefs, { ...body, version: 1, enabled: false });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ version: 2, enabled: false });
  });
  it("rejects invalid pagination and route-ID body overrides without exposing another inbox", async () => {
    for (const query of [
      "?cursor=invalid",
      "?limit=0",
      "?limit=51",
      "?limit=1.5",
    ])
      expect(
        (await call(inbox + query, { headers: { cookie: owner.cookie } }))
          .status,
      ).toBe(400);
    expect(
      (
        await post(`${inbox}/${newId()}/read`, {
          version: 1,
          notificationId: newId(),
        })
      ).status,
    ).toBe(400);
  });
  it("materializes a real pending-membership event and reads only the owner's notification exactly once", async () => {
    const fixture = await notificationFixture(),
      path = `${inbox}/${fixture.notificationId}/read`;
    const list = await call(inbox, { headers: { cookie: owner.cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      items: [
        expect.objectContaining({
          id: fixture.notificationId,
          version: 1,
          readAt: null,
          parameters: { subscriptionId: fixture.subscriptionId },
        }),
      ],
    });
    expect(
      (await post(path, { version: 1 }, { session: stranger })).status,
    ).toBe(404);
    expect(
      (
        await call(`${inbox}?cursor=${fixture.notificationId}`, {
          headers: { cookie: stranger.cookie },
        })
      ).status,
    ).toBe(404);
    const key = newId(),
      first = await post(path, { version: 1 }, { key });
    expect(first.status).toBe(200);
    const accepted = (await first.json()) as Record<string, unknown>;
    expect(accepted).toMatchObject({
      notificationId: fixture.notificationId,
      read: true,
      version: 2,
    });
    const replay = await post(path, { version: 1 }, { key });
    expect(replay.status).toBe(200);
    expect(accepted.replayed).toBe(false);
    expect(await replay.json()).toEqual({ ...accepted, replayed: true });
    expect((await post(path, { version: 1 })).status).toBe(409);
    const acknowledged = await post(path, { version: 2 });
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toEqual(accepted);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM governance_audit_events WHERE action='notification.inbox.read' AND resource_id=?",
          )
          .bind(fixture.notificationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT status FROM billing_subscriptions WHERE id=?")
          .bind(fixture.subscriptionId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("PENDING_ACTIVATION");
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payments")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
});
