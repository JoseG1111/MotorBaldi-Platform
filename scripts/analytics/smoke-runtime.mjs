import { DEVELOPMENT_ADMIN_ORIGIN as origin } from "../development/automation-client.mjs";
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
class Failure extends Error {
  constructor(step, code, status) {
    super("Sanitized analytics failure");
    Object.assign(this, { step, code, status });
  }
}
export function formatSmokeFailure(error) {
  return error instanceof Failure
    ? `FAIL step=${error.step} status=${error.status ?? "none"} code=${error.code}`
    : "FAIL step=internal status=none code=INTERNAL_ERROR";
}
const apiCodes = new Set([
  "ANALYTICS_EVIDENCE_UNAVAILABLE",
  "INVALID_ANALYTICS_QUERY",
  "VALIDATION_ERROR",
  "MFA_REQUIRED",
  "FORBIDDEN",
  "DEVELOPMENT_AUTOMATION_DENIED",
  "DEVELOPMENT_AUTOMATION_SCOPE",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "RATE_LIMITED",
  "ORIGIN_FORBIDDEN",
]);
const consistencyCodes = new Set([
  "CONSISTENCY_CHECK_UNAVAILABLE",
  "DATABASE_ENVIRONMENT_MISMATCH",
  "ANALYTICS_EVIDENCE_REQUIRED",
  "ANALYTICS_COUNT_MISMATCH",
]);
async function safeProblemCode(response) {
  let reader;
  try {
    reader = response.body?.getReader();
    if (!reader) return "UNEXPECTED_HTTP_STATUS";
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) return "UNEXPECTED_HTTP_STATUS";
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const problem = JSON.parse(new TextDecoder().decode(bytes));
    return apiCodes.has(problem?.code)
      ? problem.code
      : "UNEXPECTED_HTTP_STATUS";
  } catch {
    return "UNEXPECTED_HTTP_STATUS";
  } finally {
    try {
      await reader?.cancel();
    } catch {
      /* response remains private */
    }
  }
}
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const counts = (value, keys) =>
  exact(value, keys) &&
  keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
  keys.reduce((sum, key) => sum + BigInt(value[key]), 0n) <=
    BigInt(Number.MAX_SAFE_INTEGER);
