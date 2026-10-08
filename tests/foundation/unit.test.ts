import { describe, expect, it } from "vitest";
import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import { canonical } from "@motorbaldi/shared";
import { openapi } from "@motorbaldi/api/openapi";
import {
  deterministicAntiAbuseVerifier,
  turnstileVerifier,
  siteverifyRetryId,
  remoteLeadVerifier,
} from "@motorbaldi/auth/anti-abuse";
import {
  apiConfig,
  backgroundWorkerConfig,
  type AdminBindings,
  type ApiBindings,
  type PortalBindings,
} from "@motorbaldi/config";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import portal from "../../apps/portal/src/index.js";
import admin from "../../apps/admin/src/index.js";

describe("foundation contracts", () => {
  it("builds stable idempotency scopes", () => {
    const scope = buildIdempotencyScope({
      accountId: "018f0000-0000-7000-8000-000000000001",
      operation: "foundation.test",
    });
    expect(scope.scope).toBe(
      canonical({
        accountId: "018f0000-0000-7000-8000-000000000001",
        operation: "foundation.test",
        organizationId: null,
      }),
    );
    expect(scope.ttlSeconds).toBe(3600);
  });

  it("fails closed for unknown idempotency operations", () => {
    expect(() =>
      buildIdempotencyScope({
        accountId: "018f0000-0000-7000-8000-000000000001",
        operation: "unknown.operation",
      }),
    ).toThrow(/Unknown/);
  });

  it("validates the Turnstile response contract without exposing tokens", async () => {
    const verifier = turnstileVerifier({
      secret: "server-secret",
      expectedHostname: "portal.test",
      fetcher: async () =>
        Response.json({
          success: true,
          action: "login",
          hostname: "portal.test",
        }),
    });
    await expect(
      verifier.verify({ token: "opaque-token", action: "login" }),
    ).resolves.toBeUndefined();
    await expect(
      turnstileVerifier({
        secret: "server-secret",
        fetcher: async () => Response.json({ success: false }),
      }).verify({ token: "bad" }),
    ).rejects.toMatchObject({ code: "ANTI_ABUSE_REJECTED" });
    await expect(
      deterministicAntiAbuseVerifier("local-pass").verify({
        token: "local-pass",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed on invalid Siteverify results and sends bounded retry inputs", async () => {
    expect(() => remoteLeadVerifier(undefined, "website.test")).toThrowError(
      expect.objectContaining({ code: "ANTI_ABUSE_UNAVAILABLE" }),
    );
    expect(() => remoteLeadVerifier("fixture", undefined)).toThrowError(
      expect.objectContaining({ code: "ANTI_ABUSE_UNAVAILABLE" }),
    );
    const calls: { url: string; body: FormData }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init!.body as FormData });
      return Response.json({
        success: true,
        action: "lead",
        hostname: "website.test",
      });
    };
    const verifier = turnstileVerifier({
      secret: "fixture",
      expectedHostname: "website.test",
      fetcher: fetcher as typeof fetch,
    });
    const retry = await siteverifyRetryId("application-key", "token-one");
    expect(retry).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await siteverifyRetryId("application-key", "token-one")).toBe(retry);
    expect(await siteverifyRetryId("application-key", "token-two")).not.toBe(
      retry,
    );
    await verifier.verify({
      token: "token-one",
      action: "lead",
      remoteIp: "192.0.2.1",
      idempotencyKey: retry,
    });
    expect(calls[0]!.url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(Object.fromEntries(calls[0]!.body.entries())).toEqual({
      secret: "fixture",
      response: "token-one",
      remoteip: "192.0.2.1",
      idempotency_key: retry,
    });
    for (const token of ["", "x".repeat(2049)])
      await expect(
        verifier.verify({ token, action: "lead" }),
      ).rejects.toMatchObject({ code: "ANTI_ABUSE_REJECTED" });
    expect(calls).toHaveLength(1);
    for (const result of [
      { success: true, action: "other", hostname: "website.test" },
      { success: true, action: "lead", hostname: "other.test" },
      { success: false },
    ])
      await expect(
        turnstileVerifier({
          secret: "fixture",
          expectedHostname: "website.test",
          fetcher: async () => Response.json(result),
        }).verify({ token: "token", action: "lead" }),
      ).rejects.toMatchObject({ code: "ANTI_ABUSE_REJECTED" });
    for (const fetcher of [
      async () => Response.json({ unexpected: true }),
      async () => {
        throw new Error("network");
      },
    ])
      await expect(
        turnstileVerifier({
          secret: "fixture",
          expectedHostname: "website.test",
          fetcher,
        }).verify({ token: "token", action: "lead" }),
      ).rejects.toMatchObject({ code: "ANTI_ABUSE_UNAVAILABLE" });
  });

  it("treats development as remote and keeps explicit local configuration", () => {
    const env = {
      ENVIRONMENT: "development",
      AUTH_BASE_URL: "https://api.test",
      CORS_ORIGINS: "https://portal.test",
      AUTH_SECRET: "x".repeat(32),
      AUTH_SECRETS: JSON.stringify([{ version: 1, value: "y".repeat(32) }]),
      API_RATE_LIMITER: {},
      AUTH_RATE_LIMITER: {},
    } as unknown as ApiBindings;
    expect(apiConfig(env).environment).toBe("development");
    expect(
      apiConfig({ ...env, PUBLIC_CORS_ORIGINS: "https://website.test" })
        .publicCorsOrigins,
    ).toEqual(["https://website.test"]);
    const changed = (patch: Record<string, unknown>) =>
      ({ ...env, ...patch }) as ApiBindings;
    expect(() =>
      apiConfig(changed({ AUTH_BASE_URL: "http://api.test" })),
    ).toThrow(/HTTPS/);
    expect(() =>
      apiConfig(changed({ CORS_ORIGINS: "http://portal.test" })),
    ).toThrow(/HTTPS/);
    for (const origin of [
      "http://website.test",
      "https://website.test/",
      " https://website.test",
      "https://website.test/path",
      "https://website.test:443",
      "broken",
    ])
      expect(() =>
        apiConfig(changed({ PUBLIC_CORS_ORIGINS: origin })),
      ).toThrow();
    for (const hostname of [
      "https://website.test",
      "website.test/path",
      "website.test?x=1",
      "website.test:443",
    ])
      expect(() =>
        apiConfig(changed({ TURNSTILE_EXPECTED_HOSTNAME: hostname })),
      ).toThrow();
    expect(() => apiConfig(changed({ AUTH_SECRETS: undefined }))).toThrow(
      /AUTH_SECRETS/,
    );
    expect(() =>
      apiConfig(changed({ AUTH_SECRETS: '[{"version":1,"value":"short"}]' })),
    ).toThrow(/AUTH_SECRETS/);
    expect(() => apiConfig(changed({ API_RATE_LIMITER: undefined }))).toThrow(
      /rate limit/,
    );
    expect(() => apiConfig(changed({ AUTH_RATE_LIMITER: undefined }))).toThrow(
      /rate limit/,
    );
    expect(() =>
      apiConfig(changed({ TURNSTILE_BYPASS_TOKEN: "forbidden" })),
    ).toThrow(/bypass/);
    expect(
      apiConfig(
        changed({
          ENVIRONMENT: "local",
          AUTH_BASE_URL: "http://localhost:8787",
          CORS_ORIGINS: "http://localhost:3000",
          AUTH_SECRETS: undefined,
          API_RATE_LIMITER: undefined,
          AUTH_RATE_LIMITER: undefined,
          TURNSTILE_BYPASS_TOKEN: "local-only",
        }),
      ).turnstileBypassToken,
    ).toBe("local-only");
  });

  it("rejects deterministic malware scanning remotely", () => {
    for (const environment of [
      "development",
      "staging",
      "production",
    ] as const) {
      expect(() =>
        backgroundWorkerConfig({
          ENVIRONMENT: environment,
          MALWARE_SCANNER_PROVIDER: "DETERMINISTIC_TEST",
        } as never),
      ).toThrow(/Remote scanner/);
      expect(
        backgroundWorkerConfig({
          ENVIRONMENT: environment,
          MALWARE_SCANNER_PROVIDER: "UNCONFIGURED",
        } as never).malwareScannerProvider,
      ).toBe("UNCONFIGURED");
    }
    expect(
      backgroundWorkerConfig({
        ENVIRONMENT: "local",
        MALWARE_SCANNER_PROVIDER: "DETERMINISTIC_TEST",
      } as never).malwareScannerProvider,
    ).toBe("DETERMINISTIC_TEST");
  });

  it("forbids production Turnstile bypass and missing rate limiters", () => {
    const env = {
      ENVIRONMENT: "production",
      AUTH_BASE_URL: "https://api.test",
      CORS_ORIGINS: "https://portal.test",
      AUTH_SECRET: "x".repeat(32),
      AUTH_SECRETS: JSON.stringify([{ version: 1, value: "y".repeat(32) }]),
      TURNSTILE_BYPASS_TOKEN: "forbidden",
    } as unknown as ApiBindings;
    expect(() => apiConfig(env)).toThrow(/bypass/);
    delete (env as unknown as { TURNSTILE_BYPASS_TOKEN?: string })
      .TURNSTILE_BYPASS_TOKEN;
    expect(() => apiConfig(env)).toThrow(/rate limit/);
  });

  it("decrypts data written before Better Auth secret rotation", async () => {
    const oldValue = "old-secret-value-that-is-at-least-32-chars";
    const newValue = "new-secret-value-that-is-at-least-32-chars";
    const encrypted = await symmetricEncrypt({
      key: { keys: new Map([[1, oldValue]]), currentVersion: 1 },
      data: "rotation-fixture",
    });
    await expect(
      symmetricDecrypt({
        key: {
          keys: new Map([
            [2, newValue],
            [1, oldValue],
          ]),
          currentVersion: 2,
        },
        data: encrypted,
      }),
    ).resolves.toBe("rotation-fixture");
  });

  it("publishes the foundation OpenAPI routes", () => {
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/health/dependencies",
        "/api/v1/principal",
        "/api/v1/openapi.json",
      ]),
    );
  });

  it("serves Spanish shells and proxies same-origin API paths", async () => {
    const seen: string[] = [];
    const env = {
      ENVIRONMENT: "local",
      API_SERVICE: {
        async fetch(request: Request) {
          seen.push(request.url);
          return new Response("proxied");
        },
      },
    } as unknown as PortalBindings & AdminBindings;
    const portalPage = await portal.fetch!(
      new Request("https://portal.test/"),
      env,
    );
    const adminPage = await admin.fetch!(
      new Request("https://admin.test/"),
      env,
    );
    expect(await portalPage.text()).toContain('<html lang="es">');
    expect(await adminPage.text()).toContain("Administración MotorBaldi");
    expect(
      await (
        await portal.fetch!(
          new Request("https://portal.test/api/v1/principal"),
          env,
        )
      ).text(),
    ).toBe("proxied");
    expect(seen).toEqual(["https://api.internal/api/v1/principal"]);
  });
});
