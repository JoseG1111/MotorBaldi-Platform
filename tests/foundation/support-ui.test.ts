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
const event = { preventDefault() {} };

describe("Support browser workflows", () => {
  it("creates account requests with optional predecessor and renders messages safely", async () => {
    const writes: RequestInit[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (path === "/api/v1/me/support-cases" && init?.method === "POST") {
          writes.push(init);
          return Response.json({ caseId: "case-1" });
        }
        if (path === "/api/v1/me/support-cases")
          return Response.json({
            items: [{ caseId: "case-1", subject: "Consulta", status: "OPEN" }],
            nextCursor: null,
          });
        if (path === "/api/v1/me/support-cases/case-1")
          return Response.json({
            ...{
              caseId: "case-1",
              subject: "Consulta",
              status: "OPEN",
              version: 3,
            },
            messages: [{ body: "<script>alert(1)</script>" }],
            history: [],
          });
        return Response.json({}, { status: 401 });
      },
    );
    const form = nodes.get("support-create-form")!;
    form.fields = new Map([
      ["subject", "Consulta"],
      ["body", "Mi solicitud"],
      ["previousCaseId", "previous-1"],
    ]);
    await form.listeners.submit!({ preventDefault() {}, currentTarget: form });
    expect(JSON.parse(String(writes[0]!.body))).toEqual({
      subject: "Consulta",
      body: "Mi solicitud",
      previousCaseId: "previous-1",
    });
    expect(contents(nodes.get("support-detail")!)).toContain(
      "<script>alert(1)</script>",
    );
    expect(
      flatten(nodes.get("support-detail")!).every((n) => !("innerHTML" in n)),
    ).toBe(true);
    expect(portalPage).toContain('data-panel="support"');
    expect(runInContext("currentOrg", context)).toBeNull();
  });
  for (const admin of [false, true])
    it(
      (admin ? "staff" : "customer") +
        " submits current versions and makes closed cases terminal",
      async () => {
        let version = 4,
          closed = false;
        const writes: { path: string; body: Record<string, unknown> }[] = [];
        const base = "/api/v1/" + (admin ? "admin" : "me") + "/support-cases";
        const { context, nodes } = browserHarness(
          admin ? adminScript : portalScript,
          async (path, init) => {
            if (path.startsWith(base) && init?.method === "POST") {
              const body = JSON.parse(String(init.body));
              writes.push({ path, body });
              version++;
              if (path.endsWith("/close")) closed = true;
              return Response.json({ version });
            }
            if (path === base)
              return Response.json({
                items: [
                  {
                    caseId: "case-1",
                    subject: "Consulta",
                    status: closed ? "CLOSED" : "OPEN",
                  },
                ],
                nextCursor: null,
              });
            if (path === base + "/case-1")
              return Response.json({
                ...{
                  caseId: "case-1",
                  subject: "Consulta",
                  status: closed ? "CLOSED" : "OPEN",
                  version,
                },
                messages: [{ body: "Mensaje" }],
                history: [],
              });
            return Response.json({}, { status: 401 });
          },
        );
        if (admin)
          runInContext(
            "permissions=new Set(['platform.support.read','platform.support.manage'])",
            context,
          );
        await runInContext("openSupportCase('case-1')", context);
        const submit = async (title: string, value: string) => {
          const form = nodes
            .get("support-detail")!
            .children.find((n) =>
              n.children.some((c) => c.textContent === title),
            )!;
          form.children[0]!.children[0]!.value = value;
          await form.onsubmit!(event);
        };
        if (admin) {
          await submit("Asignar responsable (identificador)", "agent-1");
          expect(writes[0]!.body).toEqual({
            version: 4,
            assigneePersonId: "agent-1",
          });
        }
        await submit("Responder", "Respuesta");
        expect(writes.at(-1)!.body).toEqual({
          version: admin ? 5 : 4,
          body: "Respuesta",
        });
        await submit("Cerrar caso (resolución opcional)", "");
        expect(writes.at(-1)!.body).toEqual({
          version: admin ? 6 : 5,
          resolution: null,
        });
        expect(contents(nodes.get("support-detail")!)).toContain(
          "Caso cerrado.",
        );
        expect(
          nodes.get("support-detail")!.children.filter((n) => n.onsubmit),
        ).toHaveLength(0);
      },
    );
  it("uses explicit staff permissions and loads more cases", async () => {
    const calls: string[] = [];
    const { context, nodes } = browserHarness(adminScript, async (path) => {
      calls.push(path);
      if (path.includes("support-cases"))
        return Response.json({
          items: [
            {
              caseId: path.includes("?") ? "second" : "first",
              subject: path,
              status: "OPEN",
            },
          ],
          nextCursor: path.includes("?") ? null : "next/cursor",
        });
      return Response.json({}, { status: 401 });
    });
    await runInContext("refreshSupport()", context);
    expect(calls.some((p) => p.includes("support-cases"))).toBe(false);
    runInContext("permissions=new Set(['platform.support.read'])", context);
    await runInContext("refreshSupport()", context);
    await flatten(nodes.get("support-list")!).find(
      (n) => n.textContent === "Cargar más casos",
    )!.onclick!();
    expect(calls).toContain("/api/v1/admin/support-cases?cursor=next%2Fcursor");
    expect(
      flatten(nodes.get("support-list")!).filter(
        (n) => n.textContent === "Ver caso",
      ),
    ).toHaveLength(2);
    expect(adminPage).toContain(
      'data-panel="support" data-permission="platform.support.read"',
    );
  });
  it("keeps a failed reply key and shows the conflict without losing the draft", async () => {
    const writes: RequestInit[] = [];
    const { context, nodes } = browserHarness(
      portalScript,
      async (path, init) => {
        if (init?.method === "POST") {
          writes.push(init);
          return Response.json({ code: "VERSION_CONFLICT" }, { status: 409 });
        }
        if (path.endsWith("/support-cases/case-1"))
          return Response.json({
            caseId: "case-1",
            subject: "Consulta",
            status: "OPEN",
            version: 7,
            messages: [],
            history: [],
          });
        return Response.json({}, { status: 401 });
      },
    );
    await runInContext("openSupportCase('case-1')", context);
    const form = nodes
      .get("support-detail")!
      .children.find((n) =>
        n.children.some((c) => c.textContent === "Responder"),
      )!;
    const input = form.children[0]!.children[0]!;
    input.value = "Conservar mensaje";
    await form.onsubmit!(event);
    await form.onsubmit!(event);
    expect(input.value).toBe("Conservar mensaje");
    expect(contents(nodes.get("support-status")!)).toContain("cambió");
    expect(new Headers(writes[0]!.headers).get("idempotency-key")).toBe(
      new Headers(writes[1]!.headers).get("idempotency-key"),
    );
    expect(JSON.parse(String(writes[1]!.body))).toEqual({
      version: 7,
      body: "Conservar mensaje",
    });
    expect(form.children[1]!.disabled).toBe(false);
  });
});