export function validateReport(value, kind, organizationId, locationId) {
  const canonical = kind === "CANONICAL_PARTS";
  const tables = canonical
    ? ["parts_canonical"]
    : [
        "parts_offerings",
        "marketplace_listings",
        "marketplace_eligible_sources",
      ];
  if (
    !exact(value, [
      "schemaVersion",
      "classification",
      "kind",
      "observedAt",
      "scope",
      "provenance",
      "counts",
    ]) ||
    value.schemaVersion !== 1 ||
    value.classification !== "INTERNAL" ||
    value.kind !== kind ||
    typeof value.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    new Date(value.observedAt).toISOString() !== value.observedAt ||
    !exact(value.provenance, ["mode", "sourceTables"]) ||
    value.provenance.mode !== "CURRENT_STATE" ||
    JSON.stringify(value.provenance.sourceTables) !== JSON.stringify(tables) ||
    !exact(
      value.scope,
      canonical
        ? ["type", "resourceScope"]
        : ["type", "resourceScope", "organizationId", "locationId"],
    ) ||
    value.scope.type !== (canonical ? "PLATFORM" : "ORGANIZATION") ||
    value.scope.resourceScope !== "OWNED_SYNTHETIC" ||
    (!canonical &&
      (value.scope.organizationId !== organizationId ||
        value.scope.locationId !== locationId)) ||
    (canonical
      ? !counts(value.counts, ["DRAFT", "ACTIVE", "ARCHIVED"])
      : !exact(value.counts, ["offerings", "listings", "discoverable"]) ||
        !counts(value.counts.offerings, ["DRAFT", "ACTIVE", "INACTIVE"]) ||
        !counts(value.counts.listings, [
          "DRAFT",
          "PENDING_REVIEW",
          "PUBLISHED",
          "SUSPENDED",
        ]) ||
        !Number.isSafeInteger(value.counts.discoverable) ||
        value.counts.discoverable < 0 ||
        value.counts.discoverable > value.counts.listings.PUBLISHED)
  )
    throw new Failure("report-schema", "INVALID_REPORT");
  return value;
}
export async function runSmoke({
  fetch: fetcher = globalThis.fetch,
  log = console.log,
  compare,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  async function call(
    step,
    path,
    { signed = true, statuses = [200], method = "GET" } = {},
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(origin + "/api/v1" + path, {
          method,
          headers: {
            origin,
            ...(signed ? { "x-motorbaldi-automation-intent": "true" } : {}),
          },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (attempt < 2) continue;
        throw new Failure(step, "TRANSPORT_ERROR");
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const seconds = Number(response.headers.get("retry-after"));
        await sleep(
          Math.min(
            10000,
            Math.max(
              250,
              Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500,
            ),
          ),
        );
        continue;
      }
      if (!statuses.includes(response.status))
        throw new Failure(
          step,
          await safeProblemCode(response),
          response.status,
        );
      if (response.status !== 200) return;
      if (
        step.includes("report") &&
        response.headers.get("cache-control") !== "no-store"
      )
        throw new Failure(step, "CACHE_POLICY_INVALID", 200);
      try {
        return await response.json();
      } catch {
        throw new Failure(step, "INVALID_RESPONSE", 200);
      }
    }
  }
  const canonicalPath = "/admin/analytics/parts";
  await call("anonymous-denial", canonicalPath, {
    signed: false,
    statuses: [401],
  });
  await call("queue-denial", "/admin/analytics/queue", {
    statuses: [403, 404],
  });
  await call("query-denial", canonicalPath + "?unexpected=true", {
    statuses: [400],
  });
  await call("method-denial", canonicalPath, {
    method: "POST",
    statuses: [403, 404, 405],
  });
  const organizations = await call(
    "fixture-organization",
    "/admin/organizations",
  );
  const matches = Array.isArray(organizations?.items)
    ? organizations.items.filter(
        (row) =>
          row.display_name === "MotorBaldi Development Validation Workshop" &&
          row.status === "ACTIVE" &&
          row.verification_status === "VERIFIED",
      )
    : [];
  if (matches.length !== 1 || !uuid(matches[0].id))
    throw new Failure("fixture-organization", "FIXTURE_REQUIRED");
  const org = matches[0].id;
  const locations = await call(
    "fixture-location",
    `/organizations/${org}/locations`,
  );
  const sites = Array.isArray(locations?.items)
    ? locations.items.filter(
        (row) =>
          row.name === "MotorBaldi Development Workshop Site" &&
          row.status === "ACTIVE",
      )
    : [];
  if (sites.length !== 1 || !uuid(sites[0].id))
    throw new Failure("fixture-location", "FIXTURE_REQUIRED");
  const site = sites[0].id,
    foreign = "00000000-0000-4000-8000-000000000099";
  await call(
    "foreign-organization",
    `/organizations/${foreign}/analytics/parts?locationId=${site}`,
    { statuses: [403, 404] },
  );
  await call(
    "foreign-location",
    `/organizations/${org}/analytics/parts?locationId=${foreign}`,
    { statuses: [403, 404] },
  );
  const canonical = validateReport(
    await call("canonical-report", canonicalPath),
    "CANONICAL_PARTS",
  );
  const organization = validateReport(
    await call(
      "organization-report",
      `/organizations/${org}/analytics/parts?locationId=${site}`,
    ),
    "ORGANIZATION_PARTS",
    org,
    site,
  );
  if (
    canonical.counts.ARCHIVED < 1 ||
    organization.counts.offerings.INACTIVE < 1 ||
    organization.counts.listings.SUSPENDED < 1
  )
    throw new Failure("positive-evidence", "ANALYTICS_EVIDENCE_REQUIRED");
  if (typeof compare !== "function")
    throw new Failure("d1-comparison", "CONSISTENCY_CHECK_UNAVAILABLE");
  try {
    await compare({
      canonical,
      organization,
      organizationId: org,
      locationId: site,
    });
  } catch (error) {
    throw new Failure(
      "d1-comparison",
      consistencyCodes.has(error?.message)
        ? error.message
        : "CONSISTENCY_CHECK_FAILED",
    );
  }
  log(
    "PASS Development Analytics read-only scoped reports, privacy, denial and independent D1 consistency",
  );
}
