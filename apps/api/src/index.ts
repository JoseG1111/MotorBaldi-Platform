import {
  authenticateDevelopmentAutomation,
  issueDevelopmentAutomationAuthorization,
} from "@motorbaldi/auth";
import {
  automationRoute,
  validateAutomationCommand,
} from "./development-automation-scope.js";
import { partsRoutes } from "./parts-routes.js";
import { supportRoutes } from "./support-routes.js";
import { notificationRoutes } from "./notification-routes.js";
import {
  buildHostedCheckout,
  reconcilePaymentWebhook,
  reconcileStoredPayment,
  paymentGatewayCapabilities,
  sandboxPaymentsConfigured,
} from "./payment-gateway.js";
import { billingRoutes } from "./billing-routes.js";
import { inspectionRoutes } from "./inspection-routes.js";
import { workshopRoutes } from "./workshop-routes.js";
import { authentication, allowedAuthPaths } from "@motorbaldi/auth";
import { apiConfig, type ApiBindings } from "@motorbaldi/config";
import { Problem } from "@motorbaldi/contracts";
import { assertDatabaseEnvironment } from "@motorbaldi/db/environment";
import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import { errorTracker, logger } from "@motorbaldi/observability";
import { newId, type Json } from "@motorbaldi/shared";
import { files, unavailableScanner } from "@motorbaldi/storage";
import { hasVehiclePermission } from "@motorbaldi/vehicles";
import { vehicleRoutes } from "./vehicle-routes.js";
import { openapi } from "./openapi.js";
import { z, ZodError } from "zod";
import {
  remoteLeadVerifier,
  deterministicAntiAbuseVerifier,
  siteverifyRetryId,
} from "@motorbaldi/auth/anti-abuse";
import { leadInput } from "@motorbaldi/crm";
import {
  organizationInput,
  workspaces,
  memberRoles,
  locationScope,
  locationInput,
  addLocation,
  setCapabilities,
  startVerificationReview,
  endMembership,
  changeMembershipRoles,
  revokeInvitation,
  rejectMembershipRequest,
  cancelMembershipRequest,
  attachVerificationFile,
  requestVerificationInformation,
  suspendOrganization,
  updateOrganization,
  updateLocation,
  addIdentifier,
} from "@motorbaldi/organizations";
import {
  requireOrganizationPermission,
  requirePlatformPermission,
  assignPlatformRoles,
  platformRoleCodes,
} from "@motorbaldi/authz";
import {
  addContact,
  recordConsent,
  suspendAccount,
  resolveDuplicateCandidate,
} from "@motorbaldi/identity";
import {
  triageLead,
  linkLeadPerson,
  createPersonFromLead,
  recordActivity,
  activityInput,
  createNote,
  noteInput,
  createTask,
  taskInput,
  updateTask,
  assignLead,
  moveOpportunityStage,
  createTag,
  assignOpportunity,
  assignTask,
  assignTag,
} from "@motorbaldi/crm";
import {
  mechanicProfileInput,
  credentialInput,
  upsertMechanicProfile,
  setSpecialties,
  submitCredential,
  decideCredential,
} from "@motorbaldi/professional";

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
        "access-control-allow-methods":
          "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS",
        "access-control-allow-headers":
          "Content-Type,Idempotency-Key,Authorization,X-CSRF-Token",
        vary: "Origin",
      }
    : {};
export function forwardAuthResponse(
  response: Response,
  cors: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}
const routeCorsOrigins = (pathname: string, c: ReturnType<typeof apiConfig>) =>
  pathname === "/api/v1/public/leads" ? c.publicCorsOrigins : c.corsOrigins;

function requireTrustedMutationOrigin(
  request: Request,
  pathname: string,
  trustedOrigins: readonly string[],
) {
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
    pathname.startsWith("/api/v1/") &&
    !pathname.startsWith("/api/v1/auth/") &&
    pathname !== "/api/v1/public/leads" &&
    pathname !== "/api/v1/payments/wompi/events" &&
    pathname !== "/api/v1/foundation/idempotency-test" &&
    !trustedOrigins.includes(request.headers.get("origin") ?? "")
  )
    throw new Problem(403, "ORIGIN_FORBIDDEN", "Untrusted request origin");
}

