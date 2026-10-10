import { describe, expect, it } from "vitest";
import { Script, createContext, runInContext } from "node:vm";
import { portalPage, portalScript } from "../../apps/portal/src/page.js";
import { adminPage, adminScript } from "../../apps/admin/src/page.js";
import portal from "../../apps/portal/src/index.js";
import { turnstileTestScript } from "../../apps/portal/src/turnstile-test.js";
import type { PortalBindings } from "@motorbaldi/config";

describe("Phase 1 browser assets", () => {
  it("serves the development Turnstile form with a public sitekey and isolated CSP", async () => {
    const bindings = {
      ENVIRONMENT: "development",
      TURNSTILE_SITE_KEY: "0x4AAAAAAFQ5LH6o75SvXd6P",
      API_SERVICE: { fetch: async () => new Response("proxied") },
    } as unknown as PortalBindings;
    const request = (path: string, env = bindings) =>
      portal.fetch!(new Request("https://portal.test" + path), env);
    const page = await request("/turnstile-test");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('lang="es"');
    expect(html).toContain('data-sitekey="0x4AAAAAAFQ5LH6o75SvXd6P"');
    expect(html).toContain('data-action="lead"');
    expect(html).toContain(
      'src="https://challenges.cloudflare.com/turnstile/v0/api.js"',
    );
    expect(html).not.toContain("TURNSTILE_SECRET_KEY");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-src https://challenges.cloudflare.com",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    const normal = await request("/");
    expect(normal.headers.get("content-security-policy")).not.toContain(
      "challenges.cloudflare.com",
    );
    expect((await request("/turnstile-test.js")).status).toBe(200);
    for (const environment of ["local", "staging", "production"] as const) {
      const env = { ...bindings, ENVIRONMENT: environment };
      expect((await request("/turnstile-test", env)).status).toBe(404);
      expect((await request("/turnstile-test.js", env)).status).toBe(404);
    }
  });

  it("retries unchanged leads with one key and resets the widget after each attempt", async () => {
    const values: Record<string, string> = {
      givenName: "Ana",
      familyName: "García",
      email: "ana@example.test",
      phone: "",
      organizationName: "Taller",
      message: "Hola",
      countryCode: "co",
    };
    const listeners: Record<
      string,
      (event: { preventDefault(): void }) => Promise<void> | void
    > = {};
    let resetCount = 0;
    let uuidCount = 0;
    const calls: { path: string; init: RequestInit }[] = [];
    const form = {
      addEventListener(type: string, listener: (typeof listeners)[string]) {
        listeners[type] = listener;
      },
      reset() {
        for (const key of Object.keys(values)) values[key] = "";
      },
    };
    const status = { textContent: "" };
    const context = createContext({
      document: {
        getElementById: (id: string) =>
          id === "lead-test-form" ? form : status,
      },
      window: {
        turnstile: {
          getResponse: () => "fresh-token",
          reset: () => {
            resetCount++;
          },
        },
      },
      FormData: class {
        get(name: string) {
          return values[name] ?? "";
        }
      },
      crypto: {
        randomUUID: () =>
          `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, "0")}`,
      },
      fetch: async (path: string, init: RequestInit) => {
        calls.push({ path, init });
        return new Response(null, { status: calls.length === 4 ? 202 : 503 });
      },
    });
    expect(() => new Script(turnstileTestScript)).not.toThrow();
    runInContext(turnstileTestScript, context);
    const submit = async () => listeners.submit!({ preventDefault() {} });
    await submit();
    await submit();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/public/leads",
      "/api/v1/public/leads",
    ]);
    expect(calls[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
      "Idempotency-Key": (calls[0]!.init.headers as Record<string, string>)[
        "Idempotency-Key"
      ],
    });
    expect(
      (calls[1]!.init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe(
      (calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      givenName: "Ana",
      familyName: "García",
      email: "ana@example.test",
      organizationName: "Taller",
      message: "Hola",
      countryCode: "CO",
      turnstileToken: "fresh-token",
    });
    expect(resetCount).toBe(2);
    values.message = "Otro mensaje";
    listeners.input!({ preventDefault() {} });
    await submit();
    expect(
      (calls[2]!.init.headers as Record<string, string>)["Idempotency-Key"],
    ).not.toBe(
      (calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"],
    );
    await submit();
    expect(resetCount).toBe(4);
    expect(values.email).toBe("");
    values.email = "ana@example.test";
    await submit();
    expect(
      (calls[4]!.init.headers as Record<string, string>)["Idempotency-Key"],
    ).not.toBe(
      (calls[3]!.init.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(resetCount).toBe(5);
  });
  it("serves Spanish-first semantic shells and valid browser scripts", () => {
    expect(portalPage).toContain('<html lang="es">');
    expect(adminPage).toContain('<html lang="es">');
    expect(portalPage).toContain("Mis organizaciones");
    expect(portalPage).toContain("Mi garaje");
    expect(portalPage).toContain("Mi perfil profesional");
    expect(adminPage).toContain("Personas");
    expect(adminPage).toContain("Verificaciones");
    expect(portalPage).toContain('aria-live="polite"');
    expect(adminPage).toContain('aria-live="polite"');
    expect(() => new Script(portalScript)).not.toThrow();
    expect(() => new Script(adminScript)).not.toThrow();
  });

  it("shows only the granted garage list returned by the authenticated API", async () => {
    const calls: string[] = [];
    const { context, nodes } = browserHarness(portalScript, async (path) => {
      calls.push(path);
      if (path === "/api/v1/me/garage")
        return Response.json({
          items: [
            { id: "018f0000-0000-7000-8000-000000000001", kindCode: "CAR" },
          ],
        });
      return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    });
    await runInContext("refreshGarage()", context);
    expect(calls).toContain("/api/v1/me/garage");
    expect(nodes.get("garage-list")!.children).toHaveLength(2);
    expect(
      nodes.get("garage-list")!.children[0]!.children[0]!.textContent,
    ).toContain("Vehículo");
  });

  it("shows Admin sign-in for 401 and restricted access only for 403", async () => {
    for (const scenario of [
      {
        status: 401,
        code: "UNAUTHENTICATED",
        loginHidden: false,
        deniedHidden: true,
      },
      {
        status: 403,
        code: "FORBIDDEN",
        loginHidden: true,
        deniedHidden: false,
      },
      { status: 200, code: "", loginHidden: true, deniedHidden: true },
    ]) {
      const { context, nodes } = browserHarness(adminScript, async () =>
        Response.json(
          scenario.status === 200
            ? { permissions: ["platform.people.read"], mfaEnabled: true }
            : { code: scenario.code },
          { status: scenario.status },
        ),
      );
      runInContext(
        "document.getElementById('denied').classList.add('hidden');document.getElementById('private').classList.add('hidden')",
        context,
      );
      await runInContext("refresh()", context);
      expect(nodes.get("login")!.classList.contains("hidden")).toBe(
        scenario.loginHidden,
      );
      expect(nodes.get("denied")!.classList.contains("hidden")).toBe(
        scenario.deniedHidden,
      );
      expect(nodes.get("private")!.classList.contains("hidden")).toBe(
        scenario.status !== 200,
      );
    }
  });

  it("wires Portal evidence upload and case attachment through authenticated API calls", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        calls.push({ path, init });
        if (path.endsWith("/me/evidence-files") && init?.method === "POST")
          return Response.json(
            { fileId: "file-1", status: "QUARANTINED" },
            { status: 202 },
          );
        if (path.endsWith("/me/evidence-files/file-1"))
          return Response.json({ status: "ACTIVE" });
        if (path.includes("/verification/case-1/files"))
          return Response.json({ attached: true }, { status: 201 });
        return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      },
    );
    expect(portalPage).toContain('id="verification-evidence-form"');
    expect(portalPage).toContain('id="credential-evidence-files"');
    runInContext("currentOrg='org-1';currentCase='case-1'", context);
    const form = nodes.get("verification-evidence-form")!;
    form.fields = new Map<string, unknown>([
      ["file", { size: 8, type: "image/png" }],
      ["existingFileId", ""],
    ]);
    await form.listeners.submit!({ preventDefault() {}, currentTarget: form });
    expect(calls.map((call) => call.path)).toContain(
      "/api/v1/me/evidence-files",
    );
    const attached = calls.find((call) =>
      call.path.includes("/verification/case-1/files"),
    );
    expect(JSON.parse(String(attached?.init?.body))).toEqual({
      fileId: "file-1",
    });
  });

  it("wires Admin credential and duplicate decisions with reasons", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const { context, nodes } = browserHarness(
      adminScript,
      async (path, init) => {
        calls.push({ path, init });
        if (path.endsWith("/admin/professionals/credentials"))
          return Response.json([
            {
              id: "credential-1",
              person_id: "person-1",
              credential_type: "CERT",
              issuer: "Institute",
              evidence_file_id: null,
            },
          ]);
        if (path.endsWith("/admin/duplicate-candidates"))
          return Response.json([
            {
              id: "candidate-1",
              source_person_id: "person-1",
              destination_person_id: "person-2",
              reason: "SAME_VERIFIED_EMAIL",
            },
          ]);
        if (
          path.includes("/credentials/credential-1/verify") ||
          path.includes("/candidate-1/resolve")
        )
          return Response.json({ reviewed: true });
        return Response.json({ code: "FORBIDDEN" }, { status: 403 });
      },
    );
    expect(adminPage).toContain('id="credential-queue"');
    expect(adminPage).toContain('id="duplicate-queue"');
    runInContext(
      "permissions=new Set(['platform.professional.read','platform.professional.verify','platform.people.merge'])",
      context,
    );
    await runInContext("showCredentials()", context);
    const credentialBox = nodes.get("credential-queue")!.children[0]!;
    const verify = credentialBox.children.find(
      (child) => child.textContent === "Verificar",
    )!;
    await verify.onclick!();
    await runInContext("showDuplicates()", context);
    const duplicateBox = nodes.get("duplicate-queue")!.children[0]!;
    const dismiss = duplicateBox.children.find(
      (child) => child.textContent === "Descartar candidato",
    )!;
    await dismiss.onclick!();
    expect(
      JSON.parse(
        String(calls.find((call) => call.path.endsWith("/verify"))?.init?.body),
      ),
    ).toEqual({ reason: "Motivo válido" });
    expect(
      JSON.parse(
        String(
          calls.find((call) => call.path.endsWith("/resolve"))?.init?.body,
        ),
      ),
    ).toEqual({ decision: "DISMISSED", reason: "Motivo válido" });
  });
});

