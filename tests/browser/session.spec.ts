import { test, expect, type Page } from "@playwright/test";

async function session(page: Page, mode: "admin" | "portal", fail = false) {
  let active = true;
  let signouts = 0;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/auth/sign-out")) {
      signouts++;
      if (fail)
        return route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } });
      // Match the real deployed Better Auth media-type requirement.
      if (!req.headers()["content-type"]?.includes("application/json"))
        return route.fulfill({
          status: 415,
          json: { code: "UNSUPPORTED_MEDIA_TYPE" },
        });
      expect(req.postDataJSON()).toEqual({});
      active = false;
      return route.fulfill({ json: { success: true } });
    }
    if (path === "/api/v1/me/profile" && req.method() === "PATCH")
      active = false;
    if (path.endsWith("/auth/get-session"))
      return route.fulfill({
        json: active ? { session: { id: "synthetic" } } : null,
      });
    if (!active)
      return route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } });
    const data: Record<string, unknown> = {
      "/api/v1/admin/access": { permissions: ["platform.people.read"] },
      "/api/v1/admin/people": {
        items: [
          {
            id: "qa-person",
            display_name: "Persona privada QA",
            status: "ACTIVE",
          },
        ],
        nextCursor: null,
      },
      "/api/v1/me": { accountId: "qa-account", personId: "qa-person" },
      "/api/v1/me/profile": {
        given_name: "Persona privada QA",
        family_name: "Prueba",
        version: 1,
      },
      "/api/v1/auth/capabilities": {
        registrationAvailable: false,
        recoveryAvailable: false,
      },
      "/api/v1/me/contact-methods": [],
      "/api/v1/me/workspaces": [
        { id: "PERSONAL", type: "PERSONAL", name: "Mi espacio" },
      ],
      "/api/v1/directory/organizations": { items: [], nextCursor: null },
      "/api/v1/public/parts": { items: [], nextCursor: null },
    };
    if (!(path in data)) throw new Error("Unmocked session request " + path);
    return route.fulfill({ json: data[path] });
  });
  await page.goto(`http://127.0.0.1:${mode === "admin" ? 4173 : 4174}`);
  await expect(page.locator("#private")).toBeVisible();
  return () => signouts;
}
for (const mode of ["admin", "portal"] as const) {
  test(`${mode} logout sends canonical JSON and does not restore private content on reload/back`, async ({
    page,
  }) => {
    const count = await session(page, mode);
    await page.locator("#logout").click();
    await expect(page.locator("#login")).toBeVisible();
    await expect(page.locator("#private")).toBeHidden();
    expect(count()).toBe(1);
    await page.reload();
    await expect(page.locator("#private")).toBeHidden();
    await page.goto(
      `http://127.0.0.1:${mode === "admin" ? 4173 : 4174}/qa-history`,
    );
    await page.goBack();
    await expect(page.locator("#private")).toBeHidden();
    await expect(
      page.getByText("Persona privada QA", { exact: true }),
    ).toHaveCount(0);
  });
  test(`${mode} failed logout retains session and reports failure`, async ({
    page,
  }) => {
    const count = await session(page, mode, true);
    await page.locator("#logout").click();
    await expect(page.locator("#notice")).toContainText(
      "No fue posible cerrar",
    );
    await expect(page.locator("#private")).toBeVisible();
    expect(count()).toBe(1);
    await expect(page.locator("#logout")).toBeEnabled();
  });
}

test("Portal expired session returns to login and cannot retain protected workspace", async ({
  page,
}) => {
  await session(page, "portal");
  await page.locator("#profile-form button").click();
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#private")).toBeHidden();
  await page.reload();
  await expect(page.locator("#private")).toBeHidden();
});
