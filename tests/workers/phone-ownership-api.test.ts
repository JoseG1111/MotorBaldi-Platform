import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { notificationProviderRoutes } from "../../apps/api/src/notification-provider-routes.js";
import { phoneOwnershipAvailable } from "../../apps/api/src/phone-ownership-routes.js";
import { issuePhoneOwnershipChallenge } from "@motorbaldi/identity";
import { newId, sha256Hex } from "@motorbaldi/shared";
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

import ownership from "../../migrations/0028_phone_ownership_challenges.sql?raw";

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
    ownership,
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
  owner = await signup("phone-api-owner@example.test", "192.0.2.21");
  stranger = await signup("phone-api-stranger@example.test", "192.0.2.22");
}, 30000);
const phone = "+573001234567";
async function enabled(): Promise<ApiBindings> {
  return {
    ...bindings,
    ENVIRONMENT: "development",
    PHONE_OWNERSHIP_VERIFICATION_ENABLED: "true",
    PHONE_OWNERSHIP_WHATSAPP_DESTINATION: "+15551234567",
    META_WHATSAPP_APP_SECRET: "synthetic-phone-api-signing-secret",
    META_WHATSAPP_PHONE_NUMBER_ID: "123456789",
    META_WHATSAPP_TEST_RECIPIENT_SHA256: await sha256Hex(phone),
  };
}
async function fixture() {
  const contactId = newId();
  await db
    .prepare("DELETE FROM iam_phone_ownership_challenges WHERE account_id=?")
    .bind(owner.accountId)
    .run();
  await db
    .prepare(
      "DELETE FROM iam_contact_methods WHERE person_id=? AND type='PHONE'",
    )
    .bind(owner.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,'PHONE',?,?,'TEST')",
    )
    .bind(contactId, owner.personId, phone, phone)
    .run();
  // Each test gets an independent account session challenge slot.
  await db
    .prepare("DELETE FROM iam_phone_ownership_challenges WHERE account_id=?")
    .bind(owner.accountId)
    .run();
  const session = await db
    .prepare("SELECT id FROM auth_sessions WHERE user_id=?")
    .bind(owner.accountId)
    .first<{ id: string }>();
  const challenge = await issuePhoneOwnershipChallenge(
    db,
    { ...owner, sessionId: session!.id },
    contactId,
    newId(),
  );
  return { contactId, message: challenge.message };
}
async function state(contactId: string) {
  return db
    .prepare("SELECT verification_status FROM iam_contact_methods WHERE id=?")
    .bind(contactId)
    .first("verification_status");
}
async function webhook(
  message: string,
  options: {
    env?: ApiBindings;
    sender?: string;
    phoneId?: string;
    forged?: boolean;
  } = {},
) {
  const config = options.env ?? (await enabled());
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id:
                  options.phoneId ?? config.META_WHATSAPP_PHONE_NUMBER_ID,
              },
              messages: [
                {
                  id: `wamid.${newId()}`,
                  from: (options.sender ?? phone).slice(1),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: message },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.META_WHATSAPP_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return notificationProviderRoutes(
    new Request("https://api.test/api/v1/notifications/providers/meta/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${options.forged ? "0".repeat(64) : signature}`,
      },
      body: raw,
    }),
    config,
    newId(),
  );
}
describe("phone ownership API and signed inbound webhook", () => {
  it("requires authentication for capability and challenge issuance", async () => {
    expect(
      (await call("/api/v1/me/phone-verification/capability")).status,
    ).toBe(401);
    expect(
      (
        await call("/api/v1/me/phone-verification/challenges", {
          method: "POST",
          headers: {
            origin: "https://portal.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ contactMethodId: newId() }),
        })
      ).status,
    ).toBe(401);
  });
  it("exposes the default closed capability to a verified non-MFA session", async () => {
    const result = await call("/api/v1/me/phone-verification/capability", {
      headers: { cookie: owner.cookie },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ available: false });
    expect(
      (
        await call("/api/v1/me/phone-verification/capability", {
          headers: { cookie: stranger.cookie },
        })
      ).status,
    ).toBe(200);
  });
  it("verifies the matching phone once through authenticated Meta evidence", async () => {
    const f = await fixture();
    expect((await webhook(f.message))?.status).toBe(200);
    expect(await state(f.contactId)).toBe("VERIFIED");
    expect((await webhook(f.message))?.status).toBe(200);
    const count = await db
      .prepare(
        "SELECT count(*) AS n FROM governance_audit_events WHERE resource_id=? AND action='identity.phone.ownership.verified'",
      )
      .bind(f.contactId)
      .first("n");
    expect(count).toBe(1);
  });
  it("rejects forged signatures and foreign phone metadata without verification", async () => {
    const f = await fixture();
    await expect(webhook(f.message, { forged: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      webhook(f.message, { phoneId: "987654321" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await state(f.contactId)).toBe("UNVERIFIED");
  });
  it("does not consume challenges from a different allowlisted sender", async () => {
    const f = await fixture(),
      config = await enabled(),
      other = "+573009999999";
    config.META_WHATSAPP_TEST_RECIPIENT_SHA256 += `,${await sha256Hex(other)}`;
    expect(
      (await webhook(f.message, { env: config, sender: other }))?.status,
    ).toBe(200);
    expect(await state(f.contactId)).toBe("UNVERIFIED");
    expect((await webhook(f.message))?.status).toBe(200);
    expect(await state(f.contactId)).toBe("VERIFIED");
  });
  it.each(["disabled", "not allowlisted"])(
    "ignores inbound phone proof when %s",
    async (mode) => {
      const f = await fixture(),
        config = await enabled();
      if (mode === "disabled")
        config.PHONE_OWNERSHIP_VERIFICATION_ENABLED = "false";
      else
        config.META_WHATSAPP_TEST_RECIPIENT_SHA256 =
          await sha256Hex("+573009999999");
      expect((await webhook(f.message, { env: config }))?.status).toBe(200);
      expect(await state(f.contactId)).toBe("UNVERIFIED");
    },
  );
  it.each(["staging", "production"] as const)(
    "keeps phone verification unavailable in %s despite an enabling flag",
    async (environment) => {
      const config = { ...(await enabled()), ENVIRONMENT: environment };
      expect(phoneOwnershipAvailable(config)).toBe(false);
      await expect(
        webhook(`MotorBaldi ${"a".repeat(64)}`, { env: config }),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
});

it("requires a trusted origin for authenticated issuance and stays closed locally", async () => {
  const issue = (origin?: string) =>
    call("/api/v1/me/phone-verification/challenges", {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ contactMethodId: newId() }),
    });
  expect((await issue()).status).toBe(403);
  expect((await issue("https://attacker.test")).status).toBe(403);
  expect((await issue("https://portal.test")).status).toBe(503);
});
