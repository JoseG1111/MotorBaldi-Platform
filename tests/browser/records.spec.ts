import { expect, test, type Page, type Route } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const person = {
  id: "00000000-0000-4000-8000-000000000001",
  given_name: "Ana",
  family_name: "García",
  display_name: "Ana García",
  country_code: "CO",
  status: "ACTIVE",
  account_status: "ACTIVE",
};
const second = {
  ...person,
  id: "00000000-0000-4000-8000-000000000002",
  display_name: "Carlos Mendoza",
  given_name: "Carlos",
  family_name: "Mendoza",
};
const detail = {
  person: { ...person, version: 1 },
  accounts: [{ id: "synthetic-account", status: "ACTIVE" }],
  contacts: [
    {
      id: "synthetic-phone",
      type: "PHONE",
      raw_value: "+573001234567",
      verification_status: "VERIFIED",
    },
    {
      id: "synthetic-contact",
      type: "EMAIL",
      raw_value: "ana@example.test",
      verification_status: "VERIFIED",
    },
  ],
  memberships: [
    {
      id: "synthetic-partner-membership",
      organization_id: "synthetic-partner",
      display_name: "Aliado de prueba",
      status: "ACTIVE",
    },
    {
      id: "synthetic-membership",
      organization_id: "synthetic-org",
      display_name: "Taller de prueba",
      status: "ACTIVE",
    },
  ],
  consents: [],
  professionalProfile: null,
  credentials: [],
  leads: [],
  opportunities: [],
  activities: [],
  tasks: [],
  duplicateCandidates: [],
};

async function setup(
  page: Page,
  peopleResponse?: (route: Route, url: URL) => Promise<void>,
) {
  const unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/admin/people" && peopleResponse)
      return peopleResponse(route, url);
    const responses: Record<string, unknown> = {
      "/api/v1/admin/access": {
        permissions: [
          "platform.people.read",
          "platform.organization.read",
          "platform.crm.read",
          "platform.commission.read",
        ],
      },
      "/api/v1/admin/people": { items: [person], nextCursor: null },
      [`/api/v1/admin/people/${person.id}`]: detail,
      "/api/v1/admin/organizations": {
        items: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            type: "WORKSHOP",
            display_name: "Taller de prueba",
            country_code: "CO",
            status: "ACTIVE",
            verification_status: "VERIFIED",
            version: 1,
          },
        ],
        nextCursor: null,
      },
      "/api/v1/admin/organizations/00000000-0000-4000-8000-000000000010": {
        organization: {
          id: "00000000-0000-4000-8000-000000000010",
          display_name: "Taller de prueba",
          type: "WORKSHOP",
          status: "ACTIVE",
          verification_status: "VERIFIED",
        },
        locations: [{ name: "Sede Norte", city: "Bogotá" }],
        capabilities: [{ code: "PARTS" }],
        members: [{ display_name: "Ana García", status: "ACTIVE" }],
        invitations: [],
        membershipRequests: [],
        opportunities: [],
        activities: [],
        tasks: [],
        verificationCases: [],
      },
      "/api/v1/admin/crm/leads": {
        items: [
          {
            id: "synthetic-lead",
            status: "RECEIVED",
            source_id: "website",
            given_name: "Laura",
            family_name: "Pérez",
            email: "laura@example.test",
            phone: null,
            organization_name: null,
            received_at: "2026-10-01T12:00:00.000Z",
            person_id: null,
            assigned_to_person_id: null,
          },
        ],
        nextCursor: null,
      },
      "/api/v1/admin/crm/tasks": { items: [], nextCursor: null },
      "/api/v1/admin/crm/pipelines": [],
      "/api/v1/admin/commissions": {
        agreements: [],
        entries: [
          {
            id: "synthetic-entry",
            status: "PENDING",
            amount_minor: 50000,
            currency: "COP",
            version: 1,
          },
        ],
        automaticPaymentsEnabled: false,
        settlementMode: "MANUAL_TRACKING_ONLY",
      },
    };
    if (
      !Object.hasOwn(responses, url.pathname) ||
      route.request().method() !== "GET"
    ) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      await route.fulfill({
        status: 501,
        json: { code: "UNMOCKED_BROWSER_QA_REQUEST" },
      });
    } else await route.fulfill({ json: responses[url.pathname] });
  });
  await page.goto("http://127.0.0.1:4173");
  await expect(page.locator("body")).toHaveClass(/signed-in/);
  return { unexpected, errors };
}