type FakeNode = {
  children: FakeNode[];
  textContent: string;
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

describe("Vehicle browser workflows", () => {
  it("keeps a failed vehicle command key for retry and releases it after success", async () => {
    const calls: RequestInit[] = [];
    const { context } = browserHarness(adminScript, async (path, init) => {
      if (path !== "/api/v1/admin/vehicles")
        return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      calls.push(init!);
      return calls.length === 1
        ? Response.json({ code: "INTERNAL_ERROR" }, { status: 503 })
        : Response.json({ vehicleId: "vehicle-test" });
    });
    await runInContext(
      "api('/admin/vehicles',send({kindCode:'CAR'},true)).catch(()=>{})",
      context,
    );
    await runInContext(
      "api('/admin/vehicles',send({kindCode:'CAR'},true))",
      context,
    );
    expect(
      (calls[0]!.headers as Record<string, string>)["idempotency-key"],
    ).toBe((calls[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(runInContext("vehicleRetryKeys.size", context)).toBe(0);
  });

  it("shows vehicle history and claim controls without exposing ungranted professional records", async () => {
    const id = "018f0000-0000-7000-8000-000000000001";
    const calls: string[] = [];
    const { context, nodes } = browserHarness(portalScript, async (path) => {
      calls.push(path);
      if (path === "/api/v1/vehicles/" + id)
        return Response.json({
          kindCode: "CAR",
          specification: { brand: "Test Brand" },
        });
      if (path.endsWith("/permissions"))
        return Response.json({ permissions: ["vehicle.read"] });
      if (path.endsWith("/odometer"))
        return Response.json({
          items: [
            {
              reading_value: 1250,
              unit: "KILOMETERS",
              observed_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      if (path.endsWith("/claims")) return Response.json({ items: [] });
      return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    });
    await runInContext(`openVehicle('${id}')`, context);
    expect(calls).not.toContain("/api/v1/vehicles/" + id + "/records");
    expect(
      nodes
        .get("vehicle-detail")!
        .children.some((n) =>
          n.children.some((c) => c.textContent === "1250 kilómetros"),
        ),
    ).toBe(true);
    expect(
      nodes
        .get("vehicle-detail")!
        .children.some(
          (n) => n.textContent === "Solicitar revisión de relación",
        ),
    ).toBe(true);
    expect(
      nodes
        .get("vehicle-detail")!
        .children.some((n) => n.textContent === "Registrar odómetro"),
    ).toBe(false);
  });
});

describe("Workshop browser controls", () => {
  it("requires MFA to show operational closure and never shows terminal mutation controls", async () => {
    for (const [status, mfaEnabled, expectedClose] of [
      ["COMPLETED", false, false],
      ["COMPLETED", true, true],
      ["CLOSED", true, false],
    ] as const) {
      const { context, nodes } = browserHarness(portalScript, async (path) =>
        path.endsWith("/files")
          ? Response.json({ items: [] })
          : path === "/api/v1/me/evidence-files"
            ? Response.json([])
            : path.includes("/workshop/orders/")
              ? Response.json({
                  order: {
                    id: "order-test",
                    description: "Synthetic work",
                    status,
                    version: 5,
                  },
                  history: [],
                  canManage: true,
                  canExecute: true,
                  mfaEnabled,
                })
              : Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }),
      );
      await runInContext(
        "workshopOrg='organization-test';openWorkshopOrder('order-test')",
        context,
      );
      const titles = nodes
        .get("workshop-detail")!
        .children.map((node) => node.textContent);
      expect(titles.includes("Cerrar orden")).toBe(expectedClose);
      expect(titles.includes("Actualizar orden")).toBe(false);
      expect(titles.includes("Cancelar orden")).toBe(false);
    }
  });
  it("shows assigned execution separately from manager actions", async () => {
    const { context, nodes } = browserHarness(portalScript, async (path) =>
      path.endsWith("/files")
        ? Response.json({ items: [] })
        : path === "/api/v1/me/evidence-files"
          ? Response.json([])
          : path.includes("/workshop/orders/")
            ? Response.json({
                order: {
                  id: "order-test",
                  description: "Synthetic work",
                  status: "OPEN",
                  version: 2,
                },
                history: [],
                canManage: false,
                canExecute: true,
                mfaEnabled: false,
              })
            : Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }),
    );
    await runInContext(
      "workshopOrg='organization-test';openWorkshopOrder('order-test')",
      context,
    );
    const titles = nodes
      .get("workshop-detail")!
      .children.map((node) => node.textContent);
    expect(titles).toContain("Iniciar trabajo");
    expect(titles).not.toContain("Actualizar orden");
    expect(titles).not.toContain("Cancelar orden");
  });
});

describe("Inspection browser authority and media controls", () => {
  it("gates finalization/amendments by MFA and keeps final media immutable", async () => {
    for (const [status, mfaEnabled, canWrite, finalize, amend] of [
      ["DRAFT", false, true, false, false],
      ["DRAFT", true, true, true, false],
      ["FINAL", true, true, false, true],
      ["FINAL", false, true, false, false],
      ["FINAL", true, false, false, false],
    ] as const) {
      const { context, nodes } = browserHarness(portalScript, async (path) =>
        path.includes("/inspections/")
          ? Response.json({
              record: { id: "report-test", status, version: 2 },
              content: {
                schemaVersion: 1,
                summary: "Synthetic observations",
                findings: [],
              },
              files: [],
              amendments: [],
              canWrite,
              mfaEnabled,
            })
          : path === "/api/v1/me/evidence-files"
            ? Response.json([])
            : Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }),
      );
      await runInContext("openInspection('report-test')", context);
      const titles = nodes
        .get("inspection-detail")!
        .children.map((node) => node.textContent);
      expect(titles.includes("Finalizar informe")).toBe(finalize);
      expect(titles.includes("Registrar enmienda")).toBe(amend);
      expect(titles.includes("Adjuntar evidencia")).toBe(
        status === "DRAFT" && canWrite,
      );
      expect(titles.includes("Actualizar resumen")).toBe(
        status === "DRAFT" && canWrite,
      );
    }
  });
  it.each(["summary", "finding", "additional finding"])(
    "keeps original and amendment snapshots while basing %s corrections on the latest amendment",
    async (edit) => {
      const original = {
        schemaVersion: 1,
        summary: "Original report",
        findings: [
          {
            id: "original-finding",
            label: "Original label",
            observation: "Original observation",
            evidenceFileIds: ["file-original"],
          },
        ],
      };
      const earlier = {
        ...original,
        summary: "Earlier correction",
        findings: [
          { ...original.findings[0], observation: "Earlier observation" },
        ],
      };
      const latest = {
        ...earlier,
        summary: "Latest correction",
        findings: [
          {
            ...earlier.findings[0],
            label: "Latest label",
            observation: "Latest observation",
          },
          {
            id: "added-finding",
            label: "Added label",
            observation: "Added observation",
            evidenceFileIds: [],
          },
        ],
      };
      const writes: {
        path: string;
        body: { content: typeof latest; reason: string };
      }[] = [];
      const { context, nodes } = browserHarness(
        portalScript,
        async (path, init) => {
          if (init?.method === "POST") {
            writes.push({ path, body: JSON.parse(String(init.body)) });
            return Response.json({ recordId: "report-test" });
          }
          return path.includes("/inspections/")
            ? Response.json({
                record: { id: "report-test", status: "FINAL", version: 2 },
                content: original,
                amendments: [earlier, latest].map((snapshot, index) => ({
                  content_json: JSON.stringify(snapshot),
                  reason: "Correction " + index,
                  created_at: "2026-10-09T0" + index + ":00:00Z",
                })),
                amendmentsTruncated: true,
                files: [],
                canWrite: true,
                mfaEnabled: true,
              })
            : Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
        },
      );
      await runInContext("openInspection('report-test')", context);
      const root = nodes.get("inspection-detail")!;
      const text = (node: FakeNode): string =>
        [node.textContent, ...node.children.map(text)].join("\n");
      expect(text(root)).toContain("Informe final original inmutable");
      expect(text(root)).toContain("Original report");
      expect(text(root)).toContain("Original observation");
      expect(text(root)).toContain("Earlier observation");
      expect(text(root)).toContain("Latest observation");
      expect(text(root)).toContain("Added observation");
      expect(text(root)).toContain("últimas 100 enmiendas");
      const title =
        edit === "summary"
          ? "Registrar enmienda"
          : edit === "finding"
            ? "Enmendar hallazgo"
            : "Ampliar mediante enmienda";
      const form =
        root.children[
          root.children.findIndex((node) => node.textContent === title) + 1
        ];
      expect(form).toBeDefined();
      if (!form) throw new Error("Correction form is missing");
      form.fields = new Map<string, unknown>([
        ["reason", "Corrección posterior"],
        ["summary", "Next summary"],
        ["label", "Next label"],
        ["observation", "Next observation"],
      ]);
      context.testForm = form;
      await runInContext(
        "testForm.onsubmit({preventDefault(){},target:testForm})",
        context,
      );
      expect(writes).toHaveLength(1);
      const write = writes[0];
      expect(write).toBeDefined();
      if (!write) throw new Error("Amendment request is missing");
      expect(write.path).toBe("/api/v1/inspections/report-test/amend");
      const expected = JSON.parse(JSON.stringify(latest));
      if (edit === "summary") expected.summary = "Next summary";
      else if (edit === "finding")
        Object.assign(expected.findings[0], {
          label: "Next label",
          observation: "Next observation",
        });
      else
        expected.findings.push({
          id: "test-uuid",
          label: "Next label",
          observation: "Next observation",
          evidenceFileIds: [],
        });
      expect(write.body).toEqual({
        content: expected,
        reason: "Corrección posterior",
      });
      expect(original.summary).toBe("Original report");
      expect(original.findings[0]?.observation).toBe("Original observation");
      for (const forbidden of [
        "Actualizar resumen",
        "Corregir hallazgo",
        "Subir evidencia para análisis",
        "Adjuntar evidencia",
        "Finalizar informe",
      ])
        expect(text(root)).not.toContain(forbidden);
    },
  );
  it("retains pending trusted uploads in quarantine without sending an attachment", async () => {
    const calls: string[] = [];
    const { context } = browserHarness(portalScript, async (path) => {
      calls.push(path);
      return Response.json(
        path.endsWith("/me/evidence-files")
          ? { fileId: "pending-test" }
          : { status: "QUARANTINED" },
      );
    });
    await expect(
      runInContext("uploadEvidence({size:64,type:'image/png'})", context),
    ).rejects.toThrow(/revisión/);
    expect(
      calls.filter(
        (path) =>
          path.includes("evidence-files") || path.includes("inspections"),
      ),
    ).toEqual([
      "/api/v1/me/evidence-files",
      "/api/v1/me/evidence-files/pending-test",
    ]);
  });
});

describe("Membership browser controls", () => {
  const plans = {
    items: [
      {
        code: "MONTH",
        name: "Acompañamiento mensual",
        period: "MONTHLY",
        amount_minor: 2990000,
        currency: "COP",
        vehicle_limit: 2,
      },
      {
        code: "YEAR",
        name: "Acompañamiento anual",
        period: "ANNUAL",
        amount_minor: 28800000,
        currency: "COP",
        vehicle_limit: 2,
      },
    ],
  };
  const base = {
    subscription: null,
    premium: false,
    vehicleLimit: 2,
    vehicles: [],
    entitlements: [],
    checkoutAvailable: false,
    benefits: [
      { code: "GUIDANCE", label: "Orientación asistida", available: true },
      { code: "FUTURE", label: "Beneficio futuro", available: false },
    ],
  };
  const text = (node: FakeNode): string =>
    [node.textContent, ...node.children.map(text)].join("\n");
  const allNodes = (node: FakeNode): FakeNode[] => [
    node,
    ...node.children.flatMap(allNodes),
  ];

  it("shows server-priced monthly and annual options and creates only a pending request without a checkout button", async () => {
    const writes: { path: string; init: RequestInit }[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (init?.method === "POST") {
          writes.push({ path, init });
          return Response.json({ subscriptionId: "pending-subscription" });
        }
        if (path === "/api/v1/billing/plans") return Response.json(plans);
        if (path === "/api/v1/me/membership") return Response.json(base);
        return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      },
    );
    await runInContext("refreshMembership()", context);
    const root = nodes.get("membership-plans")!;
    expect(text(root)).toContain("29.900");
    expect(text(root)).toContain("288.000");
    expect(text(root)).toContain("Opción mensual");
    expect(text(root)).toContain("Opción anual");
    expect(text(nodes.get("membership-detail")!)).toContain(
      "no realiza un cobro",
    );
    expect(portalPage).toContain("ACOMPAÑAMIENTO MOTORBALDI");
    expect(portalPage).toContain("TODO SOBRE TU VEHÍCULO. SIEMPRE CONTIGO.");
    expect(portalPage).toContain("sin membresía");
    expect(portalPage).toContain("no sustituye un diagnóstico profesional");
    expect(portalPage).not.toContain("24/7");
    const future = allNodes(nodes.get("membership-benefits")!).find(
      (node) => node.textContent === "Beneficio futuro · próximamente",
    ) as FakeNode & { disabled: boolean };
    expect(future.disabled).toBe(true);
    const choose = allNodes(root).find((node) =>
      node.textContent.startsWith("Elegir opción anual"),
    );
    expect(choose?.onclick).toEqual(expect.any(Function));
    await choose!.onclick!();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/api/v1/billing/subscriptions");
    expect(JSON.parse(String(writes[0]?.init.body))).toEqual({
      planCode: "YEAR",
    });
    expect(
      new Headers(writes[0]?.init.headers).get("idempotency-key"),
    ).toBeTruthy();
    expect(text(root)).not.toContain("Pagar");
  });

  it.each([
    { capability: false, status: "PENDING_ACTIVATION", canceled: false },
    { capability: undefined, status: "PENDING_ACTIVATION", canceled: false },
    { capability: true, status: "CANCELLED", canceled: false },
    { capability: true, status: "SUSPENDED", canceled: false },
    { capability: true, status: "ACTIVE", canceled: true },
  ])(
    "hides sandbox checkout without capability or eligible subscription: $status/$capability/$canceled",
    async ({ capability, status, canceled }) => {
      const { context, nodes } = browserHarness(portalScript, async (path) => {
        if (path === "/api/v1/billing/plans") return Response.json(plans);
        if (path === "/api/v1/me/membership")
          return Response.json({
            ...base,
            checkoutAvailable: capability,
            subscription: {
              id: "synthetic",
              status,
              cancel_at_period_end: canceled,
            },
          });
        return Response.json({}, { status: 401 });
      });
      await runInContext("refreshMembership()", context);
      expect(text(nodes.get("membership-detail")!)).not.toContain(
        "en Wompi (pruebas)",
      );
    },
  );

  it.each(["PENDING_ACTIVATION", "PENDING_RENEWAL"])(
    "offers only validated sandbox checkout link after explicit action for %s",
    async (status) => {
      const writes: RequestInit[] = [];
      const { context, nodes } = browserHarness(
        portalScript,
        async (path, init) => {
          if (init?.method === "POST") {
            writes.push(init);
            expect(path).toBe(
              "/api/v1/billing/subscriptions/synthetic/checkout",
            );
            return Response.json({
              checkoutAvailable: true,
              status: "CREATED",
              checkoutUrl: "https://checkout.wompi.co/p/?reference=synthetic",
            });
          }
          if (path === "/api/v1/billing/plans") return Response.json(plans);
          if (path === "/api/v1/me/membership")
            return Response.json({
              ...base,
              checkoutAvailable: true,
              subscription: { id: "synthetic", status },
            });
          return Response.json({}, { status: 401 });
        },
      );
      await runInContext("refreshMembership()", context);
      const root = nodes.get("membership-detail")!;
      const button = allNodes(root).find(
        (node) =>
          node.textContent ===
          (status === "PENDING_ACTIVATION"
            ? "Pagar en Wompi (pruebas)"
            : "Renovar en Wompi (pruebas)"),
      )!;
      expect(writes).toHaveLength(0);
      await button.onclick!();
      expect(JSON.parse(String(writes[0]?.body))).toEqual({});
      expect(
        new Headers(writes[0]?.headers).get("idempotency-key"),
      ).toBeTruthy();
      const link = allNodes(root).find(
        (node) => node.textContent === "Continuar a Wompi (pruebas)",
      ) as FakeNode & { href: string };
      expect(link.href).toBe(
        "https://checkout.wompi.co/p/?reference=synthetic",
      );
      expect(context.location.href).toBe("https://portal.test/");
      expect(text(root)).toContain("Acceso básico gratuito");
      expect(nodes.get("notice")!.textContent).toContain(
        "no confirma el pago ni activa",
      );
    },
  );

  it.each([
    { status: "PENDING", url: "https://checkout.wompi.co/p/" },
    { status: "UNKNOWN", url: "https://checkout.wompi.co/p/" },
    { status: "CREATED", url: "http://checkout.wompi.co/p/" },
    { status: "CREATED", url: "https://checkout.wompi.co.attacker.test/p/" },
    { status: "CREATED", url: "https://checkout.wompi.co/other" },
    { status: "CREATED", url: "https://user:secret@checkout.wompi.co/p/" },
  ])(
    "withholds checkout navigation for unconfirmed payment or invalid URL: $status/$url",
    async ({ status, url }) => {
      const { context, nodes } = browserHarness(
        portalScript,
        async (path, init) => {
          if (init?.method === "POST")
            return Response.json({
              checkoutAvailable: true,
              status,
              checkoutUrl: url,
            });
          if (path === "/api/v1/billing/plans") return Response.json(plans);
          if (path === "/api/v1/me/membership")
            return Response.json({
              ...base,
              checkoutAvailable: true,
              subscription: { id: "synthetic", status: "PENDING_ACTIVATION" },
            });
          return Response.json({}, { status: 401 });
        },
      );
      await runInContext("refreshMembership()", context);
      const root = nodes.get("membership-detail")!;
      const button = allNodes(root).find(
        (node) => node.textContent === "Pagar en Wompi (pruebas)",
      ) as FakeNode & { disabled: boolean };
      await button.onclick!();
      expect(button.disabled).toBe(true);
      expect(text(root)).not.toContain("Continuar a Wompi");
      expect(context.location.href).toBe("https://portal.test/");
      expect(nodes.get("notice")!.textContent).toContain(
        "antes de iniciar otro pago",
      );
      expect(text(root)).toContain("Acceso básico gratuito");
    },
  );

  it("preserves a billing retry key after failure and sends current versions for cancellation and vehicle assignments", async () => {
    const subscription = {
      id: "paid-subscription",
      status: "ACTIVE",
      plan_code: "MONTH",
      version: 7,
      cancel_at_period_end: false,
      current_period_end: "2026-11-10T00:00:00Z",
    };
    const writes: { path: string; init: RequestInit }[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (init?.method === "POST") {
          writes.push({ path, init });
          return Response.json(
            writes.length === 1 ? { code: "VERSION_CONFLICT" } : {},
            { status: writes.length === 1 ? 409 : 200 },
          );
        }
        if (path === "/api/v1/billing/plans") return Response.json(plans);
        if (path === "/api/v1/me/membership")
          return Response.json({
            ...base,
            subscription,
            premium: true,
            vehicles: [{ vehicle_id: "included-vehicle" }],
          });
        if (path === "/api/v1/me/garage")
          return Response.json({
            items: [{ id: "included-vehicle" }, { id: "eligible-vehicle" }],
          });
        return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      },
    );
    await runInContext(
      "let membershipKeyCounter=0;crypto.randomUUID=()=> 'billing-key-'+(++membershipKeyCounter)",
      context,
    );
    await runInContext("refreshMembership()", context);
    let root = nodes.get("membership-detail")!;
    const cancel = root.children.find(
      (node) => node.textContent === "Cancelar renovación",
    );
    await cancel!.onclick!();
    await cancel!.onclick!();
    expect(writes.slice(0, 2).map((call) => call.path)).toEqual([
      "/api/v1/billing/subscriptions/paid-subscription/cancel",
      "/api/v1/billing/subscriptions/paid-subscription/cancel",
    ]);
    expect(new Headers(writes[0]?.init.headers).get("idempotency-key")).toBe(
      new Headers(writes[1]?.init.headers).get("idempotency-key"),
    );
    expect(JSON.parse(String(writes[1]?.init.body))).toEqual({ version: 7 });
    expect(nodes.get("notice")?.textContent).toContain(
      "El acceso ya pagado se conserva",
    );
    root = nodes.get("membership-detail")!;
    const remove = root.children.find((node) =>
      node.textContent.startsWith("Quitar vehículo"),
    );
    await remove!.onclick!();
    expect(writes[2]?.path).toBe(
      "/api/v1/billing/subscriptions/paid-subscription/vehicles/included-vehicle/remove",
    );
    expect(JSON.parse(String(writes[2]?.init.body))).toEqual({ version: 7 });
    root = nodes.get("membership-detail")!;
    const form =
      root.children[
        root.children.findIndex(
          (node) => node.textContent === "Incluir vehículo de mi garaje",
        ) + 1
      ]!;
    form.fields = new Map([["vehicleId", "eligible-vehicle"]]);
    context.membershipForm = form;
    await runInContext(
      "membershipForm.onsubmit({preventDefault(){},target:membershipForm})",
      context,
    );
    expect(writes[3]?.path).toBe(
      "/api/v1/billing/subscriptions/paid-subscription/vehicles",
    );
    expect(JSON.parse(String(writes[3]?.init.body))).toEqual({
      version: 7,
      vehicleId: "eligible-vehicle",
    });
  });

  it.each([
    {
      status: "PENDING_ACTIVATION",
      premium: false,
      cancel: false,
      vehicles: [],
    },
    {
      status: "ACTIVE",
      premium: true,
      cancel: true,
      vehicles: [{ vehicle_id: "one" }, { vehicle_id: "two" }],
    },
  ])(
    "gates membership vehicle controls and scheduled cancellation for $status",
    async ({ status, premium, cancel, vehicles }) => {
      const { context, nodes } = browserHarness(portalScript, async (path) => {
        if (path === "/api/v1/billing/plans") return Response.json(plans);
        if (path === "/api/v1/me/membership")
          return Response.json({
            ...base,
            premium,
            vehicles,
            subscription: {
              id: "gated-subscription",
              status,
              plan_code: "MONTH",
              version: 4,
              cancel_at_period_end: cancel,
              current_period_end: "2026-11-10T00:00:00Z",
            },
          });
        return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      });
      await runInContext("refreshMembership()", context);
      const root = nodes.get("membership-detail")!;
      expect(text(root)).not.toContain("Incluir vehículo de mi garaje");
      expect(text(nodes.get("membership-plans")!)).not.toContain(
        "Elegir opción",
      );
      if (!premium) {
        expect(text(root)).toContain("Pendiente de activación");
        expect(text(root)).not.toContain("Quitar vehículo");
        expect(text(root)).toContain("Acceso básico gratuito");
      } else {
        expect(text(root)).toContain("El acceso ya pagado se conserva");
        expect(text(root)).not.toContain("Cancelar renovación");
      }
    },
  );

  it("keeps the admin financial panels read-only and default-deny", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const { context, nodes } = browserHarness(
      adminScript,
      async (path, init) => {
        calls.push({ path, init });
        if (path === "/api/v1/admin/billing")
          return Response.json({
            subscriptions: [
              { id: "sub-test", status: "ACTIVE", plan_code: "MONTH" },
            ],
            payments: [],
            policies: { checkoutAvailable: false },
          });
        if (path === "/api/v1/admin/commissions")
          return Response.json({
            agreements: [],
            commissions: [
              {
                id: "commission-test",
                status: "PENDING",
                amount_minor: 50000,
                currency: "COP",
              },
            ],
            settlements: [],
          });
        return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      },
    );
    await runInContext("showBilling();showCommissions()", context);
    expect(
      calls.filter((call) => /billing|commissions/.test(call.path)),
    ).toHaveLength(0);
    await runInContext(
      "permissions=new Set(['platform.billing.read','platform.commission.read']);showBilling()",
      context,
    );
    await runInContext("showCommissions()", context);
    expect(text(nodes.get("billing-detail")!)).toContain("sub-test");
    expect(text(nodes.get("billing-detail")!)).toContain("Deshabilitado");
    expect(text(nodes.get("commissions-detail")!)).toContain("commission-test");
    expect(text(nodes.get("commissions-detail")!)).toContain(
      "No hay registros.",
    );
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
      0,
    );
    expect(adminPage).not.toContain("Confirmar pago");
    await runInContext(
      "permissions=new Set();showBilling();showCommissions()",
      context,
    );
    expect(nodes.get("billing-detail")?.children).toHaveLength(0);
    expect(nodes.get("commissions-detail")?.children).toHaveLength(0);
  });
});
