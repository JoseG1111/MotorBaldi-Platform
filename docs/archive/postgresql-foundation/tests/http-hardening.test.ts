import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  enforceBodyPolicy,
  enforceMutationPolicy,
  RequestLimiter,
} from "@motorbaldi/api/http-policy";
import { validateRequest } from "@motorbaldi/contracts/validation";
import { safeException } from "@motorbaldi/observability";

test("forwarded IP uses only configured proxy chain; direct spoof ignored", async () => {
  for (const trusted of [false, ["127.0.0.1/32"]] as const) {
    const app = Fastify({
      trustProxy: trusted === false ? false : [...trusted],
    });
    app.get("/ip", (request) => ({ ip: request.ip }));
    const response = await app.inject({
      url: "/ip",
      headers: { "x-forwarded-for": "198.51.100.10" },
      remoteAddress: "127.0.0.1",
    });
    assert.equal(
      response.json().ip,
      trusted === false ? "127.0.0.1" : "198.51.100.10",
    );
    const direct = await app.inject({
      url: "/ip",
      headers: { "x-forwarded-for": "198.51.100.10" },
      remoteAddress: "192.0.2.1",
    });
    assert.equal(direct.json().ip, "192.0.2.1");
    await app.close();
  }
});
test("mutation policy denies undeclared and browser cross-origin routes, permits verified machine fixture", async () => {
  const app = Fastify();
  app.addHook("onRequest", (req) =>
    enforceMutationPolicy(req, ["https://portal.test"]),
  );
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code((error as { status?: number }).status ?? 500)
      .send({ rejected: true }),
  );
  app.post("/default", () => ({ ok: true }));
  app.post(
    "/browser",
    { config: { mutationPolicy: { strategy: "browser" } } },
    () => ({ ok: true }),
  );
  app.post(
    "/machine",
    {
      config: {
        mutationPolicy: {
          strategy: "authenticated",
          authenticate: async (req) =>
            req.headers.authorization === "Bearer test-fixture",
        },
      },
    },
    () => ({ ok: true }),
  );
  const webhookSignature = createHmac("sha256", "fixture-signing-key")
    .update("fixture-event")
    .digest();
  app.post(
    "/webhook",
    {
      config: {
        mutationPolicy: {
          strategy: "authenticated",
          authenticate: async (req) => {
            const candidate = Buffer.from(
              String(req.headers["x-fixture-signature"] ?? ""),
              "hex",
            );
            return (
              candidate.length === webhookSignature.length &&
              timingSafeEqual(candidate, webhookSignature)
            );
          },
        },
      },
    },
    () => ({ ok: true }),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "x-fixture-signature": webhookSignature.toString("hex") },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/webhook",
        headers: { "x-fixture-signature": "invalid" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/default" })).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/browser",
        headers: { cookie: "session=fixture" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/browser",
        headers: { origin: "https://portal.test" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/machine",
        headers: { authorization: "Bearer test-fixture" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/machine" })).statusCode,
    401,
  );
  await app.close();
});
test("CORS allows PATCH and DELETE exact-origin preflight", async () => {
  const app = Fastify();
  await app.register(cors, {
    origin: ["https://portal.test"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "If-Match",
    ],
  });
  for (const method of ["PATCH", "DELETE"]) {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/fixture",
      headers: {
        origin: "https://portal.test",
        "access-control-request-method": method,
      },
    });
    assert.equal(response.statusCode, 204);
    assert.match(
      String(response.headers["access-control-allow-methods"]),
      new RegExp(method),
    );
  }
  await app.close();
});
test("content type policy is route and body aware", async () => {
  const request = (
    method: string,
    bodyPolicy: "json" | "bodyless" | "multipart" | undefined,
    headers: Record<string, string> = {},
  ) =>
    ({
      method,
      headers,
      routeOptions: { config: { bodyPolicy } },
    }) as never;
  assert.doesNotThrow(() => enforceBodyPolicy(request("DELETE", "bodyless")));
  assert.doesNotThrow(() => enforceBodyPolicy(request("POST", "multipart")));
  assert.throws(() => enforceBodyPolicy(request("POST", undefined)), {
    status: 415,
  });
  assert.doesNotThrow(() =>
    enforceBodyPolicy(
      request("POST", undefined, { "content-type": "application/json" }),
    ),
  );
});
test("Redis outage fails authentication closed and bounds general fallback", async () => {
  const limiter = new RequestLimiter(
    {
      eval: async () => {
        throw new Error("offline");
      },
    },
    "fixture",
  );
  await assert.rejects(
    limiter.check("fixture", true),
    /temporarily unavailable/,
  );
  for (let i = 0; i < 60; i++) await limiter.check("fixture", false);
  await assert.rejects(limiter.check("fixture", false), /Too many/);
});
test("strict validation rejects mass assignment on body, params and query with safe errors", () => {
  const schemas = {
    body: z.object({
      email: z
        .string()
        .email()
        .transform((v) => v.toLowerCase()),
    }),
    params: z.object({}),
    query: z.object({}),
  };
  for (const key of ["role", "verified", "organizationId", "ownerId"])
    assert.throws(
      () =>
        validateRequest(schemas, {
          body: { email: "fixture@example.test", [key]: "secret" },
        }),
      { code: "VALIDATION_ERROR" },
    );
  assert.throws(() =>
    validateRequest(schemas, {
      body: { email: "fixture@example.test" },
      query: { role: "admin" },
    }),
  );
  assert.throws(() =>
    validateRequest(schemas, {
      body: { email: "fixture@example.test" },
      params: { ownerId: "x" },
    }),
  );
  assert.equal(
    validateRequest(schemas, { body: { email: "FIXTURE@example.test" } }).body
      .email,
    "fixture@example.test",
  );
  const error = new Error("secret provider payload");
  error.stack = "Error: secret\n    at method (/private/path/app.js:12:3)";
  assert.deepEqual(safeException(error), {
    exceptionClass: "Error",
    sanitizedStack: "app.js:12:3",
  });
});
