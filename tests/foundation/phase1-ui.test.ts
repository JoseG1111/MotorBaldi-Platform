import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
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
});
