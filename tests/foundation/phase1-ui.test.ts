import { describe, expect, it } from "vitest";
import { Script, createContext, runInContext } from "node:vm";
import { portalPage, portalScript } from "../../apps/portal/src/page.js";
import { adminPage, adminScript } from "../../apps/admin/src/page.js";

describe("Phase 1 browser assets", () => {
  it("serves Spanish-first semantic shells and valid browser scripts", () => {
    expect(portalPage).toContain('<html lang="es">');
    expect(adminPage).toContain('<html lang="es">');
    expect(portalPage).toContain("Mis organizaciones");
    expect(portalPage).toContain("Mi perfil profesional");
    expect(adminPage).toContain("Personas");
    expect(adminPage).toContain("Verificaciones");
    expect(portalPage).toContain('aria-live="polite"');
    expect(adminPage).toContain('aria-live="polite"');
    expect(() => new Script(portalScript)).not.toThrow();
    expect(() => new Script(adminScript)).not.toThrow();
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
    add(): void;
    remove(): void;
    toggle(): void;
    contains(): boolean;
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
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
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
    },
    prompt: () => "Motivo válido",
    setTimeout,
  });
  runInContext(script, context);
  return { context, nodes };
}
