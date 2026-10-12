import { describe, expect, it } from "vitest";
import { createContext, runInContext } from "node:vm";
import { portalPage, portalScript } from "../../apps/portal/src/page.js";
import { adminPage, adminScript } from "../../apps/admin/src/page.js";
type FakeNode = {
  children: FakeNode[];
  textContent: string;
  value?: string;
  disabled?: boolean;
  name?: string;
  onsubmit?: (event: {
    preventDefault(): void;
    currentTarget?: FakeNode;
  }) => Promise<void>;
  reset(): void;
  remove(): void;
  fields?: Map<string, unknown>;
  listeners: Record<
    string,
    (event: {
      preventDefault(): void;
      currentTarget: FakeNode;
    }) => Promise<void>
  >;
  onclick?: () => Promise<void>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): boolean;
    contains(name: string): boolean;
  };
  append(...children: FakeNode[]): void;
  replaceChildren(): void;
  addEventListener(type: string, listener: FakeNode["listeners"][string]): void;
  querySelector(): FakeNode;
};

function browserHarness(
  script: string,
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
) {
  const nodes = new Map<string, FakeNode>();
  const node = (): FakeNode => ({
    reset() {},
    remove() {},
    children: [],
    textContent: "",
    listeners: {},
    classList: (() => {
      const values = new Set<string>();
      return {
        add(name: string) {
          values.add(name);
        },
        remove(name: string) {
          values.delete(name);
        },
        toggle(name: string, force?: boolean) {
          const enabled = force ?? !values.has(name);
          if (enabled) values.add(name);
          else values.delete(name);
          return enabled;
        },
        contains(name: string) {
          return values.has(name);
        },
      };
    })(),
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    querySelector() {
      return node();
    },
  });
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) {
        const element = node();
        // Match the real HTML: private content starts hidden before bootstrap.
        if (id === "private") element.classList.add("hidden");
        nodes.set(id, element);
      }
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
    fetch: fetcher,
    Response,
    URL,
    location: { href: "https://portal.test/", pathname: "/", replace() {} },
    history: { replaceState() {} },
    crypto: {
      randomUUID: (() => {
        let count = 0;
        return () => `test-uuid-${++count}`;
      })(),
    },
    URLSearchParams,
    FormData: class {
      constructor(private element: FakeNode) {}
      get(name: string) {
        return (
          this.element.fields?.get(name) ??
          flatten(this.element).find((node) => node.name === name)?.value ??
          null
        );
      }
      getAll(name: string) {
        const value = this.element.fields?.get(name);
        return value == null ? [] : Array.isArray(value) ? value : [value];
      }
    },
    prompt: () => "Motivo válido",
    setTimeout,
  });
  runInContext(script, context);
  return { context, nodes };
}

function flatten(node: FakeNode): FakeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}
function contents(node: FakeNode) {
  return flatten(node)
    .map((n) => n.textContent)
    .join(" ");
}