function problem(
  error: unknown,
  requestId: string,
  cors: Record<string, string>,
) {
  const status =
    error instanceof Problem
      ? error.status
      : error instanceof ZodError
        ? 400
        : 500;
  const code =
    error instanceof Problem
      ? error.code
      : error instanceof ZodError
        ? "VALIDATION_ERROR"
        : "INTERNAL_ERROR";
  if (status >= 500)
    errorTracker.capture(code, requestId, error, "motorbaldi-api", "fetch");
  return json(
    {
      type: "about:blank",
      status,
      code,
      message:
        error instanceof Problem
          ? error.message
          : error instanceof ZodError
            ? "Invalid request"
            : "Internal server error",
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

async function featureEnabled(env: ApiBindings, key: string) {
  const row = await env.DB.prepare(
    "SELECT enabled FROM governance_feature_flags WHERE key=? AND environment=?",
  )
    .bind(key, env.ENVIRONMENT)
    .first<{ enabled: number }>();
  return row?.enabled === 1;
}

async function boundedJson(
  request: Request,
  maxBytes = 16384,
): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new Problem(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "JSON content type required",
    );
  const reader = request.body?.getReader();
  if (!reader) throw new Problem(400, "INVALID_BODY", "Request body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Problem(413, "BODY_TOO_LARGE", "Request too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Problem(400, "INVALID_JSON", "Invalid JSON");
  }
}

async function boundedEvidence(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Problem(400, "INVALID_FILE", "File required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 10485760) {
      await reader.cancel();
      throw new Problem(413, "BODY_TOO_LARGE", "File too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const machineRequests = new WeakMap<
  Headers,
  Promise<
    | (import("@motorbaldi/contracts").Principal & {
        personId: string;
        automationAuthorizationId: string;
      })
    | null
  >
>();

async function idempotentCommand(
  env: ApiBindings,
  headers: Headers,
  operation: string,
  accountId: string,
  body: Json,
  requestId: string,
  key: string,
  organizationId?: string,
) {
  let sessionId: string | null = null;
  let automationAuthorizationId: string | null = null;
  const machine = await machineRequests.get(headers);
  if (machine) {
    automationAuthorizationId = await issueDevelopmentAutomationAuthorization(
      env.DB,
      machine,
      operation,
      body,
    );
    await validateAutomationCommand(
      env.DB,
      { ...machine, automationAuthorizationId },
      operation,
      body,
    );
  }
  if (operation !== "crm.lead.create" && !machine) {
    const session = await authentication(
      env,
      apiConfig(env),
      requestId,
    ).auth.api.getSession({ headers });
    if (
      !session ||
      session.user.id !== accountId ||
      !session.user.emailVerified
    )
      throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
    sessionId = session.session.id;
  }
  const scope = buildIdempotencyScope({ accountId, operation, organizationId });
  const response = await env.IDEMPOTENCY_COORDINATOR.getByName(
    scope.scope + ":" + key,
  ).fetch("https://idempotency/run", {
    method: "POST",
    body: JSON.stringify({
      key,
      scope,
      request: body,
      requestId,
      sessionId,
      automationAuthorizationId,
    }),
  });
  const result = await response.json<Record<string, Json>>();
  if (!response.ok)
    throw new Problem(
      response.status,
      String(result.code ?? "COMMAND_FAILED"),
      String(result.message ?? "Command unavailable"),
    );
  return result;
}

function requiredKey(request: Request) {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[\x21-\x7e]{8,128}$/.test(key))
    throw new Problem(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Invalid idempotency key",
    );
  return key;
}

async function route(
  request: Request,
  env: ApiBindings,
  ctx: ExecutionContext,
  requestId: string,
) {
  const c = apiConfig(env);
  const url = new URL(request.url);
  const cors = corsHeaders(
    request.headers.get("origin"),
    routeCorsOrigins(url.pathname, c),
  );
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  requireTrustedMutationOrigin(request, url.pathname, c.corsOrigins);
  await rateLimit(env, request, url.pathname.startsWith("/api/v1/auth/"));
  const requireMethod = (method: string) => {
    if (request.method !== method)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  const listLimit = () =>
    Math.min(
      50,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
      ),
    );

  if (url.pathname === "/health") {
    requireMethod("GET");
    return json({ status: "ok" }, { headers: cors });
  }
  if (url.pathname === "/api/v1/openapi.json") {
    requireMethod("GET");
    return json(openapi, { headers: cors });
  }

  await assertDatabaseEnvironment(env.DB, c.environment);
  const machinePromise = authenticateDevelopmentAutomation(
    request,
    env,
    requestId,
  );
  machineRequests.set(request.headers, machinePromise);
  const machine = await machinePromise;
  if (machine) {
    const intercepted = await automationRoute(env.DB, request, machine);
    if (intercepted) return intercepted;
  }
  if (url.pathname === "/api/v1/payments/wompi/events") {
    requireMethod("POST");
    await reconcilePaymentWebhook(env, await boundedJson(request), requestId, {
      checksumHeader: request.headers.get("x-event-checksum") ?? undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return json(
      { accepted: true },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  }
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
  if (url.pathname === "/api/v1/public/leads") {
    requireMethod("POST");
    if (!(await featureEnabled(env, "PUBLIC_LEAD_INTAKE")))
      throw new Problem(404, "NOT_FOUND", "Not found");
    const raw = await boundedJson(request);
    const key = requiredKey(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Problem(400, "INVALID_BODY", "Invalid request");
    const { turnstileToken, ...lead } = raw as Record<string, unknown>;
    const input = leadInput.parse(lead);
    if (c.environment !== "local") {
      await remoteLeadVerifier(
        c.turnstileSecretKey,
        c.turnstileExpectedHostname,
      ).verify({
        token: typeof turnstileToken === "string" ? turnstileToken : "",
        action: "lead",
        remoteIp: request.headers.get("cf-connecting-ip") ?? undefined,
        idempotencyKey:
          typeof turnstileToken === "string" &&
          turnstileToken.length > 0 &&
          turnstileToken.length <= 2048
            ? await siteverifyRetryId(key, turnstileToken)
            : undefined,
      });
    } else if (c.turnstileBypassToken) {
      await deterministicAntiAbuseVerifier(c.turnstileBypassToken).verify({
        token: String(turnstileToken ?? ""),
      });
    }
    await idempotentCommand(
      env,
      request.headers,
      "crm.lead.create",
      "00000000-0000-7000-8000-000000000001",
      input,
      requestId,
      key,
    );
    return json({ accepted: true }, { status: 202, headers: cors });
  }
  if (url.pathname === "/api/v1/directory/organizations") {
    requireMethod("GET");
    const rows = await env.DB.prepare(
      "SELECT id,display_name,type,country_code FROM org_organizations WHERE status='ACTIVE' AND verification_status='VERIFIED' AND id>? ORDER BY id LIMIT 30",
    )
      .bind(url.searchParams.get("cursor") ?? "")
      .all();
    return json(
      { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
      { headers: cors },
    );
  }
  const signupEnabled =
    (await featureEnabled(env, "PUBLIC_SIGNUP")) &&
    c.environment === "local" &&
    c.emailProvider === "DEVELOPMENT_SINK";
  const auth = authentication(env, c, requestId, signupEnabled);
  const businessPrincipal = async () => {
    const principal = machine ?? (await auth.principal(request.headers));
    if (!principal?.personId)
      throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
    return principal as typeof principal & { personId: string };
  };
  if (url.pathname === "/api/v1/billing/payment-capabilities") {
    requireMethod("GET");
    await businessPrincipal();
    return json(paymentGatewayCapabilities(env), {
      headers: { ...cors, "cache-control": "no-store" },
    });
  }
  const reconcilePath = url.pathname.match(
    /^\/api\/v1\/admin\/billing\/payments\/([0-9a-f-]{36})\/reconcile$/,
  );
  if (reconcilePath) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    z.object({})
      .strict()
      .parse(await boundedJson(request));
    return json(
      await reconcileStoredPayment(env, actor, reconcilePath[1]!, requestId, {
        signal: AbortSignal.timeout(10_000),
      }),
      { headers: { ...cors, "cache-control": "no-store" } },
    );
  }
  const checkoutPath = url.pathname.match(
    /^\/api\/v1\/billing\/subscriptions\/([0-9a-f-]{36})\/checkout$/,
  );
  if (checkoutPath) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    if (!sandboxPaymentsConfigured(env))
      throw new Problem(
        503,
        "PAYMENTS_UNAVAILABLE",
        "Sandbox payment gateway unavailable",
      );
    z.object({})
      .strict()
      .parse(await boundedJson(request));
    const subscriptionId = checkoutPath[1]!;
    const reserved = (await idempotentCommand(
      env,
      request.headers,
      "billing.checkout.create",
      actor.accountId,
      { subscriptionId },
      requestId,
      requiredKey(request),
    )) as { paymentId: string };
    return json(
      await buildHostedCheckout(env, actor, {
        subscriptionId,
        paymentId: reserved.paymentId,
      }),
      { headers: { ...cors, "cache-control": "no-store" } },
    );
  }
  if (url.pathname === "/api/v1/development/automation/fixtures/parts/enable") {
    requireMethod("POST");
    if (!machine)
      throw new Problem(
        403,
        "DEVELOPMENT_AUTOMATION_DENIED",
        "Development automation unavailable",
      );
    return json(
      await idempotentCommand(
        env,
        request.headers,
        "development.fixture.parts.enable",
        machine.accountId,
        (await boundedJson(request)) as Json,
        requestId,
        requiredKey(request),
      ),
      { headers: cors },
    );
  }
  const partsResponse = await partsRoutes(
    request,
    env.DB,
    businessPrincipal,
    async (operation, body, organizationId) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
        organizationId,
      ),
    () => boundedJson(request),
    cors,
  );
  if (partsResponse) return partsResponse;
  const supportResponse = await supportRoutes(
    request,
    env.DB,
    businessPrincipal,
    async (operation, body) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
      ),
    () => boundedJson(request),
    cors,
  );
  if (supportResponse) return supportResponse;
  const notificationResponse = await notificationRoutes(
    request,
    env.DB,
    businessPrincipal,
    async (operation, body) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
      ),
    () => boundedJson(request),
    cors,
  );
  if (notificationResponse) return notificationResponse;
  const billingResponse = await billingRoutes(
    request,
    env.DB,
    businessPrincipal,
    async (operation, body) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
      ),
    () => boundedJson(request),
    cors,
    sandboxPaymentsConfigured(env),
  );
  if (billingResponse) return billingResponse;
  const inspectionResponse = await inspectionRoutes(
    request,
    env.DB,
    env.PRIVATE_BUCKET,
    businessPrincipal,
    async (operation, body) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
      ),
    () => boundedJson(request),
    cors,
  );
  if (inspectionResponse) return inspectionResponse;
  const workshopResponse = await workshopRoutes(
    request,
    env.DB,
    env.PRIVATE_BUCKET,
    businessPrincipal,
    async (operation, body, organizationId) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
        organizationId,
      ),
    () => boundedJson(request),
    cors,
  );
  if (workshopResponse) return workshopResponse;
  const vehicleResponse = await vehicleRoutes(
    request,
    env.DB,
    businessPrincipal,
    async (operation, body) =>
      idempotentCommand(
        env,
        request.headers,
        operation,
        (await businessPrincipal()).accountId,
        body,
        requestId,
        requiredKey(request),
      ),
    () => boundedJson(request),
    cors,
  );
  if (vehicleResponse) return vehicleResponse;
  const vehicleRead = async (vehicleId: string) => {
    const actor = await businessPrincipal();
    if (!(await hasVehiclePermission(env.DB, actor, vehicleId, "vehicle.read")))
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
    const row = await env.DB.prepare(
      "SELECT id,kind_code,specification_json,version FROM vehicle_vehicles WHERE id=?",
    )
      .bind(vehicleId)
      .first<{
        id: string;
        kind_code: string;
        specification_json: string;
        version: number;
      }>();
    if (!row) throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
    return {
      id: row.id,
      kindCode: row.kind_code,
      specification: JSON.parse(row.specification_json),
      version: row.version,
    };
  };
  const vehicleMatch = url.pathname.match(
    /^\/api\/v1\/vehicles\/([0-9a-f-]{36})$/,
  );
  if (vehicleMatch) {
    requireMethod("GET");
    return json(await vehicleRead(vehicleMatch[1]!), { headers: cors });
  }
  if (url.pathname === "/api/v1/me/garage") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    const rows = await env.DB.prepare(
      "SELECT vehicle_id FROM vehicle_garage_entries WHERE person_id=? ORDER BY added_at DESC,vehicle_id LIMIT 30",
    )
      .bind(actor.personId)
      .all<{ vehicle_id: string }>();
    const items = [];
    for (const entry of rows.results)
      if (
        await hasVehiclePermission(
          env.DB,
          actor,
          entry.vehicle_id,
          "vehicle.read",
        )
      )
        items.push(await vehicleRead(entry.vehicle_id));
    return json({ items }, { headers: cors });
  }
  if (url.pathname === "/api/v1/me/evidence-files") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,status,last_error_code,declared_mime,size_bytes,created_at FROM storage_files WHERE uploaded_by_account_id=? AND status <> 'DELETED' ORDER BY created_at DESC,id DESC LIMIT 50",
      )
        .bind(actor.accountId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    const mime =
      request.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() ?? "";
    const declaredSize = Number(request.headers.get("x-file-size"));
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 1 ||
      declaredSize > 10485760
    )
      throw new Problem(400, "INVALID_FILE", "Invalid file size");
    const bytes = await boundedEvidence(request);
    if (bytes.length !== declaredSize)
      throw new Problem(400, "INVALID_FILE", "File size mismatch");
    const storage = files(env.DB, env.PRIVATE_BUCKET, {
      scanner: unavailableScanner,
    });
    const upload = await storage.requestUpload(
      actor.accountId,
      mime,
      declaredSize,
      requestId,
    );
    await storage.putQuarantineObject(upload.id, bytes, mime);
    return json(
      { fileId: upload.id, status: "QUARANTINED" },
      { status: 202, headers: cors },
    );
  }
  const ownEvidence = url.pathname.match(
    /^\/api\/v1\/me\/evidence-files\/([0-9a-f-]{36})$/,
  );
  if (ownEvidence) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    const row = await env.DB.prepare(
      "SELECT id,status,last_error_code,declared_mime,size_bytes FROM storage_files WHERE id=? AND uploaded_by_account_id=?",
    )
      .bind(ownEvidence[1]!, actor.accountId)
      .first();
    if (!row) throw new Problem(404, "FILE_NOT_FOUND", "File unavailable");
    return json(row, { headers: cors });
  }
  if (
    url.pathname === "/api/v1/me" ||
    url.pathname === "/api/v1/me/workspaces"
  ) {
    requireMethod("GET");
    const principal = await auth.principal(request.headers);
    if (!principal?.personId)
      throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
    return json(
      url.pathname.endsWith("/workspaces")
        ? await workspaces(env.DB, principal.personId)
        : principal,
      { headers: cors },
    );
  }
  if (url.pathname === "/api/v1/organizations") {
    requireMethod("POST");
    if (!(await featureEnabled(env, "ORGANIZATION_CREATION")))
      throw new Problem(404, "NOT_FOUND", "Not found");
    const principal = await auth.principal(request.headers);
    if (!principal?.personId)
      throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
    const body = organizationInput.parse(await boundedJson(request));
    const result = await idempotentCommand(
      env,
      request.headers,
      "organization.create",
      principal.accountId,
      body,
      requestId,
      requiredKey(request),
    );
    return json(result, { status: 201, headers: cors });
  }
  const organizationMatch = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})$/,
  );
  if (organizationMatch) {
    const principal = await businessPrincipal();
    const organizationId = organizationMatch[1]!;
    if (request.method === "PATCH") {
      const body = z
        .object({
          legalName: z.string().trim().min(1).max(240),
          displayName: z.string().trim().min(1).max(240),
          version: z.number().int().positive(),
        })
        .strict()
        .parse(await boundedJson(request));
      return json(
        {
          version: await updateOrganization(
            env.DB,
            principal,
            organizationId,
            body,
            requestId,
          ),
        },
        { headers: cors },
      );
    }
    requireMethod("GET");
    await requireOrganizationPermission(
      env.DB,
      principal,
      organizationId,
      "org.read",
    );
    const organization = await env.DB.prepare(
      "SELECT id,type,legal_name,display_name,country_code,status,verification_status,version FROM org_organizations WHERE id=?",
    )
      .bind(organizationId)
      .first();
    if (!organization)
      throw new Problem(
        404,
        "ORGANIZATION_NOT_FOUND",
        "Organization unavailable",
      );
    return json(organization, { headers: cors });
  }
  const orgPermissions = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/permissions$/,
  );
  if (orgPermissions) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    const organizationId = orgPermissions[1]!;
    await requireOrganizationPermission(
      env.DB,
      actor,
      organizationId,
      "org.read",
    );
    const rows = await env.DB.prepare(
      "SELECT DISTINCT rp.permission_code AS code FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE m.person_id=? AND m.organization_id=? AND m.status='ACTIVE' ORDER BY rp.permission_code",
    )
      .bind(actor.personId, organizationId)
      .all<{ code: string }>();
    return json(
      { permissions: rows.results.map((row) => row.code) },
      { headers: cors },
    );
  }
  const orgIdentifiers = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/identifiers$/,
  );
  if (orgIdentifiers) {
    const actor = await businessPrincipal(),
      organizationId = orgIdentifiers[1]!;
    await requireOrganizationPermission(
      env.DB,
      actor,
      organizationId,
      "org.update",
    );
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,country_code,identifier_type,verification_status,created_at FROM org_identifiers WHERE organization_id=? ORDER BY created_at DESC LIMIT 50",
      )
        .bind(organizationId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    const body = z
      .object({
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        identifierType: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
        value: z.string().trim().min(1).max(256),
      })
      .strict()
      .parse(await boundedJson(request));
    return json(
      {
        identifierId: await addIdentifier(
          env.DB,
          actor,
          organizationId,
          body,
          requestId,
        ),
      },
      { status: 201, headers: cors },
    );
  }
  const locationPatch = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/locations\/([0-9a-f-]{36})$/,
  );
  if (locationPatch) {
    requireMethod("PATCH");
    const actor = await businessPrincipal();
    const body = z
      .object({
        name: z.string().trim().min(1).max(160),
        addressLine1: z.string().trim().min(1).max(240),
        city: z.string().trim().min(1).max(160),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(await boundedJson(request));
    return json(
      {
        version: await updateLocation(
          env.DB,
          actor,
          locationPatch[1]!,
          locationPatch[2]!,
          body,
          requestId,
        ),
      },
      { headers: cors },
    );
  }
  if (url.pathname === "/api/v1/me/profile") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT id,status,given_name,middle_name,family_name,second_family_name,display_name,preferred_locale,country_code,version FROM iam_people WHERE id=?",
      )
        .bind(actor.personId)
        .first();
      return json(row, { headers: cors });
    }
    requireMethod("PATCH");
    const body = z
      .object({
        givenName: z.string().trim().min(1).max(120),
        familyName: z.string().trim().min(1).max(120),
        displayName: z.string().trim().max(240).optional(),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(await boundedJson(request));
    const result = await env.DB.prepare(
      "UPDATE iam_people SET given_name=?,family_name=?,display_name=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='ACTIVE'",
    )
      .bind(
        body.givenName,
        body.familyName,
        body.displayName ?? null,
        new Date().toISOString(),
        actor.personId,
        body.version,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new Problem(409, "VERSION_CONFLICT", "Stale profile version");
    return json({ version: body.version + 1 }, { headers: cors });
  }
  if (url.pathname === "/api/v1/me/contact-methods") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,type,raw_value,label,is_primary,verification_status FROM iam_contact_methods WHERE person_id=? ORDER BY is_primary DESC,created_at DESC LIMIT 100",
      )
        .bind(actor.personId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    const body = z
      .object({
        type: z.enum(["EMAIL", "PHONE"]),
        value: z.string().min(1).max(320),
      })
      .strict()
      .parse(await boundedJson(request));
    return json(
      {
        id: await addContact(
          env.DB,
          actor.personId,
          body.type,
          body.value,
          "SELF_SERVICE",
        ),
      },
      { status: 201, headers: cors },
    );
  }
  if (url.pathname === "/api/v1/me/consents") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,purpose,policy_version,status,source,occurred_at FROM iam_consent_events WHERE person_id=? ORDER BY occurred_at DESC,id DESC LIMIT 100",
      )
        .bind(actor.personId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    const body = z
      .object({
        purpose: z.enum([
          "TERMS",
          "PRIVACY",
          "MARKETING_EMAIL",
          "MARKETING_SMS",
          "MARKETING_WHATSAPP",
        ]),
        policyVersion: z.string().min(1).max(64),
        status: z.enum(["GRANTED", "REVOKED"]),
      })
      .strict()
      .refine(
        (value) =>
          !(
            ["TERMS", "PRIVACY"].includes(value.purpose) &&
            value.status === "REVOKED"
          ),
        "Legal policy acceptance cannot be revoked here",
      )
      .parse(await boundedJson(request));
    await recordConsent(
      env.DB,
      actor.personId,
      body.purpose,
      body.policyVersion,
      body.status,
      "SELF_SERVICE",
      requestId,
    );
    return json({ recorded: true }, { status: 201, headers: cors });
  }
  if (url.pathname === "/api/v1/me/mechanic-profile") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT person_id,professional_status,bio,years_experience,version FROM professional_mechanic_profiles WHERE person_id=?",
      )
        .bind(actor.personId)
        .first();
      return json(row, { headers: cors });
    }
    requireMethod("PUT");
    const raw = z
      .object({
        bio: z.string().trim().max(2000).optional(),
        yearsExperience: z.number().int().min(0).max(80).optional(),
        version: z.number().int().positive().optional(),
      })
      .strict()
      .parse(await boundedJson(request));
    const { version, ...profile } = raw;
    return json(
      {
        version: await upsertMechanicProfile(
          env.DB,
          actor.personId,
          mechanicProfileInput.parse(profile),
          version,
        ),
      },
      { headers: cors },
    );
  }
  if (url.pathname === "/api/v1/me/specialties") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT code FROM professional_person_specialties WHERE person_id=? ORDER BY code",
      )
        .bind(actor.personId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("PUT");
    const body = z
      .object({ codes: z.array(z.string().regex(/^[A-Z_]+$/)).max(20) })
      .strict()
      .parse(await boundedJson(request));
    await setSpecialties(env.DB, actor.personId, body.codes);
    return json({ updated: true }, { headers: cors });
  }
  if (url.pathname === "/api/v1/me/credentials") {
    const actor = await businessPrincipal();
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,credential_type,country_code,issuer,issued_at,expires_at,status,version FROM professional_credentials WHERE person_id=? ORDER BY created_at DESC LIMIT 50",
      )
        .bind(actor.personId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    const body = credentialInput.parse(await boundedJson(request));
    return json(
      {
        credentialId: await submitCredential(
          env.DB,
          actor.personId,
          body,
          requestId,
        ),
      },
      { status: 201, headers: cors },
    );
  }
  if (url.pathname === "/api/v1/me/membership-requests") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    const rows = await env.DB.prepare(
      "SELECT r.id,r.organization_id,o.display_name,r.status,r.created_at,r.expires_at FROM org_membership_requests r JOIN org_organizations o ON o.id=r.organization_id WHERE r.person_id=? ORDER BY r.created_at DESC LIMIT 50",
    )
      .bind(actor.personId)
      .all();
    return json(rows.results, { headers: cors });
  }
  if (url.pathname === "/api/v1/invitations/accept") {
    requireMethod("POST");
    const actor = await businessPrincipal();
    const body = z
      .object({ token: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
      .parse(await boundedJson(request));
    const result = await idempotentCommand(
      env,
      request.headers,
      "organization.invitation.accept",
      actor.accountId,
      body,
      requestId,
      requiredKey(request),
    );
    return json(result, { headers: cors });
  }
  const orgAction = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/(locations|capabilities|members|invitations|membership-requests|verification\/submit)$/,
  );
  if (orgAction) {
    const organizationId = orgAction[1]!,
      action = orgAction[2]!;
    const actor = await businessPrincipal();
    if (action === "locations") {
      if (request.method === "GET") {
        const membershipId = await requireOrganizationPermission(
          env.DB,
          actor,
          organizationId,
          "org.location.read",
        );
        const rows = await env.DB.prepare(
          "SELECT l.id,l.name,l.location_type,l.country_code,l.administrative_area,l.city,l.postal_code,l.address_line_1,l.address_line_2,l.latitude,l.longitude,l.status,l.version FROM org_locations l JOIN org_memberships m ON m.id=? WHERE l.organization_id=? AND l.id>? AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS (SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=l.organization_id AND ml.location_id=l.id)) ORDER BY l.id LIMIT ?",
        )
          .bind(
            membershipId,
            organizationId,
            url.searchParams.get("cursor") ?? "",
            listLimit(),
          )
          .all();
        return json(
          { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
          { headers: cors },
        );
      }
      requireMethod("POST");
      return json(
        {
          locationId: await addLocation(
            env.DB,
            actor,
            organizationId,
            locationInput.parse(await boundedJson(request)),
            requestId,
          ),
        },
        { status: 201, headers: cors },
      );
    }
    if (action === "capabilities") {
      if (request.method === "GET") {
        await requireOrganizationPermission(
          env.DB,
          actor,
          organizationId,
          "org.read",
        );
        const rows = await env.DB.prepare(
          "SELECT code FROM org_capabilities WHERE organization_id=? ORDER BY code",
        )
          .bind(organizationId)
          .all();
        return json(rows.results, { headers: cors });
      }
      requireMethod("PUT");
      const body = z
        .object({ codes: z.array(z.string().regex(/^[A-Z_]+$/)).max(20) })
        .strict()
        .parse(await boundedJson(request));
      await setCapabilities(
        env.DB,
        actor,
        organizationId,
        body.codes,
        requestId,
      );
      return json({ updated: true }, { headers: cors });
    }
    if (action === "members") {
      requireMethod("GET");
      await requireOrganizationPermission(
        env.DB,
        actor,
        organizationId,
        "org.member.read",
      );
      const rows = await env.DB.prepare(
        "SELECT m.id,m.person_id,m.status,m.location_scope_type,p.display_name,p.given_name,p.family_name,group_concat(r.code) AS roles FROM org_memberships m JOIN iam_people p ON p.id=m.person_id LEFT JOIN org_membership_roles mr ON mr.membership_id=m.id LEFT JOIN authz_roles r ON r.id=mr.role_id WHERE m.organization_id=? AND m.id>? GROUP BY m.id ORDER BY m.id LIMIT ?",
      )
        .bind(organizationId, url.searchParams.get("cursor") ?? "", listLimit())
        .all();
      return json(
        { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
        { headers: cors },
      );
    }
    if (action === "invitations") {
      if (request.method === "GET") {
        await requireOrganizationPermission(
          env.DB,
          actor,
          organizationId,
          "org.member.read",
        );
        const rows = await env.DB.prepare(
          "SELECT id,target_email,proposed_roles_json,location_scope_type,status,created_at,expires_at FROM org_invitations WHERE organization_id=? AND id>? ORDER BY id LIMIT ?",
        )
          .bind(
            organizationId,
            url.searchParams.get("cursor") ?? "",
            listLimit(),
          )
          .all();
        return json(
          { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
          { headers: cors },
        );
      }
      requireMethod("POST");
      const body = z
        .object({
          targetEmail: z.string().email(),
          roles: memberRoles,
          scope: locationScope,
        })
        .strict()
        .parse(await boundedJson(request));
      const result = await idempotentCommand(
        env,
        request.headers,
        "organization.invitation.create",
        actor.accountId,
        { organizationId, ...body },
        requestId,
        requiredKey(request),
        organizationId,
      );
      return json(result, { status: 201, headers: cors });
    }
    if (action === "membership-requests") {
      if (request.method === "GET") {
        await requireOrganizationPermission(
          env.DB,
          actor,
          organizationId,
          "org.membership_request.review",
        );
        const rows = await env.DB.prepare(
          "SELECT id,person_id,requested_roles_json,location_scope_type,status,created_at,expires_at FROM org_membership_requests WHERE organization_id=? AND id>? ORDER BY id LIMIT ?",
        )
          .bind(
            organizationId,
            url.searchParams.get("cursor") ?? "",
            listLimit(),
          )
          .all();
        return json(
          { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
          { headers: cors },
        );
      }
      requireMethod("POST");
      const body = z
        .object({
          roles: memberRoles,
          scope: locationScope,
          message: z.string().max(2000).optional(),
        })
        .strict()
        .parse(await boundedJson(request));
      const result = await idempotentCommand(
        env,
        request.headers,
        "organization.membership-request.create",
        actor.accountId,
        { organizationId, ...body },
        requestId,
        requiredKey(request),
        organizationId,
      );
      return json(result, { status: 201, headers: cors });
    }
    requireMethod("POST");
    const result = await idempotentCommand(
      env,
      request.headers,
      "organization.verification.submit",
      actor.accountId,
      { organizationId },
      requestId,
      requiredKey(request),
      organizationId,
    );
    return json(result, { status: 202, headers: cors });
  }
  const approveRequest = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/membership-requests\/([0-9a-f-]{36})\/approve$/,
  );
  if (approveRequest) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    const organizationId = approveRequest[1]!,
      membershipRequestId = approveRequest[2]!;
    const result = await idempotentCommand(
      env,
      request.headers,
      "organization.membership-request.approve",
      actor.accountId,
      { organizationId, membershipRequestId },
      requestId,
      requiredKey(request),
      organizationId,
    );
    return json(result, { headers: cors });
  }
  const memberAction = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})\/(end|roles)$/,
  );
  if (memberAction) {
    const actor = await businessPrincipal(),
      organizationId = memberAction[1]!,
      membershipId = memberAction[2]!;
    if (memberAction[3] === "end") {
      requireMethod("POST");
      await endMembership(
        env.DB,
        actor,
        organizationId,
        membershipId,
        requestId,
      );
      return json({ ended: true }, { headers: cors });
    }
    requireMethod("PUT");
    const body = z
      .object({ roles: memberRoles })
      .strict()
      .parse(await boundedJson(request));
    await changeMembershipRoles(
      env.DB,
      actor,
      organizationId,
      membershipId,
      body.roles,
      requestId,
    );
    return json({ updated: true }, { headers: cors });
  }
  const invitationRevoke = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/invitations\/([0-9a-f-]{36})\/revoke$/,
  );
  if (invitationRevoke) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await revokeInvitation(
      env.DB,
      actor,
      invitationRevoke[1]!,
      invitationRevoke[2]!,
      requestId,
    );
    return json({ revoked: true }, { headers: cors });
  }
  const requestAction = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/membership-requests\/([0-9a-f-]{36})\/(reject|cancel)$/,
  );
  if (requestAction) {
    requireMethod("POST");
    const actor = await businessPrincipal(),
      organizationId = requestAction[1]!,
      membershipRequestId = requestAction[2]!;
    if (requestAction[3] === "cancel")
      await cancelMembershipRequest(
        env.DB,
        actor,
        organizationId,
        membershipRequestId,
      );
    else {
      const body = z
        .object({ reason: z.string().trim().min(5).max(1000) })
        .strict()
        .parse(await boundedJson(request));
      await rejectMembershipRequest(
        env.DB,
        actor,
        organizationId,
        membershipRequestId,
        body.reason,
        requestId,
      );
    }
    return json({ updated: true }, { headers: cors });
  }
  const evidenceAttach = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/verification\/([0-9a-f-]{36})\/files$/,
  );
  const organizationCases = url.pathname.match(
    /^\/api\/v1\/organizations\/([0-9a-f-]{36})\/verification\/cases$/,
  );
  if (organizationCases) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requireOrganizationPermission(
      env.DB,
      actor,
      organizationCases[1]!,
      "org.verification.submit",
    );
    const rows = await env.DB.prepare(
      "SELECT id,status,submitted_at FROM org_verification_cases WHERE organization_id=? ORDER BY submitted_at DESC,id DESC LIMIT 20",
    )
      .bind(organizationCases[1]!)
      .all();
    return json(rows.results, { headers: cors });
  }
  if (evidenceAttach) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    const body = z
      .object({ fileId: z.string().uuid() })
      .strict()
      .parse(await boundedJson(request));
    await attachVerificationFile(
      env.DB,
      actor,
      evidenceAttach[1]!,
      evidenceAttach[2]!,
      body.fileId,
      requestId,
    );
    return json({ attached: true }, { status: 201, headers: cors });
  }
  const evidenceRead = url.pathname.match(
    /^\/api\/v1\/(admin\/)?organizations\/([0-9a-f-]{36})\/verification\/([0-9a-f-]{36})\/files\/([0-9a-f-]{36})$/,
  );
  if (evidenceRead) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    const organizationId = evidenceRead[2]!,
      caseId = evidenceRead[3]!,
      fileId = evidenceRead[4]!;
    if (evidenceRead[1])
      await requirePlatformPermission(
        env.DB,
        actor,
        "platform.organization.verify",
      );
    else
      await requireOrganizationPermission(
        env.DB,
        actor,
        organizationId,
        "org.verification.submit",
      );
    const row = await env.DB.prepare(
      "SELECT f.active_key,f.declared_mime FROM org_verification_files vf JOIN org_verification_cases c ON c.id=vf.case_id JOIN storage_files f ON f.id=vf.file_id WHERE vf.case_id=? AND vf.file_id=? AND c.organization_id=? AND f.status='ACTIVE'",
    )
      .bind(caseId, fileId, organizationId)
      .first<{ active_key: string; declared_mime: string }>();
    if (!row?.active_key)
      throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
    const object = await env.PRIVATE_BUCKET.get(row.active_key);
    if (!object)
      throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
    return new Response(object.body, {
      headers: {
        ...cors,
        "content-type": row.declared_mime,
        "content-disposition": "attachment",
        "cache-control": "no-store",
      },
    });
  }
  if (url.pathname === "/api/v1/admin/access") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    const rows = await env.DB.prepare(
      "SELECT DISTINCT rp.permission_code AS code FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id AND r.scope='PLATFORM' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE pr.person_id=? ORDER BY rp.permission_code",
    )
      .bind(actor.personId)
      .all<{ code: string }>();
    if (!rows.results.length)
      throw new Problem(403, "FORBIDDEN", "Access denied");
    return json(
      {
        permissions: rows.results.map((row) => row.code),
        mfaEnabled: actor.mfaEnabled,
      },
      { headers: cors },
    );
  }
  const suspendAccountMatch = url.pathname.match(
    /^\/api\/v1\/admin\/accounts\/([0-9a-f-]{36})\/suspend$/,
  );
  if (suspendAccountMatch) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.account.suspend", {
      mfa: true,
    });
    const body = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(await boundedJson(request));
    await suspendAccount(
      env.DB,
      suspendAccountMatch[1]!,
      actor,
      body.reason,
      requestId,
    );
    return json({ suspended: true }, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/people") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.people.read");
    const cursor = url.searchParams.get("cursor") ?? "";
    const search = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const rows = await env.DB.prepare(
      "SELECT p.id,p.status,p.given_name,p.family_name,p.display_name,p.country_code,a.status AS account_status FROM iam_people p LEFT JOIN iam_accounts a ON a.person_id=p.id WHERE p.id>? AND (?='' OR p.given_name LIKE ? OR p.family_name LIKE ?) ORDER BY p.id LIMIT ?",
    )
      .bind(cursor, search, `%${search}%`, `%${search}%`, listLimit())
      .all();
    return json(
      { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
      { headers: cors },
    );
  }
  const adminPerson = url.pathname.match(
    /^\/api\/v1\/admin\/people\/([0-9a-f-]{36})$/,
  );
  if (adminPerson) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.people.read");
    const personId = adminPerson[1]!;
    const queries = [
      env.DB.prepare(
        "SELECT id,status,given_name,middle_name,family_name,second_family_name,display_name,preferred_locale,country_code,merged_into_person_id,version FROM iam_people WHERE id=?",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,status FROM iam_accounts WHERE person_id=?",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,type,raw_value,verification_status FROM iam_contact_methods WHERE person_id=? ORDER BY created_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,purpose,policy_version,status,occurred_at FROM iam_consent_events WHERE person_id=? ORDER BY occurred_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT m.id,m.organization_id,m.status,o.display_name FROM org_memberships m JOIN org_organizations o ON o.id=m.organization_id WHERE m.person_id=? ORDER BY m.created_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT person_id,professional_status,bio,years_experience FROM professional_mechanic_profiles WHERE person_id=?",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,credential_type,issuer,status,expires_at FROM professional_credentials WHERE person_id=? ORDER BY created_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,status,source_id,received_at FROM crm_lead_intakes WHERE person_id=? ORDER BY received_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,title,status FROM crm_opportunities WHERE person_id=? ORDER BY created_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,type,summary,occurred_at FROM crm_activities WHERE person_id=? ORDER BY occurred_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,description,status,due_at FROM crm_tasks WHERE person_id=? ORDER BY created_at DESC LIMIT 50",
      ).bind(personId),
      env.DB.prepare(
        "SELECT id,source_person_id,destination_person_id,reason,status FROM iam_duplicate_candidates WHERE source_person_id=? OR destination_person_id=? LIMIT 50",
      ).bind(personId, personId),
    ];
    const results = await env.DB.batch(queries);
    if (!results[0]?.results?.length)
      throw new Problem(404, "PERSON_NOT_FOUND", "Person unavailable");
    return json(
      {
        person: results[0].results[0],
        accounts: results[1]?.results,
        contacts: results[2]?.results,
        consents: results[3]?.results,
        memberships: results[4]?.results,
        professionalProfile: results[5]?.results[0] ?? null,
        credentials: results[6]?.results,
        leads: results[7]?.results,
        opportunities: results[8]?.results,
        activities: results[9]?.results,
        tasks: results[10]?.results,
        duplicateCandidates: results[11]?.results,
      },
      { headers: cors },
    );
  }
  const platformRoles = url.pathname.match(
    /^\/api\/v1\/admin\/people\/([0-9a-f-]{36})\/platform-roles$/,
  );
  if (platformRoles) {
    const actor = await businessPrincipal();
    const targetPersonId = platformRoles[1]!;
    await requirePlatformPermission(env.DB, actor, "platform.roles.manage", {
      mfa: request.method !== "GET",
    });
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT r.code FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id WHERE pr.person_id=? ORDER BY r.code",
      )
        .bind(targetPersonId)
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("PUT");
    const body = z
      .object({
        roles: z.array(z.enum(platformRoleCodes)).max(8),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(await boundedJson(request));
    await assignPlatformRoles(
      env.DB,
      actor,
      targetPersonId,
      body.roles,
      body.reason,
      requestId,
    );
    return json({ updated: true }, { headers: cors });
  }
  const mergeMatch = url.pathname.match(
    /^\/api\/v1\/admin\/people\/([0-9a-f-]{36})\/merge$/,
  );
  const duplicateResolution = url.pathname.match(
    /^\/api\/v1\/admin\/duplicate-candidates\/([0-9a-f-]{36})\/resolve$/,
  );
  if (duplicateResolution) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    const body = z
      .object({
        decision: z.enum(["NOT_DUPLICATE", "DISMISSED"]),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(await boundedJson(request));
    await resolveDuplicateCandidate(
      env.DB,
      actor,
      duplicateResolution[1]!,
      body.decision,
      body.reason,
      requestId,
    );
    return json({ resolved: true }, { headers: cors });
  }
  if (mergeMatch) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.people.merge", {
      mfa: true,
    });
    const body = z
      .object({
        destinationId: z.string().uuid(),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(await boundedJson(request));
    const result = await idempotentCommand(
      env,
      request.headers,
      "identity.person.merge",
      actor.accountId,
      {
        sourceId: mergeMatch[1]!,
        destinationId: body.destinationId,
        reason: body.reason,
      },
      requestId,
      requiredKey(request),
    );
    return json(result, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/organizations") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      "platform.organization.read",
    );
    const filter = url.searchParams.get("verificationStatus");
    const status = filter
      ? z
          .enum([
            "DRAFT",
            "PENDING_VERIFICATION",
            "UNDER_REVIEW",
            "NEEDS_INFORMATION",
            "VERIFIED",
            "REJECTED",
            "SUSPENDED",
            "CLOSED",
          ])
          .parse(filter)
      : null;
    const rows = status
      ? await env.DB.prepare(
          "SELECT id,type,display_name,country_code,status,verification_status,version FROM org_organizations WHERE verification_status=? AND id>? ORDER BY id LIMIT ?",
        )
          .bind(status, url.searchParams.get("cursor") ?? "", listLimit())
          .all()
      : await env.DB.prepare(
          "SELECT id,type,display_name,country_code,status,verification_status,version FROM org_organizations WHERE id>? ORDER BY id LIMIT ?",
        )
          .bind(url.searchParams.get("cursor") ?? "", listLimit())
          .all();
    return json(
      { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
      { headers: cors },
    );
  }
  const adminOrg = url.pathname.match(
    /^\/api\/v1\/admin\/organizations\/([0-9a-f-]{36})$/,
  );
  if (adminOrg) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      "platform.organization.read",
    );
    const organizationId = adminOrg[1]!;
    const results = await env.DB.batch([
      env.DB.prepare(
        "SELECT id,type,legal_name,display_name,country_code,status,verification_status,version FROM org_organizations WHERE id=?",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,name,city,status FROM org_locations WHERE organization_id=? LIMIT 100",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT code FROM org_capabilities WHERE organization_id=?",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT m.id,m.person_id,m.status,p.display_name FROM org_memberships m JOIN iam_people p ON p.id=m.person_id WHERE m.organization_id=? LIMIT 100",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,status,submitted_at,decision_at,decision_reason FROM org_verification_cases WHERE organization_id=? ORDER BY submitted_at DESC LIMIT 50",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,target_email,status FROM org_invitations WHERE organization_id=? AND status='PENDING' LIMIT 50",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,person_id,status FROM org_membership_requests WHERE organization_id=? AND status='PENDING' LIMIT 50",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,title,status FROM crm_opportunities WHERE organization_id=? LIMIT 50",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,type,summary,occurred_at FROM crm_activities WHERE organization_id=? ORDER BY occurred_at DESC LIMIT 50",
      ).bind(organizationId),
      env.DB.prepare(
        "SELECT id,description,status FROM crm_tasks WHERE organization_id=? LIMIT 50",
      ).bind(organizationId),
    ]);
    if (!results[0]?.results?.length)
      throw new Problem(
        404,
        "ORGANIZATION_NOT_FOUND",
        "Organization unavailable",
      );
    return json(
      {
        organization: results[0].results[0],
        locations: results[1]?.results,
        capabilities: results[2]?.results,
        members: results[3]?.results,
        verificationCases: results[4]?.results,
        invitations: results[5]?.results,
        membershipRequests: results[6]?.results,
        opportunities: results[7]?.results,
        activities: results[8]?.results,
        tasks: results[9]?.results,
      },
      { headers: cors },
    );
  }
  const verificationAction = url.pathname.match(
    /^\/api\/v1\/admin\/organizations\/([0-9a-f-]{36})\/verification\/([0-9a-f-]{36})\/(start-review|approve|reject|request-information)$/,
  );
  if (verificationAction) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    const organizationId = verificationAction[1]!,
      caseId = verificationAction[2]!;
    if (verificationAction[3] === "start-review") {
      await startVerificationReview(
        env.DB,
        actor,
        organizationId,
        caseId,
        requestId,
      );
      return json({ reviewStarted: true }, { headers: cors });
    }
    await requirePlatformPermission(
      env.DB,
      actor,
      "platform.organization.verify",
      { mfa: true },
    );
    const body = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(await boundedJson(request));
    if (verificationAction[3] === "request-information") {
      await requestVerificationInformation(
        env.DB,
        actor,
        organizationId,
        caseId,
        body.reason,
        requestId,
      );
      return json({ informationRequested: true }, { headers: cors });
    }
    const result = await idempotentCommand(
      env,
      request.headers,
      verificationAction[3] === "approve"
        ? "organization.verification.approve"
        : "organization.verification.reject",
      actor.accountId,
      { organizationId, caseId, reason: body.reason },
      requestId,
      requiredKey(request),
      organizationId,
    );
    return json(result, { headers: cors });
  }
  const suspendMatch = url.pathname.match(
    /^\/api\/v1\/admin\/organizations\/([0-9a-f-]{36})\/suspend$/,
  );
  if (suspendMatch) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    const body = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(await boundedJson(request));
    await suspendOrganization(
      env.DB,
      actor,
      suspendMatch[1]!,
      body.reason,
      requestId,
    );
    return json({ suspended: true }, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/crm/leads") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.read");
    const rows = await env.DB.prepare(
      "SELECT id,status,source_id,given_name,family_name,email,phone,organization_name,received_at,person_id,assigned_to_person_id FROM crm_lead_intakes WHERE id>? ORDER BY id LIMIT ?",
    )
      .bind(url.searchParams.get("cursor") ?? "", listLimit())
      .all();
    return json(
      { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
      { headers: cors },
    );
  }
  const crmAction = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/leads\/([0-9a-f-]{36})\/(triage|create-person|link-person|convert|assign)$/,
  );
  if (crmAction) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.manage");
    const leadId = crmAction[1]!,
      action = crmAction[2]!;
    if (action === "triage") {
      const body = z
        .object({ decision: z.enum(["TRIAGED", "REJECTED", "SPAM"]) })
        .strict()
        .parse(await boundedJson(request));
      await triageLead(env.DB, leadId, actor, body.decision, requestId);
      return json({ triaged: true }, { headers: cors });
    }
    if (action === "create-person") {
      return json(
        {
          personId: await createPersonFromLead(
            env.DB,
            leadId,
            actor,
            requestId,
          ),
        },
        { status: 201, headers: cors },
      );
    }
    if (action === "link-person") {
      const body = z
        .object({ personId: z.string().uuid() })
        .strict()
        .parse(await boundedJson(request));
      await linkLeadPerson(env.DB, leadId, body.personId, actor, requestId);
      return json({ linked: true }, { headers: cors });
    }
    if (action === "assign") {
      const body = z
        .object({ personId: z.string().uuid() })
        .strict()
        .parse(await boundedJson(request));
      await assignLead(env.DB, actor, leadId, body.personId, requestId);
      return json({ assigned: true }, { headers: cors });
    }
    const body = z
      .object({
        pipelineId: z.string().min(1).max(128),
        stageId: z.string().min(1).max(128),
        title: z.string().trim().min(1).max(240),
      })
      .strict()
      .parse(await boundedJson(request));
    const result = await idempotentCommand(
      env,
      request.headers,
      "crm.lead.convert",
      actor.accountId,
      { leadId, ...body },
      requestId,
      requiredKey(request),
    );
    return json(result, { headers: cors });
  }
  const leadDetail = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/leads\/([0-9a-f-]{36})$/,
  );
  if (leadDetail) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.read");
    const row = await env.DB.prepare(
      "SELECT id,status,source_id,given_name,family_name,email,phone,organization_name,message,country_code,person_id,organization_id,utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer,received_at,triaged_at,converted_at,assigned_to_person_id,version FROM crm_lead_intakes WHERE id=?",
    )
      .bind(leadDetail[1]!)
      .first();
    if (!row) throw new Problem(404, "CRM_LEAD_NOT_FOUND", "Lead unavailable");
    return json(row, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/crm/opportunities") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.read");
    const rows = await env.DB.prepare(
      "SELECT id,pipeline_id,stage_id,person_id,organization_id,title,owner_person_id,status,version FROM crm_opportunities WHERE id>? ORDER BY id LIMIT ?",
    )
      .bind(url.searchParams.get("cursor") ?? "", listLimit())
      .all();
    return json(
      { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
      { headers: cors },
    );
  }
  const opportunityDetail = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/opportunities\/([0-9a-f-]{36})$/,
  );
  if (opportunityDetail) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.read");
    const row = await env.DB.prepare(
      "SELECT id,pipeline_id,stage_id,person_id,organization_id,lead_intake_id,title,owner_person_id,status,created_at,closed_at,version FROM crm_opportunities WHERE id=?",
    )
      .bind(opportunityDetail[1]!)
      .first();
    if (!row)
      throw new Problem(
        404,
        "OPPORTUNITY_NOT_FOUND",
        "Opportunity unavailable",
      );
    return json(row, { headers: cors });
  }
  const opportunityStage = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/opportunities\/([0-9a-f-]{36})\/stage$/,
  );
  if (opportunityStage) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.manage");
    const body = z
      .object({
        stageId: z.string().min(1).max(128),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(await boundedJson(request));
    await moveOpportunityStage(
      env.DB,
      opportunityStage[1]!,
      body.stageId,
      body.version,
      actor,
      requestId,
    );
    return json({ updated: true }, { headers: cors });
  }
  const opportunityAssign = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/opportunities\/([0-9a-f-]{36})\/assign$/,
  );
  if (opportunityAssign) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.manage");
    const body = z
      .object({ personId: z.string().uuid() })
      .strict()
      .parse(await boundedJson(request));
    await assignOpportunity(
      env.DB,
      actor,
      opportunityAssign[1]!,
      body.personId,
      requestId,
    );
    return json({ assigned: true }, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/crm/activities") {
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      request.method === "GET" ? "platform.crm.read" : "platform.crm.manage",
    );
    if (request.method === "GET") {
      const personId = url.searchParams.get("personId"),
        organizationId = url.searchParams.get("organizationId"),
        opportunityId = url.searchParams.get("opportunityId");
      if (!personId && !organizationId && !opportunityId)
        throw new Problem(400, "FILTER_REQUIRED", "Filter required");
      const rows = await env.DB.prepare(
        "SELECT id,type,person_id,organization_id,opportunity_id,actor_person_id,occurred_at,recorded_at,summary FROM crm_activities WHERE (? IS NOT NULL AND person_id=?) OR (? IS NOT NULL AND organization_id=?) OR (? IS NOT NULL AND opportunity_id=?) ORDER BY occurred_at DESC,id DESC LIMIT ?",
      )
        .bind(
          personId,
          personId,
          organizationId,
          organizationId,
          opportunityId,
          opportunityId,
          listLimit(),
        )
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    return json(
      {
        activityId: await recordActivity(
          env.DB,
          actor,
          activityInput.parse(await boundedJson(request)),
        ),
      },
      { status: 201, headers: cors },
    );
  }
  if (url.pathname === "/api/v1/admin/crm/notes") {
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      request.method === "GET" ? "platform.crm.read" : "platform.crm.manage",
    );
    if (request.method === "GET") {
      const personId = url.searchParams.get("personId"),
        organizationId = url.searchParams.get("organizationId"),
        opportunityId = url.searchParams.get("opportunityId");
      if (!personId && !organizationId && !opportunityId)
        throw new Problem(400, "FILTER_REQUIRED", "Filter required");
      const rows = await env.DB.prepare(
        "SELECT id,author_person_id,body,created_at FROM crm_notes WHERE (? IS NOT NULL AND person_id=?) OR (? IS NOT NULL AND organization_id=?) OR (? IS NOT NULL AND opportunity_id=?) ORDER BY created_at DESC,id DESC LIMIT ?",
      )
        .bind(
          personId,
          personId,
          organizationId,
          organizationId,
          opportunityId,
          opportunityId,
          listLimit(),
        )
        .all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    return json(
      {
        noteId: await createNote(
          env.DB,
          actor,
          noteInput.parse(await boundedJson(request)),
        ),
      },
      { status: 201, headers: cors },
    );
  }
  if (url.pathname === "/api/v1/admin/crm/tasks") {
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      request.method === "GET" ? "platform.crm.read" : "platform.crm.manage",
    );
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,owner_person_id,due_at,priority,status,description,person_id,organization_id,opportunity_id,version FROM crm_tasks WHERE owner_person_id=? AND id>? ORDER BY id LIMIT ?",
      )
        .bind(
          url.searchParams.get("ownerPersonId") ?? actor.personId,
          url.searchParams.get("cursor") ?? "",
          listLimit(),
        )
        .all();
      return json(
        { items: rows.results, nextCursor: rows.results.at(-1)?.id ?? null },
        { headers: cors },
      );
    }
    requireMethod("POST");
    return json(
      {
        taskId: await createTask(
          env.DB,
          actor,
          taskInput.parse(await boundedJson(request)),
          requestId,
        ),
      },
      { status: 201, headers: cors },
    );
  }
  const taskUpdate = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/tasks\/([0-9a-f-]{36})$/,
  );
  if (taskUpdate) {
    requireMethod("PATCH");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.manage");
    const body = z
      .object({
        status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(await boundedJson(request));
    return json(
      {
        version: await updateTask(
          env.DB,
          actor,
          taskUpdate[1]!,
          body,
          requestId,
        ),
      },
      { headers: cors },
    );
  }
  const taskAssign = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/tasks\/([0-9a-f-]{36})\/assign$/,
  );
  if (taskAssign) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.manage");
    const body = z
      .object({ personId: z.string().uuid() })
      .strict()
      .parse(await boundedJson(request));
    await assignTask(env.DB, actor, taskAssign[1]!, body.personId, requestId);
    return json({ assigned: true }, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/crm/tags") {
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      request.method === "GET" ? "platform.crm.read" : "platform.crm.manage",
    );
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,code,label FROM crm_tags ORDER BY code LIMIT 100",
      ).all();
      return json(rows.results, { headers: cors });
    }
    requireMethod("POST");
    const body = z
      .object({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
        label: z.string().trim().min(1).max(80),
      })
      .strict()
      .parse(await boundedJson(request));
    return json(
      { tagId: await createTag(env.DB, actor, body.code, body.label) },
      { status: 201, headers: cors },
    );
  }
  const tagAssign = url.pathname.match(
    /^\/api\/v1\/admin\/crm\/tags\/([0-9a-f-]{36})\/assign$/,
  );
  if (tagAssign) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.manage");
    const body = z
      .object({
        entityType: z.enum(["PERSON", "ORGANIZATION", "LEAD", "OPPORTUNITY"]),
        entityId: z.string().uuid(),
      })
      .strict()
      .parse(await boundedJson(request));
    await assignTag(
      env.DB,
      actor,
      tagAssign[1]!,
      body.entityType,
      body.entityId,
    );
    return json({ assigned: true }, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/crm/pipelines") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.crm.read");
    const rows = await env.DB.prepare(
      "SELECT p.id,p.code,p.name_key,s.id AS stage_id,s.code AS stage_code,s.name_key AS stage_name_key,s.position,s.is_terminal FROM crm_pipelines p JOIN crm_stages s ON s.pipeline_id=p.id WHERE p.status='ACTIVE' AND s.status='ACTIVE' ORDER BY p.code,s.position",
    ).all();
    return json(rows.results, { headers: cors });
  }
  const credentialReview = url.pathname.match(
    /^\/api\/v1\/admin\/professionals\/([0-9a-f-]{36})\/credentials\/([0-9a-f-]{36})\/(verify|reject)$/,
  );
  if (url.pathname === "/api/v1/admin/professionals/credentials") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      "platform.professional.read",
    );
    const rows = await env.DB.prepare(
      "SELECT c.id,c.person_id,c.credential_type,c.issuer,c.status,CASE WHEN f.status='ACTIVE' THEN c.evidence_file_id ELSE NULL END AS evidence_file_id,c.created_at,p.display_name FROM professional_credentials c JOIN iam_people p ON p.id=c.person_id LEFT JOIN storage_files f ON f.id=c.evidence_file_id WHERE c.status='PENDING' ORDER BY c.created_at,c.id LIMIT 50",
    ).all();
    return json(rows.results, { headers: cors });
  }
  if (url.pathname === "/api/v1/admin/duplicate-candidates") {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(env.DB, actor, "platform.people.merge");
    const rows = await env.DB.prepare(
      "SELECT id,source_person_id,destination_person_id,reason,created_at FROM iam_duplicate_candidates WHERE status='OPEN' ORDER BY created_at,id LIMIT 50",
    ).all();
    return json(rows.results, { headers: cors });
  }
  const credentialEvidence = url.pathname.match(
    /^\/api\/v1\/admin\/professionals\/([0-9a-f-]{36})\/credentials\/([0-9a-f-]{36})\/evidence$/,
  );
  if (credentialEvidence) {
    requireMethod("GET");
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      "platform.professional.read",
    );
    const row = await env.DB.prepare(
      "SELECT f.active_key,f.declared_mime FROM professional_credentials c JOIN storage_files f ON f.id=c.evidence_file_id WHERE c.person_id=? AND c.id=? AND f.status='ACTIVE'",
    )
      .bind(credentialEvidence[1]!, credentialEvidence[2]!)
      .first<{ active_key: string; declared_mime: string }>();
    if (!row?.active_key)
      throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
    const object = await env.PRIVATE_BUCKET.get(row.active_key);
    if (!object)
      throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
    return new Response(object.body, {
      headers: {
        ...cors,
        "content-type": row.declared_mime,
        "content-disposition": "attachment",
        "cache-control": "no-store",
      },
    });
  }
  if (credentialReview) {
    requireMethod("POST");
    const actor = await businessPrincipal();
    await requirePlatformPermission(
      env.DB,
      actor,
      "platform.professional.verify",
      { mfa: true },
    );
    const body = z
      .object({ reason: z.string().trim().min(5).max(1000) })
      .strict()
      .parse(await boundedJson(request));
    const credentialId = credentialReview[2]!;
    const row = await env.DB.prepare(
      "SELECT person_id FROM professional_credentials WHERE id=?",
    )
      .bind(credentialId)
      .first<{ person_id: string }>();
    if (row?.person_id !== credentialReview[1])
      throw new Problem(404, "CREDENTIAL_NOT_FOUND", "Credential unavailable");
    await decideCredential(
      env.DB,
      actor,
      credentialId,
      credentialReview[3] === "verify" ? "VERIFIED" : "REJECTED",
      body.reason,
      requestId,
    );
    return json({ reviewed: true }, { headers: cors });
  }
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
    if (path === "/sign-up/email") {
      requireMethod("POST");
      if (!signupEnabled) throw new Problem(404, "NOT_FOUND", "Not found");
      const body = z
        .object({
          name: z.string().trim().min(2).max(240),
          email: z.string().email(),
          password: z.string().min(12).max(128),
          termsAccepted: z.literal(true),
          privacyAccepted: z.literal(true),
          termsVersion: z.string().min(1).max(64),
          privacyVersion: z.string().min(1).max(64),
        })
        .strict()
        .parse(await boundedJson(request));
      const forwarded = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          name: body.name,
          email: body.email,
          password: body.password,
        }),
      });
      const result = await auth.auth.handler(forwarded);
      if (!result.ok)
        return json({ accepted: true }, { status: 202, headers: cors });
      const payload = (await result.clone().json()) as {
        user?: { id?: string };
      };
      if (payload.user?.id)
        await env.DB.prepare(
          "INSERT INTO iam_signup_consents(auth_user_id,terms_version,privacy_version,request_id) VALUES(?,?,?,?) ON CONFLICT(auth_user_id) DO NOTHING",
        )
          .bind(
            payload.user.id,
            body.termsVersion,
            body.privacyVersion,
            requestId,
          )
          .run();
      return json({ accepted: true }, { status: 202, headers: cors });
    }
    if (
      path === "/request-password-reset" &&
      (c.environment !== "local" || c.emailProvider !== "DEVELOPMENT_SINK")
    )
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
    return forwardAuthResponse(response, cors);
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
      cors = corsHeaders(
        request.headers.get("origin"),
        routeCorsOrigins(new URL(request.url).pathname, c),
      );
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
