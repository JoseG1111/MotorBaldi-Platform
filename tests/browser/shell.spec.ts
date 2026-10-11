import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const people = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    given_name: "Ana",
    family_name: "García",
    display_name: "Ana García",
    country_code: "CO",
    status: "ACTIVE",
    account_status: "ACTIVE",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    given_name: "Carlos",
    family_name: "Mendoza",
    display_name: "Carlos Mendoza",
    country_code: "CO",
    status: "PROVISIONAL",
    account_status: null,
  },
];

async function fixtures(page: Page, mode: "admin" | "portal") {
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const responses: Record<string, unknown> =
    mode === "admin"
      ? {
          "/api/v1/admin/access": {
            permissions: [
              "platform.people.read",
              "platform.organization.read",
              "platform.crm.read",
              "platform.vehicle.read",
              "platform.billing.read",
              "platform.commission.read",
              "platform.support.read",
            ],
          },
          "/api/v1/admin/people": { items: people, nextCursor: null },
        }
      : {
          "/api/v1/me": {
            accountId: "synthetic-account",
            personId: people[0]!.id,
          },
          "/api/v1/me/workspaces": [
            { id: "PERSONAL", type: "PERSONAL", name: "Mi espacio personal" },
          ],
          "/api/v1/directory/organizations": { items: [], nextCursor: null },
          "/api/v1/me/profile": {
            given_name: "Ana",
            family_name: "García",
            display_name: "Ana García",
            version: 1,
          },
          "/api/v1/me/contact-methods": [
            {
              id: "synthetic-contact",
              type: "EMAIL",
              raw_value: "ana@example.test",
              verification_status: "VERIFIED",
            },
          ],
          "/api/v1/public/parts": { items: [], nextCursor: null },
        };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      !Object.hasOwn(responses, url.pathname) ||
      route.request().method() !== "GET"
    ) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      await route.fulfill({
        status: 501,
        json: { code: "UNMOCKED_BROWSER_QA_REQUEST" },
      });
      return;
    }
    await route.fulfill({ json: responses[url.pathname] });
  });
  return { unexpected, errors };
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  for (const mode of ["admin", "portal"] as const) {
    test(`synthetic ${mode} shell ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const evidence = await fixtures(page, mode);
      await page.goto(`http://127.0.0.1:${mode === "admin" ? 4173 : 4174}`);
      await expect(page.locator("body")).toHaveClass(/signed-in/);
      await expect(
        page.locator(mode === "admin" ? "#people-list" : "#contacts"),
      ).toContainText(mode === "admin" ? "Ana García" : "ana@example.test");
      await expect(page.locator("#workspace-title")).toHaveText(
        mode === "admin" ? "Personas" : "Mi cuenta",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`synthetic-${mode}-${viewport.width}.png`),
        fullPage: true,
      });
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(
        results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      ).toEqual([]);
      const toggle = page.locator("#nav-toggle");
      await toggle.focus();
      await page.keyboard.press("Enter");
      if (viewport.width <= 768) {
        await expect(page.locator("body")).toHaveClass(/nav-open/);
        await expect(
          page.locator("#app-navigation button[data-panel]").first(),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(toggle).toBeFocused();
        await expect(page.locator("body")).not.toHaveClass(/nav-open/);
      } else {
        await expect(page.locator("body")).toHaveClass(/nav-collapsed/);
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
      }
      expect(evidence.unexpected).toEqual([]);
      expect(evidence.errors).toEqual([]);
    });
  }
}
