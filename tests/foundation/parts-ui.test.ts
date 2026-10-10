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
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  reset(): void;
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
    fetch: fetcher,
    Response,
    URL,
    location: { href: "https://portal.test/", pathname: "/" },
    history: { replaceState() {} },
    crypto: { randomUUID: () => "test-uuid" },
    FormData: class {
      constructor(private element: FakeNode) {}
      get(name: string) {
        return this.element.fields?.get(name) ?? null;
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

describe("Parts scoped browser workflows", () => {
  it("edits labeled compatibility references without dropping existing entries", async () => {
    const { context, nodes } = browserHarness(portalScript, async () =>
      Response.json({}, { status: 401 }),
    );
    runInContext(
      "let capturedParts;partsEditor(byId('parts-detail'),{id:'offer',compatibility:[{vehicleKind:'CAR',brand:'Marca A',model:'Modelo A',verified:false},{vehicleKind:'MOTORCYCLE',note:'Revisar ajuste',verified:false}]},false,async body=>{capturedParts=body})",
      context,
    );
    const root = nodes.get("parts-detail")!,
      form = flatten(root).find((node) => node.onsubmit)!;
    expect(contents(root)).not.toContain("JSON");
    expect(contents(root)).not.toContain("verified");
    const field = (name: string) =>
      flatten(form).find((node) => node.name === name)!;
    field("compatibility-0-model").value = "Modelo actualizado";
    field("compatibility-2-vehicleKind").value = "TRUCK";
    field("compatibility-2-note").value = "Confirmar con taller";
    await form.onsubmit!({ preventDefault() {} });
    expect(runInContext("capturedParts.compatibility", context)).toEqual([
      {
        vehicleKind: "CAR",
        brand: "Marca A",
        model: "Modelo actualizado",
        verified: false,
      },
      { vehicleKind: "MOTORCYCLE", note: "Revisar ajuste", verified: false },
      { vehicleKind: "TRUCK", note: "Confirmar con taller", verified: false },
    ]);
  });
  it("keeps existing compatibility when the optional new reference is blank", () => {
    const { context } = browserHarness(adminScript, async () =>
      Response.json({}, { status: 401 }),
    );
    expect(
      runInContext(
        "partsCompatibilityData({'compatibility-0-vehicleKind':'CAR','compatibility-0-brand':'Marca'},[{vehicleKind:'CAR',brand:'Marca',verified:false},{}])",
        context,
      ),
    ).toEqual([{ vehicleKind: "CAR", brand: "Marca", verified: false }]);
    expect(() =>
      runInContext(
        "partsCompatibilityData({'compatibility-0-model':'Modelo'},[{}])",
        context,
      ),
    ).toThrow("clase de vehículo");
  });

  it("retains frozen workshop data and suppresses terminal attachment controls", async () => {
    const frozen = {
      name: "Referencia histórica",
      brand: "Marca",
      manufacturerReference: "ABC",
      description: "Descripción original",
      unit: "unidad",
      status: "ACTIVE",
      priceMinor: 250000,
      availability: "AVAILABLE",
      compatibility: [],
    };
    const { context, nodes } = browserHarness(portalScript, async (path) =>
      path.includes("/parts?")
        ? Response.json([
            {
              id: "snapshot",
              snapshot: frozen,
              offeringVersion: 2,
              canonicalVersion: 1,
            },
          ])
        : Response.json({}, { status: 401 }),
    );
    runInContext("workshopOrg='org-a';workshopDetailGeneration=1", context);
    await runInContext(
      "showWorkshopParts(byId('workshop-detail'),'org-a',{id:'order',version:3,status:'CLOSED'},true,1)",
      context,
    );
    expect(contents(nodes.get("workshop-detail")!)).toContain(
      "Descripción original",
    );
    expect(contents(nodes.get("workshop-detail")!)).toContain(
      "Versión de oferta: 2",
    );
    expect(
      flatten(nodes.get("workshop-detail")!).some((node) => node.onsubmit),
    ).toBe(false);
  });
  it("attaches an applicable offering using the captured order version and reason", async () => {
    const writes: RequestInit[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json({ id: "snapshot" });
        }
        if (path.includes("/parts?")) return Response.json([]);
        if (path.includes("/parts/offerings"))
          return Response.json([
            {
              id: "offer-a",
              name: "Oferta autorizada",
              brand: "Marca",
              manufacturerReference: "ABC",
              description: "Descripción",
              unit: "unidad",
              status: "ACTIVE",
              priceMinor: null,
              availability: "UNKNOWN",
              compatibility: [],
            },
          ]);
        return Response.json({}, { status: 401 });
      },
    );
    runInContext("workshopOrg='org-a';workshopDetailGeneration=1", context);
    await runInContext(
      "showWorkshopParts(byId('workshop-detail'),'org-a',{id:'order',version:7,status:'OPEN'},true,1)",
      context,
    );
    const root = nodes.get("workshop-detail")!,
      form = flatten(root).find((node) => node.onsubmit)!;
    flatten(form).find((node) => node.name === "reason")!.value =
      "Ajuste confirmado por taller";
    runInContext("openWorkshopOrder=async()=>{}", context);
    await form.onsubmit!({ preventDefault() {} });
    expect(JSON.parse(writes[0]!.body as string)).toEqual({
      version: 7,
      offeringId: "offer-a",
      reason: "Ajuste confirmado por taller",
    });
  });

  it("denies organization members without Parts management permission", async () => {
    const calls: string[] = [];
    const { context, nodes } = browserHarness(portalScript, async (path) => {
      calls.push(path);
      if (path.endsWith("/permissions"))
        return Response.json({ permissions: ["org.read"] });
      return Response.json({}, { status: 401 });
    });
    runInContext("currentOrg='org-a'", context);
    await runInContext("showParts()", context);
    expect(calls.some((path) => path.includes("parts-offerings"))).toBe(false);
    expect(contents(nodes.get("notice")!)).toContain("OWNER");
  });
  it("denies staff without canonical permission", async () => {
    const calls: string[] = [];
    const { context } = browserHarness(adminScript, async (path) => {
      calls.push(path);
      return Response.json({}, { status: 401 });
    });
    await runInContext("showParts()", context);
    expect(calls.some((path) => path.includes("/admin/parts"))).toBe(false);
  });
  it("renders organization offers as text and preserves Consultar", async () => {
    const { context, nodes } = browserHarness(portalScript, async (path) => {
      if (path.endsWith("/permissions"))
        return Response.json({ permissions: ["org.parts.manage"] });
      if (path.includes("/parts-offerings"))
        return Response.json([
          {
            id: "offer",
            name: "<img src=x onerror=alert(1)>",
            brand: "Marca",
            manufacturerReference: "ABC",
            description: "Descripción",
            unit: "unidad",
            priceMinor: null,
            status: "ACTIVE",
            availability: "UNKNOWN",
            compatibility: [],
          },
        ]);
      return Response.json({}, { status: 401 });
    });
    runInContext("currentOrg='org-a'", context);
    await runInContext("showParts()", context);
    expect(contents(nodes.get("parts-list")!)).toContain(
      "<img src=x onerror=alert(1)>",
    );
    expect(contents(nodes.get("parts-list")!)).toContain("Consultar");
    expect(
      portalScript.slice(portalScript.indexOf("let partsGeneration")),
    ).not.toContain("innerHTML");
  });
  it("discards an offering list after switching organizations", async () => {
    let resolve!: (response: Response) => void;
    const { context, nodes } = browserHarness(portalScript, async (path) => {
      if (path.endsWith("/permissions"))
        return Response.json({ permissions: ["org.parts.manage"] });
      if (path.includes("/parts-offerings"))
        return new Promise<Response>((done) => {
          resolve = done;
        });
      return Response.json({}, { status: 401 });
    });
    runInContext("currentOrg='org-a'", context);
    const loading = runInContext("showParts()", context);
    await new Promise((done) => setTimeout(done, 0));
    runInContext("currentOrg='org-b'", context);
    resolve(Response.json([{ id: "old", name: "Otra organización" }]));
    await loading;
    expect(contents(nodes.get("parts-list")!)).not.toContain(
      "Otra organización",
    );
  });
  it("retries identical Parts commands with the same idempotency key", async () => {
    const keys: string[] = [];
    let attempt = 0;
    const { context } = browserHarness(portalScript, async (path, init) => {
      if (path.includes("/parts-offerings")) {
        keys.push(
          (init?.headers as Record<string, string>)["idempotency-key"]!,
        );
        return ++attempt === 1
          ? Response.json({}, { status: 503 })
          : Response.json({ id: "offer" });
      }
      return Response.json({}, { status: 401 });
    });
    await runInContext(
      "api('/organizations/org-a/parts-offerings',send('POST',{name:'Repuesto'},'first')).catch(()=>{})",
      context,
    );
    await runInContext(
      "api('/organizations/org-a/parts-offerings',send('POST',{name:'Repuesto'},'second'))",
      context,
    );
    expect(keys).toEqual(["first", "first"]);
  });
  it("validates integer COP prices and retains unlinked offerings", () => {
    const { context } = browserHarness(portalScript, async () =>
      Response.json({}, { status: 401 }),
    );
    expect(() =>
      runInContext("partsData({priceMinor:'1.5'},true)", context),
    ).toThrow("entero");
    const data = runInContext("partsData({priceMinor:''},true)", context);
    expect(data.priceMinor).toBeNull();
    expect(data.canonicalPartId).toBeNull();
    expect(portalPage).toContain("Repuestos de mi organización");
    expect(adminPage).toContain("Catálogo canónico");
  });
});
