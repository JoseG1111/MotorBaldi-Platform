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
};
function harness(mode = "normal") {
  const calls: { url: string; init: RequestInit }[] = [];
  const rows = new Map<
    string,
    Record<string, unknown> & { status: string; version: number }
  >();
  const receipts = new Map<string, unknown>();
  let ambiguous = false;
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace("/api/v1", "");
    const json = (data: unknown, status = 200) =>
      Response.json(data, { status });
    if (path === "/") return new Response("parts-panel");
    if (path === "/health") return json({ ok: true });
    if (!(init.headers as Record<string, string>).cookie)
      return json({ code: "UNAUTHORIZED" }, 401);
    if (mode === "http")
      return json({ code: "secret-cookie-person-id", body: "PII" }, 403);
    if (path === "/me") return json({ mfaEnabled: true, personId: "person" });
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
        return json(path.includes("workshop/orders") ? { order: row } : row);
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
    if (path.endsWith("/grants")) receipt = { grantId: ids.grant };
    if (mode === "malformed" && path === "/admin/parts") receipt = {};
    receipt = { ...(receipt as Record<string, unknown>), replayed: false };
    receipts.set(key, receipt);
    if (mode === "ambiguous" && path === "/admin/parts" && !ambiguous) {
      ambiguous = true;
      throw new Error("secret-cookie PII");
    }
    return json(receipt);
  };
  return { fetch, calls, rows };
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
  it("redacts remote errors and fixes configuration to stdin and Development hosts", async () => {
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
    expect(entry).toContain('readFileSync(0, "utf8")');
    expect(entry).not.toContain("process.env");
    expect(
      h.calls.every(({ url }) =>
        /^https:\/\/motorbaldi-(admin|portal|api)-development\.josegbarrios2\.workers\.dev/.test(
          url,
        ),
      ),
    ).toBe(true);
  });
});
