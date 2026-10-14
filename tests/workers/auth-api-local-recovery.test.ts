import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import apiWorker from "../../apps/api/src/index.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO governance_feature_flags(id,key,environment,enabled) VALUES('local-auth-recovery-signup','PUBLIC_SIGNUP','local',1)",
    )
    .run();
});
async function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0;
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
  return String(
    (((digest[offset]! & 127) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
      1_000_000,
  ).padStart(6, "0");
}

describe("actual LOCAL API auth recovery and sensitive limiter", () => {
  it("keeps metadata reads outside ten-step signup/reset/MFA capacity and still throttles the next mutation", async () => {
    let authCalls = 0,
      regularCalls = 0;
    const bindings: ApiBindings = {
      ...(env as unknown as ApiBindings),
      ENVIRONMENT: "local",
      AUTH_BASE_URL: "https://api.test",
      CORS_ORIGINS: "https://portal.test",
      EMAIL_PROVIDER: "DEVELOPMENT_SINK",
      AUTH_RATE_LIMITER: {
        limit: async () => ({ success: ++authCalls <= 10 }),
      } as RateLimit,
      API_RATE_LIMITER: {
        limit: async () => {
          regularCalls++;
          return { success: true };
        },
      } as RateLimit,
    };
    const cookies = new Map<string, string>();
    const call = async (path: string, body?: object) => {
      const response = await apiWorker.fetch(
        new Request("https://api.test/api/v1" + path, {
          method: body ? "POST" : "GET",
          headers: {
            origin: "https://portal.test",
            "cf-connecting-ip": "192.0.2.141",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(cookies.size
              ? {
                  cookie: [...cookies]
                    .map(([key, value]) => key + "=" + value)
                    .join("; "),
                }
              : {}),
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
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";", 1)[0]!,
          separator = pair.indexOf("="),
          name = pair.slice(0, separator),
          value = pair.slice(separator + 1);
        if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(header))
          cookies.delete(name);
        else cookies.set(name, value);
      }
      return response;
    };
    for (let index = 0; index < 30; index++) {
      const response = await call("/auth/capabilities");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        registrationAvailable: true,
        recoveryAvailable: true,
      });
    }
    expect(authCalls).toBe(0);
    expect(regularCalls).toBe(30);
    const email = "local-auth-recovery@example.test",
      password = "synthetic-initial-password-123456",
      changed = "synthetic-new-password-123456";
    expect(
      (
        await call("/auth/sign-up/email", {
          email,
          password,
          name: "Synthetic LOCAL",
          termsAccepted: true,
          privacyAccepted: true,
          termsVersion: "1",
          privacyVersion: "1",
        })
      ).status,
    ).toBe(202);
    const user = await db
      .prepare("SELECT id FROM auth_users WHERE email=?")
      .bind(email)
      .first<{ id: string }>();
    expect(
      await db
        .prepare(
          "SELECT terms_version,privacy_version FROM iam_signup_consents WHERE auth_user_id=?",
        )
        .bind(user!.id)
        .first(),
    ).toEqual({ terms_version: "1", privacy_version: "1" });
    const verify = await db
      .prepare(
        "SELECT action_url FROM integration_local_email_sink WHERE auth_user_id=? AND kind='VERIFY_EMAIL'",
      )
      .bind(user!.id)
      .first<{ action_url: string }>();
    const link = new URL(verify!.action_url);
    expect(link.searchParams.get("callbackURL")).toBe(
      "https://portal.test/login",
    );
    expect(
      (await call(link.pathname.replace("/api/v1", "") + link.search)).status,
    ).toBe(302);
    const reset = await call("/auth/request-password-reset", { email });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ accepted: true });
    const captured = await db
      .prepare(
        "SELECT action_url FROM integration_local_email_sink WHERE auth_user_id=? AND kind='PASSWORD_RESET'",
      )
      .bind(user!.id)
      .first<{ action_url: string }>();
    const token = new URL(captured!.action_url).pathname.split("/").at(-1)!;
    expect(
      (await call("/auth/reset-password", { token, newPassword: changed }))
        .status,
    ).toBe(200);
    expect(
      (await call("/auth/sign-in/email", { email, password: changed })).status,
    ).toBe(200);
    const enrollment = await call("/auth/two-factor/enable", {
      password: changed,
      method: "totp",
    });
    expect(enrollment.status).toBe(200);
    const setup = (await enrollment.json()) as { totpURI: string };
    const secret = new URL(setup.totpURI).searchParams.get("secret")!;
    expect(
      (
        await call("/auth/two-factor/verify-totp", {
          code: await totp(secret),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
    expect((await call("/auth/sign-out", {})).status).toBe(200);
    const fresh = await call("/auth/sign-in/email", {
      email,
      password: changed,
    });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ twoFactorRedirect: true });
    expect(
      (
        await call("/auth/two-factor/verify-totp", {
          code: await totp(secret),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
    const principal = await call("/principal");
    expect(principal.status).toBe(200);
    expect(await principal.json()).toMatchObject({
      accountId: user!.id,
      mfaEnabled: true,
    });
    expect(authCalls).toBe(10);
    expect(regularCalls).toBe(31);
    expect((await call("/auth/request-password-reset", { email })).status).toBe(
      429,
    );
    expect(authCalls).toBe(11);
  }, 20_000);
});
