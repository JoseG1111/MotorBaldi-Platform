import { describe, expect, it } from "vitest";
import type { PortalBindings } from "@motorbaldi/config";
import portal from "../../apps/portal/src/index.js";
import { portalPage } from "../../apps/portal/src/page.js";

function bindings(environment: PortalBindings["ENVIRONMENT"]): PortalBindings {
  return {
    ENVIRONMENT: environment,
    API_SERVICE: { fetch: async () => new Response(null, { status: 501 }) },
  } as unknown as PortalBindings;
}
describe("Production Portal file availability", () => {
  it("disables every static upload input and supplies the closed marker and Spanish explanation", async () => {
    const response = await portal.fetch(
      new Request("https://portal.test/"),
      bindings("production"),
    );
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toMatch(/<body[^>]*data-file-uploads-available="false"/);
    const inputs = page.match(/<input\b[^>]*type="file"[^>]*>/g) ?? [];
    expect(inputs.length).toBe(
      (portalPage.match(/<input\b[^>]*type="file"[^>]*>/g) ?? []).length,
    );
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).toContain(" disabled");
      expect(input).toContain('aria-disabled="true"');
    }
    expect(page).toContain(
      "La carga de archivos no está disponible. Puedes consultar los archivos autorizados existentes.",
    );
    // Existing ACTIVE selections remain usable; this boundary only stops new file bytes.
    expect(page).toContain('id="credential-evidence-files"');
    expect(page).not.toMatch(
      /<select[^>]*id="credential-evidence-files"[^>]*disabled/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("preserves Local, Development and Staging quarantine upload presentation", async () => {
    for (const environment of ["local", "development", "staging"] as const) {
      const response = await portal.fetch(
        new Request("https://portal.test/"),
        bindings(environment),
      );
      const page = await response.text();
      expect(page).toBe(portalPage);
      expect(page).not.toContain('data-file-uploads-available="false"');
      for (const input of page.match(/<input\b[^>]*type="file"[^>]*>/g) ?? [])
        expect(input).not.toContain(" disabled");
    }
  });
});
