import { describe, expect, it } from "vitest";
const runtimePath = "../../scripts/communications/smoke-runtime.mjs";
const { runSmoke, formatSmokeFailure } = await import(runtimePath);

type Mode =
  | "normal"
  | "http"
  | "malformed"
  | "ambiguous"
  | "concurrent"
  | "cleanup"
  | "unknown"
  | "null-read"
  | "null-mutation"
  | "before-apply"
  | "cas-race"
  | "asset-timeout"
  | "asset-status"
  | "restore-ambiguous"
  | "restore-malformed"
  | "restore-before-apply"
  | "restore-double-failure";
function harness(mode: Mode, reversed = false) {
  let enabled = true,
    version = 0,
    writes = 0;
  const keys: string[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const json = (data: unknown, status = 200) =>
      Response.json(data, { status });
    if (path === "/" && mode === "asset-timeout")
      throw new DOMException("secret-cookie private-person", "TimeoutError");
    if (path === "/" && mode === "asset-status")
      return new Response("secret-cookie", { status: 503 });
    if (path === "/" || path === "/app.js")
      return new Response("support-panel /me/notifications /support-cases");
    if (path === "/health") return json({ ok: true });
    if (!(init.headers as Record<string, string>).cookie)
      return json({ code: "UNAUTHORIZED" }, 401);
    if (path === "/api/v1/me")
      return json({ mfaEnabled: true, personId: "private-person" });
    if (path.endsWith("notification-preferences")) {
      if (init.method === "GET") {
        if (mode === "null-read") return json(null);
        if (mode === "cleanup" && writes) return json(null);
        if (mode === "concurrent" && writes) {
          enabled = true;
          version = 2;
        }
        return json({
          externalDeliveryAvailable: false,
          items: [
            { category: "TRANSACTIONAL", channel: "IN_APP", enabled, version },
          ],
        });
      }
      writes++;
      const key = (init.headers as Record<string, string>)["idempotency-key"]!;
      keys.push(key);
      const body = JSON.parse(String(init.body));
      if (mode === "http")
        return json(
          { code: "VERSION_CONFLICT", body: "secret-cookie private-person" },
          409,
        );
      if (mode === "unknown")
        return json({ code: "private-person secret-cookie" }, 500);
      if (mode === "before-apply" && writes === 1)
        throw new Error("secret-cookie");
      if (mode === "cas-race" && writes === 4) {
        enabled = true;
        version = 2;
      }
      if (mode === "restore-before-apply" && writes === 4)
        throw new Error("secret-cookie");
      if (mode === "restore-double-failure" && writes >= 4)
        throw new Error("secret-cookie");
      const saved = receipts.get(key);
      if (saved) {
        if (saved.enabled !== body.enabled)
          return json({ code: "IDEMPOTENCY_CONFLICT" }, 409);
        const replayed = { ...saved, replayed: true };
        return json(
          reversed
            ? Object.fromEntries(Object.entries(replayed).reverse())
            : replayed,
        );
      }
      if (body.version !== version)
        return json({ code: "VERSION_CONFLICT" }, 409);
      enabled = body.enabled;
      version++;
      const receipt = { enabled, version, replayed: false };
      receipts.set(key, receipt);
      if (writes === 4 && mode === "restore-ambiguous")
        throw new Error("secret-cookie");
      if (writes === 4 && mode === "restore-malformed") return json(null);
      if (writes === 1 && mode === "null-mutation") return json(null);
      if (writes === 1 && (mode === "malformed" || mode === "cleanup"))
        return new Response("private-person secret-cookie", { status: 200 });
      if (writes === 1 && mode === "ambiguous")
        throw new Error("secret-cookie private-person");
      return json(receipt);
    }
    if (path.endsWith("support-cases") && init.method === "POST")
      return json({ code: "INTERNAL_ERROR" }, 500);
    return json({ items: [] });
  };
  const run = (verifyOnly = false) =>
    runSmoke({ cookie: "secret-cookie", fetch, verifyOnly, log: () => {} });
  const failure = async () => {
    try {
      await run();
      throw new Error("Expected failure");
    } catch (error) {
      return formatSmokeFailure(error);
    }
  };
  return {
    run,
    fetch,
    failure,
    state: () => ({ enabled, version, writes, keys }),
  };
}

