import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { CUSTOMER_PLANS } from "../../packages/shared/src/customer-plans.js";
for (const [width, height] of [
  [1440, 900],
  [1280, 800],
  [768, 1024],
  [390, 844],
] as const) {
  test(`Premium comparison and genuine pending request ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    let requested: unknown = null;
    let pending = false;
    const paths: Record<string, unknown> = {
      "/me": { personId: "qa-person", accountId: "qa-account" },
      "/me/workspaces": [
        { id: "personal", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/directory/organizations": { items: [] },
      "/me/profile": {
        version: 1,
        given_name: "Ana",
        family_name: "QA",
        display_name: "Ana QA",
      },
      "/me/contact-methods": [],
      "/billing/plans": {
        items: Object.entries(CUSTOMER_PLANS.prices).map(([period, p]) => ({
          code: p.planCode,
          period,
          amount_minor: p.amountMinor,
          currency: p.currency,
          name: "MotorBaldi Premium",
          vehicle_limit: 3,
        })),
      },
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1",
        "",
      );
      if (
        path === "/billing/subscriptions" &&
        route.request().method() === "POST"
      ) {
        requested = route.request().postDataJSON();
        pending = true;
        return route.fulfill({
          json: { id: "qa-subscription", status: "PENDING_ACTIVATION" },
        });
      }
      if (path === "/me/membership")
        return route.fulfill({
          json: {
            premium: false,
            subscription: pending
              ? {
                  id: "qa-subscription",
                  status: "PENDING_ACTIVATION",
                  plan_code: "ACOMPANAMIENTO_ANNUAL",
                  version: 1,
                }
              : null,
            vehicles: [],
            vehicleLimit: 1,
            checkoutAvailable: false,
            benefits: [],
          },
        });
      return route.fulfill({
        status: Object.hasOwn(paths, path) ? 200 : 501,
        json: paths[path] ?? { code: "UNMOCKED_REQUEST" },
      });
    });
    await page.goto("http://127.0.0.1:4174");
    await expect(page.locator("body")).toHaveClass(/signed-in/);
    if (width <= 768) await page.locator("#nav-toggle").click();
    await page.locator('[data-panel="membership"]').click();
    await expect(page.locator("#membership-title")).toHaveText(
      "Tu vehículo tiene quien esté pendiente de él.",
    );
    await expect(page.locator("#premium-price")).toContainText("29.900");
    await page.getByRole("button", { name: "Anual", exact: true }).click();
    await expect(page.locator("#premium-price")).toContainText("288.000");
    await expect(page.locator('[data-period="ANNUAL"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#premium-features")).toContainText(
      "Ilimitadas, sin cuota mensual",
    );
    await expect(page.locator(".premium-category")).toHaveCount(8);
    await expect(page.locator("#premium-faq-list details")).toHaveCount(11);
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
    await page.screenshot({
      path: info.outputPath(`synthetic-premium-${width}.png`),
      fullPage: true,
    });
    await page.locator("#premium-select").click();
    await expect
      .poll(() => requested)
      .toEqual({ planCode: "ACOMPANAMIENTO_ANNUAL" });
    await expect(page.locator("#notice")).toContainText(
      "No se realizó ningún cobro",
    );
    await expect(page.locator("#premium-select")).toHaveText(
      "Administrar mi plan",
    );
  });
}
