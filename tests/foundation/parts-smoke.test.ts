import { parseWorkshopCommand } from "@motorbaldi/workshops";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const runtimePath = "../../scripts/parts/smoke-runtime.mjs";
const { runSmoke, formatSmokeFailure } = await import(runtimePath);
const ids = {
  part: "11111111-1111-4111-8111-111111111111",
  offer: "22222222-2222-4222-8222-222222222222",
  order: "33333333-3333-4333-8333-333333333333",
  vehicle: "44444444-4444-4444-8444-444444444444",
  grant: "55555555-5555-4555-8555-555555555555",
  snapshot: "66666666-6666-4666-8666-666666666666",
  grant2: "77777777-7777-4777-8777-777777777777",
};
function harness(mode = "normal", automation = false) {
  const calls: { url: string; init: RequestInit }[] = [];
  const rows = new Map<
    string,
    Record<string, unknown> & { status: string; version: number }
  >();
  const receipts = new Map<string, unknown>();
  const grants = new Map<string, string>();
  let ambiguous = false;
  let createdGrants = 0;
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) =>
      Response.json(data, { status });
    if (path === "/") return new Response("parts-panel");
    if (path === "/health") return json({ ok: true });
    if (
      !(init.headers as Record<string, string>).cookie &&
      (init.headers as Record<string, string>)[
        "x-motorbaldi-automation-intent"
      ] !== "true"
    )
      return json({ code: "UNAUTHORIZED" }, 401);
    if (mode === "http")
      return json({ code: "secret-cookie-person-id", body: "PII" }, 403);
    if (path === "/me")
      return json({
        mfaEnabled: !automation,
        authenticationMethod: automation
          ? "DEVELOPMENT_AUTOMATION"
          : "HUMAN_SESSION",
        personId: "person",
      });
    if (path === "/development/automation/fixtures/parts/enable")
      return json({
        enabled: true,
        organizationId: "org",
        locationId: "site",
        replayed: false,
      });
    if (path === "/admin/organizations")
      return json({
        items: [
          {
            id: "org",
            display_name: "MotorBaldi Development Validation Workshop",
            verification_status: "VERIFIED",
          },
        ],
      });
    if (path.endsWith("/locations"))
      return json({
        items: [
          {
            id: "site",
            name: "MotorBaldi Development Workshop Site",
            status: "ACTIVE",
          },
        ],
      });
    if (path.endsWith("/capabilities"))
      return json(mode === "prerequisite" ? [] : [{ code: "PARTS" }]);
    if (path.endsWith("/permissions"))
      return json({ permissions: ["org.parts.manage"] });
    if (init.method !== "POST") {
      if (path === "/admin/parts/match") return json([{ id: ids.part }]);
      if (
        mode === "concurrent" &&
        rows.has(path) &&
        path.includes("parts-offerings/")
      )
        rows.get(path)!.version++;
      if (rows.has(path)) {
        const row = rows.get(path)!;
        return json(
          path.includes("workshop/orders")
            ? {
                order: {
                  ...row,
                  vehicle_id:
                    mode === "foreign-order" ? ids.grant : row.vehicleId,
                  vehicleId: undefined,
                },
              }
            : row,
        );
      }
      if (path.endsWith("/parts") && path.includes("workshop"))
        return json([{ snapshot: { priceMinor: 12345 } }]);
      return json([]);
    }
    const body = JSON.parse(init.body as string);
    const headers = init.headers as Record<string, string>;
    if (headers.origin === "https://untrusted.example") return json({}, 403);
    const key = headers["idempotency-key"]!;
    if (receipts.has(key)) {
      if (
        body.name === "Synthetic mismatch" ||
        body.reason === "Synthetic mismatched replay"
      )
        return json({}, 409);
      return json({
        ...(receipts.get(key) as Record<string, unknown>),
        replayed: true,
      });
    }
    if (path.endsWith("/transition") || path.endsWith("/update")) {
      const row = rows.get(path.replace(/\/(transition|update)$/, ""))!;
      if (row.version !== body.version) return json({}, 409);
      if (mode === "cleanup" && body.toStatus === "INACTIVE")
        return json({}, 403);
      row.version++;
      if (body.toStatus) row.status = body.toStatus;
    }
    if (
      path.endsWith("/parts") &&
      path.includes("workshop") &&
      rows.get(path.replace(/\/parts$/, ""))!.version !== body.version
    )
      return json({}, 409);
    let receipt: unknown = {
      partId: path.includes("/admin/parts/") ? ids.part : undefined,
      offeringId: path.includes("parts-offerings/") ? ids.offer : undefined,
      orderId: path.includes("workshop/orders/") ? ids.order : undefined,
      version: body.version + 1,
    };
    if (path === "/admin/parts") {
      receipt = { partId: ids.part, version: 1 };
      rows.set(path + "/" + ids.part, {
        status: "DRAFT",
        version: 1,
        manufacturerReference: body.manufacturerReference,
        vehicleId: body.vehicleId,
        description: body.description,
      });
    }
    if (path.endsWith("/parts-offerings")) {
      receipt = { offeringId: ids.offer, version: 1 };
      rows.set(path + "/" + ids.offer, {
        status: "DRAFT",
        version: 1,
        manufacturerReference: body.manufacturerReference,
        vehicleId: body.vehicleId,
        description: body.description,
      });
    }
    if (path.endsWith("/workshop/orders")) {
      receipt = { orderId: ids.order, version: 1 };
      rows.set(path + "/" + ids.order, {
        status: "DRAFT",
        version: 1,
        manufacturerReference: body.manufacturerReference,
        vehicleId: body.vehicleId,
        description: body.description,
      });
    }
    if (path === "/admin/vehicles") receipt = { vehicleId: ids.vehicle };
    if (path.endsWith("/parts") && path.includes("workshop")) {
      receipt = { snapshotId: ids.snapshot, version: 2 };
      rows.get(path.replace(/\/parts$/, ""))!.version++;
    }
    if (path.endsWith("/grants")) {
      const grantId = createdGrants++ === 0 ? ids.grant : ids.grant2;
      grants.set(grantId, "ACTIVE");
      receipt = { grantId };
    }
    if (path.endsWith("/revoke")) {
      const grantId = path.split("/").at(-2)!;
      if (mode === "grant-cleanup") return json({}, 403);
      grants.set(grantId, "REVOKED");
      receipt = { vehicleId: ids.vehicle };
    }
    if (mode === "malformed" && path === "/admin/parts") receipt = {};
    receipt = { ...(receipt as Record<string, unknown>), replayed: false };
    receipts.set(key, receipt);
    if (mode === "ambiguous" && path === "/admin/parts" && !ambiguous) {
      ambiguous = true;
      throw new Error("secret-cookie PII");
    }
    if (mode === "ambiguous-revoke" && path.endsWith("/revoke") && !ambiguous) {
      ambiguous = true;
      throw new Error("opaque-secret-value");
    }
    return json(receipt);
  };
  return { fetch, calls, rows, grants };
}
describe("Development Parts smoke", () => {
  it("counts unknown malformed create receipts and never cleans unconfirmed IDs", async () => {
    const h = harness("malformed");
    const error = await runSmoke({
      ...h,
      cookie: "opaque",
      log: () => {},
    }).catch((e: unknown) => e);
    expect(formatSmokeFailure(error)).toContain("unknown_outcome=1");
    expect(h.calls.some(({ url }) => url.includes("/undefined"))).toBe(false);
  });
  it("preserves a concurrently changed fixture instead of retiring it", async () => {
    const h = harness("concurrent");
    const error = await runSmoke({
      ...h,
      cookie: "opaque",
      log: () => {},
    }).catch((e: unknown) => e);
    expect(formatSmokeFailure(error)).toContain("step=cleanup-ownership");
    expect(
      h.calls.some(
        ({ url, init }) =>
          url.includes("parts-offerings/") &&
          init.body &&
          JSON.parse(init.body as string).toStatus === "INACTIVE",
      ),
    ).toBe(false);
  });
  it("checks anonymous assets and protection without credentials", async () => {
    const h = harness();
    await runSmoke({ ...h, anonymous: true, log: () => {} });
    expect(
      h.calls.every(
        ({ init }) => !((init.headers ?? {}) as Record<string, string>).cookie,
      ),
    ).toBe(true);
  });
  it("keeps GET-only verification read only", async () => {
    const h = harness();
    await runSmoke({ ...h, cookie: "opaque", verifyOnly: true, log: () => {} });
    expect(h.calls.every(({ init }) => init.method !== "POST")).toBe(true);
  });
  it("fails absent capability before mutations", async () => {
    const h = harness("prerequisite");
    await expect(runSmoke({ ...h, cookie: "opaque" })).rejects.toMatchObject({
      code: "PARTS_FIXTURE_REQUIRED",
    });
    expect(h.calls.every(({ init }) => init.method !== "POST")).toBe(true);
  });
  it("retries an ambiguous create with its same key and retires only own fixtures", async () => {
    const h = harness("ambiguous");
    await runSmoke({ ...h, cookie: "opaque", log: () => {} });
    const writes = h.calls.filter(
      ({ url, init }) =>
        url.endsWith("/admin/parts") &&
        init.method === "POST" &&
        JSON.parse(init.body as string).name !== "Synthetic mismatch" &&
        (init.headers as Record<string, string>).origin !==
          "https://untrusted.example",
    );
    expect(
      (writes[0]!.init.headers as Record<string, string>)["idempotency-key"],
    ).toBe(
      (writes[1]!.init.headers as Record<string, string>)["idempotency-key"],
    );
    expect([...h.grants.values()]).toEqual(["REVOKED", "REVOKED"]);
    expect([...h.rows.values()].map((row) => row.status).sort()).toEqual([
      "ARCHIVED",
      "CANCELLED",
      "INACTIVE",
    ]);
  });
  it("reports cleanup failure counts without exposing paths or fixtures", async () => {
    const h = harness("cleanup");
    const error = await runSmoke({
      ...h,
      cookie: "opaque",
      log: () => {},
    }).catch((e: unknown) => e);
    expect(formatSmokeFailure(error)).toContain("known_unclosed=1");
    expect(formatSmokeFailure(error)).not.toContain("org");
  });
  it("redacts remote errors and defaults CLI to OS automation and Development hosts", async () => {
    const h = harness("http");
    const error = await runSmoke({ ...h, cookie: "opaque" }).catch(
      (e: unknown) => e,
    );
    expect(formatSmokeFailure(error)).not.toMatch(/secret|PII|person/);
    await expect(runSmoke({ cookie: "opaque\nsecret" })).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
    const entry = readFileSync(
      new URL("../../scripts/parts/development-smoke.mjs", import.meta.url),
      "utf8",
    );
    expect(entry).toContain("automation: !anonymous");
    expect(entry).toContain("fetch: getAutomationFetch()");
    expect(entry).not.toContain("readFileSync");
    expect(entry).not.toContain("process.env");
    expect(
      h.calls.every(({ url }) =>
        /^https:\/\/motorbaldi-(admin|portal|api)-development\.josegbarrios2\.workers\.dev/.test(
          url,
        ),
      ),
    ).toBe(true);
  });
  it("uses marked machine requests and enables only the named PARTS fixture in full mode", async () => {
    const h = harness("ambiguous", true);
    await runSmoke({ ...h, automation: true, log: () => {} });
    const enable = h.calls.filter(({ url }) =>
      url.endsWith("/development/automation/fixtures/parts/enable"),
    );
    expect(enable).toHaveLength(1);
    expect(JSON.parse(enable[0]!.init.body as string)).toEqual({
      organizationId: "org",
      locationId: "site",
      reason: "Synthetic Development PARTS fixture enable",
    });
    expect(
      (enable[0]!.init.headers as Record<string, string>)["idempotency-key"],
    ).toBe("development-parts-fixture-enable-v1");
    const writes = h.calls.filter(
      ({ url, init }) =>
        url.endsWith("/admin/parts") &&
        init.method === "POST" &&
        JSON.parse(init.body as string).name !== "Synthetic mismatch" &&
        (init.headers as Record<string, string>).origin !==
          "https://untrusted.example",
    );
    expect(
      (writes[0]!.init.headers as Record<string, string>)["idempotency-key"],
    ).toBe(
      (writes[1]!.init.headers as Record<string, string>)["idempotency-key"],
    );
    expect(
      writes.every(
        ({ init }) =>
          (init.headers as Record<string, string>)[
            "x-motorbaldi-automation-intent"
          ] === "true",
      ),
    ).toBe(true);
    const order = h.calls.find(
      ({ url, init }) =>
        url.endsWith("/workshop/orders") && init.method === "POST",
    );
    const orderBody = JSON.parse(order!.init.body as string);
    expect(orderBody).not.toHaveProperty("assignedPersonId");
    expect(() =>
      parseWorkshopCommand("workshop.order.create", {
        ...orderBody,
        organizationId: "018f0000-0000-7000-8000-000000000021",
        locationId: "018f0000-0000-7000-8000-000000000022",
      }),
    ).not.toThrow();
    expect(
      h.calls.some(
        ({ url, init }) =>
          url.endsWith("/capabilities") && init.method === "POST",
      ),
    ).toBe(false);
  });
  it("keeps machine verification GET-only and anonymous probes unmarked", async () => {
    const h = harness("normal", true);
    await runSmoke({ ...h, automation: true, verifyOnly: true, log: () => {} });
    expect(h.calls.every(({ init }) => init.method !== "POST")).toBe(true);
    expect(
      h.calls
        .slice(0, 5)
        .every(
          ({ init }) =>
            !(init.headers as Record<string, string>)[
              "x-motorbaldi-automation-intent"
            ],
        ),
    ).toBe(true);
    expect(
      (
        h.calls.find(({ url }) => url.endsWith("/me"))!.init.headers as Record<
          string,
          string
        >
      )["x-motorbaldi-automation-intent"],
    ).toBe("true");
  });
  it("revokes only confirmed own grants after terminal order cleanup with bounded expiry", async () => {
    const h = harness();
    const started = Date.now();
    await runSmoke({ ...h, cookie: "opaque", log: () => {} });
    const grantCreates = h.calls.filter(
      ({ url, init }) => url.endsWith("/grants") && init.method === "POST",
    );
    expect(grantCreates).toHaveLength(2);
    for (const { init } of grantCreates) {
      const expiry = Date.parse(JSON.parse(init.body as string).expiresAt);
      expect(expiry).toBeGreaterThanOrEqual(started + 3600000);
      expect(expiry).toBeLessThanOrEqual(Date.now() + 3600000);
    }
    const orderClose = h.calls.findIndex(
      ({ url, init }) =>
        url.includes("workshop/orders/") &&
        init.body &&
        JSON.parse(init.body as string).toStatus === "CANCELLED",
    );
    const revokeCalls = h.calls.filter(({ url }) => url.endsWith("/revoke"));
    expect(revokeCalls).toHaveLength(2);
    for (const call of revokeCalls) {
      expect(h.calls.indexOf(call)).toBeGreaterThan(orderClose);
      expect(call.url).toMatch(
        new RegExp(
          `${ids.vehicle}/grants/(${ids.grant}|${ids.grant2})/revoke$`,
        ),
      );
      expect(JSON.parse(call.init.body as string)).toEqual({
        reason: "Synthetic Development Parts cleanup",
      });
    }
  });
  it("rejects a foreign vehicle in the raw Workshop order response before cleanup", async () => {
    const h = harness("foreign-order", true);
    const failure = await runSmoke({
      ...h,
      automation: true,
      log: () => {},
    }).catch((error: unknown) => error);
    expect(formatSmokeFailure(failure)).toContain("step=cleanup-ownership");
    expect(
      h.calls.some(
        ({ url, init }) =>
          url.endsWith(`/workshop/orders/${ids.order}/transition`) &&
          JSON.parse(init.body as string).toStatus === "CANCELLED",
      ),
    ).toBe(false);
  });
  it("counts unrevoked confirmed grants without exposing their IDs", async () => {
    const h = harness("grant-cleanup");
    const failure = await runSmoke({
      ...h,
      cookie: "opaque",
      log: () => {},
    }).catch((error: unknown) => error);
    const report = formatSmokeFailure(failure);
    expect(report).toContain("known_unclosed=2");
    expect(report).toContain("cleanup_failures=2");
    expect(report).not.toContain(ids.grant);
  });
  it("retries an ambiguous revoke with the same key and preserves preexisting grants", async () => {
    const h = harness("ambiguous-revoke");
    h.grants.set("preexisting-grant", "ACTIVE");
    await runSmoke({ ...h, cookie: "opaque", log: () => {} });
    expect(h.grants.get("preexisting-grant")).toBe("ACTIVE");
    const first = h.calls.filter(({ url }) =>
      url.endsWith(`/grants/${ids.grant}/revoke`),
    );
    expect(first).toHaveLength(2);
    expect(
      (first[0]!.init.headers as Record<string, string>)["idempotency-key"],
    ).toBe(
      (first[1]!.init.headers as Record<string, string>)["idempotency-key"],
    );
    expect(first[0]!.init.body).toBe(first[1]!.init.body);
    expect(h.calls.some(({ url }) => url.includes("preexisting-grant"))).toBe(
      false,
    );
  });
});
