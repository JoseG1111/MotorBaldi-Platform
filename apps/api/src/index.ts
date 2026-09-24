import { authentication, allowedAuthPaths } from "@motorbaldi/auth";
import { apiConfig, type ApiBindings } from "@motorbaldi/config";
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
const routeName = (pathname: string) =>
  pathname.startsWith("/api/v1/auth/")
    ? "/api/v1/auth/:action"
    : new Set([
          "/health",
          "/health/dependencies",
          "/api/v1/openapi.json",
          "/api/v1/principal",
          "/api/v1/foundation/idempotency-test",
        ]).has(pathname)
      ? pathname
      : "unmatched";
const corsHeaders = (
  origin: string | null,
  origins: readonly string[],
): Record<string, string> =>
  origin && origins.includes(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
        "access-control-allow-headers":
          "Content-Type,Idempotency-Key,Authorization,X-CSRF-Token",
        vary: "Origin",
      }
    : {};

function problem(
  error: unknown,
  requestId: string,
  cors: Record<string, string>,
) {
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
    {
      status,
      headers: { ...cors, "content-type": "application/problem+json" },
    },
  );
}

async function rateLimit(
  env: ApiBindings,
  request: Request,
  sensitive: boolean,
) {
  const limiter = sensitive ? env.AUTH_RATE_LIMITER : env.API_RATE_LIMITER;
  if (!limiter) {
    if (env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "production")
      throw new Problem(503, "RATE_LIMIT_CONFIGURATION", "Service unavailable");
    return;
  }
  const network = request.headers.get("cf-connecting-ip") ?? "local";
  if (
    !(
      await limiter.limit({
        key: sensitive ? `auth:${network}` : `public:${network}`,
      })
    ).success
  )
    throw new Problem(429, "RATE_LIMITED", "Too many requests");
}

async function route(
  request: Request,
  env: ApiBindings,
  ctx: ExecutionContext,
  requestId: string,
) {
  const c = apiConfig(env);
  const url = new URL(request.url);
  const cors = corsHeaders(request.headers.get("origin"), c.corsOrigins);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  await rateLimit(env, request, url.pathname.startsWith("/api/v1/auth/"));
  const requireMethod = (method: string) => {
    if (request.method !== method)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };

  if (url.pathname === "/health") {
    requireMethod("GET");
    return json({ status: "ok" }, { headers: cors });
  }
  if (url.pathname === "/api/v1/openapi.json") {
    requireMethod("GET");
    return json(openapi, { headers: cors });
  }

  await assertDatabaseEnvironment(env.DB, c.environment);
  if (url.pathname === "/health/dependencies") {
    requireMethod("GET");
    const d1 = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return json(
      {
        status: d1?.ok === 1 ? "ready" : "unavailable",
        dependencies: { d1: "available", r2: "configured" },
      },
      { headers: cors },
    );
  }
  const auth = authentication(env, c, requestId);
  if (url.pathname === "/api/v1/principal") {
    requireMethod("GET");
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
    if (path === "/sign-in/email" && !response.ok)
      ctx.waitUntil(
        env.DB.prepare(
          "INSERT INTO governance_security_events(id, code, request_id) VALUES (?, 'LOGIN_FAILED', ?)",
        )
          .bind(newId(), requestId)
          .run(),
      );
    return new Response(response.body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), ...cors },
    });
  }
  if (url.pathname === "/api/v1/foundation/idempotency-test") {
    requireMethod("POST");
    if (c.environment !== "local")
      throw new Problem(404, "NOT_FOUND", "Not found");
    const body = (await request.json()) as Json;
    const record = body as Record<string, Json>;
    const scope = buildIdempotencyScope({
      accountId:
        typeof record.accountId === "string"
          ? record.accountId
          : "018f0000-0000-7000-8000-000000000001",
      organizationId:
        typeof record.organizationId === "string"
          ? record.organizationId
          : undefined,
      operation:
        typeof record.operation === "string"
          ? record.operation
          : "foundation.test",
    });
    const key = request.headers.get("idempotency-key") ?? "";
    const response = await env.IDEMPOTENCY_COORDINATOR.getByName(
      scope.scope + ":" + key,
    ).fetch("https://idempotency/run", {
      method: "POST",
      body: JSON.stringify({ key, scope, request: body, requestId }),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
  throw new Problem(404, "NOT_FOUND", "Not found");
}

export default {
  async fetch(request: Request, env: ApiBindings, ctx: ExecutionContext) {
    const requestId = newId();
    const started = Date.now();
    let response: Response;
    let cors: Record<string, string> = {};
    try {
      const c = apiConfig(env);
      cors = corsHeaders(request.headers.get("origin"), c.corsOrigins);
      response = await route(request, env, ctx, requestId);
    } catch (error) {
      response = problem(error, requestId, cors);
    }
    response.headers.set("x-request-id", requestId);
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    logger.info({
      event: "http_request",
      service: "motorbaldi-api",
      method: request.method,
      operation: routeName(new URL(request.url).pathname),
      status: response.status,
      durationMs: Date.now() - started,
      requestId,
    });
    return response;
  },
} satisfies ExportedHandler<ApiBindings>;