describe("Development communication smoke safe diagnostics and restoration", () => {
  it("imports CLI without reading stdin or running network calls", async () => {
    const cliPath = "../../scripts/communications/development-smoke.mjs";
    expect((await import(cliPath)).cli).toBeTypeOf("function");
  });
  it("reproduces authenticated GET success and identifies full-smoke mutation failure", async () => {
    const smoke = harness("http");
    expect((await smoke.run(true)).mutations).toBe(0);
    expect(await smoke.failure()).toContain(
      "step=preference-update status=409 code=VERSION_CONFLICT",
    );
    expect(smoke.state().writes).toBe(1);
  });
  it("rejects null authenticated read with fixed diagnostics", async () => {
    expect(await harness("null-read").failure()).toBe(
      "FAIL step=authenticated-reads status=200 code=INVALID_RESPONSE",
    );
  });
  for (const mode of [
    "malformed",
    "ambiguous",
    "null-mutation",
    "before-apply",
  ] as const) {
    it(`recovers ${mode} initial mutation receipt once with the original key before restoring`, async () => {
      const smoke = harness(mode);
      const output = await smoke.failure();
      expect(output).toContain(
        `step=preference-update status=${["ambiguous", "before-apply"].includes(mode) ? "none" : "200"} code=${["ambiguous", "before-apply"].includes(mode) ? "TRANSPORT_ERROR" : "INVALID_RESPONSE"}`,
      );
      expect(smoke.state()).toMatchObject({
        enabled: true,
        version: 2,
        writes: 3,
      });
      expect(smoke.state().keys[0]).toBe(smoke.state().keys[1]);
      expect(smoke.state().keys[2]).not.toBe(smoke.state().keys[0]);
      expect(output).not.toContain("secret-cookie");
      expect(output).not.toContain("private-person");
    });
  }
  it("compares replay structurally independent of object property order", async () => {
    const smoke = harness("malformed", true);
    // After receipt recovery, malformed original remains the primary failure.
    expect(await smoke.failure()).not.toContain("cleanup");
    const normal = harness("concurrent", true);
    expect(await normal.failure()).toContain("step=preference-restore-read");
    expect(normal.state().writes).toBe(3);
  });
  it("preserves a concurrent version without issuing restoration", async () => {
    const smoke = harness("concurrent");
    expect(await smoke.failure()).toContain("step=preference-restore-read");
    expect(smoke.state()).toMatchObject({
      enabled: true,
      version: 2,
      writes: 3,
    });
  });
  it("uses compare-and-swap restoration to preserve a change racing after cleanup read", async () => {
    const smoke = harness("cas-race");
    expect(await smoke.failure()).toContain(
      "step=preference-restore status=409 code=VERSION_CONFLICT",
    );
    expect(smoke.state()).toMatchObject({
      enabled: true,
      version: 2,
      writes: 4,
    });
  });
  for (const mode of [
    "restore-ambiguous",
    "restore-malformed",
    "restore-before-apply",
  ] as const) {
    it(`recovers ${mode} using one retry with the restoration key`, async () => {
      const smoke = harness(mode);
      expect(await smoke.failure()).toBe(
        "FAIL step=case-create status=500 code=INTERNAL_ERROR; support_fixture_review known_unclosed=0 unknown_outcome=true",
      );
      expect(smoke.state()).toMatchObject({
        enabled: true,
        version: 2,
        writes: 5,
      });
      expect(smoke.state().keys[3]).toBe(smoke.state().keys[4]);
      expect(smoke.state().keys[3]).not.toBe(smoke.state().keys[0]);
    });
  }
  it("retains both restoration and bounded recovery failures", async () => {
    const smoke = harness("restore-double-failure");
    expect(await smoke.failure()).toBe(
      "FAIL step=preference-restore status=none code=TRANSPORT_ERROR; cleanup step=preference-restore-recover status=none code=TRANSPORT_ERROR",
    );
    expect(smoke.state().writes).toBe(5);
  });
  it("reports asset transport with no stale anonymous response status", async () => {
    expect(await harness("asset-timeout").failure()).toBe(
      "FAIL step=ui-assets status=none code=TIMEOUT",
    );
  });
  it("reports the actual failing asset HTTP status", async () => {
    expect(await harness("asset-status").failure()).toBe(
      "FAIL step=ui-assets status=503 code=HTTP_ERROR",
    );
  });
  it("retains primary and cleanup failures when cleanup read is malformed", async () => {
    const output = await harness("cleanup").failure();
    expect(output).toBe(
      "FAIL step=preference-update status=200 code=INVALID_RESPONSE; cleanup step=preference-restore-read status=200 code=INVALID_RESPONSE",
    );
  });
  it("withholds unknown API codes and exception messages", async () => {
    const output = await harness("unknown").failure();
    expect(output).toContain(
      "step=preference-update status=500 code=HTTP_ERROR",
    );
    expect(output).not.toMatch(/private-person|secret-cookie/);
    expect(formatSmokeFailure(new Error("secret-cookie"))).toBe(
      "FAIL step=internal code=INTERNAL_ERROR",
    );
  });
});

