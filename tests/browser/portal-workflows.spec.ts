import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const org = "00000000-0000-4000-8000-000000000010",
  denied = "00000000-0000-4000-8000-000000000011",
  vehicle = "00000000-0000-4000-8000-000000000020",
  site = "00000000-0000-4000-8000-000000000030";
const offering = {
  id: "qa-offering",
  version: 1,
  name: "Filtro sintético Norte",
  category: "FILTER",
  brand: "Marca QA",
  manufacturerReference: "QA-F01",
  description: "Oferta sintética para pruebas de interfaz",
  unit: "Unidad",
  status: "ACTIVE",
  compatibility: [],
  priceMinor: null,
  availability: "UNKNOWN",
  currency: "COP",
  updatedAt: "2026-10-11T12:00:00.000Z",
};
const content = {
  schemaVersion: 1,
  summary: "Inspección sintética de seguridad",
  findings: [
    {
      id: "qa-finding",
      label: "Sistema de frenos",
      observation: "Observación profesional sintética",
      evidenceFileIds: [],
    },
  ],
};
const paths: Record<string, unknown> = {
  "/me": { personId: "qa-person", accountId: "qa-account" },
  "/me/workspaces": [
    { id: "personal", type: "PERSONAL", name: "Mi espacio" },
    { id: org, type: "ORGANIZATION", name: "Taller sintético Norte" },
    {
      id: denied,
      type: "ORGANIZATION",
      name: "Aliado sin permisos operativos",
    },
  ],
  "/directory/organizations": { items: [], nextCursor: null },
  "/me/profile": {
    version: 1,
    given_name: "Ana",
    family_name: "García",
    display_name: "Ana García",
  },
  "/me/contact-methods": [
    {
      type: "EMAIL",
      raw_value: "ana@example.test",
      verification_status: "VERIFIED",
    },
  ],
  "/me/garage": { items: [{ id: vehicle, kindCode: "CAR" }], nextCursor: null },
  [`/vehicles/${vehicle}`]: {
    id: vehicle,
    kindCode: "CAR",
    specification: { brand: "Marca QA", model: "Modelo Norte", year: 2024 },
  },
  [`/vehicles/${vehicle}/permissions`]: {
    permissions: [
      "vehicle.read",
      "vehicle.record.read",
      "vehicle.odometer.write",
    ],
  },
  [`/vehicles/${vehicle}/odometer`]: {
    items: [
      {
        reading_value: 24000,
        unit: "KILOMETERS",
        observed_at: "2026-10-11T12:00:00.000Z",
        corrects_reading_id: null,
      },
    ],
    nextCursor: null,
  },
  [`/vehicles/${vehicle}/claims`]: { items: [], nextCursor: null },
  [`/vehicles/${vehicle}/records`]: {
    items: [
      {
        id: "qa-record",
        record_type: "SERVICE",
        status: "FINAL",
        content_json: JSON.stringify({
          summary: "Servicio preventivo sintético",
        }),
      },
    ],
    amendments: [],
  },
  "/billing/plans": {
    items: [
      {
        code: "QA_MONTH",
        name: "Acompañamiento de prueba",
        period: "MONTHLY",
        amount_minor: 500000,
        currency: "COP",
        vehicle_limit: 2,
      },
    ],
  },
  "/me/membership": {
    subscription: null,
    premium: false,
    vehicles: [],
    vehicleLimit: 2,
    checkoutAvailable: false,
    benefits: [{ label: "Beneficio sintético", available: false }],
  },
  "/me/notification-preferences": {
    items: [
      {
        category: "TRANSACTIONAL",
        channel: "IN_APP",
        enabled: true,
        version: 1,
      },
    ],
  },
  "/me/notifications": {
    items: [
      {
        id: "qa-notification",
        title: "Aviso sintético de servicio",
        body: "Tu registro de prueba está disponible.",
        readAt: null,
        version: 1,
      },
    ],
    nextCursor: null,
  },
  "/me/support-cases": {
    items: [
      {
        caseId: "qa-case",
        subject: "Consulta sintética de membresía",
        status: "OPEN",
      },
    ],
    nextCursor: null,
  },
  "/me/support-cases/qa-case": {
    caseId: "qa-case",
    subject: "Consulta sintética de membresía",
    status: "OPEN",
    version: 1,
    messages: [
      {
        body: "Necesito información de mi plan de prueba.",
        createdAt: "2026-10-11T12:00:00.000Z",
      },
    ],
    history: [],
    messagesTruncated: false,
    historyTruncated: false,
  },
  "/public/parts": {
    items: [
      {
        ...offering,
        partnerBusinessName: "Aliado sintético",
        generalLocation: "Bogotá",
        country: "CO",
        lastUpdatedAt: "2026-10-11T12:00:00.000Z",
      },
    ],
    nextCursor: null,
  },
  [`/organizations/${org}`]: {
    id: org,
    display_name: "Taller sintético Norte",
    verification_status: "VERIFIED",
  },
  [`/organizations/${org}/permissions`]: {
    permissions: [
      "org.workshop.read",
      "org.inspection.execute",
      "org.inspection.write",
      "org.parts.manage",
    ],
  },
  [`/organizations/${org}/locations`]: {
    items: [{ id: site, name: "Sede Norte", city: "Bogotá", status: "ACTIVE" }],
    nextCursor: null,
  },
  [`/organizations/${org}/capabilities`]: [{ code: "WORKSHOP_SERVICE" }],
  [`/organizations/${org}/workshop/locations`]: {
    items: [{ id: site, name: "Sede Norte" }],
    canManage: false,
  },
  [`/organizations/${org}/workshop/orders`]: {
    items: [
      {
        id: "qa-order",
        description: "Mantenimiento preventivo sintético",
        status: "IN_PROGRESS",
      },
    ],
    nextCursor: null,
  },
  [`/organizations/${org}/workshop/orders/qa-order`]: {
    order: {
      id: "qa-order",
      description: "Mantenimiento preventivo sintético",
      status: "IN_PROGRESS",
      vehicle_id: vehicle,
      organization_id: org,
      location_id: site,
      version: 1,
    },
    history: [],
    canManage: false,
    canExecute: false,
    mfaEnabled: false,
  },
  [`/organizations/${org}/workshop/orders/qa-order/parts`]: [],
  [`/organizations/${org}/workshop/orders/qa-order/files`]: { items: [] },
  [`/organizations/${org}/inspections/locations`]: {
    items: [{ id: site, name: "Sede Norte" }],
  },
  [`/organizations/${org}/inspections/locations/${site}/vehicles`]: {
    items: [{ id: vehicle, kind_code: "CAR" }],
  },
  [`/organizations/${org}/inspections`]: {
    items: [
      {
        id: "qa-inspection",
        content_json: JSON.stringify(content),
        status: "FINAL",
      },
    ],
    nextCursor: null,
  },
  "/inspections/qa-inspection": {
    record: { id: "qa-inspection", status: "FINAL", version: 1 },
    content,
    amendments: [],
    files: [],
    canWrite: false,
    mfaEnabled: false,
  },
  [`/organizations/${org}/parts-offerings`]: [offering],
  [`/organizations/${org}/parts-offerings/${offering.id}`]: offering,
  [`/organizations/${org}/marketplace-listings`]: {
    items: [],
    nextCursor: null,
  },
  [`/organizations/${org}/analytics/parts`]: {
    schemaVersion: 1,
    classification: "INTERNAL",
    kind: "ORGANIZATION_PARTS",
    observedAt: "2026-10-11T12:00:00.000Z",
    scope: {
      type: "ORGANIZATION",
      organizationId: org,
      locationId: site,
      resourceScope: "AUTHORIZED",
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
      offerings: { DRAFT: 0, ACTIVE: 1, INACTIVE: 0 },
      listings: { DRAFT: 0, PENDING_REVIEW: 0, PUBLISHED: 0, SUSPENDED: 0 },
      discoverable: 0,
    },
  },
  [`/organizations/${denied}`]: {
    id: denied,
    display_name: "Aliado sin permisos operativos",
    verification_status: "VERIFIED",
  },
  [`/organizations/${denied}/permissions`]: { permissions: [] },
  [`/organizations/${denied}/locations`]: { items: [] },
  [`/organizations/${denied}/capabilities`]: [],
};
async function setup(page: Page) {
  const errors: string[] = [],
    unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (route.request().method() !== "GET" || !Object.hasOwn(paths, path)) {
      unexpected.push(`${route.request().method()} ${path}`);
      await route.fulfill({
        status: 501,
        json: { code: "UNMOCKED_BROWSER_QA_REQUEST" },
      });
    } else await route.fulfill({ json: paths[path] });
  });
  await page.goto("http://127.0.0.1:4174");
  await expect(page.locator("body")).toHaveClass(/signed-in/);
  await expect(page.locator("#workspace option")).toHaveCount(3);
  return { errors, unexpected };
}
async function navigate(page: Page, panel: string) {
  if (
    await page.evaluate(
      () => innerWidth <= 768 && !document.body.classList.contains("nav-open"),
    )
  )
    await page.locator("#nav-toggle").click();
  await page.locator(`[data-panel="${panel}"]`).click();
}
async function workspace(page: Page, value: string) {
  if (!(await page.locator("#workspace").isVisible()))
    await page.locator("#nav-toggle").click();
  await page.locator("#workspace").selectOption(value);
  if (
    await page.evaluate(
      () => innerWidth <= 768 && document.body.classList.contains("nav-open"),
    )
  )
    await page.locator("#nav-toggle").click();
}
async function quality(page: Page, path: string) {
  await page.screenshot({ path, fullPage: true });
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
for (const width of [1440, 390])
  test(`Portal customer and organization workflows ${width}`, async ({
    page,
  }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const evidence = await setup(page);
    for (const panel of ["workshop", "inspections", "parts"])
      await expect(page.locator(`[data-panel="${panel}"]`)).toBeHidden();
    for (const [panel, text] of [
      ["discovery", "Filtro sintético Norte"],
      ["garage", "Automóvil"],
      ["membership", "Acceso básico gratuito"],
      ["notifications", "Aviso sintético"],
      ["support", "Consulta sintética"],
    ] as const) {
      await navigate(page, panel);
      await expect(page.locator(`#${panel}-panel`)).toContainText(text);
      await quality(
        page,
        info.outputPath(`synthetic-portal-${panel}-${width}.png`),
      );
    }
    await navigate(page, "garage");
    await page
      .locator("#garage-list")
      .getByRole("button", { name: "Abrir vehículo", exact: true })
      .click();
    await expect(page.locator("#vehicle-detail")).toContainText("Modelo Norte");
    await expect(page.locator("#vehicle-detail")).toContainText(
      "Servicio preventivo sintético",
    );
    await quality(
      page,
      info.outputPath(`synthetic-portal-vehicle-history-${width}.png`),
    );
    await navigate(page, "support");
    await page
      .locator("#support-list")
      .getByRole("button", { name: "Ver caso", exact: true })
      .click();
    await expect(page.locator("#support-detail")).toContainText(
      "Necesito información",
    );
    await quality(
      page,
      info.outputPath(`synthetic-portal-support-detail-${width}.png`),
    );
    await workspace(page, org);
    await expect(page.locator("#organization-title")).toHaveText(
      "Taller sintético Norte",
    );
    await quality(
      page,
      info.outputPath(`synthetic-portal-organization-${width}.png`),
    );
    await navigate(page, "workshop");
    await expect(page.locator("#workshop-list")).toContainText(
      "Mantenimiento preventivo sintético",
    );
    await page
      .locator("#workshop-list")
      .getByRole("button", { name: "Abrir orden", exact: true })
      .click();
    await expect(page.locator("#workshop-detail")).toContainText(
      "Mantenimiento preventivo sintético",
    );
    await quality(
      page,
      info.outputPath(`synthetic-portal-workshop-${width}.png`),
    );
    await navigate(page, "inspections");
    await page
      .locator("#inspection-list")
      .getByRole("button", { name: "Abrir informe", exact: true })
      .click();
    await expect(page.locator("#inspection-detail")).toContainText(
      "Sistema de frenos",
    );
    await quality(
      page,
      info.outputPath(`synthetic-portal-inspection-${width}.png`),
    );
    await navigate(page, "parts");
    await expect(page.locator("#parts-list")).toContainText(offering.name);
    await quality(
      page,
      info.outputPath(`synthetic-portal-partner-offerings-${width}.png`),
    );
    await workspace(page, denied);
    await expect(page.locator("#organization-title")).toHaveText(
      "Aliado sin permisos operativos",
    );
    for (const panel of ["workshop", "inspections", "parts"])
      await expect(page.locator(`[data-panel="${panel}"]`)).toBeHidden();
    await workspace(page, "personal");
    for (const panel of ["workshop", "inspections", "parts"])
      await expect(page.locator(`[data-panel="${panel}"]`)).toBeHidden();
    expect(evidence.errors).toEqual([]);
    expect(evidence.unexpected).toEqual([]);
  });

test("Portal profile form sends validated current-version data and confirms success", async ({
  page,
}) => {
  const evidence = await setup(page);
  let submitted: unknown;
  await page.route("**/api/v1/me/profile", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { version: 2 } });
  });
  await navigate(page, "account");
  await page.locator('#profile-form input[name="givenName"]').fill("Lucía");
  await page
    .locator("#profile-form")
    .getByRole("button", { name: "Guardar perfil" })
    .click();
  await expect(page.locator("#notice")).toHaveText("Cambios guardados.");
  expect(submitted).toMatchObject({ givenName: "Lucía", version: 1 });
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});

test("A late organization response cannot restore permissions after switching to personal", async ({
  page,
}) => {
  const evidence = await setup(page);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/organizations/" + org, async (route) => {
    started();
    await held;
    await route.fulfill({ json: paths["/organizations/" + org] });
  });
  await page.locator("#workspace").selectOption(org);
  await began;
  await page.locator("#workspace").selectOption("personal");
  const returned = page.waitForResponse((response) =>
    response.url().endsWith("/organizations/" + org),
  );
  release();
  await returned;
  await expect(page.locator("#notice")).toContainText("El espacio cambió");
  await expect(page.locator("#organization-detail")).toBeHidden();
  for (const panel of ["workshop", "inspections", "parts"])
    await expect(
      page.locator('[data-panel="' + panel + '"]').first(),
    ).toBeHidden();
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});
