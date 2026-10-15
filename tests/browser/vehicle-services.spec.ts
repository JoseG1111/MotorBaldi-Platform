import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
const id = "00000000-0000-7000-8000-000000000001";
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
])
  test(
    "Customer expiry and maintenance persist through rendered controls " +
      viewport.width,
    async ({ page }) => {
      await page.setViewportSize(viewport);
      let compliance: Record<string, unknown>[] = [];
      const maintenance: Record<string, unknown>[] = [];
      await page.route("**/api/**", async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname.replace("/api/v1", "");
        if (path.endsWith("/auth/get-session"))
          return route.fulfill({ json: { session: { id: "synthetic" } } });
        const fixtures: Record<string, unknown> = {
          "/me": {
            accountId: "synthetic-account",
            personId: "synthetic-person",
          },
          "/me/profile": {
            given_name: "Cliente",
            family_name: "Sintético",
            version: 1,
          },
          "/auth/capabilities": {
            registrationAvailable: false,
            recoveryAvailable: false,
          },
          "/billing/payments": { items: [], nextCursor: null },
          "/me/contact-methods": [],
          "/me/workspaces": [
            { id: "PERSONAL", type: "PERSONAL", name: "Mi espacio" },
          ],
          "/directory/organizations": { items: [], nextCursor: null },
          "/public/parts": { items: [], nextCursor: null },
          "/me/vehicles": {
            items: [
              {
                id,
                kind_code: "CAR",
                version: 1,
                specification: {
                  make: "Marca sintética",
                  model: "Modelo de prueba",
                },
                writable: true,
              },
              {
                id: "00000000-0000-7000-8000-000000000002",
                kind_code: "CAR",
                version: 1,
                specification: {
                  make: "Vehículo histórico",
                  model:
                    "ModeloConNombreMuyLargoSinEspaciosParaComprobarElAjusteEnPantallasPequeñas",
                },
                writable: false,
              },
            ],
            nextCursor: null,
          },
        };
        if (path === "/vehicles/" + id + "/compliance") {
          expect(request.headers()["idempotency-key"]).toBeTruthy();
          const payload = request.postDataJSON();
          compliance = [
            {
              id: "revision",
              document_type: payload.documentType,
              expires_on: payload.expiresOn,
              provider: payload.provider,
              verification_status: "USER_ENTERED",
            },
          ];
          return route.fulfill({
            json: { vehicleId: id, entryId: "revision" },
          });
        }
        if (path === "/vehicles/" + id + "/maintenance") {
          const payload = request.postDataJSON();
          maintenance.push({
            id: "entry",
            performed_on: payload.performedOn,
            title: payload.title,
            notes: payload.notes,
            mileage: null,
          });
          return route.fulfill({ json: { vehicleId: id, entryId: "entry" } });
        }
        if (path === "/vehicles/" + id + "/services")
          return route.fulfill({
            json: {
              compliance,
              maintenance,
              writable: true,
              owned: true,
              nextCursor: null,
              entitlements: {
                premium: false,
                manualMaintenanceLimit: 5,
                vehicleLimit: 1,
              },
              manualEntriesUsed: maintenance.length,
              monthlySummary: null,
            },
          });
        if (path in fixtures) return route.fulfill({ json: fixtures[path] });
        throw new Error("Unexpected vehicle request " + path);
      });
      await page.goto("http://127.0.0.1:4174");
      await expect(page.locator("#private")).toBeVisible();
      if (viewport.width <= 768) await page.locator("#nav-toggle").click();
      await page
        .locator("#app-navigation [data-panel=vehicle-services]")
        .click();
      await expect(
        page.locator("#vehicle-official-sources a").first(),
      ).toHaveAttribute(
        "href",
        "https://www.fasecolda.com/ramos/soat/companias-autorizadas/",
      );
      await expect(
        page.locator("#vehicle-official-sources a").nth(1),
      ).toHaveAttribute(
        "href",
        "https://www.runt.gov.co/directorio-de-actores",
      );
      const selectors = page.locator("#customer-vehicle-list > button");
      await expect(selectors).toHaveCount(2);
      await expect(selectors.first()).toHaveAttribute("aria-pressed", "false");
      await expect(selectors.nth(1)).toHaveClass(/secondary/);
      const geometry = await selectors.evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            right: box.right,
            bottom: box.bottom,
          };
        }),
      );
      expect(
        geometry.every(
          (box) =>
            box.height >= 44 &&
            box.width <= (viewport.width > 600 ? 320 : viewport.width),
        ),
      ).toBe(true);
      const gap =
        viewport.width <= 600
          ? geometry[1]!.y - geometry[0]!.bottom
          : geometry[1]!.x - geometry[0]!.right;
      expect(gap).toBeGreaterThanOrEqual(12);
      await page
        .getByRole("button", {
          name: "Marca sintética · Modelo de prueba",
          exact: true,
        })
        .click();
      await expect(selectors.first()).toHaveAttribute("aria-pressed", "true");
      await expect(selectors.first()).not.toHaveClass(/secondary/);
      await expect(selectors.nth(1)).toHaveAttribute("aria-pressed", "false");
      const soat = page.locator("#customer-vehicle-services section").filter({
        has: page.getByRole("heading", { name: "SOAT", exact: true }),
      });
      await soat.getByLabel("Fecha de vencimiento").fill("2030-12-20");
      await soat
        .getByLabel("Aseguradora o CDA (opcional)")
        .fill("Proveedor declarado");
      await soat.getByRole("button", { name: "Guardar fecha" }).click();
      await expect(soat).toContainText("2030-12-20");
      await expect(soat).toContainText("Declarado por el usuario");
      const history = page
        .locator("#customer-vehicle-services section")
        .filter({
          has: page.getByRole("heading", {
            name: "Historial manual de mantenimiento",
            exact: true,
          }),
        });
      await history.getByLabel("Fecha del servicio").fill("2026-10-01");
      await history
        .getByLabel("Mantenimiento realizado")
        .fill("Cambio de aceite sintético");
      await history
        .getByRole("button", { name: "Registrar mantenimiento" })
        .click();
      await expect(history).toContainText("Cambio de aceite sintético");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .include("#vehicle-services-panel")
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path:
          "test-results/browser/vehicle-services-" + viewport.width + ".png",
        fullPage: true,
      });
    },
  );

