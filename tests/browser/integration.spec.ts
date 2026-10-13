/** LOCAL real API/D1 coverage; no remote owner or human MFA assurance is claimed. */
import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";

test.use({ trace: "off", screenshot: "off", video: "off" });
const password = "Local-browser-QA-password-2026!";
const portal = "http://127.0.0.1:4184";
const admin = "http://127.0.0.1:4183";
function totp(secret: string) {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replaceAll("=", "")) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 15;
  return String(
    (((digest[offset]! & 127) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
      1000000,
  ).padStart(6, "0");
}
async function login(page: Page, base: string, email: string) {
  await page.goto(base);
  await page.locator("#login-form [name=email]").fill(email);
  await page.locator("#login-form [name=password]").fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/sign-in/email") &&
        response.request().method() === "POST",
    ),
    page.locator("#login-form button").click(),
  ]);
  expect(response.status()).toBe(200);
}
async function persisted(page: Page, url: string) {
  const response = await page.request.get(url);
  expect(response.status()).toBe(200);
  return response.json();
}

test("LOCAL real Portal profile/support persist and logout invalidates session replay", async ({
  page,
  context,
}) => {
  await login(page, portal, "local-portal@example.test");
  await expect(page.locator("#private")).toBeVisible();
  await expect(page.locator("#profile-form [name=givenName]")).toHaveValue(
    "LOCAL",
  );
  await page.locator("#profile-form [name=givenName]").fill("LOCAL Saved");
  await page.locator("#profile-form [name=familyName]").fill("Browser QA");
  await page
    .locator("#profile-form [name=displayName]")
    .fill("LOCAL persisted profile");
  await page.locator("#profile-form button").click();
  await expect(page.locator("#notice")).toHaveText("Cambios guardados.");
  expect(await persisted(page, portal + "/api/v1/me/profile")).toMatchObject({
    given_name: "LOCAL Saved",
    family_name: "Browser QA",
    display_name: "LOCAL persisted profile",
  });
  await page.reload();
  await expect(page.locator("#profile-form [name=givenName]")).toHaveValue(
    "LOCAL Saved",
  );
  await page.locator("[data-panel=support]").click();
  await page.getByText("Crear caso de soporte", { exact: true }).click();
  await page
    .locator("#support-create-form [name=purpose]")
    .selectOption("ACCOUNT");
  await page
    .locator("#support-create-form [name=subject]")
    .fill("LOCAL persisted support");
  await page
    .locator("#support-create-form [name=body]")
    .fill("LOCAL real browser saved support message.");
  let releaseSupport!: () => void;
  const supportPause = new Promise<void>((resolve) => {
    releaseSupport = resolve;
  });
  await page.route("**/api/v1/me/support-cases", async (route) => {
    if (route.request().method() === "POST") await supportPause;
    await route.continue();
  });
  await page.locator("#support-create-form button[type=submit]").click();
  await expect(
    page.locator("#support-create-form button[type=submit]"),
  ).toBeDisabled();
  await expect(page.locator("#support-upgrade")).toBeEnabled();
  releaseSupport();
  await expect(page.locator("#support-detail")).toContainText(
    "LOCAL real browser saved support message.",
  );
  const list = await persisted(page, portal + "/api/v1/me/support-cases");
  const saved = list.items.find(
    (item: { subject: string }) => item.subject === "LOCAL persisted support",
  );
  expect(Boolean(saved)).toBe(true);
  const detail = await persisted(
    page,
    portal + "/api/v1/me/support-cases/" + saved.caseId,
  );
  expect(
    detail.messages.some(
      (item: { body: string }) =>
        item.body === "LOCAL real browser saved support message.",
    ),
  ).toBe(true);
  const captured = await context.cookies(portal);
  const cookie = captured
    .map((item) => item.name + "=" + item.value)
    .join("; ");
  await page.locator("#logout").click();
  await expect(page.locator("#login")).toBeVisible();
  const replay = await page.request.get(portal + "/api/v1/me", {
    headers: { cookie },
  });
  expect(replay.status()).toBe(401);
});

test("LOCAL normal MFA enrollment and fresh Admin login persist CRM task completion", async ({
  page,
}) => {
  await login(page, portal, "local-admin@example.test");
  await expect(page.locator("#private")).toBeVisible();
  expect((await persisted(page, portal + "/api/v1/principal")).mfaEnabled).toBe(
    false,
  );
  const blocked = await page.request.get(portal + "/api/v1/admin/vehicles");
  expect(blocked.status()).toBe(403);
  const enrollment = await page.request.post(
    portal + "/api/v1/auth/two-factor/enable",
    { headers: { origin: portal }, data: { password, method: "totp" } },
  );
  expect(enrollment.status()).toBe(200);
  const body = await enrollment.json();
  const secret = new URL(body.totpURI).searchParams.get("secret");
  expect(Boolean(secret)).toBe(true);
  const confirmed = await page.request.post(
    portal + "/api/v1/auth/two-factor/verify-totp",
    {
      headers: { origin: portal },
      data: { code: totp(secret!), trustDevice: false },
    },
  );
  expect(confirmed.status()).toBe(200);
  const signedOut = await page.request.post(portal + "/api/v1/auth/sign-out", {
    headers: { origin: portal },
    data: {},
  });
  expect(signedOut.status()).toBe(200);
  await login(page, admin, "local-admin@example.test");
  await expect(page.locator("#mfa-form")).toBeVisible();
  // Avoid Playwright action logs containing a live MFA code on failure.
  await page.locator("#mfa-form [name=code]").evaluate((element, value) => {
    (element as HTMLInputElement).value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, totp(secret!));
  await page.locator("#mfa-form button").click();
  await expect(page.locator("#private")).toBeVisible();
  const principal = await persisted(page, admin + "/api/v1/principal");
  expect(principal.mfaEnabled).toBe(true);
  await page.locator("[data-panel=crm]").click();
  await expect(page.locator("#task-form")).toBeVisible();
  await page
    .locator("#task-form [name=ownerPersonId]")
    .fill(principal.personId);
  await page
    .locator("#task-form [name=description]")
    .fill("LOCAL persisted CRM task");
  await page.locator("#task-form button").click();
  await expect(page.locator("#notice")).toHaveText("Tarea creada.");
  await expect(page.locator("#crm-tasks")).toContainText(
    "LOCAL persisted CRM task",
  );
  const tasks = await persisted(page, admin + "/api/v1/admin/crm/tasks");
  const task = tasks.items.find(
    (item: { description: string }) =>
      item.description === "LOCAL persisted CRM task",
  );
  expect(task.status).toBe("OPEN");
  await page
    .locator("#crm-tasks")
    .getByRole("button", { name: "Marcar como completada" })
    .click();
  await expect(
    page
      .locator("#crm-tasks")
      .getByRole("button", { name: "Marcar como completada" }),
  ).toHaveCount(0);
  const completed = await persisted(page, admin + "/api/v1/admin/crm/tasks");
  expect(
    completed.items.find((item: { id: string }) => item.id === task.id),
  ).toMatchObject({ status: "COMPLETED", version: task.version + 1 });
});
