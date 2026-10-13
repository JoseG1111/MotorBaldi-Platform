import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { sha256Hex } from "@motorbaldi/shared";
import { apiConfig, type ApiBindings } from "@motorbaldi/config";
import { authEmailCapability, authOptions } from "@motorbaldi/auth";
import { createAuthEmailTransport } from "../../packages/messaging/src/auth-email.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const bindings = env as unknown as ApiBindings;
const db = bindings.DB;
const token = "synthetic-reset-token-123456789";
const recipientHash = await sha256Hex("owner@example.test");
const config = {
  environment: "development",
  enabled: true,
  testRecipientHashes: recipientHash,
  apiKey: "synthetic-resend-key",
  from: "auth@example.test",
  fromVerified: true,
  authBaseUrl: "https://api.test",
  trustedOrigins: ["https://portal.test"],
};
const resetUrl = `https://api.test/api/v1/auth/reset-password/${token}?callbackURL=${encodeURIComponent("https://portal.test/reset-password")}`;
const payload = {
  kind: "PASSWORD_RESET" as const,
  recipient: "owner@example.test",
  url: resetUrl,
  token,
  idempotencyKey: "auth-email-test-001",
  signal: new AbortController().signal,
};

beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
});

describe("dedicated Resend auth email", () => {
  it("fails closed without every explicit remote capability, independently of notification delivery", () => {
    for (const patch of [
      { enabled: false },
      { enabled: undefined },
      { apiKey: undefined },
      { fromVerified: false },
      { from: "bad\r\n@example.test" },
      { environment: "local" },
      { trustedOrigins: ["http://portal.test"] },
      { authBaseUrl: "https://api.test/path" },
    ])
      expect(createAuthEmailTransport({ ...config, ...patch })).toBeNull();
    for (const environment of ["development", "staging", "production"])
      expect(
        createAuthEmailTransport({ ...config, environment }),
      ).not.toBeNull();
  });
  it("requires a valid Development recipient allowlist and rejects unauthorized emails before HTTP", async () => {
    for (const testRecipientHashes of [
      undefined,
      "",
      "not-a-hash",
      "A".repeat(64),
      recipientHash + ",",
      [recipientHash, recipientHash].join(","),
      Array.from({ length: 11 }, (_, index) =>
        index.toString(16).padStart(64, "0"),
      ).join(","),
    ])
      expect(
        createAuthEmailTransport({ ...config, testRecipientHashes }),
      ).toBeNull();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ id: "authorized-id" }));
    const transport = createAuthEmailTransport(config, fetcher)!;
    expect(
      await transport.send({
        ...payload,
        recipient: "unauthorized@example.test",
      }),
    ).toEqual({ status: "REJECTED", code: "AUTHORITY_DENIED" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (await transport.send({ ...payload, recipient: " OWNER@EXAMPLE.TEST " }))
        .status,
    ).toBe("ACCEPTED");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).to).toEqual([
      "owner@example.test",
    ]);
    for (const environment of ["staging", "production"]) {
      const remote = createAuthEmailTransport(
        { ...config, environment, testRecipientHashes: undefined },
        fetcher,
      )!;
      expect(
        (
          await remote.send({
            ...payload,
            recipient: "legitimate-user@example.test",
          })
        ).status,
      ).toBe("ACCEPTED");
    }
  });
  it("submits a fixed reset template and exact provider request without claiming delivery", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "synthetic-provider-id" }));
    const transport = createAuthEmailTransport(config, fetcher)!;
    expect(await transport.send(payload)).toEqual({
      status: "ACCEPTED",
      providerReference: "synthetic-provider-id",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      signal: payload.signal,
      headers: {
        Authorization: "Bearer synthetic-resend-key",
        "Content-Type": "application/json",
        "Idempotency-Key": payload.idempotencyKey,
      },
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      from: "auth@example.test",
      to: ["owner@example.test"],
      subject: "Restablece tu contraseña de MotorBaldi",
      text: `Restablece tu contraseña de MotorBaldi: https://portal.test/reset-password?token=${token}\nEste enlace vence en 1 hora y solo puede usarse una vez. Si no solicitaste este cambio, ignora este mensaje.`,
    });
  });
  it("sends only the signed-token verification route to a fixed trusted callback", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: "verification-id" }));
    const transport = createAuthEmailTransport(config, fetcher)!;
    const signedShape = "synthetic.payload.signature";
    const url = `https://api.test/api/v1/auth/verify-email?token=${signedShape}&callbackURL=${encodeURIComponent("https://portal.test/login")}`;
    expect(
      (
        await transport.send({
          ...payload,
          kind: "VERIFY_EMAIL",
          url,
          token: signedShape,
        })
      ).status,
    ).toBe("ACCEPTED");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({
      subject: "Verifica tu correo en MotorBaldi",
      text: `Confirma tu correo en MotorBaldi: ${url}\nEste enlace vence en 1 hora. Si no creaste esta cuenta, ignora este mensaje.`,
    });
  });
  it("rejects untrusted origins, paths, duplicate tokens and arbitrary redirect queries before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = createAuthEmailTransport(config, fetcher)!;
    for (const url of [
      resetUrl.replace("https://api.test", "https://attacker.test"),
      resetUrl.replace("reset-password/", "sign-in/"),
      resetUrl + "&token=extra",
      resetUrl.replace(
        encodeURIComponent("https://portal.test/reset-password"),
        encodeURIComponent("https://attacker.test/reset-password"),
      ),
      resetUrl.replace(
        encodeURIComponent("https://portal.test/reset-password"),
        encodeURIComponent(
          "https://portal.test/reset-password?redirect=https://attacker.test",
        ),
      ),
      resetUrl + "#fragment",
    ])
      expect(await transport.send({ ...payload, url })).toEqual({
        status: "REJECTED",
        code: "INVALID_REQUEST",
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("classifies failure without leaking provider text, credentials, links or recipients and never retries", async () => {
    for (const [status, result] of [
      [400, "REJECTED"],
      [429, "UNKNOWN"],
      [500, "UNKNOWN"],
      [302, "UNKNOWN"],
    ] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("synthetic-private-provider-error", { status }),
        );
      expect(
        await createAuthEmailTransport(config, fetcher)!.send(payload),
      ).toEqual({
        status: result,
        code:
          result === "REJECTED" ? "TRANSPORT_REJECTED" : "TRANSPORT_UNKNOWN",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("synthetic-private-token"));
    expect(
      await createAuthEmailTransport(config, fetcher)!.send(payload),
    ).toEqual({ status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" });
    expect(fetcher).toHaveBeenCalledOnce();
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ private: "synthetic-private-body" }));
    expect(
      await createAuthEmailTransport(config, malformed)!.send(payload),
    ).toEqual({ status: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" });
  });
});

describe("remote Better Auth callback wiring", () => {
  it("uses the separate auth capability and fails honestly without writing a local sink", async () => {
    const remote = {
      ...bindings,
      ENVIRONMENT: "development" as const,
      AUTH_BASE_URL: "https://api.test",
      CORS_ORIGINS: "https://portal.test",
      EMAIL_PROVIDER: "RESEND",
      AUTH_EMAIL_DELIVERY_ENABLED: "true",
      AUTH_EMAIL_TEST_RECIPIENT_SHA256: recipientHash,
      RESEND_API_KEY: "synthetic-resend-key",
      RESEND_FROM: "auth@example.test",
      RESEND_DOMAIN_VERIFIED: "true",
      NOTIFICATION_EXTERNAL_DELIVERY_ENABLED: "false",
    };
    const c = apiConfig(remote);
    expect(authEmailCapability(remote, c)).toBe(true);
    expect(
      authEmailCapability(
        {
          ...remote,
          AUTH_EMAIL_DELIVERY_ENABLED: "false",
          NOTIFICATION_EXTERNAL_DELIVERY_ENABLED: "true",
        },
        c,
      ),
    ).toBe(false);
    expect(
      authOptions({ ...remote, RESEND_API_KEY: undefined }, c, "closed", true)
        .emailAndPassword?.disableSignUp,
    ).toBe(true);
    const options = authOptions(remote, c, "remote-auth-email", true);
    const user = {
      id: "remote-synthetic-user",
      name: "Synthetic",
      email: "owner@example.test",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const before = await db
      .prepare("SELECT count(*) n FROM integration_local_email_sink")
      .first<{ n: number }>();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "synthetic-resend-id" }));
    try {
      await options.emailAndPassword!.sendResetPassword!(
        { user, url: resetUrl, token },
        undefined,
      );
      expect(fetcher).toHaveBeenCalledOnce();
      fetcher.mockResolvedValue(
        new Response("synthetic-private-provider-text", { status: 500 }),
      );
      await expect(
        options.emailAndPassword!.sendResetPassword!(
          { user, url: resetUrl, token },
          undefined,
        ),
      ).rejects.toThrow("AUTH_EMAIL_SUBMISSION_FAILED");
      const disabled = authOptions(
        { ...remote, AUTH_EMAIL_DELIVERY_ENABLED: "false" },
        c,
        "disabled",
        true,
      );
      await expect(
        disabled.emailAndPassword!.sendResetPassword!(
          { user, url: resetUrl, token },
          undefined,
        ),
      ).rejects.toThrow("EMAIL_PROVIDER_UNCONFIGURED");
      expect(fetcher).toHaveBeenCalledTimes(2);
      const after = await db
        .prepare("SELECT count(*) n FROM integration_local_email_sink")
        .first<{ n: number }>();
      expect(after).toEqual(before);
    } finally {
      fetcher.mockRestore();
    }
  });
});

describe("Better Auth onboarding and reset state", () => {
  it("keeps the local sink, rejects unsigned verification, consumes reset once, expires tokens and revokes sessions", async () => {
    const local = {
      ...bindings,
      ENVIRONMENT: "local" as const,
      AUTH_BASE_URL: "https://api.test",
      CORS_ORIGINS: "https://portal.test",
      EMAIL_PROVIDER: "DEVELOPMENT_SINK",
    };
    const c = apiConfig(local);
    expect(authEmailCapability(local, c)).toBe(true);
    const options = authOptions(local, c, "auth-email-security-test", true);
    expect(options.emailAndPassword).toMatchObject({
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
    });
    const auth = betterAuth(options);
    const call = (path: string, body?: object) =>
      auth.handler(
        new Request("https://api.test/api/v1/auth" + path, {
          method: body ? "POST" : "GET",
          headers: {
            origin: "https://portal.test",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const email = "auth-onboarding@example.test";
    const password = "synthetic-password-123456";
    expect(
      (
        await call("/sign-up/email", {
          email,
          password,
          name: "Synthetic Owner",
          callbackURL: "https://portal.test/login",
        })
      ).status,
    ).toBe(200);
    const user = await db
      .prepare("SELECT id,email_verified FROM auth_users WHERE email=?")
      .bind(email)
      .first<{ id: string; email_verified: number }>();
    expect(user!.email_verified).toBe(0);
    const verify = await db
      .prepare(
        "SELECT action_url FROM integration_local_email_sink WHERE auth_user_id=? AND kind='VERIFY_EMAIL'",
      )
      .bind(user!.id)
      .first<{ action_url: string }>();
    expect(verify).toBeTruthy();
    expect(
      (await call("/verify-email?token=unsigned.synthetic.token")).status,
    ).toBe(401);
    expect(
      (
        await call(
          new URL(verify!.action_url).pathname.replace("/api/v1/auth", "") +
            new URL(verify!.action_url).search,
        )
      ).status,
    ).toBe(302);
    const signedIn = await call("/sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);
    expect(
      (await db
        .prepare("SELECT count(*) n FROM auth_sessions WHERE user_id=?")
        .bind(user!.id)
        .first<{ n: number }>())!.n,
    ).toBeGreaterThan(0);
    expect(
      (
        await call("/request-password-reset", {
          email,
          redirectTo: "https://portal.test/reset-password",
        })
      ).status,
    ).toBe(200);
    const reset = await db
      .prepare(
        "SELECT action_url FROM integration_local_email_sink WHERE auth_user_id=? AND kind='PASSWORD_RESET' ORDER BY rowid DESC LIMIT 1",
      )
      .bind(user!.id)
      .first<{ action_url: string }>();
    const resetToken = new URL(reset!.action_url).pathname.split("/").at(-1)!;
    const changed = "synthetic-replacement-password-123456";
    expect(
      (
        await call("/reset-password", {
          token: resetToken,
          newPassword: changed,
        })
      ).status,
    ).toBe(200);
    expect(
      (await db
        .prepare("SELECT count(*) n FROM auth_sessions WHERE user_id=?")
        .bind(user!.id)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    expect(
      (
        await call("/reset-password", {
          token: resetToken,
          newPassword: changed,
        })
      ).status,
    ).toBe(400);
    expect((await call("/sign-in/email", { email, password })).status).toBe(
      401,
    );
    expect(
      (await call("/sign-in/email", { email, password: changed })).status,
    ).toBe(200);
    expect(
      (
        await call("/request-password-reset", {
          email,
          redirectTo: "https://portal.test/reset-password",
        })
      ).status,
    ).toBe(200);
    const expiring = await db
      .prepare(
        "SELECT action_url FROM integration_local_email_sink WHERE auth_user_id=? AND kind='PASSWORD_RESET' ORDER BY rowid DESC LIMIT 1",
      )
      .bind(user!.id)
      .first<{ action_url: string }>();
    const expiredToken = new URL(expiring!.action_url).pathname
      .split("/")
      .at(-1)!;
    await db
      .prepare(
        "UPDATE auth_verifications SET expires_at='2000-01-01T00:00:00.000Z' WHERE identifier=?",
      )
      .bind("reset-password:" + expiredToken)
      .run();
    expect(
      (
        await call("/reset-password", {
          token: expiredToken,
          newPassword: password,
        })
      ).status,
    ).toBe(400);
    const existing = await call("/request-password-reset", {
      email,
      redirectTo: "https://portal.test/reset-password",
    });
    const missing = await call("/request-password-reset", {
      email: "missing@example.test",
      redirectTo: "https://portal.test/reset-password",
    });
    expect(existing.status).toBe(missing.status);
    expect(await existing.json()).toEqual(await missing.json());
  }, 30_000);
});
