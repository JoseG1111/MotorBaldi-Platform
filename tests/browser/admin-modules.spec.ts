import { expect, test, type Page, type Route } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

// Synthetic records follow the existing API projections; no customer data is used.
const vehicleId = "00000000-0000-4000-8000-000000000021";
const org = {
  id: "00000000-0000-4000-8000-000000000010",
  type: "WORKSHOP",
  display_name: "Taller sintético Norte",
  country_code: "CO",
  status: "ACTIVE",
  verification_status: "PENDING_VERIFICATION",
  version: 1,
};
const part = {
  id: "00000000-0000-4000-8000-000000000030",
  name: "Filtro de aceite de prueba",
  category: "FILTER",
  brand: "Marca sintética",
  manufacturerReference: "QA-F01",
  description: "Referencia sintética para validación del catálogo",
  unit: "Unidad",
  status: "ACTIVE",
  version: 1,
  compatibility: [
    {
      vehicleKind: "CAR",
      brand: "Marca sintética",
      model: "Modelo QA",
      verified: false,
    },
  ],
};
const reportBase = {
  schemaVersion: 1,
  classification: "INTERNAL",
  observedAt: "2026-10-11T12:00:00.000Z",
  scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
};
const responses: Record<string, unknown> = {
  "/admin/access": {
    permissions: [
      "platform.people.read",
      "platform.organization.read",
      "platform.organization.verify",
      "platform.professional.read",
      "platform.professional.verify",
      "platform.vehicle.read",
      "platform.vehicle.manage",
      "platform.workshop.read",
      "platform.billing.read",
      "platform.catalog.manage",
      "platform.support.read",
      "platform.support.manage",
      "platform.audit.read",
    ],
  },
  "/admin/people": { items: [], nextCursor: null },
  "/admin/organizations": { items: [org], nextCursor: null },
  [`/admin/organizations/${org.id}`]: {
    organization: org,
    locations: [],
    capabilities: [],
    members: [],
    invitations: [],
    membershipRequests: [],
    opportunities: [],
    activities: [],
    tasks: [],
    verificationCases: [
      {
        id: "qa-verification",
        status: "PENDING_VERIFICATION",
        submitted_at: "2026-10-11T12:00:00.000Z",
      },
    ],
  },
  "/admin/professionals/credentials": [
    {
      id: "qa-credential",
      person_id: "qa-professional",
      display_name: "Profesional de prueba",
      credential_type: "CERT",
      issuer: "Instituto sintético",
      evidence_file_id: null,
    },
  ],
  "/admin/vehicles": {
    items: [{ id: vehicleId, kind_code: "CAR" }],
    nextCursor: null,
  },
  [`/admin/vehicles/${vehicleId}`]: {
    vehicle: {
      id: vehicleId,
      kind_code: "CAR",
      specification_json: JSON.stringify({
        brand: "Marca QA",
        model: "Modelo Norte",
        year: 2024,
      }),
      version: 1,
    },
    identifiers: [],
    grants: [],
    relationships: [],
    claims: [],
  },
  "/admin/workshop/orders": {
    items: [
      {
        id: "qa-order",
        description: "Mantenimiento preventivo de prueba",
        organization_name: org.display_name,
        location_name: "Sede Norte",
        status: "IN_PROGRESS",
      },
    ],
    nextCursor: null,
  },
  "/admin/inspections": {
    items: [
      {
        id: "qa-inspection",
        organization_name: org.display_name,
        location_name: "Sede Norte",
        status: "FINAL",
        finalized_at: "2026-10-11T12:00:00.000Z",
        content_json: JSON.stringify({
          summary: "Inspección sintética de seguridad",
          findings: [
            {
              label: "Sistema de frenos",
              observation: "Revisión profesional de prueba",
            },
          ],
        }),
        latest_amendment_json: null,
      },
    ],
    nextCursor: null,
  },
  "/admin/parts": [part],
  [`/admin/parts/${part.id}`]: part,
  "/admin/marketplace/listings": {
    items: [
      {
        listingId: "qa-listing",
        organizationId: org.id,
        status: "PENDING_REVIEW",
        version: 1,
        snapshot: {
          ...part,
          partnerBusinessName: "Aliado sintético",
          generalLocation: "Bogotá",
          country: "CO",
          priceMinor: null,
          availability: "UNKNOWN",
          lastUpdatedAt: "2026-10-11T12:00:00.000Z",
        },
      },
    ],
    nextCursor: null,
  },
  "/admin/analytics/parts": {
    ...reportBase,
    kind: "CANONICAL_PARTS",
    provenance: { mode: "CURRENT_STATE", sourceTables: ["parts_canonical"] },
    counts: { DRAFT: 0, ACTIVE: 1, ARCHIVED: 0 },
  },
  "/admin/analytics/queue": {
    ...reportBase,
    kind: "PLATFORM_QUEUE",
    provenance: {
      mode: "CURRENT_STATE",
      sourceTables: ["integration_outbox_events", "integration_dead_letters"],
    },
    counts: {
      PENDING: 1,
      PROCESSING: 0,
      PROCESSED: 2,
      DEAD: 0,
      liveLeases: 0,
      unresolvedDeadLetters: 0,
    },
  },
  "/admin/support-cases": {
    items: [
      {
        caseId: "qa-case",
        subject: "Consulta sintética de membresía",
        status: "OPEN",
      },
    ],
    nextCursor: null,
  },
  "/admin/support-cases/qa-case": {
    caseId: "qa-case",
    subject: "Consulta sintética de membresía",
    status: "OPEN",
    version: 1,
    messages: [
      {
        body: "Necesito información sobre mi membresía de prueba.",
        createdAt: "2026-10-11T12:00:00.000Z",
      },
    ],
    history: [{ action: "CREATED", createdAt: "2026-10-11T12:00:00.000Z" }],
    messagesTruncated: false,
    historyTruncated: false,
  },
  "/admin/billing": {
    subscriptions: [
      {
        id: "qa-membership",
        status: "ACTIVE",
        plan_code: "QA_PLAN",
        created_at: "2026-10-11T12:00:00.000Z",
      },
    ],
    payments: [
      {
        id: "qa-payment",
        status: "PENDING",
        amount_minor: 500000,
        currency: "COP",
        subscription_id: "qa-membership",
        created_at: "2026-10-11T12:00:00.000Z",
      },
    ],
    policies: {},
  },
};
async function setup(
  page: Page,
  override?: (route: Route, path: string) => Promise<boolean>,
) {
  const unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (override && (await override(route, path))) return;
    if (route.request().method() !== "GET" || !Object.hasOwn(responses, path)) {
      unexpected.push(`${route.request().method()} ${path}`);
      await route.fulfill({
        status: 501,
        json: { code: "UNMOCKED_BROWSER_QA_REQUEST" },
      });
    } else await route.fulfill({ json: responses[path] });
  });
  await page.goto("http://127.0.0.1:4173");
  await expect(page.locator("body")).toHaveClass(/signed-in/);
  return { unexpected, errors };
}
async function navigate(page: Page, panel: string) {
  if (await page.evaluate(() => innerWidth <= 768))
    await page.locator("#nav-toggle").click();
  await page.locator(`[data-panel="${panel}"]`).click();
}
const modules = [
  ["verifications", "Taller sintético Norte"],
  ["professionals", "Instituto sintético"],
  ["vehicles", vehicleId],
  ["workshop", "Mantenimiento preventivo de prueba"],
  ["inspections", "Sistema de frenos"],
  ["parts", part.name],
  ["support", "Consulta sintética de membresía"],
  ["billing", "qa-payment"],
  ["analytics", "Eventos pendientes: 1"],
] as const;
for (const width of [1440, 390]) {
  test(`remaining Admin modules: canonical workflows, accessibility and layout ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const evidence = await setup(page);
    for (const [panel, text] of modules) {
      await navigate(page, panel);
      await expect(page.locator(`#${panel}-panel`)).toContainText(text);
      if (panel === "parts")
        await expect(page.locator("#marketplace-review-list")).toContainText(
          "Aliado sintético",
        );
      await page.screenshot({
        path: info.outputPath(`synthetic-admin-${panel}-${width}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
    }
    await navigate(page, "vehicles");
    await page
      .locator("#vehicle-list")
      .getByRole("button", { name: new RegExp(vehicleId) })
      .click();
    await expect(page.locator("#vehicle-detail")).toContainText("Modelo Norte");
    await page
      .locator("#vehicle-detail")
      .getByText("Actualizar vehículo", { exact: true })
      .first()
      .click();
    await expect(
      page.locator("#vehicle-detail").getByLabel("Marca", { exact: true }),
    ).toHaveValue("Marca QA");
    await page.screenshot({
      path: info.outputPath(`synthetic-admin-vehicle-detail-${width}.png`),
      fullPage: true,
    });
    await navigate(page, "support");
    await page
      .locator("#support-list")
      .getByRole("button", {
        name: "Consulta sintética de membresía",
        exact: true,
      })
      .click();
    await expect(page.locator("#support-detail")).toContainText(
      "Necesito información",
    );
    await expect(
      page
        .locator("#support-detail")
        .getByRole("button", { name: "Responder", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`synthetic-admin-support-detail-${width}.png`),
      fullPage: true,
    });
    await navigate(page, "parts");
    await page
      .getByRole("button", { name: "Revisar repuesto", exact: true })
      .first()
      .click();
    await expect(page.locator("#parts-detail")).toContainText(
      part.manufacturerReference,
    );
    await page.screenshot({
      path: info.outputPath(`synthetic-admin-part-detail-${width}.png`),
      fullPage: true,
    });
    expect(evidence.unexpected).toEqual([]);
    expect(evidence.errors).toEqual([]);
  });
}

test("Vehicle access picker reaches later authorized targets without unbounded loading", async ({
  page,
}) => {
  const first = {
    id: "00000000-0000-4000-8000-000000000041",
    given_name: "Primera",
    family_name: "Persona",
    display_name: "Primera Persona",
    status: "ACTIVE",
  };
  const last = {
    ...first,
    id: "00000000-0000-4000-8000-000000000042",
    display_name: "Persona posterior QA",
  };
  let granted: Record<string, unknown> | null = null;
  const evidence = await setup(page, async (route, path) => {
    if (path === "/admin/people") {
      const url = new URL(route.request().url());
      const later =
        url.searchParams.has("cursor") ||
        url.searchParams.get("q") === "posterior";
      await route.fulfill({
        json: {
          items: [later ? last : first],
          nextCursor: later ? null : first.id,
        },
      });
      return true;
    }
    if (path === `/admin/vehicles/${vehicleId}/grants`) {
      expect(route.request().method()).toBe("POST");
      granted = route.request().postDataJSON();
      await route.fulfill({ json: { grantId: "qa-grant" } });
      return true;
    }
    return false;
  });
  await navigate(page, "vehicles");
  await page.locator("#vehicle-list .record-link").click();
  await page
    .locator("#vehicle-detail summary")
    .filter({ hasText: /^Conceder acceso$/ })
    .click();
  const form = page.locator("#vehicle-detail form").filter({
    has: page.getByRole("heading", { name: "Conceder acceso", exact: true }),
  });
  await form.getByRole("button", { name: "Siguiente", exact: true }).click();
  await expect(form.locator("select[name=target]")).toContainText(
    "Persona posterior QA",
  );
  await form.getByRole("button", { name: "Anterior", exact: true }).click();
  await expect(form.locator("select[name=target]")).toContainText(
    "Primera Persona",
  );
  await form.getByLabel("Buscar personas por nombre").fill("posterior");
  await form.getByLabel("Buscar personas por nombre").press("Enter");
  await expect(form.locator("select[name=target]")).toContainText(
    "Persona posterior QA",
  );
  await form.locator("select[name=target]").selectOption("person:" + last.id);
  await form.locator("[name=reason]").fill("Acceso sintético autorizado QA");
  await form
    .getByRole("button", { name: "Conceder acceso", exact: true })
    .click();
  await expect
    .poll(() => granted)
    .toMatchObject({ personId: last.id, permissionCode: "vehicle.read" });
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});
