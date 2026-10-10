import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
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

const db = (env as unknown as ApiBindings).DB;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const password = "local-billing-api-password-123";
type Client = {
  accountId: string;
  personId: string;
  cookies: Map<string, string>;
  ip: number;
};
let owner: Client, other: Client, admin: Client, reader: Client, noMfa: Client;
let clientCase = 1;
beforeEach(() => {
  clientCase++;
});

async function request(
  client: Client | null,
  path: string,
  body?: object,
  key?: string,
) {
  const response = await worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://portal.test",
        "cf-connecting-ip": `192.0.2.${(client?.ip ?? 1) + clientCase}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
        ...(client?.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([n, v]) => `${n}=${v}`)
                .join("; "),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as never,
    env as unknown as ApiBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0]!,
      separator = pair.indexOf("="),
      name = pair.slice(0, separator),
      value = pair.slice(separator + 1);
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(header))
      client?.cookies.delete(name);
    else client?.cookies.set(name, value);
  }
  return response;
}
async function rawRequest(
  path: string,
  init: RequestInit,
  client: Client | null = null,
) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", `192.0.2.${(client?.ip ?? 1) + clientCase}`);
  if (client?.cookies.size)
    headers.set(
      "cookie",
      [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    );
  return worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      ...init,
      headers,
    }) as never,
    env as unknown as ApiBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}

async function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replaceAll("=", "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1]! & 15;
  const code =
    (((digest[offset]! & 127) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
    1_000_000;
  return String(code).padStart(6, "0");
}

async function authenticate(ip: number, mfa = false): Promise<Client> {
  const accountId = newId(),
    email = `${accountId}@example.test`;
  const client = {
    accountId,
    personId: "",
    cookies: new Map<string, string>(),
    ip,
  };
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Billing API',?,1)",
    )
    .bind(accountId, email)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential',?)",
    )
    .bind(newId(), accountId, accountId, await hashPassword(password))
    .run();
  expect(
    (await request(client, "/auth/sign-in/email", { email, password })).status,
  ).toBe(200);
  if (mfa) {
    const enrollment = await request(client, "/auth/two-factor/enable", {
      password,
      method: "totp",
    });
    expect(enrollment.status).toBe(200);
    const secret = new URL(
      ((await enrollment.json()) as { totpURI: string }).totpURI,
    ).searchParams.get("secret")!;
    expect(
      (
        await request(client, "/auth/two-factor/verify-totp", {
          code: await totp(secret),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
    await request(client, "/auth/sign-out", {});
    expect(
      (await request(client, "/auth/sign-in/email", { email, password }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(client, "/auth/two-factor/verify-totp", {
          code: await totp(secret),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
  }
  const me = await request(client, "/me");
  expect(me.status).toBe(200);
  client.personId = ((await me.json()) as { personId: string }).personId;
  return client;
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
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  owner = await authenticate(10);
  other = await authenticate(40);
  admin = await authenticate(70, true);
  reader = await authenticate(100, true);
  noMfa = await authenticate(130);
  await db
    .prepare(
      "INSERT INTO authz_roles(id,scope,code) VALUES('billing-api-manager','PLATFORM','BILLING_API_MANAGER'),('billing-api-reader','PLATFORM','BILLING_API_READER')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('billing-api-manager','platform.billing.manage'),('billing-api-manager','platform.billing.read'),('billing-api-reader','platform.billing.read')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'billing-api-manager'),(?,'billing-api-reader'),(?,'billing-api-manager')",
    )
    .bind(admin.personId, reader.personId, noMfa.personId)
    .run();
}, 30_000);
async function create(client = owner, key = newId()) {
  const response = await request(
    client,
    "/billing/subscriptions",
    { planCode: "ACOMPANAMIENTO_MONTHLY" },
    key,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    subscriptionId: string;
    version: number;
    replayed: boolean;
  };
}
function grantBody(version = 1) {
  return {
    version,
    startsAt: new Date(Date.now() - 1000).toISOString(),
    endsAt: new Date(Date.now() + 86400000).toISOString(),
    reason: "Explicit finite administrator membership grant",
  };
}

describe("billing API with real authenticated session assurance", () => {
  it("publishes exact server plans and keeps anonymous membership private", async () => {
    const response = await request(null, "/billing/plans");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as { items: unknown[] }).items).toEqual([
      {
        code: "ACOMPANAMIENTO_MONTHLY",
        name: "ACOMPAÑAMIENTO MOTORBALDI",
        period: "MONTH",
        amount_minor: 2990000,
        currency: "COP",
        vehicle_limit: 2,
      },
      {
        code: "ACOMPANAMIENTO_ANNUAL",
        name: "ACOMPAÑAMIENTO MOTORBALDI",
        period: "YEAR",
        amount_minor: 28800000,
        currency: "COP",
        vehicle_limit: 2,
      },
    ]);
    expect((await request(null, "/me/membership")).status).toBe(401);
  });
  it("serves a free membership overview and leaves existing vehicle routes available", async () => {
    const owner = await authenticate(160);
    const free = await request(owner, "/me/membership");
    expect(free.status).toBe(200);
    expect(await free.json()).toMatchObject({
      subscription: null,
      premium: false,
      entitlements: [],
      checkoutAvailable: false,
    });
    const vehicleId = newId();
    await db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
      .bind(vehicleId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
      )
      .bind(newId(), vehicleId, owner.personId, admin.accountId)
      .run();
    expect((await request(owner, `/vehicles/${vehicleId}`)).status).toBe(200);
    expect((await request(other, `/vehicles/${vehicleId}`)).status).toBe(404);
    expect((await request(owner, "/me/membership")).status).toBe(200);
    await create(owner);
    expect((await request(owner, `/vehicles/${vehicleId}`)).status).toBe(200);
    expect(await (await request(owner, "/me/membership")).json()).toMatchObject(
      { premium: false, subscription: { status: "PENDING_ACTIVATION" } },
    );
  });
  it("rejects client prices and creates one pending snapshot plus replay", async () => {
    expect(
      (
        await request(
          owner,
          "/billing/subscriptions",
          { planCode: "ACOMPANAMIENTO_MONTHLY", amountMinor: 1 },
          newId(),
        )
      ).status,
    ).toBe(400);
    const key = newId(),
      created = await create(owner, key);
    expect(created.replayed).toBe(false);
    const repeated = await create(owner, key);
    expect(repeated).toMatchObject({
      subscriptionId: created.subscriptionId,
      replayed: true,
    });
    const membership = await request(owner, "/me/membership");
    expect(await membership.json()).toMatchObject({
      premium: false,
      subscription: {
        id: created.subscriptionId,
        status: "PENDING_ACTIVATION",
        auto_renew: 0,
      },
    });
    expect(
      await db
        .prepare(
          "SELECT amount_minor,currency,status FROM billing_periods WHERE subscription_id=?",
        )
        .bind(created.subscriptionId)
        .first(),
    ).toEqual({ amount_minor: 2990000, currency: "COP", status: "PENDING" });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM billing_subscriptions WHERE account_id=?",
          )
          .bind(owner.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await request(
          owner,
          "/billing/payments/confirm",
          { subscriptionId: created.subscriptionId, approved: true },
          newId(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          owner,
          "/billing/subscriptions",
          { planCode: "ACOMPANAMIENTO_ANNUAL" },
          key,
        )
      ).status,
    ).toBe(409);
  });
  it("enforces another-account denial, CAS and route identifiers", async () => {
    const owner = await authenticate(160);
    const created = await create(owner);
    expect(
      (
        await request(
          other,
          `/billing/subscriptions/${created.subscriptionId}/cancel`,
          { version: 1 },
          newId(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          owner,
          `/billing/subscriptions/${created.subscriptionId}/cancel`,
          { subscriptionId: created.subscriptionId, version: 1 },
          newId(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          owner,
          `/billing/subscriptions/${created.subscriptionId}/cancel`,
          { version: 99 },
          newId(),
        )
      ).status,
    ).toBe(409);
    const key = newId();
    expect(
      (
        await request(
          owner,
          `/billing/subscriptions/${created.subscriptionId}/cancel`,
          { version: 1 },
          key,
        )
      ).status,
    ).toBe(200);
    const replay = await request(
      owner,
      `/billing/subscriptions/${created.subscriptionId}/cancel`,
      { version: 1 },
      key,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(
      (
        await request(
          owner,
          `/billing/subscriptions/${created.subscriptionId}/cancel`,
          { version: 1 },
          newId(),
        )
      ).status,
    ).toBe(409);
  });
  it("requires fresh MFA and distinguishes read-only financial permission from management", async () => {
    const owner = await authenticate(160);
    const created = await create(owner);
    const path = `/admin/billing/subscriptions/${created.subscriptionId}/grant`;
    expect((await request(reader, "/admin/billing")).status).toBe(200);
    expect((await request(owner, "/admin/billing")).status).toBe(403);
    expect((await request(reader, path, grantBody(), newId())).status).toBe(
      403,
    );
    expect((await request(noMfa, path, grantBody(), newId())).status).toBe(403);
    const failed = await request(noMfa, path, grantBody(), newId());
    expect(await failed.json()).toMatchObject({ code: "MFA_REQUIRED" });
    expect((await request(admin, path, grantBody(), newId())).status).toBe(200);
    expect(await (await request(owner, "/me/membership")).json()).toMatchObject(
      { premium: true, subscription: { status: "ACTIVE" } },
    );
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payments")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("rechecks current coordinator authority before returning a committed admin replay", async () => {
    const owner = await authenticate(160);
    const created = await create(owner),
      key = newId(),
      body = grantBody(),
      path = `/admin/billing/subscriptions/${created.subscriptionId}/grant`;
    expect((await request(admin, path, body, key)).status).toBe(200);
    const cached = await request(admin, path, body, key);
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({ replayed: true });
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='billing-api-manager' AND permission_code='platform.billing.manage'",
      )
      .run();
    expect((await request(admin, path, body, key)).status).toBe(403);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM billing_admin_grants WHERE subscription_id=?",
          )
          .bind(created.subscriptionId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await db
      .prepare(
        "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('billing-api-manager','platform.billing.manage')",
      )
      .run();
  });
  it("keeps checkout unavailable without Worker keys and never reserves a payment", async () => {
    const owner = await authenticate(160),
      created = await create(owner),
      path = `/billing/subscriptions/${created.subscriptionId}/checkout`;
    expect(await (await request(owner, "/me/membership")).json()).toMatchObject(
      { checkoutAvailable: false, premium: false },
    );
    const unavailable = await request(owner, path, {}, newId());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "PAYMENTS_UNAVAILABLE",
    });
    expect((await request(null, path, {}, newId())).status).toBe(401);
    const denied = await rawRequest(
      path,
      {
        method: "POST",
        headers: {
          origin: "https://untrusted.example",
          "content-type": "application/json",
          "idempotency-key": newId(),
        },
        body: "{}",
      },
      owner,
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ORIGIN_FORBIDDEN" });
    // Missing configuration is checked before body parsing; untrusted browser data cannot enable checkout.
    expect(
      (
        await request(
          owner,
          path,
          { amountMinor: 1, status: "APPROVED" },
          newId(),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payments")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_payment_attempts")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("exempts only the exact webhook mutation from browser origin checks", async () => {
    const webhook = await rawRequest("/payments/wompi/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(webhook.status).toBe(503);
    const another = await rawRequest("/payments/wompi/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(another.status).toBe(403);
    expect(await another.json()).toMatchObject({ code: "ORIGIN_FORBIDDEN" });
    const get = await rawRequest("/payments/wompi/events", { method: "GET" });
    expect(get.status).toBe(405);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM billing_provider_events")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("bounds webhook JSON before any financial mutation", async () => {
    const oversized = await rawRequest("/payments/wompi/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ untrusted: "x".repeat(17000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    const nonJson = await rawRequest("/payments/wompi/events", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(nonJson.status).toBe(415);
    expect(await nonJson.json()).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    const malformed = await rawRequest("/payments/wompi/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_JSON" });
    for (const table of [
      "billing_payments",
      "billing_payment_attempts",
      "billing_provider_events",
      "billing_payment_confirmations",
    ])
      expect(
        (
          await db
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
  });

  it("does not elevate a stale pre-enrollment session to MFA", async () => {
    const owner = await authenticate(160);
    const created = await create(owner);
    await db
      .prepare(
        "UPDATE auth_users SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(admin.accountId)
      .run();
    const response = await request(
      admin,
      `/admin/billing/subscriptions/${created.subscriptionId}/grant`,
      grantBody(),
      newId(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "MFA_REQUIRED" });
  });
});
