import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function mockAuth(
  page: Page,
  capabilities: unknown = {
    registrationAvailable: true,
    recoveryAvailable: true,
  },
) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/capabilities")
      return route.fulfill({ json: capabilities });
    if (path.startsWith("/api/v1/public/parts"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.startsWith("/api/v1/auth/"))
      return route.fulfill({ json: { status: true } });
    return route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } });
  });
}

test("remote signup and recovery use configured capabilities and fixed callbacks on mobile", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuth(page);
  await page.goto("http://127.0.0.1:4174/login");
  const signup = page.locator("#signup-form");
  await expect(signup).toBeVisible();
  await signup.locator('[name="name"]').fill("Synthetic Owner");
  await signup.locator('[name="email"]').fill("owner@example.test");
  await signup.locator('[name="password"]').fill("synthetic-password-123456");
  await signup.locator('[name="termsAccepted"]').check();
  await signup.locator('[name="privacyAccepted"]').check();
  const submitted = page.waitForRequest("**/api/v1/auth/sign-up/email");
  await signup.getByRole("button", { name: "Crear cuenta" }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    callbackURL: "http://127.0.0.1:4174/login",
    termsAccepted: true,
    privacyAccepted: true,
  });
  await expect(page.locator("#notice")).toHaveText(
    "Solicitud recibida. Revisa tu correo para continuar con la verificación.",
  );
  await page.getByText("Olvidé mi contraseña", { exact: true }).click();
  await page
    .locator('#recovery-form [name="email"]')
    .fill("missing@example.test");
  const recovery = page.waitForRequest("**/api/v1/auth/request-password-reset");
  await page.locator("#recovery-form").getByRole("button").click();
  expect((await recovery).postDataJSON()).toEqual({
    email: "missing@example.test",
    redirectTo: "http://127.0.0.1:4174/reset-password",
  });
  await expect(page.locator("#notice")).toHaveText(
    "Si existe una cuenta con ese correo, recibirás un enlace para restablecer tu contraseña.",
  );
  await page
    .getByText("Reenviar verificación de correo", { exact: true })
    .click();
  await page
    .locator('#verification-resend-form [name="email"]')
    .fill("unverified@example.test");
  const verification = page.waitForRequest(
    "**/api/v1/auth/send-verification-email",
  );
  await page.locator("#verification-resend-form").getByRole("button").click();
  expect((await verification).postDataJSON()).toEqual({
    email: "unverified@example.test",
    callbackURL: "http://127.0.0.1:4174/login",
  });
  await expect(page.locator("#notice")).toHaveText(
    "Si tu cuenta necesita verificación, recibirás un enlace para confirmar tu correo.",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .locator("#login")
    .screenshot({ path: info.outputPath("synthetic-auth-mobile.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("reset validates confirmation, keeps token ephemeral, clears sensitive fields and returns to login", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuth(page);
  const calls: unknown[] = [];
  await page.route("**/api/v1/auth/reset-password", async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: true } });
  });
  await page.goto(
    "http://127.0.0.1:4174/reset-password?token=synthetic-reset-token-123456789",
  );
  await expect(page).toHaveURL("http://127.0.0.1:4174/reset-password");
  await expect(page.locator("#accept-invitation")).toBeHidden();
  await expect(page.locator("#signup-section")).toBeHidden();
  const form = page.locator("#reset-form");
  await form
    .locator('[name="newPassword"]')
    .fill("synthetic-new-password-123456");
  await form
    .locator('[name="confirmPassword"]')
    .fill("synthetic-other-password-123456");
  await form.getByRole("button").click();
  await expect(page.locator("#notice")).toHaveText(
    "Las contraseñas deben coincidir.",
  );
  expect(calls).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await form
    .locator('[name="confirmPassword"]')
    .fill("synthetic-new-password-123456");
  await form.getByRole("button").click();
  await expect(page.locator("#notice")).toHaveText(
    "Contraseña actualizada. Inicia sesión con tu nueva contraseña.",
  );
  expect(calls).toEqual([
    {
      token: "synthetic-reset-token-123456789",
      newPassword: "synthetic-new-password-123456",
    },
  ]);
  await expect(page).toHaveURL("http://127.0.0.1:4174/login");
  await expect(form.locator('[name="newPassword"]')).toHaveValue("");
  await expect(form.locator('[name="confirmPassword"]')).toHaveValue("");
  await expect(page.locator("#login-form")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).length + Object.keys(localStorage).length,
    ),
  ).toBe(0);
});

test("disabled or malformed remote capabilities keep onboarding unavailable", async ({
  page,
}) => {
  for (const capabilities of [
    { registrationAvailable: false, recoveryAvailable: false },
    { registrationAvailable: "true", recoveryAvailable: true },
  ]) {
    await mockAuth(page, capabilities);
    await page.goto("http://127.0.0.1:4174/login");
    await expect(page.locator("#signup-section")).toBeHidden();
    await expect(page.locator("#recovery-section")).toBeHidden();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("invalid or expired reset links expose a generic recovery message", async ({
  page,
}) => {
  await mockAuth(page);
  await page.goto("http://127.0.0.1:4174/reset-password?token=bad");
  await expect(page.locator("#reset-form")).toBeHidden();
  await expect(page.locator("#notice")).toHaveText(
    "Este enlace no es válido o ya venció. Solicita un nuevo enlace de recuperación.",
  );
  await page.route("**/api/v1/auth/reset-password", async (route) => {
    await route.fulfill({
      status: 400,
      json: {
        code: "INVALID_TOKEN",
        private: "synthetic-private-provider-body",
      },
    });
  });
  await page.goto(
    "http://127.0.0.1:4174/reset-password?token=synthetic-expired-token-123456789",
  );
  await page
    .locator('#reset-form [name="newPassword"]')
    .fill("synthetic-new-password-123456");
  await page
    .locator('#reset-form [name="confirmPassword"]')
    .fill("synthetic-new-password-123456");
  await page.locator("#reset-form").getByRole("button").click();
  await expect(page.locator("#notice")).toHaveText(
    "No fue posible restablecer la contraseña. El enlace puede haber vencido o ya haberse usado. Solicita uno nuevo.",
  );
  await expect(page.locator("body")).not.toContainText(
    "synthetic-private-provider-body",
  );
  await expect(page).toHaveURL("http://127.0.0.1:4174/reset-password");
});
