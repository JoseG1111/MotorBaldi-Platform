import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { sha256Hex } from "@motorbaldi/shared";
import apiWorker from "../../apps/api/src/index.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const fault = vi.hoisted(() => ({ throwHandler: false }));
vi.mock("@motorbaldi/auth", async () => {
  const original =
    await vi.importActual<typeof import("@motorbaldi/auth")>(
      "@motorbaldi/auth",
    );
  return {
    ...original,
    authentication: (...args: Parameters<typeof original.authentication>) => {
      const instance = original.authentication(...args);
      return {
        ...instance,
        auth: {
          ...instance.auth,
          handler: async (request: Request) => {
            if (fault.throwHandler)
              throw new Error("synthetic-private-handler-error");
            return instance.auth.handler(request);
          },
        },
      };
    },
  };
});
const db = (env as unknown as ApiBindings).DB;
const knownEmail = "authorized-auth@example.test";
const unverifiedEmail = "unverified-auth@example.test";
const allowlist = [
  await sha256Hex(knownEmail),
  await sha256Hex(unverifiedEmail),
].join(",");
const remote = {
  ...(env as unknown as ApiBindings),
  ENVIRONMENT: "development" as const,
  AUTH_BASE_URL: "https://api.test",
  CORS_ORIGINS: "https://portal.test,https://admin.test",
  EMAIL_PROVIDER: "RESEND",
  AUTH_EMAIL_DELIVERY_ENABLED: "true",
  AUTH_EMAIL_TEST_RECIPIENT_SHA256: allowlist,
  RESEND_API_KEY: "synthetic-resend-key",
  RESEND_FROM: "auth@example.test",
  RESEND_DOMAIN_VERIFIED: "true",
};
let client = 1;
async function call(
  path: string,
  body?: object,
  bindings: ApiBindings = remote,
) {
  return apiWorker.fetch(
    new Request("https://api.test/api/v1/auth" + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://portal.test",
        "cf-connecting-ip": "198.51.100." + client++,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    bindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}
beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'development')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO governance_feature_flags(id,key,environment,enabled) VALUES('auth-api-signup','PUBLIC_SIGNUP','development',1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES('auth-api-known','Synthetic Authorized',?,1)",
    )
    .bind(knownEmail)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES('auth-api-unauthorized','Synthetic Unauthorized','unauthorized-auth@example.test',1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES('auth-api-unverified','Synthetic Unverified',?,0)",
    )
    .bind(unverifiedEmail)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES('auth-api-unverified-credential','auth-api-unverified','auth-api-unverified','credential','synthetic-unused-hash')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO iam_signup_consents(auth_user_id,terms_version,privacy_version,request_id) VALUES('auth-api-unverified','1','1','synthetic-seed-consent')",
    )
    .run();
});
afterEach(() => {
  fault.throwHandler = false;
  vi.restoreAllMocks();
});

