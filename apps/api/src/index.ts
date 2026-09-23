import { authentication, allowedAuthPaths } from "@motorbaldi/auth";
import { runtimeConfig, type PlatformBindings } from "@motorbaldi/config";
import { Problem } from "@motorbaldi/contracts";
import { assertDatabaseEnvironment } from "@motorbaldi/db/environment";
import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import { errorTracker, logger } from "@motorbaldi/observability";
import { newId, type Json } from "@motorbaldi/shared";
import { openapi } from "./openapi.js";

export { IdempotencyCoordinator, OutboxCoordinator } from "./coordinators.js";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });

function corsHeaders(
  request: Request,
  origins: readonly string[],
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !origins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "Content-Type,Idempotency-Key,If-Match,Authorization,X-CSRF-Token",
  };
}

function problem(error: unknown, requestId: string) {
  const status = error instanceof Problem ? error.status : 500;
  const code = error instanceof Problem ? error.code : "INTERNAL_ERROR";
  if (status >= 500)
    errorTracker.capture(code, requestId, error, "motorbaldi-api", "fetch");
  return json(
    {
      type: "about:blank",
      status,
      code,
      message:
        error instanceof Problem ? error.message : "Internal server error",
      requestId,
      ...(error instanceof Problem && error.details
        ? { details: error.details }
        : {}),
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

async function rateLimit(
  env: PlatformBindings,
  request: Request,
  sensitive: boolean,
) {
  const limiter = sensitive ? env.AUTH_RATE_LIMITER : env.API_RATE_LIMITER;
  if (!limiter) return;
  const key = request.headers.get("cf-connecting-ip") ?? "local";
  const result = await limiter.limit({ key });
  if (!result.success)
    throw new Problem(429, "RATE_LIMITED", "Too many requests");
}

async function handle(
  request: Request,
  env: PlatformBindings,
  ctx: ExecutionContext,
) {
  const requestId = newId();
  const started = Date.now();
  const c = runtimeConfig(env);
  const cors = corsHeaders(request, c.corsOrigins);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });

  await rateLimit(
    env,
    request,
    new URL(request.url).pathname.startsWith("/api/v1/auth"),
  );
  const url = new URL(request.url);
  const auth = authentication(env, c, requestId);

  try {
    if (url.pathname === "/health")
      return json({ status: "ok" }, { headers: cors });
    if (url.pathname === "/health/dependencies") {
      await assertDatabaseEnvironment(env.DB, c.environment);
      const d1 = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      const r2 = env.PRIVATE_BUCKET ? "configured" : "not_bound";
      return json(
        {
          status: d1?.ok === 1 ? "ready" : "unavailable",
          dependencies: { d1: "available", r2 },
        },
        { headers: cors },
      );
    }
    if (url.pathname === "/api/v1/openapi.json")
      return json(openapi, { headers: cors });
    if (url.pathname === "/api/v1/principal") {
      if (
        !request.headers.get("cookie") &&
        !request.headers.get("authorization")
      ) {
        throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
      }
      const principal = await auth.principal(request.headers);
      if (!principal)
        throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
      return json(principal, { headers: cors });
    }
    if (url.pathname.startsWith("/api/v1/auth/")) {
      const path = url.pathname.slice("/api/v1/auth".length);
      if (!allowedAuthPaths.has(path))
        throw new Problem(404, "NOT_FOUND", "Not found");
      const response = await auth.auth.handler(request);
      if (path === "/sign-in/email" && !response.ok) {
        ctx.waitUntil(
          env.DB.prepare(
            "INSERT INTO governance_security_events(id, code, request_id) VALUES (?, 'LOGIN_FAILED', ?)",
          )
            .bind(newId(), requestId)
            .run(),
        );
      }
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...Object.fromEntries(response.headers),
          ...cors,
          "x-request-id": requestId,
        },
      });
    }
    if (
      url.pathname === "/api/v1/foundation/idempotency-test" &&
      request.method === "POST"
    ) {
      const key = request.headers.get("idempotency-key") ?? "";
      const body = (await request.json()) as Json;
      const scope = buildIdempotencyScope({
        accountId: "018f0000-0000-7000-8000-000000000001",
        operation: "foundation.test",
      });
      const coordinator = env.IDEMPOTENCY_COORDINATOR?.getByName(
        scope.scope + ":" + key,
      );
      if (!coordinator)
        throw new Problem(
          503,
          "COORDINATOR_UNAVAILABLE",
          "Idempotency coordinator unavailable",
        );
      const response = await coordinator.fetch("https://idempotency/run", {
        method: "POST",
        body: JSON.stringify({
          key,
          scope,
          request: body,
          response: { ok: true, requestId },
        }),
      });
      return new Response(response.body, {
        status: response.status,
        headers: { ...cors, "content-type": "application/json" },
      });
    }
    throw new Problem(404, "NOT_FOUND", "Not found");
  } finally {
    logger.info({
      event: "http_request",
      service: "motorbaldi-api",
      method: request.method,
      operation: url.pathname,
      status: 0,
      durationMs: Date.now() - started,
      requestId,
    });
  }
}

export default {
  async fetch(request: Request, env: PlatformBindings, ctx: ExecutionContext) {
    const requestId = newId();
    try {
      const response = await handle(request, env, ctx);
      response.headers.set(
        "x-request-id",
        response.headers.get("x-request-id") ?? requestId,
      );
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("referrer-policy", "no-referrer");
      return response;
    } catch (error) {
      return problem(error, requestId);
    }
  },
};
