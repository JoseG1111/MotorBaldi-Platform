import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("A delayed bootstrap cannot replace the customer navigation selected after refresh", async ({
  page,
}) => {
  let release!: () => void;
  const profile = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/me/profile") {
      await profile;
      return route.fulfill({
        json: {
          version: 1,
          given_name: "QA",
          family_name: "Synthetic",
          display_name: "QA",
        },
      });
    }
    const responses: Record<string, unknown> = {
      "/me": { accountId: "qa", personId: "qa" },
      "/me/workspaces": [
        { id: "personal", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/directory/organizations": { items: [], nextCursor: null },
      "/me/contact-methods": [],
      "/me/vehicles": { items: [], nextCursor: null },
      "/me/garage": { items: [], nextCursor: null },
    };
    await route.fulfill({
      json: responses[path] ?? { items: [], nextCursor: null },
    });
  });
  await page.goto("http://127.0.0.1:4174/#workshops");
  await expect(page.locator("#private")).toBeVisible();
  await expect(page.locator("#private")).toHaveAttribute("aria-busy", "true");
  await page.locator('#app-navigation [data-panel="vehicle-services"]').click();
  await expect(page.locator("#vehicle-services-panel")).toBeVisible();
  release();
  await expect(page.locator("#private")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#vehicle-services-panel")).toBeVisible();
  await expect(page.locator("#workshops-panel")).toBeHidden();
  await expect(page).toHaveURL("http://127.0.0.1:4174/");
});

