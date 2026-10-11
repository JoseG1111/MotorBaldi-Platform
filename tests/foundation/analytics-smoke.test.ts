import { describe, expect, it } from "vitest";
import {
  runSmoke,
  formatSmokeFailure,
  validateReport,
} from "../../scripts/analytics/smoke-runtime.mjs";
import {
  assessAnalyticsConsistency,
  buildConsistencySql,
  compareRemoteEvidence,
} from "../../scripts/analytics/consistency-runtime.mjs";
const org = "018f0000-0000-7000-8000-000000000001",
  site = "018f0000-0000-7000-8000-000000000002";
const canonical = {
  schemaVersion: 1 as const,
  classification: "INTERNAL" as const,
  kind: "CANONICAL_PARTS",
  observedAt: "2026-10-10T00:00:00.000Z",
  scope: { type: "PLATFORM", resourceScope: "OWNED_SYNTHETIC" },
  provenance: {
    mode: "CURRENT_STATE" as const,
    sourceTables: ["parts_canonical"],
  },
  counts: { DRAFT: 0, ACTIVE: 0, ARCHIVED: 4 },
};
const organization = {
  ...canonical,
  kind: "ORGANIZATION_PARTS",
  scope: {
    type: "ORGANIZATION",
    resourceScope: "OWNED_SYNTHETIC",
    organizationId: org,
    locationId: site,
  },
  provenance: {
    mode: "CURRENT_STATE" as const,
    sourceTables: [
      "parts_offerings",
      "marketplace_listings",
      "marketplace_eligible_sources",
    ],
  },
  counts: {
    offerings: { DRAFT: 0, ACTIVE: 0, INACTIVE: 3 },
    listings: { DRAFT: 0, PENDING_REVIEW: 0, PUBLISHED: 0, SUSPENDED: 1 },
    discoverable: 0,
  },
};
const evidence = {
  canonical,
  organization,
  organizationId: org,
  locationId: site,
};
function results() {
  return [
    { success: true, results: [{ environment: "development" }] },
    {
      success: true,
      results: [
        {
          identities: 1,
          canonical_DRAFT: 0,
          canonical_ACTIVE: 0,
          canonical_ARCHIVED: 4,
          offering_DRAFT: 0,
          offering_ACTIVE: 0,
          offering_INACTIVE: 3,
          listing_DRAFT: 0,
          listing_PENDING_REVIEW: 0,
          listing_PUBLISHED: 0,
          listing_SUSPENDED: 1,
          discoverable: 0,
        },
      ],
    },
  ];
}
function harness(mode = "normal") {
  const calls: { path: string; init: RequestInit }[] = [];
  let transient = false;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)),
      path = url.pathname.replace("/api/v1", "");
    calls.push({ path, init });
    const json = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { "cache-control": mode === "cache" ? "private" : "no-store" },
      });
    if (!new Headers(init.headers).has("x-motorbaldi-automation-intent"))
      return json({ code: "UNAUTHORIZED" }, 401);
    if (mode === "known-error")
      return json(
        { code: "ANALYTICS_EVIDENCE_UNAVAILABLE", details: "private-body-PII" },
        500,
      );
    if (mode === "oversized-error")
      return json(
        { code: "FORBIDDEN", details: "private-body-PII".repeat(500) },
        500,
      );
    if (mode === "private")
      return json(
        { code: "secret-person-cookie", details: "private-body-PII" },
        403,
      );
    if (path === "/admin/analytics/queue" || url.href.includes("000000000099"))
      return json({}, 403);
    if (url.searchParams.has("unexpected")) return json({}, 400);
    if (init.method === "POST") return json({}, 405);
    if (path === "/admin/organizations")
      return json({
        items: [
          {
            id: org,
            display_name: "MotorBaldi Development Validation Workshop",
            status: "ACTIVE",
            verification_status: "VERIFIED",
          },
        ],
      });
    if (path.endsWith("/locations"))
      return json({
        items: [
          {
            id: site,
            name: "MotorBaldi Development Workshop Site",
            status: "ACTIVE",
          },
        ],
      });
    if (path === "/admin/analytics/parts") {
      if (mode === "rate-exhausted")
        return json({ details: "private rate body" }, 429);
      if ((mode === "transient" || mode === "rate") && !transient) {
        transient = true;
        return json({}, mode === "rate" ? 429 : 503);
      }
      if (mode === "transport" && !transient) {
        transient = true;
        throw new Error("secret transport body");
      }
      if (mode === "malformed")
        return json({ ...canonical, email: "person@example.invalid" });
      if (mode === "empty")
        return json({
          ...canonical,
          counts: { DRAFT: 0, ACTIVE: 0, ARCHIVED: 0 },
        });
      return json(canonical);
    }
    return json(organization);
  };
  return { fetch, calls };
}
async function run(mode = "normal", compare = async () => {}) {
  const h = harness(mode),
    logs: string[] = [];
  let failure = "";
  try {
    await runSmoke({
      fetch: h.fetch,
      compare,
      log: (line) => logs.push(line),
      sleep: async () => {},
    });
  } catch (error) {
    failure = formatSmokeFailure(error);
  }
  return { ...h, logs, failure };
}
describe("Development analytics read-only smoke", () => {
  it("checks scoped positive reports and all denials without mutation body or sensitive logs", async () => {
    const h = await run();
    expect(h.failure).toBe("");
    expect(h.logs).toHaveLength(1);
    expect(h.calls.every((call) => call.init.body === undefined)).toBe(true);
    expect(h.calls.filter((call) => call.init.method === "POST")).toHaveLength(
      1,
    );
    expect(h.logs.join()).not.toContain(org);
    expect(h.calls.some((call) => call.path === "/admin/analytics/queue")).toBe(
      true,
    );
  });
  it("rejects malformed/private fields and missing no-store", async () => {
    expect((await run("malformed")).failure).toContain("INVALID_REPORT");
    expect((await run("cache")).failure).toContain("CACHE_POLICY_INVALID");
    expect(() =>
      validateReport(
        {
          ...organization,
          counts: { ...organization.counts, discoverable: 1 },
        },
        "ORGANIZATION_PARTS",
        org,
        site,
      ),
    ).toThrow();
  });
  it("sanitizes private failure bodies and transport errors", async () => {
    const h = await run("private");
    expect(h.failure).toContain("status=403");
    expect(h.failure).not.toMatch(/secret|cookie|PII|person/);
    expect(formatSmokeFailure(new Error("secret"))).toBe(
      "FAIL step=internal status=none code=INTERNAL_ERROR",
    );
  });
  it.each(["transient", "rate", "transport"])(
    "retries %s reads with bounded fresh fetch calls",
    async (mode) => {
      const h = await run(mode);
      expect(h.failure).toBe("");
      expect(
        h.calls.filter(
          (call) =>
            call.path === "/admin/analytics/parts" &&
            call.init.method === "GET" &&
            new Headers(call.init.headers).has(
              "x-motorbaldi-automation-intent",
            ),
        ),
      ).toHaveLength(3);
    },
  );
  it("preserves only bounded allowlisted API and consistency codes", async () => {
    expect((await run("known-error")).failure).toBe(
      "FAIL step=queue-denial status=500 code=ANALYTICS_EVIDENCE_UNAVAILABLE",
    );
    expect((await run("oversized-error")).failure).toBe(
      "FAIL step=queue-denial status=500 code=UNEXPECTED_HTTP_STATUS",
    );
    for (const code of [
      "CONSISTENCY_CHECK_UNAVAILABLE",
      "DATABASE_ENVIRONMENT_MISMATCH",
      "ANALYTICS_EVIDENCE_REQUIRED",
      "ANALYTICS_COUNT_MISMATCH",
    ]) {
      expect(
        (
          await run("normal", async () => {
            throw new Error(code);
          })
        ).failure,
      ).toBe(`FAIL step=d1-comparison status=none code=${code}`);
    }
  });
  it("bounds exhausted rate retries and preserves only safe status diagnostics", async () => {
    const h = await run("rate-exhausted");
    expect(h.failure).toBe(
      "FAIL step=canonical-report status=429 code=UNEXPECTED_HTTP_STATUS",
    );
    expect(h.failure).not.toContain("private");
    expect(
      h.calls.filter(
        (call) =>
          call.path === "/admin/analytics/parts" &&
          call.init.method === "GET" &&
          new Headers(call.init.headers).has("x-motorbaldi-automation-intent"),
      ),
    ).toHaveLength(4);
  });
  it("rejects empty owned evidence rather than accepting a false pass", async () => {
    expect((await run("empty")).failure).toContain(
      "ANALYTICS_EVIDENCE_REQUIRED",
    );
  });
  it("rejects independent D1 mismatch, unsafe SQL scopes and incorrect environment", () => {
    assessAnalyticsConsistency(results(), evidence);
    const mismatch = results();
    Object.assign(mismatch[1]!.results[0]!, { canonical_ARCHIVED: 5 });
    expect(() => assessAnalyticsConsistency(mismatch, evidence)).toThrow(
      "ANALYTICS_COUNT_MISMATCH",
    );
    const wrong = results();
    Object.assign(wrong[0]!.results[0]!, { environment: "production" });
    expect(() => assessAnalyticsConsistency(wrong, evidence)).toThrow(
      "DATABASE_ENVIRONMENT_MISMATCH",
    );
    expect(() => buildConsistencySql("' OR 1=1", site)).toThrow();
    const empty = results();
    Object.assign(empty[1]!.results[0]!, { canonical_ARCHIVED: 0 });
    expect(() => assessAnalyticsConsistency(empty, evidence)).toThrow(
      "ANALYTICS_EVIDENCE_REQUIRED",
    );
    expect(() =>
      assessAnalyticsConsistency(
        [
          {
            success: true,
            results: [{ environment: "development", private: "PII" }],
          },
        ],
        evidence,
      ),
    ).toThrow("CONSISTENCY_CHECK_UNAVAILABLE");
  });
  it("requires existing checker success and captures all subprocess output", async () => {
    const calls: { file: string; args: string[] }[] = [];
    await compareRemoteEvidence(evidence, {
      exec: async (file, args) => {
        calls.push({ file, args });
        return file === "pnpm" ? JSON.stringify(results()) : "PASS safe";
      },
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]!.args).toContain("--remote");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--env") + 1]).toBe(
      "development",
    );
    await expect(
      compareRemoteEvidence(evidence, {
        exec: async (file) =>
          file === "pnpm"
            ? JSON.stringify(results())
            : "unavailable private body",
      }),
    ).rejects.toThrow("CONSISTENCY_CHECK_UNAVAILABLE");
  });
  it("never passes without independent checker availability or when comparison fails", async () => {
    const h = harness();
    await expect(runSmoke({ fetch: h.fetch, log: () => {} })).rejects.toThrow();
    expect(
      (
        await run("normal", async () => {
          throw new Error("private identifiers");
        })
      ).failure,
    ).toBe("FAIL step=d1-comparison status=none code=CONSISTENCY_CHECK_FAILED");
  });
});
