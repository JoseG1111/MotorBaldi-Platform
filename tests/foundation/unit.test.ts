import { describe, expect, it } from "vitest";
import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import { canonical } from "@motorbaldi/shared";
import { openapi } from "@motorbaldi/api/openapi";
import {
  deterministicAntiAbuseVerifier,
  turnstileVerifier,
} from "@motorbaldi/auth/anti-abuse";
import {
  apiConfig,
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

  it("forbids remote Turnstile bypass and missing rate limiters", () => {
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