async function search(page: Page, value: string) {
  await page.locator('#people-search input[name="q"]').fill(value);
  await page
    .locator("#people-search")
    .getByRole("button", { name: "Buscar", exact: true })
    .click();
}

test("People search, pagination and canonical record detail", async ({
  page,
}, testInfo) => {
  const queries: string[] = [];
  const evidence = await setup(page, async (route, url) => {
    queries.push(url.searchParams.toString());
    await route.fulfill({
      json: url.searchParams.get("cursor")
        ? { items: [second], nextCursor: null }
        : { items: [person], nextCursor: person.id },
    });
  });
  await expect(page.locator("#people-list table")).toBeVisible();
  await page
    .locator("#people-list")
    .getByRole("button", { name: /Cargar más|Siguiente/ })
    .click();
  await expect(page.locator("#people-list")).toContainText("Carlos Mendoza");
  expect(queries.some((query) => query.includes("cursor="))).toBe(true);
  await search(page, "Ana");
  expect(queries.at(-1)).toContain("q=Ana");
  await page
    .locator("#people-list")
    .getByRole("button", { name: "Ana García", exact: true })
    .click();
  await expect(page.locator("#person-detail")).toContainText(
    "ana@example.test",
  );
  await expect(page.locator("#person-detail")).toContainText(
    "Taller de prueba",
  );
  await expect(page.locator("#person-detail")).toContainText(
    "Aliado de prueba",
  );
  await expect(page.locator("#person-detail")).toContainText("+573001234567");
  await page.screenshot({
    path: testInfo.outputPath("synthetic-person-detail.png"),
    fullPage: false,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page
    .locator("#person-detail")
    .getByRole("button", { name: "Volver a la lista" })
    .click();
  await expect(page.locator("#person-detail")).toBeEmpty();
  expect(evidence.unexpected).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

for (const failure of [
  "malformed",
  "malformed-row",
  "network",
  "forbidden",
] as const) {
  test(`People ${failure} failure remains a helpful error`, async ({
    page,
  }) => {
    const evidence = await setup(page, async (route) => {
      if (failure === "network") await route.abort("failed");
      else if (failure === "forbidden")
        await route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
      else
        await route.fulfill({
          json: {
            items: failure === "malformed-row" ? [{}] : undefined,
            nextCursor: null,
          },
        });
    });
    await expect(page.locator("#notice")).toContainText(
      failure.startsWith("malformed")
        ? "formato esperado"
        : failure === "forbidden"
          ? "permiso"
          : "Revisa tu conexión e inténtalo de nuevo",
    );
    await expect(page.locator("#notice")).not.toContainText(
      /undefined|TypeError|Failed to fetch/,
    );
    expect(evidence.errors).toEqual([]);
    expect(evidence.unexpected).toEqual([]);
  });
}

test("People stale search cannot replace the newest result", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const evidence = await setup(page, async (route, url) => {
    if (url.searchParams.get("q") === "Ana")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      json: {
        items: [url.searchParams.get("q") === "Carlos" ? second : person],
        nextCursor: null,
      },
    });
  });
  await expect(page.locator("#people-list")).toContainText("Ana García");
  await search(page, "Ana");
  await expect.poll(() => Boolean(release)).toBe(true);
  await search(page, "Carlos");
  await expect(page.locator("#people-list")).toContainText("Carlos Mendoza");
  release!();
  await expect(page.locator("#people-list")).not.toContainText("Ana García");
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});

for (const [panel, content] of [
  ["organizations", "Taller de prueba"],
  ["crm", "Laura"],
  ["commissions", "synthetic-entry"],
] as const) {
  test(`synthetic Admin ${panel} canonical data`, async ({
    page,
  }, testInfo) => {
    const evidence = await setup(page);
    await page.locator(`[data-panel="${panel}"]`).click();
    await expect(page.locator(`#${panel}-panel`)).toContainText(content);
    await page.screenshot({
      path: testInfo.outputPath(`synthetic-${panel}.png`),
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(evidence.unexpected).toEqual([]);
    expect(evidence.errors).toEqual([]);
  });
}

test("People current-page filtering and sorting are explicitly scoped", async ({
  page,
}) => {
  const evidence = await setup(page, async (route) => {
    await route.fulfill({
      json: {
        items: [person, { ...second, status: "PROVISIONAL" }],
        nextCursor: null,
      },
    });
  });
  await expect(page.locator("#people-list table")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Orden en esta página", exact: true })
    .selectOption("desc");
  await expect(page.locator("#people-list tbody tr").first()).toContainText(
    "Carlos Mendoza",
  );
  await page
    .getByRole("combobox", { name: "Estado en esta página", exact: true })
    .selectOption("ACTIVE");
  await expect(page.locator("#people-list tbody tr")).toHaveCount(1);
  await expect(page.locator("#people-list tbody tr")).toContainText(
    "Ana García",
  );
  expect(evidence.unexpected).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("Admin navigation excludes capabilities without permission", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/admin/access")
      await route.fulfill({ json: { permissions: ["platform.people.read"] } });
    else if (path === "/api/v1/admin/people")
      await route.fulfill({ json: { items: [person], nextCursor: null } });
    else throw new Error(`Unexpected request in narrow role: ${path}`);
  });
  await page.goto("http://127.0.0.1:4173");
  await expect(page.locator("#people-list")).toContainText("Ana García");
  await expect(page.locator('[data-panel="people"]')).toBeVisible();
  for (const panel of [
    "organizations",
    "crm",
    "vehicles",
    "billing",
    "commissions",
    "parts",
    "analytics",
    "support",
  ])
    await expect(page.locator(`[data-panel="${panel}"]`)).toBeHidden();
});

test("Organization detail renders capability codes and member relationships without a label exception", async ({
  page,
}) => {
  const evidence = await setup(page);
  await page.locator('[data-panel="organizations"]').click();
  await page
    .locator("#organization-list")
    .getByRole("button", { name: "Taller de prueba" })
    .click();
  await expect(page.locator("#organization-detail")).toContainText(
    "Sede Norte",
  );
  await expect(page.locator("#organization-detail")).toContainText(
    "Ana García",
  );
  await expect(page.locator("#notice")).not.toContainText(
    /TypeError|is not a function/,
  );
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});

test("People directory uses a bounded dense page", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const evidence = await setup(page, async (route) => {
    await route.fulfill({
      json: {
        items: Array.from({ length: 20 }, (_, index) => ({
          ...person,
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          display_name:
            [
              "Ana García",
              "Carlos Mendoza",
              "Laura Pérez",
              "Andrés Torres",
              "Camila Rojas",
              "Daniel López",
              "María Rodríguez",
              "Jorge Ruiz",
              "Sara Gómez",
              "Diego Castro",
            ][index % 10] + (index >= 10 ? " · Prueba" : ""),
          status: index % 5 === 0 ? "PROVISIONAL" : "ACTIVE",
          account_status: index % 5 === 0 ? null : "ACTIVE",
        })),
        nextCursor: person.id,
      },
    });
  });
  await expect(page.locator("#people-list tbody tr")).toHaveCount(20);
  await expect(page.locator("#people-list")).toContainText(
    "20 registros en esta página",
  );
  await page.screenshot({
    path: testInfo.outputPath("synthetic-people-dense-1440.png"),
  });
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});
