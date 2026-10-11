import { describe, expect, it } from "vitest";
import { createContext, runInContext } from "node:vm";
import { portalPage, portalScript } from "../../apps/portal/src/page.js";
import { adminPage, adminScript } from "../../apps/admin/src/page.js";

type Node = {
  textContent: string;
  value: string;
  children: Node[];
  name?: string;
  fields?: Map<string, unknown>;
  append(...nodes: Node[]): void;
  replaceChildren(): void;
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): boolean;
  };
  addEventListener(...args: unknown[]): void;
  querySelector(): Node;
  reset(): void;
  remove(): void;
};
const org = "018f0000-0000-7000-8000-000000000001",
  site = "018f0000-0000-7000-8000-000000000002";
const base = {
  schemaVersion: 1,
  classification: "INTERNAL",
  observedAt: "2026-10-10T23:00:00.000Z",
};
const canonical = {
  ...base,
  kind: "CANONICAL_PARTS",
  scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
  provenance: { mode: "CURRENT_STATE", sourceTables: ["parts_canonical"] },
  counts: { DRAFT: 2, ACTIVE: 3, ARCHIVED: 1 },
};
const queue = {
  ...base,
  kind: "PLATFORM_QUEUE",
  scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
  provenance: {
    mode: "CURRENT_STATE",
    sourceTables: ["integration_outbox_events", "integration_dead_letters"],
  },
  counts: {
    PENDING: 1,
    PROCESSING: 2,
    PROCESSED: 5,
    DEAD: 1,
    liveLeases: 1,
    unresolvedDeadLetters: 1,
  },
};
function organization(locationId: string | null = site) {
  return {
    ...base,
    kind: "ORGANIZATION_PARTS",
    scope: {
      type: "ORGANIZATION",
      organizationId: org,
      locationId,
      resourceScope: "OWNED_SYNTHETIC",
    },
    provenance: {
      mode: "CURRENT_STATE",
      sourceTables: [
        "parts_offerings",
        "marketplace_listings",
        "marketplace_eligible_sources",
      ],
    },
    counts: {
      offerings: { DRAFT: 1, ACTIVE: 3, INACTIVE: 2 },
      listings: { DRAFT: 1, PENDING_REVIEW: 2, PUBLISHED: 4, SUSPENDED: 3 },
      discoverable: 2,
    },
  };
}
function contents(node: Node): string {
  return [node.textContent, ...node.children.map(contents)].join(" ");
}
async function browser(
  script: string,
  transport: (path: string, init?: RequestInit) => Promise<Response>,
) {
  const nodes = new Map<string, Node>(),
    calls: { path: string; init?: RequestInit }[] = [];
  const node = (): Node => ({
    textContent: "",
    value: "",
    children: [],
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren() {
      this.children = [];
      this.textContent = "";
    },
    classList: {
      add() {},
      remove() {},
      toggle(_name, force) {
        return !!force;
      },
    },
    addEventListener() {},
    querySelector() {
      return node();
    },
    reset() {},
    remove() {},
  });
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id)!;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return node();
    },
  };
  const context = createContext({
    document,
    fetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      if (path === "/api/v1/me" || path === "/api/v1/admin/access")
        return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
      if (path.startsWith("/api/v1/public/parts"))
        return Response.json({ items: [], nextCursor: null });
      return transport(path, init);
    },
    Response,
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => "synthetic-ui-key" },
    location: { href: "https://portal.test/", pathname: "/", reload() {} },
    history: { replaceState() {} },
    FormData: class {
      constructor(private n: Node) {}
      get(key: string) {
        return this.n.fields?.get(key) ?? null;
      }
      getAll() {
        return [];
      }
    },
    setTimeout,
    prompt: () => "Reason",
  });
  runInContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { context, nodes, calls, node: document.getElementById };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("Scoped current analytics UI", () => {
  it("keeps internal reports inside authenticated screens and labels read-only current information", () => {
    expect(adminPage).toContain(
      'data-permission="platform.audit.read">Estado operativo',
    );
    expect(adminPage).toContain(
      'id="analytics-canonical-status" role="status"',
    );
    expect(portalPage.indexOf('id="analytics-organization"')).toBeGreaterThan(
      portalPage.indexOf('id="private"'),
    );
    expect(portalPage).toContain('id="analytics-location"');
  });
  it("renders only exact count fields, UTC provenance and synthetic scope with safe DOM text", async () => {
    const h = await browser(adminScript, async () => Response.json(canonical));
    runInContext(
      "permissions=new Set(['platform.catalog.manage']);",
      h.context,
    );
    await runInContext("showAnalyticsCanonical()", h.context);
    const text = contents(h.node("analytics-canonical-report"));
    expect(text).toContain("Referencias activas: 3");
    expect(text).toContain("Observado (UTC): 2026-10-10T23:00:00.000Z");
    expect(text).toContain("no representa ventas, ingresos ni proyecciones");
    expect(text).not.toMatch(/actorId|priceMinor|VIN|plate/);
    expect(
      h.calls
        .filter((c) => c.path.includes("/analytics/"))
        .every((c) => !c.init?.method || c.init.method === "GET"),
    ).toBe(true);
  });
  it("fails unavailable rather than displaying false zero counts after a failed query", async () => {
    const h = await browser(adminScript, async () =>
      Response.json({ code: "secret-body-PII" }, { status: 503 }),
    );
    runInContext(
      "permissions=new Set(['platform.catalog.manage']);",
      h.context,
    );
    h.node("analytics-canonical-report").textContent = "previous data";
    await runInContext("showAnalyticsCanonical()", h.context);
    expect(h.node("analytics-canonical-report").children).toHaveLength(0);
    expect(h.node("analytics-canonical-status").textContent).toContain(
      "no está disponible",
    );
    expect(h.node("analytics-canonical-status").textContent).not.toContain(
      "secret",
    );
  });
  it("rejects malformed counts, unknown schemas and raw record fields before rendering", async () => {
    const responses = [
      { ...canonical, counts: { ...canonical.counts, ACTIVE: -1 } },
      { ...canonical, schemaVersion: 2 },
      { ...canonical, customerEmail: "secret@example.test" },
    ];
    let index = 0;
    const h = await browser(adminScript, async () =>
      Response.json(responses[index++]),
    );
    runInContext(
      "permissions=new Set(['platform.catalog.manage']);",
      h.context,
    );
    for (let i = 0; i < responses.length; i++) {
      await runInContext("showAnalyticsCanonical()", h.context);
      expect(h.node("analytics-canonical-report").children).toHaveLength(0);
      expect(h.node("analytics-canonical-status").textContent).toContain(
        "no está disponible",
      );
    }
  });
  it("does not request Queue reports with catalog authority alone", async () => {
    const h = await browser(adminScript, async () => Response.json(queue));
    runInContext(
      "permissions=new Set(['platform.catalog.manage']);",
      h.context,
    );
    await runInContext("showAnalyticsQueue()", h.context);
    expect(
      h.calls.some((c) => c.path === "/api/v1/admin/analytics/queue"),
    ).toBe(false);
    expect(h.node("analytics-queue-status").textContent).toContain(
      "no está disponible",
    );
  });
  it("renders Queue operational measures without inferring payments or exposing event rows", async () => {
    const h = await browser(adminScript, async () => Response.json(queue));
    runInContext("permissions=new Set(['platform.audit.read']);", h.context);
    await runInContext("showAnalyticsQueue()", h.context);
    expect(contents(h.node("analytics-queue-report"))).toContain(
      "Eventos procesados: 5",
    );
    expect(contents(h.node("analytics-queue-report"))).toContain(
      "Incidencias sin resolver: 1",
    );
    expect(
      h.calls.some((c) => c.path === "/api/v1/admin/analytics/queue"),
    ).toBe(true);
  });
  it("discards stale responses from an earlier administrative refresh", async () => {
    const first = deferred<Response>(),
      second = deferred<Response>();
    let count = 0;
    const h = await browser(adminScript, () =>
      ++count === 1 ? first.promise : second.promise,
    );
    runInContext(
      "permissions=new Set(['platform.catalog.manage']);",
      h.context,
    );
    const old = runInContext("showAnalyticsCanonical()", h.context),
      current = runInContext("showAnalyticsCanonical()", h.context);
    second.resolve(
      Response.json({
        ...canonical,
        counts: { ...canonical.counts, ACTIVE: 4 },
      }),
    );
    await current;
    first.resolve(
      Response.json({
        ...canonical,
        counts: { ...canonical.counts, ACTIVE: 99 },
      }),
    );
    await old;
    expect(contents(h.node("analytics-canonical-report"))).toContain(
      "Referencias activas: 4",
    );
    expect(contents(h.node("analytics-canonical-report"))).not.toContain("99");
  });
  it("selects an active own site and shows published state separately from current discoverability", async () => {
    const h = await browser(portalScript, async (path) =>
      path.endsWith("/locations")
        ? Response.json({
            items: [{ id: site, name: "Sede de validación", status: "ACTIVE" }],
          })
        : Response.json(organization()),
    );
    runInContext(`currentOrg='${org}';partsGeneration=1`, h.context);
    await runInContext(
      `prepareOrganizationAnalytics({org:'${org}'},1)`,
      h.context,
    );
    expect(
      h.calls.some(
        (c) =>
          c.path ===
          `/api/v1/organizations/${org}/analytics/parts?locationId=${site}`,
      ),
    ).toBe(true);
    const text = contents(h.node("analytics-organization-report"));
    expect(text).toContain("Estado publicado: 4");
    expect(text).toContain("Actualmente descubribles: 2");
    expect(text).toContain("datos sintéticos propios");
  });
  it("rejects a report for a different organization or location", async () => {
    const h = await browser(portalScript, async (path) =>
      path.endsWith("/locations")
        ? Response.json({
            items: [{ id: site, name: "Sede", status: "ACTIVE" }],
          })
        : Response.json({
            ...organization(),
            scope: { ...organization().scope, organizationId: "foreign" },
          }),
    );
    runInContext(`currentOrg='${org}';partsGeneration=1`, h.context);
    await runInContext(
      `prepareOrganizationAnalytics({org:'${org}'},1)`,
      h.context,
    );
    expect(h.node("analytics-organization-report").children).toHaveLength(0);
    expect(h.node("analytics-organization-status").textContent).toContain(
      "no está disponible",
    );
  });
  it("clears current counts and discards a pending response after workspace change", async () => {
    const report = deferred<Response>();
    const h = await browser(portalScript, async (path) =>
      path.endsWith("/locations")
        ? Response.json({
            items: [{ id: site, name: "Sede", status: "ACTIVE" }],
          })
        : report.promise,
    );
    runInContext(`currentOrg='${org}';partsGeneration=1`, h.context);
    const pending = runInContext(
      `prepareOrganizationAnalytics({org:'${org}'},1)`,
      h.context,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    runInContext(
      "clearOrganizationAnalytics();currentOrg='another';partsGeneration++",
      h.context,
    );
    report.resolve(Response.json(organization()));
    await pending;
    expect(h.node("analytics-organization-report").children).toHaveLength(0);
    expect(h.node("analytics-organization-status").textContent).toBe("");
  });
  it("invalidates a pending administrative report when authentication refresh fails", async () => {
    const response = deferred<Response>();
    const h = await browser(adminScript, () => response.promise);
    runInContext(
      "permissions=new Set(['platform.catalog.manage']);",
      h.context,
    );
    const pending = runInContext("showAnalyticsCanonical()", h.context);
    await runInContext("refresh()", h.context);
    response.resolve(Response.json(canonical));
    await pending;
    expect(h.node("analytics-canonical-report").children).toHaveLength(0);
    expect(h.node("analytics-canonical-status").textContent).toBe("");
  });
  it("clears and invalidates partner reports synchronously before signing out", async () => {
    const response = deferred<Response>();
    const h = await browser(portalScript, async (path) =>
      path.endsWith("/locations")
        ? Response.json({
            items: [{ id: site, name: "Sede", status: "ACTIVE" }],
          })
        : path.endsWith("/auth/sign-out")
          ? Response.json({ ok: true })
          : response.promise,
    );
    runInContext(`currentOrg='${org}';partsGeneration=1`, h.context);
    const pending = runInContext(
      `prepareOrganizationAnalytics({org:'${org}'},1)`,
      h.context,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runInContext("byId('logout').onclick()", h.context);
    response.resolve(Response.json(organization()));
    await pending;
    expect(h.node("analytics-organization-report").children).toHaveLength(0);
    expect(h.node("analytics-organization-status").textContent).toBe("");
  });
});
