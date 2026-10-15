import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const phoneId = "00000000-0000-4000-8000-000000000002";
const message = "MotorBaldi " + "a".repeat(64);
async function setup(page: Page, available: boolean, pending = false) {
  const state = { posts: 0, verified: false, release: () => {} };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/me/phone-verification/challenges") {
      state.posts++;
      expect(route.request().postDataJSON()).toEqual({
        contactMethodId: phoneId,
      });
      if (pending) await gate;
      return route.fulfill({
        json: {
          message,
          destination: "+573001234567",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
    }
    const routes: Record<string, unknown> = {
      "/me": { accountId: "synthetic-account", personId: "synthetic-person" },
      "/me/workspaces": [
        { id: "personal", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/me/profile": { given_name: "Ana", family_name: "García", version: 1 },
      "/me/contact-methods": [
        {
          id: phoneId,
          type: "PHONE",
          raw_value: "+573000000000",
          verification_status: state.verified ? "VERIFIED" : "UNVERIFIED",
        },
      ],
      "/me/phone-verification/capability": { available },
      "/directory/organizations": { items: [], nextCursor: null },
      "/public/parts": { items: [], nextCursor: null },
      "/auth/capabilities": {
        registrationAvailable: false,
        recoveryAvailable: false,
      },
      "/auth/sign-out": { success: true },
    };
    return route.fulfill({ json: routes[path] ?? {} });
  });
  await page.goto("http://127.0.0.1:4174");
  await expect(page.locator("#contacts")).toContainText("Sin verificar");
  return state;
}

test("unavailable phone proof explains that adding a phone does not verify it", async ({
  page,
}) => {
  await setup(page, false);
  await expect(page.locator("#contacts")).toContainText(
    "Agregar un teléfono no lo verifica",
  );
  await expect(page.locator("#contacts")).toContainText("no está disponible");
  await expect(
    page.getByRole("button", { name: "Verificar con WhatsApp", exact: true }),
  ).toHaveCount(0);
});

test("manual proof displays exact message locally and refreshes verified status", async ({
  page,
}) => {
  const state = await setup(page, true);
  await page
    .getByRole("button", { name: "Verificar con WhatsApp", exact: true })
    .click();
  await expect(page.locator("#contacts pre")).toHaveText(message);
  await expect(page.locator("#contacts")).toContainText("+573001234567");
  await expect(page.locator("#contacts")).toContainText(
    "no autoriza notificaciones",
  );
  expect(page.url()).not.toContain("a".repeat(64));
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain(message);
  state.verified = true;
  await page
    .getByRole("button", { name: "Actualizar estado del teléfono" })
    .click();
  await expect(page.locator("#contacts")).toContainText("Verificado");
  await expect(page.locator("#contacts pre")).toHaveCount(0);
});

test("pending proof prevents duplicate requests and discards a stale refreshed response", async ({
  page,
}) => {
  const state = await setup(page, true, true);
  const verify = page.getByRole("button", {
    name: "Verificar con WhatsApp",
    exact: true,
  });
  await verify.click();
  await expect(verify).toBeDisabled();
  await expect.poll(() => state.posts).toBe(1);
  await page
    .getByRole("button", { name: "Actualizar estado del teléfono" })
    .click();
  state.release();
  await expect(page.locator("#contacts pre")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Verificar con WhatsApp", exact: true }),
  ).toBeEnabled();
  expect(state.posts).toBe(1);
});

test("manual phone proof stays accessible and contained across supported viewports", async ({
  page,
}, testInfo) => {
  await setup(page, true);
  await page
    .getByRole("button", { name: "Verificar con WhatsApp", exact: true })
    .click();
  await expect(page.locator("#contacts pre")).toHaveText(message);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.screenshot({
      path: testInfo.outputPath(
        "synthetic-phone-proof-" + viewport.width + ".png",
      ),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  }
});

for (const action of ["logout", "expired"] as const) {
  test(
    "clears plaintext phone proof immediately on " + action,
    async ({ page }) => {
      await setup(page, true);
      await page
        .getByRole("button", { name: "Verificar con WhatsApp", exact: true })
        .click();
      await expect(page.locator("#contacts pre")).toHaveText(message);
      // Keep the current document alive to inspect cleanup before redirect completes.
      await page.route("http://127.0.0.1:4174/", (route) => route.abort());
      if (action === "logout") {
        await page.route("**/api/v1/auth/sign-out", (route) =>
          route.fulfill({ status: 500, json: {} }),
        );
        await page.evaluate(() => document.getElementById("logout")!.click());
      } else {
        await page.route("**/api/v1/me/profile", (route) =>
          route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } }),
        );
        await page.evaluate("api('/me/profile').catch(()=>{})");
      }
      await expect(page.locator("#contacts pre")).toHaveCount(0);
      expect(await page.locator("body").textContent()).not.toContain(message);
    },
  );
}