const sample = {
  listingId: "listing-a",
  name: "Filtro de aceite",
  category: "Filtros",
  brand: "Marca",
  manufacturerReference: "REF",
  description: "Información aprobada",
  unit: "unidad",
  compatibility: [
    { vehicleKind: "CAR", brand: "Marca", model: "Modelo", verified: false },
  ],
  priceMinor: 125000,
  currency: "COP",
  priceIndicative: true,
  availability: "AVAILABLE",
  lastUpdatedAt: "2026-10-10T00:00:00Z",
  partnerBusinessName: "Taller asociado",
  generalLocation: "Bogotá, Colombia",
  compatibilityNotice: "Confirmar ajuste con el taller",
  availabilityNotice: "Disponibilidad informativa",
};
function response(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function field(form: FakeNode, name: string) {
  return flatten(form).find((n) => n.name === name)!;
}
const tick = () => new Promise((done) => setTimeout(done, 0));
describe("Marketplace browser discovery and reviewed publication", () => {
  it("renders only approved public fields as text with indicative COP and informational compatibility", () => {
    const { context, nodes } = browserHarness(portalScript, async () =>
      response({}, 401),
    );
    runInContext(
      `marketplaceSummary(byId('test-public'),${JSON.stringify({ ...sample, name: "<img src=x onerror=alert(1)>", partnerSku: "PRIVATE-SKU", vin: "PRIVATE-VIN", addressLine1: "PRIVATE-ADDRESS", accountId: "PRIVATE-ACCOUNT" })})`,
      context,
    );
    const text = contents(nodes.get("test-public")!);
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(text).toContain("Bogotá, Colombia");
    expect(text).toContain("COP");
    expect(text).toContain("Modelo");
    for (const value of [
      "PRIVATE-SKU",
      "PRIVATE-VIN",
      "PRIVATE-ADDRESS",
      "PRIVATE-ACCOUNT",
    ])
      expect(text).not.toContain(value);
    expect(
      flatten(nodes.get("test-public")!).some((n) =>
        (n as unknown as { innerHTML?: string }).innerHTML?.includes("<img"),
      ),
    ).toBe(false);
  });
  it("keeps omitted prices as Consultar and provides no commerce or media controls", () => {
    const { context, nodes } = browserHarness(portalScript, async () =>
      response({}, 401),
    );
    runInContext(
      `marketplaceSummary(byId('test-public'),${JSON.stringify({ ...sample, priceMinor: null })})`,
      context,
    );
    expect(contents(nodes.get("test-public")!)).toContain("Consultar");
    expect(
      flatten(nodes.get("test-public")!).some((n) => n.onclick || n.onsubmit),
    ).toBe(false);
    expect(portalPage).toContain("marketplace-public-list");
  });
  it("retries identical partner publication mutations with the same key after transient failure", async () => {
    const keys: string[] = [];
    let count = 0;
    const { context } = browserHarness(portalScript, async (path, init) => {
      if (path.includes("marketplace-listings") && init?.method === "POST") {
        keys.push((init.headers as Record<string, string>)["idempotency-key"]!);
        return ++count === 1 ? response({}, 503) : response({ version: 2 });
      }
      return response({}, 401);
    });
    await runInContext(
      "api('/organizations/org-a/marketplace-listings/listing-a/submit',send('POST',{version:1,reason:'Solicitud explícita'},'attempt-one')).catch(()=>{})",
      context,
    );
    await runInContext(
      "api('/organizations/org-a/marketplace-listings/listing-a/submit',send('POST',{version:1,reason:'Solicitud explícita'},'attempt-two'))",
      context,
    );
    expect(keys).toEqual(["attempt-one", "attempt-one"]);
  });
  it("loads Spanish public discovery anonymously outside the private account panel", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        calls.push({ path, init });
        return path.includes("/public/parts?")
          ? response({ items: [sample], nextCursor: null })
          : response({}, 401);
      },
    );
    await tick();
    await runInContext("showMarketplacePublic()", context);
    const publicCalls = calls.filter((c) => c.path.includes("/public/parts?"));
    expect(publicCalls.length).toBeGreaterThan(0);
    expect(publicCalls.every((c) => c.init?.credentials === "omit")).toBe(true);
    expect(contents(nodes.get("marketplace-public-list")!)).toContain(
      "Filtro de aceite",
    );
    expect(nodes.get("marketplace-public-status")!.textContent).toContain(
      "Ofertas aprobadas",
    );
    expect(portalPage.indexOf('id="marketplace-public-list"')).toBeLessThan(
      portalPage.indexOf('id="private"'),
    );
  });
  it("encodes public search and cursor filters and ignores stale search responses", async () => {
    const paths: string[] = [];
    let resolveOld!: (r: Response) => void;
    const { context, nodes } = browserHarness(portalScript, async (path) => {
      paths.push(path);
      if (path.includes("/public/parts?")) {
        const url = new URL(path, "https://portal.test");
        if (url.searchParams.get("q") === "old")
          return new Promise<Response>((done) => {
            resolveOld = done;
          });
        return response({
          items: [{ ...sample, name: "Resultado actual" }],
          nextCursor: "cursor&next",
        });
      }
      return response({}, 401);
    });
    await tick();
    runInContext("marketplacePublicQuery={q:'old',category:''}", context);
    const old = runInContext("showMarketplacePublic()", context);
    await tick();
    runInContext(
      "marketplacePublicQuery={q:'filtro & aceite',category:'A/B'}",
      context,
    );
    await runInContext("showMarketplacePublic()", context);
    resolveOld(
      response({
        items: [{ ...sample, name: "Resultado obsoleto" }],
        nextCursor: null,
      }),
    );
    await old;
    expect(contents(nodes.get("marketplace-public-list")!)).not.toContain(
      "Resultado obsoleto",
    );
    await nodes.get("marketplace-public-more")!.onclick!();
    const url = new URL(
      paths.filter((p) => p.includes("/public/parts?")).at(-1)!,
      "https://portal.test",
    );
    expect(url.searchParams.get("q")).toBe("filtro & aceite");
    expect(url.searchParams.get("category")).toBe("A/B");
    expect(url.searchParams.get("cursor")).toBe("cursor&next");
  });
  it("creates a private partner draft and submits the captured version with a reason", async () => {
    const writes: { path: string; body: unknown }[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (init?.method === "POST") {
          writes.push({ path, body: JSON.parse(String(init.body)) });
          return response({ listingId: "listing-a", version: 2 });
        }
        if (path.includes("marketplace-listings?"))
          return response({
            items: [
              {
                listingId: "listing-a",
                version: 7,
                status: "DRAFT",
                snapshot: sample,
              },
            ],
            nextCursor: null,
          });
        if (path.endsWith("/permissions"))
          return response({ permissions: ["org.parts.manage"] });
        return path.includes("/public/parts?")
          ? response({ items: [], nextCursor: null })
          : response({}, 401);
      },
    );
    runInContext("currentOrg='org-a'", context);
    await runInContext("showMarketplaceOwned({org:'org-a'})", context);
    const draft = flatten(nodes.get("marketplace-owned-detail")!).find(
      (n) => n.onsubmit,
    )!;
    field(draft, "offeringId").value = "offer-a";
    field(draft, "generalLocation").value = "Bogotá, Colombia";
    field(draft, "reason").value = "Solicitud explícita";
    await draft.onsubmit!({ preventDefault() {} });
    expect(writes[0]).toEqual({
      path: "/api/v1/organizations/org-a/marketplace-listings",
      body: {
        offeringId: "offer-a",
        generalLocation: "Bogotá, Colombia",
        reason: "Solicitud explícita",
      },
    });
    const submit = flatten(nodes.get("marketplace-owned-list")!).find(
      (n) => n.onsubmit && contents(n).includes("Enviar a revisión"),
    )!;
    field(submit, "reason").value = "Revisión necesaria";
    await submit.onsubmit!({ preventDefault() {} });
    expect(writes[1]).toEqual({
      path: "/api/v1/organizations/org-a/marketplace-listings/listing-a/submit",
      body: { version: 7, reason: "Revisión necesaria" },
    });
    expect(contents(nodes.get("marketplace-owned-detail")!)).toContain(
      "borrador privado",
    );
  });
  it("refuses retained partner publication controls after switching organizations", async () => {
    const writes: string[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (init?.method === "POST") writes.push(path);
        if (path.includes("marketplace-listings?"))
          return response({
            items: [
              {
                listingId: "listing-a",
                version: 4,
                status: "PUBLISHED",
                snapshot: sample,
              },
            ],
            nextCursor: null,
          });
        return path.includes("/public/parts?")
          ? response({ items: [], nextCursor: null })
          : response({}, 401);
      },
    );
    runInContext("currentOrg='org-a'", context);
    await runInContext("showMarketplaceOwned({org:'org-a'})", context);
    const withdraw = flatten(nodes.get("marketplace-owned-list")!).find(
      (n) => n.onsubmit && contents(n).includes("Retirar"),
    )!;
    field(withdraw, "reason").value = "Retiro solicitado";
    runInContext("currentOrg='org-b'", context);
    await withdraw.onsubmit!({ preventDefault() {} });
    expect(writes).toEqual([]);
    expect(contents(nodes.get("notice")!)).toContain("espacio cambió");
  });
  it("moderates the reviewed snapshot using current version and reason without publication flags", async () => {
    for (const action of ["Aprobar publicación", "Rechazar y devolver"]) {
      const writes: { path: string; body: Record<string, unknown> }[] = [];
      const { context, nodes } = browserHarness(
        adminScript,
        async (path, init) => {
          if (init?.method === "POST") {
            writes.push({ path, body: JSON.parse(String(init.body)) });
            return response({ version: 9 });
          }
          if (path.includes("/admin/marketplace/listings?"))
            return response({
              items: [
                {
                  listingId: "listing-a",
                  organizationId: "org-a",
                  version: 8,
                  status: "PENDING_REVIEW",
                  snapshot: {
                    ...sample,
                    name: "Contenido revisado",
                    partnerSku: "PRIVATE-SKU",
                  },
                },
              ],
              nextCursor: null,
            });
          return response({}, 401);
        },
      );
      runInContext(
        "permissions=new Set(['platform.catalog.manage']);byId('marketplace-review-filter').value='PENDING_REVIEW'",
        context,
      );
      await runInContext("showMarketplaceReview()", context);
      const root = nodes.get("marketplace-review-list")!;
      expect(contents(root)).toContain("Contenido revisado");
      expect(contents(root)).not.toContain("PRIVATE-SKU");
      const form = flatten(root).find(
        (n) => n.onsubmit && contents(n).includes(action),
      )!;
      field(form, "reason").value = "Contenido público verificado";
      await form.onsubmit!({ preventDefault() {} });
      expect(writes[0]).toEqual({
        path:
          "/api/v1/admin/marketplace/listings/listing-a/" +
          (action.startsWith("Aprobar") ? "approve" : "reject"),
        body: {
          organizationId: "org-a",
          version: 8,
          reason: "Contenido público verificado",
        },
      });
      expect(writes[0]!.body).not.toHaveProperty("published");
      expect(adminPage).toContain("marketplace-review-list");
    }
  });
});
