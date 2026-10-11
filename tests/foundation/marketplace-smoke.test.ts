import { describe, expect, it } from "vitest";
const runtimePath = "../../scripts/marketplace/smoke-runtime.mjs";
const { runSmoke, formatSmokeFailure } = await import(runtimePath);
const ids = {
  org: "018f0000-0000-7000-8000-000000000001",
  site: "018f0000-0000-7000-8000-000000000002",
  part: "018f0000-0000-7000-8000-000000000003",
  offer: "018f0000-0000-7000-8000-000000000004",
  listing: "018f0000-0000-7000-8000-000000000005",
};
type Row = Record<string, unknown> & { status: string; version: number };
function harness(mode = "normal") {
  const calls: { path: string; init: RequestInit }[] = [],
    rows = new Map<string, Row>(),
    receipts = new Map<
      string,
      { body: string; receipt: Record<string, unknown> }
    >();
  let thrown = false,
    creates = 0;
  const fetch = async (url: string, init: RequestInit = {}) => {
    const target = new URL(url),
      path = target.pathname.replace("/api/v1", "");
    calls.push({ path, init });
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status });
    const headers = new Headers(init.headers),
      signed = headers.get("x-motorbaldi-automation-intent") === "true";
    if (path === "/")
      return new Response(
        target.hostname.startsWith("motorbaldi-admin")
          ? "marketplace-review"
          : "marketplace-public",
      );
    if (path.startsWith("/public/parts")) {
      if (target.searchParams.getAll("limit").length > 1)
        return json({ code: "INVALID_MARKETPLACE_QUERY" }, 400);
      if (path.endsWith("/capabilities"))
        return json({
          discovery: true,
          orders: false,
          checkout: false,
          payments: false,
          wompi: false,
          reservations: false,
          inventoryDeductions: false,
          commissions: false,
          transactionFees: false,
          media: false,
          automaticFulfillment: false,
        });
      const listing = rows.get(ids.listing),
        offering = rows.get(ids.offer);
      const visible =
        listing?.status === "PUBLISHED" &&
        offering?.status === "ACTIVE" &&
        listing.offeringVersion === offering.version;
      const view = listing
        ? {
            listingId: ids.listing,
            name: offering?.name,
            category: "VALIDATION",
            brand: "Synthetic Development",
            manufacturerReference: offering?.manufacturerReference,
            description: "Synthetic Development marketplace validation",
            unit: "UNIT",
            compatibility: [],
            priceMinor: listing.priceMinor,
            currency: "COP",
            priceIndicative: true,
            availability: "AVAILABLE",
            lastUpdatedAt: "2026-10-10T00:00:00.000Z",
            partnerBusinessName: "Synthetic partner",
            country: "CO",
            generalLocation: "Synthetic City, Synthetic Region",
            compatibilityNotice: "Informational",
            availabilityNotice: "Informational",
          }
        : null;
      if (path !== "/public/parts")
        return visible && path.endsWith(ids.listing)
          ? json(view)
          : json({ code: "MARKETPLACE_NOT_FOUND" }, 404);
      return json({ items: visible ? [view] : [], nextCursor: null });
    }
    if (!signed) return json({ code: "UNAUTHORIZED" }, 401);
    if (mode === "private-error")
      return json(
        { code: "secret-token-cookie-person-id", details: "private-body-PII" },
        403,
      );
    if (path === "/me")
      return json({
        mfaEnabled: false,
        authenticationMethod: "DEVELOPMENT_AUTOMATION",
      });
    if (path === "/admin/organizations")
      return json({
        items: [
          {
            id: ids.org,
            status: "ACTIVE",
            verification_status: "VERIFIED",
            display_name: "MotorBaldi Development Validation Workshop",
          },
        ],
      });
    if (path.endsWith("/locations"))
      return json({
        items: [
          {
            id: ids.site,
            status: "ACTIVE",
            name: "MotorBaldi Development Workshop Site",
            generalLocation: "Synthetic City, Synthetic Region",
          },
        ],
      });
    if (path.endsWith("/capabilities"))
      return json([{ code: "PARTS" }, { code: "WORKSHOP" }]);
    if (init.method !== "POST") {
      const listing = rows.get(ids.listing);
      if (path.endsWith("/marketplace-listings"))
        return json({
          items: listing ? [{ ...listing, listingId: ids.listing }] : [],
          nextCursor: null,
        });
      if (path.endsWith("/parts-offerings"))
        return json(rows.has(ids.offer) ? [rows.get(ids.offer)] : []);
      if (path === "/admin/parts")
        return json(rows.has(ids.part) ? [rows.get(ids.part)] : []);
      const row = rows.get(path.split("/").at(-1)!);
      if (!row) return json({ code: "PARTS_NOT_FOUND" }, 404);
      if (mode === "foreign-cleanup" && path.endsWith(ids.part))
        return json({ ...row, manufacturerReference: "foreign-reference" });
      return json(
        row.id === ids.listing ? { ...row, listingId: ids.listing } : row,
      );
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (headers.get("origin") === "https://untrusted.example")
      return json({ code: "ORIGIN_FORBIDDEN" }, 403);
    if (mode === "partial" && path.endsWith("/approve"))
      return json({ code: "FORBIDDEN" }, 403);
    if (mode === "no-outcome" && path === "/admin/parts")
      throw new Error("secret transport credentials response");
    const key = path + ":" + headers.get("idempotency-key"),
      prior = receipts.get(key);
    if (prior) {
      if (prior.body !== String(init.body))
        return json({ code: "IDEMPOTENCY_CONFLICT" }, 409);
      if (mode === "corrupt-receipt" && path === "/admin/parts")
        return json({ secret: "private-response" });
      return json({ ...prior.receipt, replayed: true });
    }
    const collection =
      path === "/admin/parts" ||
      path.endsWith("/parts-offerings") ||
      path.endsWith("/marketplace-listings");
    const resource = path.includes("marketplace")
      ? ids.listing
      : path.includes("parts-offerings")
        ? ids.offer
        : ids.part;
    let row = rows.get(resource);
    if (collection) {
      creates++;
      row = {
        ...body,
        id: resource,
        status: "DRAFT",
        version: 1,
        ...(resource !== ids.part ? { organizationId: ids.org } : {}),
        ...(resource === ids.listing ? { offeringId: ids.offer } : {}),
      };
      rows.set(resource, row);
    } else {
      if (!row) throw new Error("Missing synthetic test row");
      if (row.version !== body.version)
        return json({ code: "MARKETPLACE_STATE_CONFLICT" }, 409);
      row.version++;
      const action = path.split("/").at(-1);
      if (action === "transition") row.status = String(body.toStatus);
      if (action === "update")
        Object.assign(row, body, { version: row.version });
      if (action === "submit") {
        row.status = "PENDING_REVIEW";
        row.offeringVersion = rows.get(ids.offer)?.version;
        row.priceMinor = rows.get(ids.offer)?.priceMinor;
      }
      if (action === "approve") row.status = "PUBLISHED";
      if (action === "reject") row.status = "DRAFT";
      if (action === "withdraw" || action === "suspend")
        row.status = "SUSPENDED";
    }
    const field =
      resource === ids.part
        ? "partId"
        : resource === ids.offer
          ? "offeringId"
          : "listingId";
    const receipt = {
      [field]: resource,
      version: row!.version,
      replayed: false,
    };
    receipts.set(key, { body: String(init.body), receipt });
    if (mode === "ambiguous-once" && !thrown && path === "/admin/parts") {
      thrown = true;
      throw new Error("secret response credentials");
    }
    if (mode === "corrupt-receipt" && path === "/admin/parts")
      return json({ secret: "private-response" });
    return json(receipt);
  };
  return {
    fetch,
    calls,
    rows,
    get creates() {
      return creates;
    },
  };
}
describe("Development marketplace smoke safety", () => {
  it("verifies public discovery and moderation then preserves only terminal synthetic records", async () => {
    const h = harness(),
      logs: string[] = [];
    await runSmoke({ fetch: h.fetch, log: (line: string) => logs.push(line) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^PASS/);
    expect(h.rows.get(ids.part)?.status).toBe("ARCHIVED");
    expect(h.rows.get(ids.offer)?.status).toBe("INACTIVE");
    expect(h.rows.get(ids.listing)?.status).toBe("SUSPENDED");
    expect(
      h.calls.every(
        (c) =>
          !new Headers(c.init.headers).has("cookie") &&
          !new Headers(c.init.headers).has("authorization"),
      ),
    ).toBe(true);
    expect(h.creates).toBe(3);
  });
  it("runs anonymous reads without authentication or fixture mutations", async () => {
    const h = harness();
    await runSmoke({ anonymous: true, fetch: h.fetch, log: () => {} });
    expect(h.creates).toBe(0);
    expect(
      h.calls.every(
        (c) =>
          c.init.method !== "POST" &&
          !new Headers(c.init.headers).has("x-motorbaldi-automation-intent"),
      ),
    ).toBe(true);
  });
  it("retries an ambiguous committed create using the identical body and idempotency key", async () => {
    const h = harness("ambiguous-once");
    await runSmoke({ fetch: h.fetch, log: () => {} });
    const creates = h.calls.filter(
      (c) => c.path === "/admin/parts" && c.init.method === "POST",
    );
    expect(creates).toHaveLength(2);
    expect(creates[0]?.init.body).toBe(creates[1]?.init.body);
    expect(new Headers(creates[0]?.init.headers).get("idempotency-key")).toBe(
      new Headers(creates[1]?.init.headers).get("idempotency-key"),
    );
    expect(h.creates).toBe(3);
  });
  it("withholds arbitrary server codes and response bodies from diagnostics", async () => {
    const h = harness("private-error");
    let error: unknown;
    try {
      await runSmoke({ fetch: h.fetch, log: () => {} });
    } catch (e) {
      error = e;
    }
    const message = formatSmokeFailure(error);
    expect(message).toContain(
      "step=automation-session status=403 code=HTTP_ERROR",
    );
    expect(message).not.toMatch(/secret|cookie|token|person|private-body|PII/);
  });
  it("cleans partial publication fixtures after an authorization failure and preserves failure", async () => {
    const h = harness("partial");
    let error: unknown;
    try {
      await runSmoke({ fetch: h.fetch, log: () => {} });
    } catch (e) {
      error = e;
    }
    expect(formatSmokeFailure(error)).toContain(
      "step=listing-approve status=403 code=FORBIDDEN",
    );
    expect(formatSmokeFailure(error)).toContain(
      "known_unclosed=0 unknown_outcome=0 cleanup_failures=0",
    );
    expect(h.rows.get(ids.listing)?.status).toBe("SUSPENDED");
    expect(h.rows.get(ids.offer)?.status).toBe("INACTIVE");
    expect(h.rows.get(ids.part)?.status).toBe("ARCHIVED");
  });
  it("preserves a concurrently changed resource instead of mutating a foreign fingerprint", async () => {
    const h = harness("foreign-cleanup");
    let error: unknown;
    try {
      await runSmoke({ fetch: h.fetch, log: () => {} });
    } catch (e) {
      error = e;
    }
    expect(formatSmokeFailure(error)).toContain("step=cleanup-ownership");
    expect(formatSmokeFailure(error)).toContain(
      "known_unclosed=1 unknown_outcome=0 cleanup_failures=1",
    );
    expect(h.rows.get(ids.part)?.status).toBe("ACTIVE");
  });
  it("reconciles an owned unique synthetic create with withheld receipts before cleanup without marking smoke passed", async () => {
    const h = harness("corrupt-receipt");
    let error: unknown;
    try {
      await runSmoke({
        fetch: h.fetch,
        log: () => {
          throw new Error("False pass");
        },
      });
    } catch (e) {
      error = e;
    }
    expect(formatSmokeFailure(error)).toContain(
      "step=canonical-create status=200 code=INVALID_RESPONSE",
    );
    expect(formatSmokeFailure(error)).toContain(
      "known_unclosed=0 unknown_outcome=0 cleanup_failures=0",
    );
    expect(h.rows.get(ids.part)?.status).toBe("ARCHIVED");
    expect(h.creates).toBe(1);
  });
  it("reports an unresolved creation outcome without exposing IDs or claiming successful cleanup", async () => {
    const h = harness("no-outcome");
    let error: unknown;
    try {
      await runSmoke({ fetch: h.fetch, log: () => {} });
    } catch (e) {
      error = e;
    }
    expect(formatSmokeFailure(error)).toContain(
      "step=canonical-create status=none code=TRANSPORT_ERROR",
    );
    expect(formatSmokeFailure(error)).toContain(
      "unknown_outcome=1 cleanup_failures=1",
    );
    expect(formatSmokeFailure(error)).not.toContain(ids.org);
    expect(h.creates).toBe(0);
  });
});
