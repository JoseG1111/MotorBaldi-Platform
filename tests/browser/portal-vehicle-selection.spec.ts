import { expect, test, type Page, type Route } from "@playwright/test";

const ownedId = "11111111-1111-4111-8111-111111111111";
const laterId = "22222222-2222-4222-8222-222222222222";
const coveredId = "33333333-3333-4333-8333-333333333333";
const retiredId = "44444444-4444-4444-8444-444444444444";
const favoriteId = "55555555-5555-4555-8555-555555555555";
const owned = (id: string, model: string, active = true) => ({
  id,
  specification: { brand: "Marca QA", model },
  active,
  writable: active,
});
const membership = {
  premium: true,
  vehicleLimit: 3,
  vehicles: [{ vehicle_id: coveredId }],
  benefits: [],
  checkoutAvailable: false,
  subscription: {
    id: "qa-subscription",
    status: "ACTIVE",
    version: 1,
    plan_code: "QA_MONTH",
    cancel_at_period_end: 0,
  },
};

async function setup(
  page: Page,
  override?: (route: Route, path: string) => Promise<boolean>,
) {
  const unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const responses: Record<string, unknown> = {
    "/me": { accountId: "qa-account", personId: "qa-person" },
    "/me/workspaces": [
      { id: "personal", name: "Mi espacio", type: "PERSONAL" },
    ],
    "/directory/organizations": { items: [], nextCursor: null },
    "/me/profile": {
      version: 1,
      given_name: "Ana",
      family_name: "QA",
      display_name: "Ana QA",
    },
    "/me/contact-methods": [],
    "/public/parts": { items: [], nextCursor: null },
    "/auth/capabilities": {
      registrationAvailable: false,
      recoveryAvailable: false,
    },
    "/billing/plans": {
      items: [
        {
          code: "QA_MONTH",
          period: "MONTHLY",
          name: "MotorBaldi Premium",
          amount_minor: 2990000,
          currency: "COP",
          vehicle_limit: 3,
        },
      ],
    },
    "/billing/payments": { items: [], nextCursor: null },
    "/me/membership": membership,
    "/me/vehicles": { items: [], nextCursor: null },
    "/me/garage": { items: [], nextCursor: null },
    "/me/support-cases": { items: [], nextCursor: null },
    [`/vehicles/${coveredId}`]: owned(coveredId, "Cubierto fuera del garaje"),
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (override && (await override(route, path))) return;
    if (route.request().method() !== "GET" || !Object.hasOwn(responses, path)) {
      unexpected.push(route.request().method() + " " + path);
      await route.fulfill({
        status: 501,
        json: { code: "UNMOCKED_QA_REQUEST" },
      });
    } else await route.fulfill({ json: responses[path] });
  });
  await page.goto("http://127.0.0.1:4174/");
  await expect(page.locator("#private")).toHaveAttribute("aria-busy", "false");
  return { unexpected, errors };
}
async function membershipPanel(page: Page) {
  await page.locator('#app-navigation [data-panel="membership"]').click();
  await page.locator("#membership-management > summary").click();
}
async function supportPanel(page: Page) {
  await page.locator('#app-navigation [data-panel="support"]').click();
  await page.locator("#support-panel summary").first().click();
}
async function settled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("Premium vehicle picker includes owned vehicles outside favorites and explicitly loads later owners", async ({
  page,
}) => {
  let ownedRequests = 0,
    writes = 0;
  let release: (() => void) | undefined;
  const evidence = await setup(page, async (route, path) => {
    if (path === "/me/vehicles") {
      ownedRequests++;
      const later = new URL(route.request().url()).searchParams.has("cursor");
      await route.fulfill({
        json: {
          items: later
            ? [owned(laterId, "Vehículo posterior")]
            : [
                owned(ownedId, "Propio sin favorito"),
                owned(coveredId, "Ya cubierto"),
                owned(retiredId, "Inactivo", false),
              ],
          nextCursor: later ? null : ownedId,
        },
      });
      return true;
    }
    if (path === "/me/garage") {
      await route.fulfill({
        json: {
          items: [
            owned(ownedId, "Duplicado favorito"),
            owned(retiredId, "Inactivo favorito"),
            owned(favoriteId, "Favorito autorizado"),
          ],
          nextCursor: null,
        },
      });
      return true;
    }
    if (path === "/billing/subscriptions/qa-subscription/vehicles") {
      writes++;
      expect(route.request().postDataJSON()).toEqual({
        version: 1,
        vehicleId: laterId,
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 503,
        json: { code: "SERVICE_UNAVAILABLE" },
      });
      return true;
    }
    return false;
  });
  await membershipPanel(page);
  const select = page.locator("#membership-vehicle");
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select).toContainText("Propio sin favorito");
  await expect(select).toContainText("Favorito autorizado");
  await expect(select).not.toContainText("Inactivo");
  await expect(select.locator(`option[value="${coveredId}"]`)).toHaveCount(0);
  expect(ownedRequests).toBe(1);
  await page
    .getByRole("button", { name: "Cargar más vehículos propios", exact: true })
    .click();
  await expect(select.locator("option")).toHaveCount(3);
  expect(ownedRequests).toBe(2);
  await expect(
    page.getByRole("button", {
      name: "Cargar más vehículos propios",
      exact: true,
    }),
  ).toBeHidden();
  await page
    .locator("#membership-detail summary")
    .filter({ hasText: /^Incluir vehículo en Premium$/ })
    .click();
  await select.selectOption(laterId);
  const submit = page.getByRole("button", {
    name: "Incluir vehículo en Premium",
    exact: true,
  });
  await submit.click();
  await expect.poll(() => writes).toBe(1);
  await expect(submit).toBeDisabled();
  await select.locator("..").locator("..").dispatchEvent("submit");
  release!();
  await expect(submit).toBeEnabled();
  expect(writes).toBe(1);
  await expect(select).toHaveValue(laterId);
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});

