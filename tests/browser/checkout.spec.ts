import { test, expect, type Page } from "@playwright/test";
import { CUSTOMER_PLANS } from "../../packages/shared/src/customer-plans.js";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const checkoutUrl =
  "https://checkout.wompi.co/p/?public-key=pub_test_LOCAL_FIXTURE&reference=local-checkout";
async function fixture(
  page: Page,
  options: {
    create?: boolean;
    entry?: string;
    checkoutStatus?: string;
    url?: string;
    failure?: "transport" | "api";
  } = {},
) {
  let subscription = !options.create;
  let premium = false;
  let paymentStatus = options.checkoutStatus ?? "CREATED";
  let attempts = 0;
  let membershipReads = 0;
  let selectedPlan: unknown;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/billing/subscriptions") {
      selectedPlan = route.request().postDataJSON();
      subscription = true;
      return route.fulfill({
        json: { subscriptionId, status: "PENDING_ACTIVATION" },
      });
    }
    if (path === `/billing/subscriptions/${subscriptionId}/checkout`) {
      expect(route.request().postDataJSON()).toEqual({});
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      attempts++;
      if (attempts === 1 && options.failure === "transport")
        return route.abort("failed");
      if (attempts === 1 && options.failure === "api")
        return route.fulfill({
          status: 503,
          json: {
            code: "PAYMENTS_UNAVAILABLE",
            message: "Payment gateway unavailable",
          },
        });
      return route.fulfill({
        json: {
          paymentId: "local-payment",
          status: paymentStatus,
          checkoutAvailable: paymentStatus === "CREATED",
          checkoutUrl: options.url ?? checkoutUrl,
        },
      });
    }
    if (path === "/me/membership") {
      membershipReads++;
      return route.fulfill({
        json: {
          premium,
          subscription: subscription
            ? {
                id: subscriptionId,
                status: premium ? "ACTIVE" : "PENDING_ACTIVATION",
                plan_code: "ACOMPANAMIENTO_MONTHLY",
                version: 1,
              }
            : null,
          vehicles: [],
          vehicleLimit: premium ? 3 : 1,
          checkoutAvailable: true,
          benefits: [],
        },
      });
    }
    if (path === "/billing/payments")
      return route.fulfill({
        json: {
          items: attempts
            ? [
                {
                  id: "local-payment",
                  amount_minor: 2990000,
                  currency: "COP",
                  status: paymentStatus,
                  provider_environment: "SANDBOX",
                  created_at: "2026-10-13T10:00:00.000Z",
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    const responses: Record<string, unknown> = {
      "/me": { accountId: "qa-account", personId: "qa-person" },
      "/me/workspaces": [
        { id: "personal", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/me/profile": {
        version: 1,
        given_name: "QA",
        family_name: "Synthetic",
        display_name: "QA",
      },
      "/me/contact-methods": [],
      "/directory/organizations": { items: [], nextCursor: null },
      "/billing/plans": {
        items: Object.entries(CUSTOMER_PLANS.prices).map(([period, price]) => ({
          code: price.planCode,
          period,
          amount_minor: price.amountMinor,
          currency: price.currency,
          name: "MotorBaldi Premium",
          vehicle_limit: 3,
        })),
      },
      "/billing/payment-capabilities": {
        environment: "SANDBOX",
        checkoutAvailable: true,
        manualReconciliationAvailable: true,
        productionAvailable: false,
        recurringAvailable: false,
      },
    };
    return route.fulfill({
      status: Object.hasOwn(responses, path) ? 200 : 501,
      json: responses[path] ?? { code: "UNMOCKED_REQUEST" },
    });
  });
  await page.goto("http://127.0.0.1:4174" + (options.entry ?? ""));
  await expect(page.locator("body")).toHaveClass(/signed-in/);
  if (!options.entry) await page.locator('[data-panel="membership"]').click();
  await expect(page.locator("#membership-detail")).toContainText(
    "Acceso básico gratuito",
  );
  if (!options.create) await page.locator("#premium-select").click();
  return {
    attempts: () => attempts,
    membershipReads: () => membershipReads,
    selectedPlan: () => selectedPlan,
    approve: () => {
      premium = true;
      paymentStatus = "APPROVED";
    },
  };
}
const pay = (page: Page) =>
  page.getByRole("button", { name: "Pagar en Wompi (pruebas)", exact: true });

test("renders monthly/yearly prices and creates a pending plan before a fixed Sandbox checkout link", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await fixture(page, { create: true });
  await expect(page.locator("#premium-price")).toContainText("29.900");
  await page.getByRole("button", { name: "Anual", exact: true }).click();
  await expect(page.locator("#premium-price")).toContainText("288.000");
  await page.locator("#premium-select").click();
  await expect
    .poll(state.selectedPlan)
    .toEqual({ planCode: "ACOMPANAMIENTO_ANNUAL" });
  await expect(pay(page)).toBeVisible();
  await expect(page.locator("#membership-detail")).toContainText(
    "Wompi en modo de pruebas. No es un pago de producción.",
  );
  await pay(page).click();
  await expect(
    page.getByRole("link", { name: "Continuar a Wompi (pruebas)" }),
  ).toHaveAttribute("href", checkoutUrl);
  await expect(pay(page)).toBeDisabled();
  await expect(page.locator("#membership-detail")).toContainText(
    "Acceso básico gratuito",
  );
  expect(state.attempts()).toBe(1);
  await page.getByRole("button", { name: "Consultar estado del pago" }).click();
  await expect(
    page.getByRole("region", { name: "Historial de pagos" }),
  ).toContainText("Pago iniciado");
  expect(state.membershipReads()).toBeGreaterThan(1);
  await expect(page.locator("#membership-detail")).not.toContainText(
    "Acompañamiento activo",
  );
  await page
    .locator("#membership-management")
    .screenshot({ path: info.outputPath("synthetic-checkout-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator("#membership-management")
    .screenshot({ path: info.outputPath("synthetic-checkout-mobile.png") });
  state.approve();
  await page.getByRole("button", { name: "Consultar estado del pago" }).click();
  await expect(page.locator("#membership-detail")).toContainText(
    "Acompañamiento activo",
  );
  await expect(
    page.getByRole("region", { name: "Historial de pagos" }),
  ).toContainText("Pago confirmado");
});
for (const status of ["PENDING", "UNKNOWN", "DECLINED"])
  test(`${status} reservation never activates Premium or presents another checkout`, async ({
    page,
  }) => {
    await fixture(page, { checkoutStatus: status });
    await pay(page).click();
    await expect(page.locator("#notice")).toContainText(
      "Confirmación del pago pendiente",
    );
    await expect(pay(page)).toBeDisabled();
    await expect(
      page.getByRole("link", { name: /Continuar a Wompi/ }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Consultar estado del pago" })
      .click();
    await expect(page.locator("#membership-detail")).toContainText(
      "Acceso básico gratuito",
    );
    await expect(page.locator("#membership-detail")).not.toContainText(
      "Acompañamiento activo",
    );
  });
for (const failure of ["transport", "api"] as const)
  test(`${failure} failure re-enables the pay button for retry`, async ({
    page,
  }) => {
    const state = await fixture(page, { failure });
    await pay(page).click();
    await expect(page.locator("#notice")).not.toBeEmpty();
    await expect(pay(page)).toBeEnabled();
    await pay(page).click();
    await expect(
      page.getByRole("link", { name: "Continuar a Wompi (pruebas)" }),
    ).toHaveAttribute("href", checkoutUrl);
    await expect(pay(page)).toBeDisabled();
    expect(state.attempts()).toBe(2);
  });
for (const url of [
  "https://checkout.wompi.co.evil.invalid/p/",
  "https://checkout.wompi.co/p/#redirect",
  "javascript:alert(1)",
  "https://attacker@checkout.wompi.co/p/",
])
  test(`rejects malicious checkout URL ${url}`, async ({ page }) => {
    await fixture(page, { url });
    await pay(page).click();
    await expect(page.locator("#notice")).not.toBeEmpty();
    await expect(
      page.getByRole("link", { name: /Continuar a Wompi/ }),
    ).toHaveCount(0);
    await expect(pay(page)).toBeDisabled();
    await expect(page.locator("#membership-detail")).toContainText(
      "Acceso básico gratuito",
    );
  });

test("forged APPROVED provider return discards query claims and reads the unchanged server entitlement", async ({
  page,
}) => {
  const state = await fixture(page, {
    entry:
      "/payment-return?status=APPROVED&id=forged&reference=foreign-payment",
    checkoutStatus: "PENDING",
  });
  await expect(page).toHaveURL("http://127.0.0.1:4174/#premium");
  expect(state.membershipReads()).toBeGreaterThan(0);
  expect(state.attempts()).toBe(0);
  await expect(page.locator("#membership-detail")).toContainText(
    "Acceso básico gratuito",
  );
  await expect(page.locator("#membership-detail")).not.toContainText(
    "Acompañamiento activo",
  );
  await expect(
    page.getByRole("link", { name: /Continuar a Wompi/ }),
  ).toHaveCount(0);
});

test("an older status refresh cannot replace a newer saved cancellation", async ({
  page,
}) => {
  const controls = await fixture(page);
  controls.approve();
  await page.getByRole("button", { name: "Consultar estado del pago" }).click();
  await expect(page.locator("#membership-detail")).toContainText(
    "Acompañamiento activo",
  );
  let releaseOld!: () => void, oldStarted!: () => void;
  const waiting = new Promise<void>((resolve) => (oldStarted = resolve)),
    release = new Promise<void>((resolve) => (releaseOld = resolve));
  let reads = 0,
    cancelled = false;
  await page.route("**/api/v1/me/membership", async (route) => {
    const isOld = ++reads === 1;
    const snapshot = {
      premium: true,
      vehicleLimit: 3,
      vehicles: [],
      benefits: [],
      checkoutAvailable: true,
      subscription: {
        id: subscriptionId,
        status: "ACTIVE",
        plan_code: "ACOMPANAMIENTO_MONTHLY",
        version: cancelled ? 2 : 1,
        cancel_at_period_end: cancelled ? 1 : 0,
        current_period_end: "2099-12-13T10:00:00.000Z",
      },
    };
    if (isOld) {
      oldStarted();
      await release;
    }
    await route.fulfill({ json: snapshot });
  });
  await page.route(
    `**/api/v1/billing/subscriptions/${subscriptionId}/cancel`,
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ version: 1 });
      cancelled = true;
      await route.fulfill({
        json: { subscriptionId, cancelAtPeriodEnd: true, version: 2 },
      });
    },
  );
  await page.getByRole("button", { name: "Consultar estado del pago" }).click();
  await waiting;
  await page
    .getByRole("button", { name: "Cancelar renovación", exact: true })
    .click();
  await expect(page.locator("#membership-detail")).toContainText(
    "Cancelación programada.",
  );
  const lateResponse = page.waitForResponse(
    (r) => r.url().includes("/me/membership") && r.request().method() === "GET",
  );
  releaseOld();
  await (await lateResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("#membership-detail")).toContainText(
    "Cancelación programada.",
  );
  await expect(
    page.getByRole("button", { name: "Cancelar renovación", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Renovar en Wompi (pruebas)",
      exact: true,
    }),
  ).toHaveCount(0);
});