for (const width of [1440, 1280, 768, 390]) {
  test(`Free help and genuine workshop contact ${width}`, async ({ page }) => {
    await page.setViewportSize({
      width,
      height: { 1440: 900, 1280: 800, 768: 1024, 390: 844 }[width]!,
    });
    const vehicleId = "11111111-1111-4111-8111-111111111111";
    const orgId = "22222222-2222-4222-8222-222222222222";
    const requestId = "33333333-3333-4333-8333-333333333333";
    let saved: unknown = null;
    let closed = false;
    let sent = false;
    const requests: string[] = [];
    const row = () => ({
      id: requestId,
      organizationId: orgId,
      organizationName: "Taller Uno",
      vehicleId,
      message: "Consultar revisión del vehículo",
      status: closed ? "CLOSED" : "OPEN",
      version: closed ? 2 : 1,
      responseMessage: closed
        ? "Puedes consultar disponibilidad con el taller"
        : null,
      createdAt: "2026-10-12T10:00:00Z",
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace("/api/v1", "");
      requests.push(path + url.search);
      if (path === `/workshops/${orgId}/contact-requests`) {
        saved = route.request().postDataJSON();
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        sent = true;
        return route.fulfill({ json: row() });
      }
      if (
        path ===
        `/organizations/${orgId}/workshop/contact-requests/${requestId}/close`
      ) {
        expect(route.request().postDataJSON()).toEqual({
          version: 1,
          responseMessage: "Puedes consultar disponibilidad con el taller",
        });
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        closed = true;
        return route.fulfill({ json: row() });
      }
      if (path === "/workshops/discovery")
        return route.fulfill({
          json: {
            items: [
              {
                id: orgId,
                displayName: url.searchParams.has("cursor")
                  ? "Taller Dos"
                  : "Taller Uno",
                countryCode: "CO",
              },
            ],
            nextCursor: url.searchParams.has("cursor") ? null : "next-workshop",
          },
        });
      if (path === "/me/workshop-contact-requests")
        return route.fulfill({
          json: {
            items: sent ? [row()] : [],
            nextCursor:
              sent && !url.searchParams.has("cursor") ? "next-request" : null,
          },
        });
      if (path === `/organizations/${orgId}/workshop/contact-requests`)
        return route.fulfill({ json: { items: [row()], nextCursor: null } });
      const routes: Record<string, unknown> = {
        "/me": { personId: "qa-person", accountId: "qa-account" },
        "/me/workspaces": [
          { id: "personal", type: "PERSONAL", name: "Mi espacio" },
          { id: orgId, type: "ORGANIZATION", name: "Taller Uno" },
        ],
        "/directory/organizations": { items: [] },
        "/me/profile": {
          version: 1,
          given_name: "Ana",
          family_name: "QA",
          display_name: "Ana QA",
        },
        "/me/contact-methods": [],
        "/me/vehicles": {
          items: [
            {
              id: vehicleId,
              writable: true,
              specification: { make: "Marca", model: "Modelo", plate: "QA123" },
            },
          ],
          nextCursor: null,
        },
        [`/organizations/${orgId}`]: {
          display_name: "Taller Uno",
          verification_status: "VERIFIED",
        },
        [`/organizations/${orgId}/permissions`]: {
          permissions: ["org.workshop.read", "org.workshop.manage"],
        },
        [`/organizations/${orgId}/locations`]: { items: [] },
        [`/organizations/${orgId}/capabilities`]: [],
        [`/organizations/${orgId}/members`]: { items: [] },
        [`/organizations/${orgId}/workshop/locations`]: {
          items: [{ id: "site-one", name: "Sede Uno" }],
          canManage: true,
        },
        [`/organizations/${orgId}/workshop/locations/site-one/vehicles`]: {
          items: [],
        },
        [`/organizations/${orgId}/workshop/orders`]: {
          items: [],
          nextCursor: null,
        },
      };
      return route.fulfill({
        status: Object.hasOwn(routes, path) ? 200 : 501,
        json: routes[path] ?? { code: "UNMOCKED_REQUEST" },
      });
    });
    await page.goto("http://127.0.0.1:4174/#help");
    await expect(page.locator("#help-panel")).toBeVisible();
    await page.getByText("SOAT, RTM y recordatorios", { exact: true }).click();
    await expect(page.locator("#help-panel")).toContainText(
      "no una consulta oficial",
    );
    await page
      .getByText("Privacidad, seguridad, acceso y reclamaciones", {
        exact: true,
      })
      .click();
    await expect(page.locator("#help-panel")).toContainText(
      "disponibles también en Gratis",
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    const navigate = async (panel: string) => {
      const button = page.locator(`#app-navigation [data-panel="${panel}"]`);
      if (width <= 768 && !(await button.isVisible()))
        await page.locator("#nav-toggle").click();
      await button.click();
    };
    await navigate("workshops");
    await expect(page.locator("#customer-workshop-list")).toContainText(
      "Taller Uno",
    );
    await page.locator('#customer-workshop-search [name="q"]').fill("Taller");
    await page.locator("#customer-workshop-search button").click();
    await expect
      .poll(() =>
        requests.some((path) => path === "/workshops/discovery?q=Taller"),
      )
      .toBe(true);
    await page.locator("#customer-workshop-more").click();
    await expect(page.locator("#customer-workshop-list")).toContainText(
      "Taller Dos",
    );
    await page
      .getByRole("button", {
        name: "Solicitar contacto con Taller Uno",
        exact: true,
      })
      .click();
    const form = page.locator("#customer-workshop-contact-form");
    await form.locator('[name="vehicleId"]').selectOption(vehicleId);
    await form
      .locator('[name="message"]')
      .fill("Consultar revisión del vehículo");
    await form.locator('button[type="submit"]').click();
    expect(saved).toBeNull();
    await form.locator('[name="dataSharingConsent"]').check();
    await form.locator('button[type="submit"]').click();
    await expect
      .poll(() => saved)
      .toEqual({
        vehicleId,
        message: "Consultar revisión del vehículo",
        dataSharingConsent: true,
      });
    await expect(page.locator("#customer-workshop-status")).toContainText(
      "no confirma una cita",
    );
    await expect(page.locator("#customer-workshop-requests")).toContainText(
      "Abierta",
    );
    await page.locator("#customer-workshop-requests-more").click();
    await expect
      .poll(() =>
        requests.some((path) =>
          path.includes("/me/workshop-contact-requests?cursor=next-request"),
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.locator("#workspace").selectOption(orgId);
    await expect(page.locator("#organization-title")).toHaveText("Taller Uno");
    await navigate("workshop");
    await page.locator("#workshop-contact-inbox summary").click();
    await page.locator("#workshop-contact-refresh").click();
    await expect(page.locator("#workshop-contact-list")).toContainText(
      "Consultar revisión del vehículo",
    );
    await page
      .locator('#workshop-contact-list [name="responseMessage"]')
      .fill("Puedes consultar disponibilidad con el taller");
    await page
      .getByRole("button", {
        name: "Responder y cerrar solicitud",
        exact: true,
      })
      .click();
    await expect(page.locator("#workshop-contact-list")).toContainText(
      "Cerrada",
    );
    await expect(
      page.getByRole("button", {
        name: "Responder y cerrar solicitud",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.locator("#workspace").selectOption("personal");
    await navigate("workshops");
    await expect(page.locator("#customer-workshop-requests")).toContainText(
      "Cerrada",
    );
    await expect(page.locator("#customer-workshop-requests")).toContainText(
      "Respuesta del taller: Puedes consultar disponibilidad con el taller",
    );
    await navigate("help");
    await expect(page.locator("#help-title")).toBeVisible();
    await page.screenshot({
      path: `test-results/browser/customer-help-${width}.png`,
      fullPage: true,
    });
    await navigate("workshops");
    await page.screenshot({
      path: `test-results/browser/customer-workshops-${width}.png`,
      fullPage: true,
    });
  });
}