test("A late saved expiry cannot replace the vehicle selected afterward", async ({
  page,
}) => {
  const second = "00000000-0000-7000-8000-000000000002";
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === `/vehicles/${id}/compliance`) {
      await pause;
      return route.fulfill({ json: { vehicleId: id } });
    }
    if (path.endsWith("/services"))
      return route.fulfill({
        json: {
          owned: true,
          writable: true,
          entitlements: { premium: true },
          manualEntriesUsed: 0,
          maintenance: [],
          nextCursor: null,
          compliance: path.includes(second)
            ? [
                {
                  document_type: "SOAT",
                  expires_on: "2030-03-03",
                  verification_status: "USER_ENTERED",
                  provider: "Vehículo B",
                },
              ]
            : [],
        },
      });
    const fixtures: Record<string, unknown> = {
      "/me": { accountId: "synthetic-account", personId: "synthetic-person" },
      "/me/workspaces": [
        { id: "PERSONAL", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/me/profile": {
        given_name: "Cliente",
        family_name: "Sintético",
        version: 1,
      },
      "/auth/capabilities": {
        registrationAvailable: false,
        recoveryAvailable: false,
      },
      "/billing/payments": { items: [], nextCursor: null },
      "/me/contact-methods": [],
      "/directory/organizations": { items: [] },
      "/public/parts": { items: [] },
      "/me/vehicles": {
        items: [
          {
            id,
            version: 1,
            specification: { make: "Vehículo", model: "A" },
            writable: true,
          },
          {
            id: second,
            version: 1,
            specification: { make: "Vehículo", model: "B" },
            writable: true,
          },
        ],
        nextCursor: null,
      },
    };
    return route.fulfill({
      status: Object.hasOwn(fixtures, path) ? 200 : 501,
      json: fixtures[path] ?? { code: "UNMOCKED_REQUEST" },
    });
  });
  await page.goto("http://127.0.0.1:4174");
  await expect(page.locator("#private")).toBeVisible();
  await page.locator('#app-navigation [data-panel="vehicle-services"]').click();
  await page.getByRole("button", { name: "Vehículo · A", exact: true }).click();
  const soat = page
    .locator("#customer-vehicle-services section")
    .filter({ has: page.getByRole("heading", { name: "SOAT", exact: true }) });
  await soat.locator('[name="expiresOn"]').fill("2029-01-01");
  await soat.getByRole("button", { name: "Guardar fecha" }).click();
  await page.getByRole("button", { name: "Vehículo · B", exact: true }).click();
  await expect(page.locator("#customer-vehicle-services")).toContainText(
    "Vehículo B",
  );
  release();
  await expect(page.locator("#notice")).toContainText("Información guardada");
  await expect(page.locator("#customer-vehicle-services")).toContainText(
    "Vehículo B",
  );
});

test("Malformed vehicle service data shows a Spanish error instead of a JavaScript exception", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const fixtures: Record<string, unknown> = {
      "/me": { accountId: "synthetic-account", personId: "synthetic-person" },
      "/me/workspaces": [
        { id: "PERSONAL", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/me/profile": {
        given_name: "Cliente",
        family_name: "Sintético",
        version: 1,
      },
      "/auth/capabilities": {
        registrationAvailable: false,
        recoveryAvailable: false,
      },
      "/billing/payments": { items: [], nextCursor: null },
      "/me/contact-methods": [],
      "/directory/organizations": { items: [] },
      "/public/parts": { items: [] },
      "/me/vehicles": {
        items: [
          {
            id,
            version: 1,
            specification: { make: "Vehículo", model: "QA" },
            writable: true,
          },
        ],
        nextCursor: null,
      },
    };
    if (path.endsWith("/services"))
      return route.fulfill({
        json: {
          owned: true,
          writable: true,
          entitlements: { premium: false },
          manualEntriesUsed: 0,
          compliance: null,
          maintenance: [],
        },
      });
    return route.fulfill({
      status: Object.hasOwn(fixtures, path) ? 200 : 501,
      json: fixtures[path] ?? { code: "UNMOCKED_REQUEST" },
    });
  });
  await page.goto("http://127.0.0.1:4174");
  await expect(page.locator("#private")).toBeVisible();
  await page.locator('#app-navigation [data-panel="vehicle-services"]').click();
  await page
    .getByRole("button", { name: "Vehículo · QA", exact: true })
    .click();
  const error = page.locator("#customer-vehicle-services");
  await expect(error).toContainText(
    "La respuesta del servicio no tiene el formato esperado",
  );
  await expect(error).not.toContainText(
    /undefined|TypeError|Cannot|Sin fecha registrada/,
  );
});
