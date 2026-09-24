import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { apiConfig, type ApiBindings } from "@motorbaldi/config";
import { authOptions } from "@motorbaldi/auth";
import migration from "../../migrations/0001_foundation.sql?raw";

const testEnv = env as unknown as ApiBindings;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const call = (path: string, init?: RequestInit) =>
  worker.fetch!(
    new Request("https://api.test" + path, init) as never,
    testEnv,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );

beforeAll(async () => {
  await testEnv.DB.exec(migration.replace(/\n/g, " "));
  await testEnv.DB.prepare(
    "INSERT INTO governance_environment_metadata(singleton, environment) VALUES (1, 'local')",
  ).run();
  const password = await hashPassword("correct-password-123");
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES ('018f0000-0000-7000-8000-000000000001','Verified','verified@example.test',1,0)",
    ),
    testEnv.DB.prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES ('cred-verified','018f0000-0000-7000-8000-000000000001','018f0000-0000-7000-8000-000000000001','credential',?)",
    ).bind(password),
    testEnv.DB.prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES ('018f0000-0000-7000-8000-000000000002','Unverified','unverified@example.test',0)",
    ),
    testEnv.DB.prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES ('cred-unverified','018f0000-0000-7000-8000-000000000002','018f0000-0000-7000-8000-000000000002','credential',?)",
    ).bind(password),
  ]);
});

async function signIn(
  email = "verified@example.test",
  password = "correct-password-123",
) {
  return call("/api/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://api.test" },
    body: JSON.stringify({ email, password }),
  });
}

describe("real D1 migration", () => {
  it("fails closed when Worker and D1 environments differ", async () => {
    const { assertDatabaseEnvironment } =
      await import("@motorbaldi/db/environment");
    await expect(
      assertDatabaseEnvironment(testEnv.DB, "production"),
    ).rejects.toMatchObject({
      status: 503,
      code: "DATABASE_ENVIRONMENT_MISMATCH",
    });
  });

  it("creates STRICT tables and enforces immutable governance history", async () => {
    const strict = await testEnv.DB.prepare(
      "SELECT strict FROM pragma_table_list WHERE name = 'auth_users'",
    ).first<{ strict: number }>();
    expect(strict?.strict).toBe(1);
    await expect(
      testEnv.DB.prepare(
        "UPDATE governance_environment_metadata SET environment='production'",
      ).run(),
    ).rejects.toThrow(/immutable/);
    await testEnv.DB.prepare(
      "INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id) VALUES ('audit-1','test','test','one','request-1')",
    ).run();
    await expect(
      testEnv.DB.prepare(
        "DELETE FROM governance_audit_events WHERE id='audit-1'",
      ).run(),
    ).rejects.toThrow(/append-only/);
    await testEnv.DB.prepare(
      "INSERT INTO governance_security_events(id,code,request_id) VALUES ('security-1','TEST','request-1')",
    ).run();
    await expect(
      testEnv.DB.prepare(
        "UPDATE governance_security_events SET code='CHANGED' WHERE id='security-1'",
      ).run(),
    ).rejects.toThrow(/append-only/);
  });

  it("matches Better Auth's configured schema", async () => {
    const plan = await getMigrations(
      authOptions(testEnv, apiConfig(testEnv), "schema-test"),
      { throwOnUnsafe: false },
    );
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });
});

describe("API and Better Auth runtime", () => {
  it("uses one request ID, correct methods, and CORS on errors", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/health", { method: "POST" })).status).toBe(405);
    const denied = await call("/api/v1/principal", {
      headers: { origin: "https://api.test" },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(
      "https://api.test",
    );
    expect(((await denied.json()) as { requestId: string }).requestId).toBe(
      denied.headers.get("x-request-id"),
    );
  });

  it("signs in a verified user, creates/reads/revokes a session, and reports MFA", async () => {
    const signedIn = await signIn();
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toBeTruthy();
    const session = await call("/api/v1/auth/get-session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    await testEnv.DB.prepare(
      "UPDATE auth_users SET two_factor_enabled = 1 WHERE id = '018f0000-0000-7000-8000-000000000001'",
    ).run();
    const principal = await call("/api/v1/principal", { headers: { cookie } });
    expect(principal.status).toBe(200);
    expect(await principal.json()).toMatchObject({
      accountId: "018f0000-0000-7000-8000-000000000001",
      mfaEnabled: true,
    });
    expect(
      (
        await call("/api/v1/auth/sign-out", {
          method: "POST",
          headers: { cookie, origin: "https://api.test" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/v1/principal", { headers: { cookie } })).status,
    ).toBe(401);
  });

  it("rejects invalid passwords and unverified principals", async () => {
    expect(
      (await signIn("verified@example.test", "wrong-password-123")).status,
    ).toBeGreaterThanOrEqual(400);
    const response = await signIn("unverified@example.test");
    const cookie = response.headers.get("set-cookie");
    if (cookie)
      expect(
        (await call("/api/v1/principal", { headers: { cookie } })).status,
      ).toBe(401);
    else expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("idempotency coordinator", () => {
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "same-key-123",
  };
  it("serializes ten requests around one logical effect", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers,
          body: JSON.stringify({ value: "same" }),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const payloads = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{
            replayed: boolean;
            effectNumber: number;
          }>,
      ),
    );
    expect(payloads.filter((value) => !value.replayed)).toHaveLength(1);
    expect(new Set(payloads.map((value) => value.effectNumber)).size).toBe(1);
  });

  it("rejects conflicts, unknown operations, and oversized responses", async () => {
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers,
          body: JSON.stringify({ value: "different" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers: { ...headers, "idempotency-key": "unknown-op-key" },
          body: JSON.stringify({ operation: "unknown.operation" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers: { ...headers, "idempotency-key": "oversize-key" },
          body: JSON.stringify({ responseBytes: 9000 }),
        })
      ).status,
    ).toBe(413);
  });

  it("isolates account and organization scopes and safely reuses expired keys", async () => {
    const key = "scope-isolation-key";
    const first = await call("/api/v1/foundation/idempotency-test", {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      body: JSON.stringify({
        accountId: "018f0000-0000-7000-8000-000000000001",
        organizationId: "018f0000-0000-7000-8000-000000000010",
      }),
    });
    const second = await call("/api/v1/foundation/idempotency-test", {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      body: JSON.stringify({
        accountId: "018f0000-0000-7000-8000-000000000002",
        organizationId: "018f0000-0000-7000-8000-000000000011",
      }),
    });
    expect([first.status, second.status]).toEqual([200, 200]);
    await testEnv.DB.prepare(
      "UPDATE governance_idempotency_records SET expires_at='2000-01-01T00:00:00.000Z' WHERE key=?",
    )
      .bind(key)
      .run();
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers: { ...headers, "idempotency-key": key },
          body: JSON.stringify({
            accountId: "018f0000-0000-7000-8000-000000000001",
            organizationId: "018f0000-0000-7000-8000-000000000010",
            reused: true,
          }),
        })
      ).status,
    ).toBe(200);
  });
});
