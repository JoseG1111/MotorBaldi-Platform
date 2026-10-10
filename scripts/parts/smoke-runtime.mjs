import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const admin = "https://motorbaldi-admin-development.josegbarrios2.workers.dev";
const portal =
  "https://motorbaldi-portal-development.josegbarrios2.workers.dev";
const api = "https://motorbaldi-api-development.josegbarrios2.workers.dev";
const codes = new Set([
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "MFA_REQUIRED",
  "PARTS_NOT_FOUND",
  "PARTS_VERSION_CONFLICT",
  "PARTS_STATE_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "ORIGIN_FORBIDDEN",
  "VERSION_CONFLICT",
]);
class Failure extends Error {
  constructor(step, code, status) {
    super("Sanitized Parts failure");
    Object.assign(this, { step, code, status });
  }
}
export function formatSmokeFailure(error) {
  if (!(error instanceof Failure))
    return "FAIL step=internal code=INTERNAL_ERROR";
  return `FAIL step=${error.step} status=${error.status ?? "none"} code=${error.code}; known_unclosed=${error.known ?? 0} unknown_outcome=${error.unknown ?? 0} cleanup_failures=${error.cleanup ?? 0}`;
}
export async function runSmoke({
  cookie = "",
  anonymous = false,
  verifyOnly = false,
  fetch: fetcher = globalThis.fetch,
  log = console.log,
} = {}) {
  let unknown = 0;
  const fixtures = [];
  if (
    (!anonymous && (!cookie || /[\r\n]/.test(cookie))) ||
    (anonymous && verifyOnly)
  )
    throw new Failure("configuration", "INVALID_CONFIGURATION");
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
      origin = admin,
      authenticated = true,
    } = {},
  ) {
    const mutation = body !== undefined;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetcher(admin + "/api/v1" + path, {
          method: mutation ? "POST" : "GET",
          headers: {
            origin,
            ...(authenticated && cookie ? { cookie } : {}),
            ...(mutation
              ? { "content-type": "application/json", "idempotency-key": key }
              : {}),
          },
          ...(mutation ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (mutation && status === 200 && attempt === 0) continue;
        if (mutation && status === 200) unknown++;
        throw new Failure(step, "TRANSPORT_ERROR");
      }
      if (response.status >= 500 && mutation && status === 200 && attempt === 0)
        continue;
      const data = await response.json().catch(() => null);
      if (response.status !== status) {
        if (mutation && status === 200 && response.status >= 500) unknown++;
        throw new Failure(
          step,
          codes.has(data?.code) ? data.code : "HTTP_ERROR",
          response.status,
        );
      }
      if (status === 200 && (data === null || typeof data !== "object")) {
        if (mutation && attempt === 0) continue;
        if (mutation) unknown++;
        throw new Failure(step, "INVALID_RESPONSE", response.status);
      }
      if (mutation && status === 200) {
        const field = path.endsWith("/grants")
          ? "grantId"
          : path.startsWith("/admin/vehicles")
            ? "vehicleId"
            : path.startsWith("/admin/parts")
              ? "partId"
              : path.includes("parts-offerings")
                ? "offeringId"
                : path.endsWith("/parts")
                  ? "snapshotId"
                  : "orderId";
        const expectedVersion = [
          "partId",
          "offeringId",
          "orderId",
          "snapshotId",
        ].includes(field)
          ? (body.version ?? 0) + 1
          : undefined;
        if (
          !uuid(data?.[field]) ||
          typeof data.replayed !== "boolean" ||
          (expectedVersion !== undefined && data.version !== expectedVersion)
        ) {
          if (attempt === 0) continue;
          unknown++;
          throw new Failure(step, "INVALID_RESPONSE", response.status);
        }
      }
      return data;
    }
  }
  const uuid = (value) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  function receipt(data, field, step, version) {
    if (
      !uuid(data?.[field]) ||
      typeof data.replayed !== "boolean" ||
      (version !== undefined && data.version !== version)
    ) {
      unknown++;
      throw new Failure(step, "INVALID_RESPONSE");
    }
  }
  async function advance(step, fixture, body) {
    const data = await call(
      step,
      fixture.path + (body.toStatus ? "/transition" : "/update"),
      body,
    );
    receipt(
      data,
      fixture.order
        ? "orderId"
        : fixture.terminal === "ARCHIVED"
          ? "partId"
          : "offeringId",
      step,
      body.version + 1,
    );
    check(
      data[
        fixture.order
          ? "orderId"
          : fixture.terminal === "ARCHIVED"
            ? "partId"
            : "offeringId"
      ] === fixture.path.split("/").at(-1),
      step,
    );
    fixture.version = body.version + 1;
    if (body.toStatus) fixture.status = body.toStatus;
  }
  async function clean(fixture) {
    const data = await call("cleanup-read", fixture.path);
    const row = fixture.order ? data.order : data;
    check(
      row.version === fixture.version &&
        row.status === fixture.status &&
        (fixture.order
          ? row.vehicleId === fixture.vehicleId &&
            row.description === fixture.description
          : row.manufacturerReference === fixture.reference),
      "cleanup-ownership",
    );
    if (row.status === fixture.terminal) {
      fixture.done = true;
      return;
    }
    await advance("cleanup-transition", fixture, {
      version: row.version,
      toStatus: fixture.terminal,
      reason: "Synthetic Development Parts cleanup",
    });
    fixture.done = true;
  }
  try {
    const missing = "018f0000-0000-7000-8000-000000000099";
    for (const path of [
      "/admin/parts",
      `/organizations/${missing}/parts-offerings`,
      `/organizations/${missing}/parts-catalog`,
      `/organizations/${missing}/workshop/orders/${missing}/parts`,
      `/organizations/${missing}/workshop/orders/${missing}/parts/offerings`,
    ])
      await call("anonymous-protection", path, undefined, {
        status: 401,
        authenticated: false,
      });
    for (const host of [admin, portal]) {
      let response;
      try {
        response = await fetcher(host, { signal: AbortSignal.timeout(30000) });
      } catch {
        throw new Failure("assets", "TRANSPORT_ERROR");
      }
      check(
        response.status === 200 &&
          (await response.text()).includes("parts-panel"),
        "assets",
      );
    }
    const health = await fetcher(api + "/health", {
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    check(health?.status === 200, "health");
    if (anonymous) {
      log("PASS Development anonymous Parts protection and assets");
      return;
    }
    const me = await call("session", "/me");
    check(me.mfaEnabled === true, "session");
    await call("canonical-list", "/admin/parts");
    const organizations = await call(
      "fixture-organization",
      "/admin/organizations",
    );
    const org = organizations.items?.find(
      (row) =>
        row.display_name === "MotorBaldi Development Validation Workshop" &&
        row.verification_status === "VERIFIED",
    );
    if (!org)
      throw new Failure("fixture-prerequisite", "PARTS_FIXTURE_REQUIRED");
    const base = `/organizations/${org.id}`;
    const location = (
      await call("fixture-location", base + "/locations")
    ).items?.find(
      (row) =>
        row.name === "MotorBaldi Development Workshop Site" &&
        row.status === "ACTIVE",
    );
    const capabilities = await call(
      "fixture-capabilities",
      base + "/capabilities",
    );
    const permissions = await call(
      "fixture-permissions",
      base + "/permissions",
    );
    if (
      !location ||
      !capabilities.some((row) => row.code === "PARTS") ||
      !permissions.permissions?.includes("org.parts.manage")
    )
      throw new Failure("fixture-prerequisite", "PARTS_FIXTURE_REQUIRED");
    const offers = base + "/parts-offerings";
    await call("offering-list", offers + "?locationId=" + location.id);
    await call(
      "catalog-list",
      base + "/parts-catalog?locationId=" + location.id,
    );
    await call(
      "workshop-scope",
      base + "/workshop/locations/" + location.id + "/vehicles",
    );
    if (verifyOnly) {
      log("PASS Development Parts GET-only verification");
      return;
    }
    const reason = "Synthetic Development Parts validation";
    const data = {
      name: "Synthetic Development Parts fixture",
      category: "VALIDATION",
      brand: "Synthetic Development",
      manufacturerReference: randomUUID(),
      description: reason,
      unit: "UNIT",
      compatibility: [],
    };
    const key = randomUUID();
    await call(
      "origin-rejection",
      "/admin/parts",
      { ...data, reason },
      { status: 403, origin: "https://untrusted.example" },
    );
    const created = await call(
      "canonical-create",
      "/admin/parts",
      { ...data, reason },
      { key },
    );
    receipt(created, "partId", "canonical-receipt", 1);
    const canonical = {
      path: "/admin/parts/" + created.partId,
      terminal: "ARCHIVED",
      reference: data.manufacturerReference,
      version: 1,
      status: "DRAFT",
    };
    fixtures.push(canonical);
    const canonicalReplay = await call(
      "canonical-replay",
      "/admin/parts",
      { ...data, reason },
      { key },
    );
    receipt(canonicalReplay, "partId", "canonical-replay", 1);
    check(
      canonicalReplay.partId === created.partId &&
        canonicalReplay.replayed === true,
      "canonical-replay",
    );
    await call(
      "canonical-mismatch",
      "/admin/parts",
      { ...data, name: "Synthetic mismatch", reason },
      { key, status: 409 },
    );
    await advance("canonical-activate", canonical, {
      version: 1,
      toStatus: "ACTIVE",
      reason,
    });
    await advance("canonical-update", canonical, {
      ...data,
      version: 2,
      reason,
    });
    await call(
      "canonical-stale",
      canonical.path + "/update",
      { ...data, version: 2, reason },
      { status: 409 },
    );
    const matches = await call(
      "strong-match",
      "/admin/parts/match?" +
        new URLSearchParams({
          brand: data.brand,
          manufacturerReference: data.manufacturerReference,
        }),
    );
    check(
      matches.length === 1 && matches[0].id === created.partId,
      "strong-match",
    );
    const vehicle = await call("vehicle-create", "/admin/vehicles", {
      kindCode: "CAR",
      specification: {
        brand: "Synthetic Development",
        model: "Parts validation " + randomUUID(),
      },
      reason,
    });
    receipt(vehicle, "vehicleId", "vehicle-receipt");
    for (const permissionCode of [
      "vehicle.workshop.read",
      "vehicle.workshop.write",
    ])
      receipt(
        await call(
          "vehicle-grant",
          `/admin/vehicles/${vehicle.vehicleId}/grants`,
          {
            organizationId: org.id,
            locationId: location.id,
            permissionCode,
            reason,
          },
        ),
        "grantId",
        "grant-receipt",
      );
    const orderDescription = reason + " " + randomUUID();
    const order = await call("order-create", base + "/workshop/orders", {
      vehicleId: vehicle.vehicleId,
      locationId: location.id,
      assignedPersonId: me.personId,
      description: orderDescription,
      reason,
    });
    receipt(order, "orderId", "order-receipt", 1);
    const orderFixture = {
      path: base + "/workshop/orders/" + order.orderId,
      terminal: "CANCELLED",
      order: true,
      version: 1,
      status: "DRAFT",
      vehicleId: vehicle.vehicleId,
      description: orderDescription,
    };
    fixtures.push(orderFixture);
    const offeringData = {
      ...data,
      locationId: location.id,
      canonicalPartId: created.partId,
      priceMinor: 12345,
      currency: "COP",
      availability: "AVAILABLE",
    };
    const offered = await call("offering-create", offers, {
      ...offeringData,
      reason,
    });
    receipt(offered, "offeringId", "offering-receipt", 1);
    const offering = {
      path: offers + "/" + offered.offeringId,
      terminal: "INACTIVE",
      reference: data.manufacturerReference,
      version: 1,
      status: "DRAFT",
    };
    fixtures.push(offering);
    await advance("offering-activate", offering, {
      version: 1,
      toStatus: "ACTIVE",
      reason,
    });
    const snapshotKey = randomUUID();
    const snapshotInput = {
      offeringId: offered.offeringId,
      version: 1,
      reason,
    };
    const snapshot = await call(
      "snapshot-add",
      orderFixture.path + "/parts",
      snapshotInput,
      { key: snapshotKey },
    );
    receipt(snapshot, "snapshotId", "snapshot-receipt", 2);
    orderFixture.version = 2;
    const snapshotReplay = await call(
      "snapshot-replay",
      orderFixture.path + "/parts",
      snapshotInput,
      { key: snapshotKey },
    );
    receipt(snapshotReplay, "snapshotId", "snapshot-replay", 2);
    check(
      snapshotReplay.snapshotId === snapshot.snapshotId &&
        snapshotReplay.replayed === true,
      "snapshot-replay",
    );
    await call(
      "snapshot-mismatch",
      orderFixture.path + "/parts",
      { ...snapshotInput, reason: "Synthetic mismatched replay" },
      { key: snapshotKey, status: 409 },
    );
    await call("snapshot-stale", orderFixture.path + "/parts", snapshotInput, {
      status: 409,
    });
    const frozen = await call("snapshot-read", orderFixture.path + "/parts");
    check(
      frozen.length === 1 && frozen[0].snapshot?.priceMinor === 12345,
      "snapshot-price",
    );
    await advance("offering-update", offering, {
      ...offeringData,
      priceMinor: 23456,
      version: 2,
      reason,
    });
    await call(
      "offering-stale",
      offering.path + "/update",
      { ...offeringData, version: 2, reason },
      { status: 409 },
    );
    check(
      isDeepStrictEqual(
        frozen,
        await call("snapshot-freeze", orderFixture.path + "/parts"),
      ),
      "snapshot-freeze",
    );
    for (const fixture of [...fixtures].reverse()) await clean(fixture);
    log(
      "PASS Development Parts canonical, scoped offering and immutable Workshop snapshot lifecycle",
    );
  } catch (error) {
    const primary =
      error instanceof Failure
        ? error
        : new Failure("internal", "INVALID_RESPONSE");
    let cleanup = 0;
    for (const fixture of [...fixtures].reverse())
      if (!fixture.done) {
        try {
          await clean(fixture);
        } catch {
          cleanup++;
        }
      }
    Object.assign(primary, {
      known: fixtures.filter((row) => !row.done).length,
      unknown,
      cleanup,
    });
    throw primary;
  }
}
