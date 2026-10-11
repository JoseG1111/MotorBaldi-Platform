import { randomUUID } from "node:crypto";
const admin = "https://motorbaldi-admin-development.josegbarrios2.workers.dev";
const portal =
  "https://motorbaldi-portal-development.josegbarrios2.workers.dev";
const allowedCodes = new Set([
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "MFA_REQUIRED",
  "DEVELOPMENT_AUTOMATION_DENIED",
  "DEVELOPMENT_AUTOMATION_SCOPE",
  "DATABASE_ENVIRONMENT_MISMATCH",
  "PARTS_NOT_FOUND",
  "PARTS_STATE_CONFLICT",
  "MARKETPLACE_NOT_FOUND",
  "MARKETPLACE_STATE_CONFLICT",
  "MARKETPLACE_SOURCE_INELIGIBLE",
  "MARKETPLACE_LOCATION_INVALID",
  "MARKETPLACE_LISTING_EXISTS",
  "IDEMPOTENCY_CONFLICT",
  "ORIGIN_FORBIDDEN",
]);
class Failure extends Error {
  constructor(step, code, status) {
    super("Sanitized Development marketplace failure");
    Object.assign(this, { step, code, status });
  }
}
export function formatSmokeFailure(error) {
  if (!(error instanceof Failure))
    return "FAIL step=internal status=none code=INTERNAL_ERROR";
  return `FAIL step=${error.step} status=${error.status ?? "none"} code=${error.code}; known_unclosed=${error.known ?? 0} unknown_outcome=${error.unknown ?? 0} cleanup_failures=${error.cleanup ?? 0}`;
}
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const publicFields = new Set([
  "listingId",
  "name",
  "category",
  "brand",
  "manufacturerReference",
  "description",
  "unit",
  "compatibility",
  "priceMinor",
  "currency",
  "priceIndicative",
  "availability",
  "lastUpdatedAt",
  "partnerBusinessName",
  "country",
  "generalLocation",
  "compatibilityNotice",
  "availabilityNotice",
]);
export async function runSmoke({
  anonymous = false,
  fetch: fetcher = globalThis.fetch,
  log = console.log,
} = {}) {
  const fixtures = [];
  let unknown = 0,
    failure = null,
    cleanupFailures = 0;
  const check = (condition, step) => {
    if (!condition) throw new Failure(step, "ASSERTION_FAILED");
  };
  async function call(
    step,
    path,
    body,
    {
      status = 200,
      key = randomUUID(),
      authenticated = true,
      origin = admin,
      field,
      version,
    } = {},
  ) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetcher(admin + "/api/v1" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin,
            ...(authenticated
              ? { "x-motorbaldi-automation-intent": "true" }
              : {}),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json", "idempotency-key": key }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (attempt === 0) continue;
        const error = new Failure(step, "TRANSPORT_ERROR");
        if (body !== undefined && status === 200) {
          unknown++;
          error.ambiguous = true;
        }
        throw error;
      }
      if (
        [429, 502, 503, 504].includes(response.status) &&
        status === 200 &&
        attempt === 0
      ) {
        const seconds = Number(response.headers.get("retry-after"));
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              10000,
              Math.max(
                250,
                Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500,
              ),
            ),
          ),
        );
        continue;
      }
      const data = await response.json().catch(() => null);
      if (response.status !== status) {
        if (response.status >= 500 && status === 200 && attempt === 0) continue;
        const error = new Failure(
          step,
          allowedCodes.has(data?.code) ? data.code : "HTTP_ERROR",
          response.status,
        );
        if (body !== undefined && status === 200 && response.status >= 500) {
          unknown++;
          error.ambiguous = true;
        }
        throw error;
      }
      if (
        status === 200 &&
        (data === null ||
          typeof data !== "object" ||
          (field &&
            (!uuid(data[field]) ||
              typeof data.replayed !== "boolean" ||
              data.version !== version)))
      ) {
        if (attempt === 0) continue;
        const error = new Failure(step, "INVALID_RESPONSE", response.status);
        if (body !== undefined) {
          unknown++;
          error.ambiguous = true;
        }
        throw error;
      }
      return data;
    }
  }
  async function apply(
    fixture,
    step,
    path,
    body,
    {
      field = fixture.field,
      nextStatus = fixture.status,
      key = randomUUID(),
    } = {},
  ) {
    const pending = {
      step,
      path,
      body,
      field,
      version: (body.version ?? 0) + 1,
      key,
      nextStatus,
    };
    fixture.pending = pending;
    try {
      const response = await call(step, path, body, {
        field,
        version: pending.version,
        key,
      });
      accept(fixture, response, pending);
      return response;
    } catch (error) {
      fixture.ambiguous = error instanceof Failure && error.ambiguous === true;
      if (!fixture.ambiguous) fixture.pending = null;
      throw error;
    }
  }
  function accept(fixture, response, pending) {
    fixture.id = response[pending.field];
    fixture.version = response.version;
    fixture.status = pending.nextStatus;
    fixture.pending = null;
    if (fixture.ambiguous) {
      unknown--;
      fixture.ambiguous = false;
    }
  }
  async function recover(fixture) {
    if (!fixture.pending) return;
    const pending = fixture.pending;
    try {
      const response = await call(
        "cleanup-recover",
        pending.path,
        pending.body,
        { field: pending.field, version: pending.version, key: pending.key },
      );
      accept(fixture, response, pending);
    } catch (error) {
      if (error instanceof Failure && error.ambiguous) unknown--;
      const matches = [];
      let cursor = "";
      for (let page = 0; page < 10; page++) {
        const target =
          fixture.type === "canonical" ? "/admin/parts" : fixture.base;
        const response = await call(
          "cleanup-owned-discovery",
          target +
            "?limit=50" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        );
        const rows = fixture.type === "listing" ? response.items : response;
        if (!Array.isArray(rows)) throw error;
        for (const row of rows) {
          const match =
            fixture.type === "listing"
              ? row.offeringId === fixture.offeringId &&
                row.organizationId === fixture.org
              : row.manufacturerReference === fixture.reference &&
                row.name === fixture.name &&
                row.brand === "Synthetic Development" &&
                row.category === "VALIDATION" &&
                (!fixture.org ||
                  (row.organizationId === fixture.org &&
                    row.locationId === fixture.locationId &&
                    row.canonicalPartId === fixture.canonicalId));
          if (match) matches.push(row);
        }
        if (rows.length < 50) {
          cursor = "";
          break;
        }
        cursor =
          fixture.type === "listing" ? rows.at(-1).listingId : rows.at(-1).id;
        if (!uuid(cursor)) throw error;
      }
      if (cursor || matches.length !== 1) throw error;
      const row = matches[0],
        id = fixture.type === "listing" ? row.listingId : row.id;
      if (
        !uuid(id) ||
        row.version !== pending.version ||
        row.status !== pending.nextStatus ||
        (pending.body.priceMinor !== undefined &&
          row.priceMinor !== pending.body.priceMinor)
      )
        throw error;
      accept(fixture, { [pending.field]: id, version: row.version }, pending);
    }
  }
  async function cleanup(fixture) {
    await recover(fixture);
    if (!fixture.id) {
      if (fixture.pending || fixture.ambiguous)
        throw new Failure("cleanup-unknown", "UNKNOWN_OUTCOME");
      fixture.done = true;
      return;
    }
    const path =
      fixture.type === "canonical"
        ? "/admin/parts/" + fixture.id
        : fixture.base + "/" + fixture.id;
    const row = await call("cleanup-read", path);
    check(
      row.version === fixture.version &&
        row.status === fixture.status &&
        (fixture.type === "listing"
          ? row.offeringId === fixture.offeringId &&
            row.organizationId === fixture.org
          : row.manufacturerReference === fixture.reference &&
            row.name === fixture.name &&
            row.brand === "Synthetic Development" &&
            row.category === "VALIDATION" &&
            (!fixture.org ||
              (row.organizationId === fixture.org &&
                row.locationId === fixture.locationId &&
                row.canonicalPartId === fixture.canonicalId))),
      "cleanup-ownership",
    );
    const terminal =
      fixture.type === "canonical"
        ? "ARCHIVED"
        : fixture.type === "offering"
          ? "INACTIVE"
          : "SUSPENDED";
    if (row.status !== terminal)
      await apply(
        fixture,
        "cleanup-transition",
        path + (fixture.type === "listing" ? "/withdraw" : "/transition"),
        {
          version: row.version,
          ...(fixture.type === "listing" ? {} : { toStatus: terminal }),
          reason: "Synthetic Development marketplace cleanup",
        },
        { nextStatus: terminal },
      );
    const verified = await call("cleanup-verify", path);
    check(
      verified.status === terminal && verified.version === fixture.version,
      "cleanup-verification",
    );
    fixture.done = true;
  }
  function validatePublic(
    row,
    listing,
    price,
    name,
    reference,
    generalLocation,
  ) {
    check(
      row.listingId === listing.id &&
        row.name === name &&
        row.manufacturerReference === reference &&
        row.brand === "Synthetic Development" &&
        row.category === "VALIDATION" &&
        row.priceMinor === price &&
        row.priceIndicative === true &&
        row.currency === "COP" &&
        row.availability === "AVAILABLE" &&
        row.generalLocation === generalLocation &&
        typeof row.partnerBusinessName === "string" &&
        row.partnerBusinessName.length > 0 &&
        typeof row.lastUpdatedAt === "string" &&
        row.compatibilityNotice &&
        row.availabilityNotice &&
        Array.isArray(row.compatibility) &&
        row.compatibility.length === 0 &&
        Object.keys(row).every((key) => publicFields.has(key)),
      "public-privacy",
    );
  }
  try {
    const capabilities = await call(
      "public-capabilities",
      "/public/parts/capabilities",
      undefined,
      { authenticated: false },
    );
    check(
      capabilities.discovery === true &&
        [
          "orders",
          "checkout",
          "payments",
          "wompi",
          "reservations",
          "inventoryDeductions",
          "commissions",
          "transactionFees",
          "media",
          "automaticFulfillment",
        ].every((field) => capabilities[field] === false),
      "commerce-disabled",
    );
    const page = await call(
      "public-list",
      "/public/parts?limit=20",
      undefined,
      { authenticated: false },
    );
    check(
      Array.isArray(page.items) && Object.hasOwn(page, "nextCursor"),
      "public-list",
    );
    await call(
      "public-query-rejection",
      "/public/parts?limit=20&limit=20",
      undefined,
      { authenticated: false, status: 400 },
    );
    const missing = "018f0000-0000-7000-8000-000000000099";
    await call("public-hidden", "/public/parts/" + missing, undefined, {
      authenticated: false,
      status: 404,
    });
    for (const path of [
      "/admin/marketplace/listings",
      `/organizations/${missing}/marketplace-listings`,
    ])
      await call("anonymous-protection", path, undefined, {
        authenticated: false,
        status: 401,
      });
    for (const [host, marker] of [
      [portal, "marketplace-public"],
      [admin, "marketplace-review"],
    ]) {
      let response;
      try {
        response = await fetcher(host, { signal: AbortSignal.timeout(30000) });
      } catch {
        throw new Failure("assets", "TRANSPORT_ERROR");
      }
      check(
        response.status === 200 && (await response.text()).includes(marker),
        "assets",
      );
    }
    if (anonymous) {
      log(
        "PASS Development anonymous marketplace discovery, privacy and disabled-commerce protection",
      );
      return;
    }
    const me = await call("automation-session", "/me");
    check(
      me.authenticationMethod === "DEVELOPMENT_AUTOMATION" &&
        me.mfaEnabled === false,
      "automation-session",
    );
    const organizations = await call(
      "fixture-organization",
      "/admin/organizations",
    );
    const matches =
      organizations.items?.filter(
        (row) =>
          row.display_name === "MotorBaldi Development Validation Workshop" &&
          row.status === "ACTIVE" &&
          row.verification_status === "VERIFIED",
      ) ?? [];
    check(matches.length === 1 && uuid(matches[0].id), "fixture-organization");
    const org = matches[0].id,
      base = "/organizations/" + org;
    const sites =
      (await call("fixture-location", base + "/locations")).items?.filter(
        (row) =>
          row.name === "MotorBaldi Development Workshop Site" &&
          row.status === "ACTIVE",
      ) ?? [];
    check(
      sites.length === 1 &&
        uuid(sites[0].id) &&
        typeof sites[0].generalLocation === "string" &&
        sites[0].generalLocation.length > 0,
      "fixture-location",
    );
    const location = sites[0];
    const capabilitiesBefore = await call(
      "fixture-capabilities",
      base + "/capabilities",
    );
    if (!capabilitiesBefore.some((row) => row.code === "PARTS"))
      throw new Failure("fixture-prerequisite", "PARTS_FIXTURE_REQUIRED");
    const reason = "Synthetic Development marketplace validation",
      reference = randomUUID(),
      data = {
        name: "Synthetic Development marketplace " + reference,
        category: "VALIDATION",
        brand: "Synthetic Development",
        manufacturerReference: reference,
        description: reason,
        unit: "UNIT",
        compatibility: [],
      };
    const canonical = {
      type: "canonical",
      field: "partId",
      name: data.name,
      reference,
      status: "DRAFT",
    };
    fixtures.push(canonical);
    await apply(
      canonical,
      "canonical-create",
      "/admin/parts",
      { ...data, reason },
      { nextStatus: "DRAFT" },
    );
    await apply(
      canonical,
      "canonical-activate",
      "/admin/parts/" + canonical.id + "/transition",
      { version: canonical.version, toStatus: "ACTIVE", reason },
      { nextStatus: "ACTIVE" },
    );
    const offers = base + "/parts-offerings",
      offeringData = {
        ...data,
        locationId: location.id,
        canonicalPartId: canonical.id,
        partnerSku: "Synthetic private SKU",
        priceMinor: 12345,
        currency: "COP",
        availability: "AVAILABLE",
      };
    const offering = {
      type: "offering",
      field: "offeringId",
      base: offers,
      org,
      locationId: location.id,
      canonicalId: canonical.id,
      name: data.name,
      reference,
      status: "DRAFT",
    };
    fixtures.push(offering);
    await apply(
      offering,
      "offering-create",
      offers,
      { ...offeringData, reason },
      { nextStatus: "DRAFT" },
    );
    await apply(
      offering,
      "offering-activate",
      offers + "/" + offering.id + "/transition",
      { version: offering.version, toStatus: "ACTIVE", reason },
      { nextStatus: "ACTIVE" },
    );
    const listings = base + "/marketplace-listings",
      listing = {
        type: "listing",
        field: "listingId",
        base: listings,
        org,
        offeringId: offering.id,
        status: "DRAFT",
      };
    fixtures.push(listing);
    await apply(
      listing,
      "listing-create",
      listings,
      {
        offeringId: offering.id,
        generalLocation: location.generalLocation,
        reason,
      },
      { nextStatus: "DRAFT" },
    );
    const publicPath = "/public/parts/" + listing.id,
      listingPath = listings + "/" + listing.id,
      reviewPath = "/admin/marketplace/listings/" + listing.id;
    await call("draft-private", publicPath, undefined, {
      authenticated: false,
      status: 404,
    });
    await apply(
      listing,
      "listing-submit",
      listingPath + "/submit",
      { version: listing.version, reason },
      { nextStatus: "PENDING_REVIEW" },
    );
    await call("pending-private", publicPath, undefined, {
      authenticated: false,
      status: 404,
    });
    const approvalKey = randomUUID(),
      approvalBody = { organizationId: org, version: listing.version, reason };
    const approved = await apply(
      listing,
      "listing-approve",
      reviewPath + "/approve",
      approvalBody,
      { nextStatus: "PUBLISHED", key: approvalKey },
    );
    const replay = await call(
      "approval-replay",
      reviewPath + "/approve",
      approvalBody,
      { key: approvalKey, field: "listingId", version: approved.version },
    );
    check(
      replay.replayed === true && replay.listingId === listing.id,
      "approval-replay",
    );
    await call(
      "approval-idempotency-mismatch",
      reviewPath + "/approve",
      { ...approvalBody, reason: reason + " changed" },
      { key: approvalKey, status: 409 },
    );
    await call(
      "approval-stale",
      reviewPath + "/suspend",
      { organizationId: org, version: approvalBody.version, reason },
      { status: 409 },
    );
    await call(
      "origin-rejection",
      reviewPath + "/suspend",
      { organizationId: org, version: listing.version, reason },
      { origin: "https://untrusted.example", status: 403 },
    );
    validatePublic(
      await call("approved-public", publicPath, undefined, {
        authenticated: false,
      }),
      listing,
      12345,
      data.name,
      reference,
      location.generalLocation,
    );
    const search = await call(
      "approved-public-search",
      "/public/parts?limit=20&q=" +
        encodeURIComponent(data.name) +
        "&category=VALIDATION",
      undefined,
      { authenticated: false },
    );
    check(
      search.items.length === 1 && search.items[0].listingId === listing.id,
      "approved-public-search",
    );
    await apply(
      offering,
      "source-price-update",
      offers + "/" + offering.id + "/update",
      { ...offeringData, priceMinor: 23456, version: offering.version, reason },
      { nextStatus: "ACTIVE" },
    );
    await call("stale-source-hidden", publicPath, undefined, {
      authenticated: false,
      status: 404,
    });
    await apply(
      listing,
      "source-resubmit",
      listingPath + "/submit",
      { version: listing.version, reason },
      { nextStatus: "PENDING_REVIEW" },
    );
    await apply(
      listing,
      "source-reapprove",
      reviewPath + "/approve",
      { organizationId: org, version: listing.version, reason },
      { nextStatus: "PUBLISHED" },
    );
    validatePublic(
      await call("fresh-approved-public", publicPath, undefined, {
        authenticated: false,
      }),
      listing,
      23456,
      data.name,
      reference,
      location.generalLocation,
    );
    await apply(
      listing,
      "rejection-submit",
      listingPath + "/submit",
      { version: listing.version, reason },
      { nextStatus: "PENDING_REVIEW" },
    );
    await apply(
      listing,
      "staff-reject",
      reviewPath + "/reject",
      { organizationId: org, version: listing.version, reason },
      { nextStatus: "DRAFT" },
    );
    await call("rejected-private", publicPath, undefined, {
      authenticated: false,
      status: 404,
    });
    await apply(
      listing,
      "rejected-resubmit",
      listingPath + "/submit",
      { version: listing.version, reason },
      { nextStatus: "PENDING_REVIEW" },
    );
    await apply(
      listing,
      "rejected-reapprove",
      reviewPath + "/approve",
      { organizationId: org, version: listing.version, reason },
      { nextStatus: "PUBLISHED" },
    );
    await apply(
      listing,
      "staff-revoke",
      reviewPath + "/suspend",
      { organizationId: org, version: listing.version, reason },
      { nextStatus: "SUSPENDED" },
    );
    await call("revoked-private", publicPath, undefined, {
      authenticated: false,
      status: 404,
    });
    await apply(
      listing,
      "partner-withdraw",
      listingPath + "/withdraw",
      { version: listing.version, reason },
      { nextStatus: "SUSPENDED" },
    );
    const capabilitiesAfter = await call(
      "fixture-capabilities-preserved",
      base + "/capabilities",
    );
    check(
      JSON.stringify(capabilitiesAfter) === JSON.stringify(capabilitiesBefore),
      "fixture-capabilities-preserved",
    );
  } catch (error) {
    failure =
      error instanceof Failure
        ? error
        : new Failure("internal", "INTERNAL_ERROR");
  } finally {
    for (const fixture of [...fixtures].reverse()) {
      try {
        await cleanup(fixture);
      } catch (error) {
        cleanupFailures++;
        failure ??=
          error instanceof Failure
            ? error
            : new Failure("cleanup", "INTERNAL_ERROR");
      }
    }
  }
  if (failure) {
    failure.known = fixtures.filter((f) => f.id && !f.done).length;
    failure.unknown = unknown;
    failure.cleanup = cleanupFailures;
    throw failure;
  }
  check(unknown === 0 && fixtures.every((f) => f.done), "cleanup-evidence");
  log(
    "PASS Development marketplace publication, moderation, privacy, source refresh and owned synthetic cleanup",
  );
}
