import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../../apps/api/src/index.js";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
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

const db = (env as unknown as ApiBindings).DB;
const phone = "+573001234567";
let bindings: ApiBindings;
type Client = {
  accountId: string;
  personId: string;
  cookie: string;
  contactId: string;
};
let owner: Client, other: Client;
function request(
  path: string,
  client?: Client,
  body?: object,
  origin: string | null = "https://portal.test",
) {
  return worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(origin ? { origin } : {}),
        ...(client ? { cookie: client.cookie } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as never,
    bindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}
async function authenticate(): Promise<Client> {
  const accountId = newId(),
    email = `${accountId}@example.test`,
    password = "development-phone-fixture-password-123";
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Phone API',?,1)",
    )
    .bind(accountId, email)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential',?)",
    )
    .bind(newId(), accountId, accountId, await hashPassword(password))
    .run();
  const login = await request("/auth/sign-in/email", undefined, {
    email,
    password,
  });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((v) => v.split(";", 1)[0])
    .join("; ");
  const client = { accountId, personId: "", cookie, contactId: newId() };
  const me = await request("/me", client);
  expect(me.status).toBe(200);
  client.personId = ((await me.json()) as { personId: string }).personId;
  await db
    .prepare(
      "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,'PHONE',?,?,'TEST')",
    )
    .bind(client.contactId, client.personId, phone, phone)
    .run();
  return client;
}
beforeAll(async () => {
  for (const sql of [
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
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'development')",
    )
    .run();
  bindings = {
    ...(env as unknown as ApiBindings),
    ENVIRONMENT: "development",
    PHONE_OWNERSHIP_VERIFICATION_ENABLED: "true",
    PHONE_OWNERSHIP_WHATSAPP_DESTINATION: "+15551234567",
    META_WHATSAPP_APP_SECRET: "synthetic-development-phone-api-secret",
    META_WHATSAPP_PHONE_NUMBER_ID: "123456789",
    META_WHATSAPP_TEST_RECIPIENT_SHA256: await sha256Hex(phone),
    API_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    } as RateLimit,
    AUTH_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    } as RateLimit,
  };
  owner = await authenticate();
  other = await authenticate();
}, 30000);
describe("enabled Development phone verification HTTP API", () => {
  it("requires authentication and reports the enabled capability for a human session", async () => {
    expect((await request("/me/phone-verification/capability")).status).toBe(
      401,
    );
    const result = await request("/me/phone-verification/capability", owner);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ available: true });
  });
  it("rejects CSRF and another owner's contact", async () => {
    const body = { contactMethodId: owner.contactId };
    expect(
      (await request("/me/phone-verification/challenges", owner, body, null))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          "/me/phone-verification/challenges",
          owner,
          body,
          "https://attacker.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/me/phone-verification/challenges", other, body)).status,
    ).toBe(404);
  });
  it("issues a hash-only challenge for the owner's non-MFA session and enforces cooldown", async () => {
    const body = { contactMethodId: owner.contactId };
    const result = await request(
      "/me/phone-verification/challenges",
      owner,
      body,
    );
    expect(result.status).toBe(201);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const challenge = (await result.json()) as {
      message: string;
      expiresAt: string;
      destination: string;
    };
    expect(challenge.message).toMatch(/^MotorBaldi [a-f0-9]{64}$/);
    expect(challenge.destination).toBe(
      bindings.PHONE_OWNERSHIP_WHATSAPP_DESTINATION,
    );
    expect(Date.parse(challenge.expiresAt)).toBeGreaterThan(Date.now());
    const row = await db
      .prepare(
        "SELECT * FROM iam_phone_ownership_challenges WHERE account_id=?",
      )
      .bind(owner.accountId)
      .first();
    expect(row?.token_sha256).toBe(
      await sha256Hex(challenge.message.slice(11)),
    );
    expect(row?.phone_sha256).toBe(await sha256Hex(phone));
    expect(JSON.stringify(row)).not.toContain(phone);
    expect(JSON.stringify(row)).not.toContain(challenge.message.slice(11));
    expect(
      (await request("/me/phone-verification/challenges", owner, body)).status,
    ).toBe(429);
  });
  it("rejects a revoked session", async () => {
    await db
      .prepare("DELETE FROM auth_sessions WHERE user_id=?")
      .bind(other.accountId)
      .run();
    expect(
      (
        await request("/me/phone-verification/challenges", other, {
          contactMethodId: other.contactId,
        })
      ).status,
    ).toBe(401);
  });
});

it("enforces the recipient allowlist and HTTP rate limiter before issuance", async () => {
  const allowed = bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256;
  const limiter = bindings.AUTH_RATE_LIMITER;
  try {
    bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256 =
      await sha256Hex("+573009999999");
    expect(
      (
        await request("/me/phone-verification/challenges", owner, {
          contactMethodId: owner.contactId,
        })
      ).status,
    ).toBe(404);
    bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256 = allowed;
    bindings.AUTH_RATE_LIMITER = {
      async limit() {
        return { success: false };
      },
    } as RateLimit;
    expect(
      (
        await request("/me/phone-verification/challenges", owner, {
          contactMethodId: owner.contactId,
        })
      ).status,
    ).toBe(429);
  } finally {
    bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256 = allowed;
    bindings.AUTH_RATE_LIMITER = limiter;
  }
});