function workflowHarness(
  target: "create" | "reply" | "close" | "inbox",
  fault: "lost" | "malformed" | "persistent",
) {
  const base = harness("normal"),
    receipts = new Map<
      string,
      { body: string; result: Record<string, unknown> }
    >();
  const cases = new Map<
    string,
    {
      version: number;
      status: string;
      messages: unknown[];
      previousCaseId?: string;
    }
  >();
  const calls: { path: string; body: string; key: string }[] = [];
  const notificationId = "11111111-1111-4111-8111-111111111111";
  let readAt: string | null = null,
    injected = false;
  const fetch = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname,
      json = (value: unknown, status = 200) => Response.json(value, { status });
    if (!(init.headers as Record<string, string> | undefined)?.cookie)
      return base.fetch(url, init);
    if (path === "/api/v1/me/notifications")
      return json({
        items: new URL(url).searchParams.has("cursor")
          ? []
          : [{ id: notificationId, version: readAt ? 2 : 1, readAt }],
      });
    const inbox = path.endsWith("/read");
    if (!path.includes("support-cases") && !inbox) return base.fetch(url, init);
    if (init.method === "GET") {
      if (path.endsWith("support-cases")) return json({ items: [] });
      const id = path.split("/").at(-1)!;
      return json(cases.get(id));
    }
    const bodyText = String(init.body),
      body = JSON.parse(bodyText),
      key = (init.headers as Record<string, string>)["idempotency-key"]!;
    calls.push({ path, body: bodyText, key });
    const kind = inbox
      ? "inbox"
      : path.endsWith("support-cases")
        ? "create"
        : path.split("/").at(-1);
    const saved = receipts.get(key);
    if (saved) {
      if (saved.body !== bodyText)
        return json({ code: "IDEMPOTENCY_CONFLICT" }, 409);
      if (kind === target && fault === "persistent")
        throw new Error("secret-cookie private-person");
      return json({ ...saved.result, replayed: true });
    }
    let result: Record<string, unknown>;
    if (inbox) {
      readAt = "2026-10-10T00:00:00Z";
      result = {
        notificationId,
        read: true,
        readAt,
        version: 2,
        replayed: false,
      };
    } else if (kind === "create") {
      const id = `00000000-0000-4000-8000-${String(cases.size + 1).padStart(12, "0")}`;
      cases.set(id, {
        version: 1,
        status: "OPEN",
        messages: [{}],
        ...(body.previousCaseId ? { previousCaseId: body.previousCaseId } : {}),
      });
      result = { caseId: id, version: 1, status: "OPEN", replayed: false };
    } else {
      const id = path.split("/").at(-2)!,
        item = cases.get(id)!;
      if (item.status === "CLOSED" || item.version !== body.version)
        return json({ code: "SUPPORT_STATE_CONFLICT" }, 409);
      item.version++;
      if (kind === "reply") item.messages.push({});
      if (kind === "assign") item.status = "ASSIGNED";
      if (kind === "close") item.status = "CLOSED";
      result = {
        caseId: id,
        version: item.version,
        status: item.status,
        replayed: false,
      };
    }
    receipts.set(key, { body: bodyText, result });
    if (kind === target && !injected) {
      injected = true;
      if (fault === "malformed")
        return json({ secret: "private-person secret-cookie" });
      throw new Error("private-person secret-cookie");
    }
    return json(result);
  };
  return {
    run: () => runSmoke({ cookie: "secret-cookie", fetch, log: () => {} }),
    calls,
    cases,
  };
}

describe("bounded support and inbox command recovery", () => {
  for (const target of ["create", "reply", "close", "inbox"] as const) {
    for (const fault of ["lost", "malformed"] as const) {
      it(`recovers ${fault} ${target} receipt with unchanged path/body/key and completes workflow`, async () => {
        const smoke = workflowHarness(target, fault);
        await smoke.run();
        expect(smoke.cases.size).toBe(2);
        expect(
          [...smoke.cases.values()].every((item) => item.status === "CLOSED"),
        ).toBe(true);
        const first = smoke.calls.findIndex((call) =>
          target === "create"
            ? call.path.endsWith("support-cases")
            : call.path.endsWith(`/${target === "inbox" ? "read" : target}`),
        );
        expect(smoke.calls[first + 1]).toEqual(smoke.calls[first]);
      });
    }
    it(`bounds persistent ${target} failure and reports retained fixture risk without IDs`, async () => {
      const smoke = workflowHarness(target, "persistent");
      let output = "";
      try {
        await smoke.run();
      } catch (error) {
        output = formatSmokeFailure(error);
      }
      expect(output).toContain("code=TRANSPORT_ERROR");
      expect(output).toContain("cleanup");
      expect(output).not.toMatch(
        /secret-cookie|private-person|00000000|11111111/,
      );
      if (target === "create")
        expect(output).toContain("known_unclosed=0 unknown_outcome=true");
      if (target === "reply" || target === "close")
        expect(output).toContain("known_unclosed=1 unknown_outcome=true");
      const first = smoke.calls.findIndex((call) =>
        target === "create"
          ? call.path.endsWith("support-cases")
          : call.path.endsWith(`/${target === "inbox" ? "read" : target}`),
      );
      expect(smoke.calls.slice(first)).toHaveLength(2);
      expect(smoke.calls[first + 1]).toEqual(smoke.calls[first]);
    });
  }
});