test("Membership picker discards owned results from a superseded refresh", async ({
  page,
}) => {
  let reads = 0,
    release: (() => void) | undefined;
  const evidence = await setup(page, async (route, path) => {
    if (path !== "/me/vehicles") return false;
    const old = ++reads === 1;
    if (old)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({
      json: {
        items: [
          owned(
            old ? ownedId : laterId,
            old ? "Respuesta antigua" : "Respuesta actual",
          ),
        ],
        nextCursor: null,
      },
    });
    return true;
  });
  await membershipPanel(page);
  await expect.poll(() => reads).toBe(1);
  await page
    .getByRole("button", { name: "Consultar estado del pago", exact: true })
    .click();
  await expect(page.locator("#membership-vehicle")).toContainText(
    "Respuesta actual",
  );
  const response = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith("/me/vehicles"),
  );
  release!();
  await (await response).finished();
  await settled(page);
  await expect(page.locator("#membership-vehicle")).toHaveCount(1);
  await expect(page.locator("#membership-vehicle")).not.toContainText(
    "Respuesta antigua",
  );
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});

test("Assisted support resolves canonical covered vehicles outside favorites and clears context after creation", async ({
  page,
}) => {
  let body: unknown;
  const evidence = await setup(page, async (route, path) => {
    if (path === "/me/support-cases" && route.request().method() === "POST") {
      body = route.request().postDataJSON();
      await route.fulfill({ json: { caseId: "qa-new-case" } });
      return true;
    }
    if (path === "/me/support-cases/qa-new-case") {
      await route.fulfill({
        json: {
          caseId: "qa-new-case",
          subject: "Coordinación QA",
          status: "OPEN",
          version: 1,
          messages: [],
          history: [],
        },
      });
      return true;
    }
    return false;
  });
  await supportPanel(page);
  const form = page.locator("#support-create-form");
  await form.getByLabel("Tipo de solicitud").selectOption("VEHICLE_ASSISTANCE");
  await expect(page.locator("#support-vehicle-id")).toContainText(
    "Cubierto fuera del garaje",
  );
  await page.locator("#support-vehicle-id").selectOption(coveredId);
  await form.getByLabel("Asunto", { exact: true }).fill("Coordinación QA");
  await form
    .getByLabel("Mensaje", { exact: true })
    .fill("Solicitud sintética de acompañamiento");
  await form
    .getByRole("button", { name: "Crear solicitud", exact: true })
    .click();
  await expect(page.locator("#support-detail")).toContainText(
    "Coordinación QA",
  );
  expect(body).toMatchObject({
    purpose: "VEHICLE_ASSISTANCE",
    vehicleId: coveredId,
  });
  await expect(page.locator("#support-vehicle-context")).toBeHidden();
  await expect(page.locator("#support-vehicle-id")).not.toHaveAttribute(
    "required",
    "",
  );
  await expect(page.locator("#support-vehicle-id option")).toHaveCount(0);
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});

test("Assisted support ignores a late vehicle response after changing purpose or workspace", async ({
  page,
}) => {
  let release: (() => void) | undefined,
    reads = 0;
  const evidence = await setup(page, async (route, path) => {
    if (path !== `/vehicles/${coveredId}`) return false;
    reads++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: owned(coveredId, "Respuesta tardía cubierta"),
    });
    return true;
  });
  await supportPanel(page);
  const purpose = page.locator('#support-create-form [name="purpose"]');
  await purpose.selectOption("VEHICLE_ASSISTANCE");
  await expect.poll(() => reads).toBe(1);
  await purpose.selectOption("ACCOUNT");
  const response = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith(`/vehicles/${coveredId}`),
  );
  release!();
  await (await response).finished();
  await settled(page);
  await expect(page.locator("#support-vehicle-context")).toBeHidden();
  await expect(page.locator("#support-vehicle-id option")).toHaveCount(0);
  await purpose.selectOption("VEHICLE_ASSISTANCE");
  await expect.poll(() => reads).toBe(2);
  await page.locator("#workspace").dispatchEvent("change");
  const workspaceResponse = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith(`/vehicles/${coveredId}`),
  );
  release!();
  await (await workspaceResponse).finished();
  await settled(page);
  await expect(page.locator("#support-vehicle-id")).not.toContainText(
    "Respuesta tardía cubierta",
  );
  expect(evidence.errors).toEqual([]);
  expect(evidence.unexpected).toEqual([]);
});