describe("actual API Worker remote auth boundaries", () => {
  it("reports unavailable capabilities and refuses signup/recovery unless explicit email readiness exists", async () => {
    for (const patch of [
      { AUTH_EMAIL_DELIVERY_ENABLED: "false" },
      { RESEND_API_KEY: undefined },
      { RESEND_DOMAIN_VERIFIED: "false" },
      { AUTH_EMAIL_TEST_RECIPIENT_SHA256: undefined },
      { AUTH_EMAIL_TEST_RECIPIENT_SHA256: "bad" },
    ]) {
      const bindings = { ...remote, ...patch };
      const capabilities = await call("/capabilities", undefined, bindings);
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toEqual({
        registrationAvailable: false,
        recoveryAvailable: false,
      });
      expect(capabilities.headers.get("cache-control")).toBe("no-store");
      expect(
        (await call("/sign-up/email", { email: "new@example.test" }, bindings))
          .status,
      ).toBe(404);
      expect(
        (await call("/request-password-reset", { email: knownEmail }, bindings))
          .status,
      ).toBe(404);
      expect(
        (
          await call(
            "/send-verification-email",
            { email: unverifiedEmail },
            bindings,
          )
        ).status,
      ).toBe(404);
    }
    const enabled = await call("/capabilities");
    expect(await enabled.json()).toEqual({
      registrationAvailable: true,
      recoveryAvailable: true,
    });
    await db
      .prepare(
        "UPDATE governance_feature_flags SET enabled=0 WHERE id='auth-api-signup'",
      )
      .run();
    expect(await (await call("/capabilities")).json()).toEqual({
      registrationAvailable: false,
      recoveryAvailable: true,
    });
    await db
      .prepare(
        "UPDATE governance_feature_flags SET enabled=1 WHERE id='auth-api-signup'",
      )
      .run();
  });
  it("refuses signup callbacks and reset redirects outside fixed trusted origin paths", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "should-never-submit" }));
    const signup = {
      name: "Synthetic User",
      email: "signup@example.test",
      password: "synthetic-password-123456",
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "1",
      privacyVersion: "1",
    };
    for (const callbackURL of [
      "https://attacker.test/login",
      "https://portal.test/other",
      "https://portal.test/login?redirect=https://attacker.test",
      "https://portal.test/login#private",
      "https://user:pass@portal.test/login",
    ]) {
      const response = await call("/sign-up/email", { ...signup, callbackURL });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_CALLBACK" });
    }
    for (const redirectTo of [
      "https://attacker.test/reset-password",
      "https://portal.test/other",
      "https://portal.test/reset-password?redirect=https://attacker.test",
      "https://portal.test/reset-password#private",
      "https://user:pass@portal.test/reset-password",
    ]) {
      const response = await call("/request-password-reset", {
        email: knownEmail,
        redirectTo,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_CALLBACK" });
    }
    for (const callbackURL of [
      "https://attacker.test/login",
      "https://portal.test/other",
      "https://portal.test/login?redirect=https://attacker.test",
      "https://portal.test/login#private",
    ]) {
      const response = await call("/send-verification-email", {
        email: unverifiedEmail,
        callbackURL,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_CALLBACK" });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM auth_users WHERE email='signup@example.test'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("normalizes known, unknown, unauthorized and provider failure reset requests without false delivery claims", async () => {
    const logs: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      logs.push(value);
    });
    vi.spyOn(console, "warn").mockImplementation((value) => {
      logs.push(value);
    });
    vi.spyOn(console, "error").mockImplementation((value) => {
      logs.push(value);
    });
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("synthetic-private-provider-body", { status: 500 }),
      );
    const outcomes: { status: number; body: unknown }[] = [];
    for (const email of [
      knownEmail,
      "missing-auth@example.test",
      "unauthorized-auth@example.test",
    ]) {
      const response = await call("/request-password-reset", {
        email,
        redirectTo: "https://portal.test/reset-password",
      });
      outcomes.push({ status: response.status, body: await response.json() });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(outcomes).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 200,
        body: { accepted: true },
      })),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(
      (await db
        .prepare("SELECT count(*) n FROM integration_local_email_sink")
        .first<{ n: number }>())!.n,
    ).toBe(0);
    const recorded = JSON.stringify(logs);
    const failures = await db
      .prepare(
        "SELECT code,actor_id,request_id FROM governance_security_events WHERE code='AUTH_EMAIL_SUBMISSION_FAILED'",
      )
      .all<{ code: string; actor_id: string | null; request_id: string }>();
    expect(failures.results).toHaveLength(2);
    for (const row of failures.results) {
      expect(row.actor_id).toBeNull();
      expect(row.request_id).toBeTruthy();
    }
    expect(JSON.stringify(failures.results)).not.toContain(knownEmail);
    for (const privateValue of [
      knownEmail,
      "unauthorized-auth@example.test",
      "synthetic-private-provider-body",
      "synthetic-resend-key",
      "callbackURL",
      "newPassword",
    ])
      expect(recorded).not.toContain(privateValue);
  });
  it("normalizes a thrown handler through the same accepted response and logs only generic safe metadata", async () => {
    const logs: unknown[] = [];
    vi.spyOn(console, "warn").mockImplementation((value) => {
      logs.push(value);
    });
    fault.throwHandler = true;
    for (const email of [knownEmail, "missing-auth@example.test"]) {
      const response = await call("/request-password-reset", { email });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true });
    }
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(
      "synthetic-private-handler-error",
    );
    for (const value of logs)
      expect(Object.keys(JSON.parse(String(value))).sort()).toEqual([
        "event",
        "requestId",
        "service",
      ]);
  });
  it("keeps verification resends private across unverified, verified, unknown and provider-failed requests", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("synthetic-private-verification-error", { status: 500 }),
      );
    for (const email of [
      unverifiedEmail,
      knownEmail,
      "missing-auth@example.test",
    ]) {
      const response = await call("/send-verification-email", {
        email,
        callbackURL: "https://portal.test/login",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true });
    }
    expect(fetcher).toHaveBeenCalledOnce();
    const submitted = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    const link = new URL(
      submitted.text
        .split("\n")[0]
        .replace("Confirma tu correo en MotorBaldi: ", ""),
    );
    expect(link.origin).toBe("https://api.test");
    expect(link.pathname).toBe("/api/v1/auth/verify-email");
    expect(link.searchParams.get("callbackURL")).toBe(
      "https://portal.test/login",
    );
    fault.throwHandler = true;
    const thrown = await call("/send-verification-email", {
      email: unverifiedEmail,
    });
    expect(thrown.status).toBe(200);
    expect(await thrown.json()).toEqual({ accepted: true });
  });
  it("retains consent for a new signup despite transport failure and recovers via resend without trusting duplicate payload IDs", async () => {
    const email = "created-after-failure@example.test";
    const bindings = {
      ...remote,
      AUTH_EMAIL_TEST_RECIPIENT_SHA256: await sha256Hex(email),
    };
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("synthetic-initial-email-failure", { status: 500 }),
      );
    const signup = {
      name: "Synthetic Accepted",
      email,
      password: "synthetic-signup-password-123456",
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "accepted-terms-v2",
      privacyVersion: "accepted-privacy-v3",
      callbackURL: "https://portal.test/login",
    };
    const response = await call("/sign-up/email", signup, bindings);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    const user = await db
      .prepare("SELECT id,email_verified FROM auth_users WHERE email=?")
      .bind(email)
      .first<{ id: string; email_verified: number }>();
    expect(user!.email_verified).toBe(0);
    const consent = await db
      .prepare(
        "SELECT terms_version,privacy_version FROM iam_signup_consents WHERE auth_user_id=?",
      )
      .bind(user!.id)
      .first();
    expect(consent).toEqual({
      terms_version: "accepted-terms-v2",
      privacy_version: "accepted-privacy-v3",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const duplicate = await call(
      "/sign-up/email",
      { ...signup, termsVersion: "unsigned-retry-version" },
      bindings,
    );
    expect(duplicate.status).toBe(202);
    expect(
      await db
        .prepare(
          "SELECT terms_version,privacy_version FROM iam_signup_consents WHERE auth_user_id=?",
        )
        .bind(user!.id)
        .first(),
    ).toEqual(consent);
    fetcher.mockImplementation(async () =>
      Response.json({ id: "synthetic-verification-resend" }),
    );
    const resend = await call("/send-verification-email", { email }, bindings);
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ accepted: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const submitted = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    const link = new URL(
      submitted.text
        .split("\n")[0]
        .replace("Confirma tu correo en MotorBaldi: ", ""),
    );
    expect(
      (
        await call(
          link.pathname.replace("/api/v1/auth", "") + link.search,
          undefined,
          bindings,
        )
      ).status,
    ).toBe(302);
    expect(
      (await db
        .prepare("SELECT email_verified FROM auth_users WHERE id=?")
        .bind(user!.id)
        .first<{ email_verified: number }>())!.email_verified,
    ).toBe(1);
    const signedIn = await call(
      "/sign-in/email",
      { email, password: signup.password },
      bindings,
    );
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()) as object).toHaveProperty(
      "user.id",
      user!.id,
    );
  });
  it("does not attach consent to a preexisting account or issue verification after a consent-write failure", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ id: "must-not-send" }));
    const signup = {
      name: "Synthetic",
      email: knownEmail,
      password: "synthetic-preexisting-password-123456",
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "1",
      privacyVersion: "1",
    };
    expect((await call("/sign-up/email", signup)).status).toBe(202);
    expect(
      await db
        .prepare(
          "SELECT 1 FROM iam_signup_consents WHERE auth_user_id='auth-api-known'",
        )
        .first(),
    ).toBeNull();
    const email = "consent-write-failure@example.test";
    const bindings = {
      ...remote,
      AUTH_EMAIL_TEST_RECIPIENT_SHA256: await sha256Hex(email),
    };
    await db.exec(
      "CREATE TRIGGER synthetic_block_signup_consent BEFORE INSERT ON iam_signup_consents BEGIN SELECT RAISE(ABORT,'synthetic consent write failure'); END",
    );
    try {
      expect(
        (await call("/sign-up/email", { ...signup, email }, bindings)).status,
      ).toBe(202);
      const user = await db
        .prepare("SELECT id,email_verified FROM auth_users WHERE email=?")
        .bind(email)
        .first<{ id: string; email_verified: number }>();
      expect(user!.email_verified).toBe(0);
      expect(
        await db
          .prepare("SELECT 1 FROM iam_signup_consents WHERE auth_user_id=?")
          .bind(user!.id)
          .first(),
      ).toBeNull();
      expect(
        (await call("/send-verification-email", { email }, bindings)).status,
      ).toBe(200);
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        (await db
          .prepare("SELECT email_verified FROM auth_users WHERE id=?")
          .bind(user!.id)
          .first<{ email_verified: number }>())!.email_verified,
      ).toBe(0);
      expect(
        (
          await call(
            "/sign-in/email",
            { email, password: signup.password },
            bindings,
          )
        ).status,
      ).toBe(403);
    } finally {
      await db.exec("DROP TRIGGER synthetic_block_signup_consent");
    }
  });
  it("keeps public GET capability discovery on the regular limiter while auth mutations remain sensitive", async () => {
    const apiLimit = vi.fn(async () => ({ success: true }));
    const authLimit = vi.fn(async () => ({ success: false }));
    const bindings = {
      ...remote,
      API_RATE_LIMITER: { limit: apiLimit } as RateLimit,
      AUTH_RATE_LIMITER: { limit: authLimit } as RateLimit,
    };
    const capabilities = await call("/capabilities", undefined, bindings);
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      registrationAvailable: true,
      recoveryAvailable: true,
    });
    expect(apiLimit).toHaveBeenCalledOnce();
    expect(authLimit).not.toHaveBeenCalled();
    for (const path of [
      "/capabilities",
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
      "/send-verification-email",
      "/reset-password",
      "/two-factor/verify-totp",
    ])
      expect((await call(path, {}, bindings)).status).toBe(429);
    expect(authLimit).toHaveBeenCalledTimes(7);
    expect(apiLimit).toHaveBeenCalledOnce();
    apiLimit.mockResolvedValue({ success: false });
    const throttled = await call("/capabilities", undefined, bindings);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(authLimit).toHaveBeenCalledTimes(7);
  });
  it("preserves 429 abuse control instead of normalizing it to accepted", async () => {
    const AUTH_RATE_LIMITER = {
      limit: async () => ({ success: false }),
    } as RateLimit;
    const response = await call(
      "/request-password-reset",
      { email: knownEmail },
      { ...remote, AUTH_RATE_LIMITER },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(
      (
        await call(
          "/send-verification-email",
          { email: unverifiedEmail },
          { ...remote, AUTH_RATE_LIMITER },
        )
      ).status,
    ).toBe(429);
  });
});
