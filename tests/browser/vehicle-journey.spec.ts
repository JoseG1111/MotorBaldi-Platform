import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

/** Real LOCAL API/D1/password session; never captures credentials or production data. */
test("LOCAL Free customer vehicle and expiry persist, limits reject, pending upgrade grants no benefits", async ({
  page,
}, info) => {
  const base = "http://127.0.0.1:4184";
  await page.goto(base);
  await page
    .locator("#login-form [name=email]")
    .fill("local-portal@example.test");
  await page
    .locator("#login-form [name=password]")
    .fill("Local-browser-QA-password-2026!");
  await page.locator("#login-form button").click();
  await expect(page.locator("#private")).toBeVisible();
  await page.locator('#app-navigation [data-panel="vehicle-services"]').click();
  const registration = page.locator("#customer-vehicle-register");
  await page.getByText("Registrar un vehículo", { exact: true }).click();
  await registration.locator('[name="make"]').fill("Marca QA");
  await registration.locator('[name="model"]').fill("Vehículo sintético");
  await registration.locator('[name="plate"]').fill("QA123");
  const [registrationResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/me/vehicles") &&
        response.request().method() === "POST",
    ),
    registration.locator("button").click(),
  ]);
  expect(registrationResponse.status()).toBe(200);
  const vehicleButton = page.locator("#customer-vehicle-list button").first();
  await expect(vehicleButton).toContainText("Marca QA");
  await vehicleButton.click();
  const soat = page
    .locator("#customer-vehicle-services section")
    .filter({ has: page.getByRole("heading", { name: "SOAT", exact: true }) });
  await soat.locator('[name="expiresOn"]').fill("2027-06-15");
  await soat.locator('[name="provider"]').fill("Proveedor declarado QA");
  await soat.getByRole("button", { name: "Guardar fecha" }).click();
  await expect(soat).toContainText("2027-06-15");
  await expect(soat).toContainText("Declarado por el usuario");
  const manual = page.locator("#customer-vehicle-services section").filter({
    has: page.getByRole("heading", {
      name: "Historial manual de mantenimiento",
      exact: true,
    }),
  });
  await manual.locator('[name="performedOn"]').fill("2026-10-10");
  await manual.locator('[name="title"]').fill("Cambio de aceite QA");
  await manual.locator('[name="mileage"]').fill("54321");
  await manual.getByRole("button", { name: "Registrar mantenimiento" }).click();
  await expect(manual).toContainText("Cambio de aceite QA");
  const vehiclesResponse = await page.request.get(base + "/api/v1/me/vehicles");
  expect(vehiclesResponse.status()).toBe(200);
  const { items } = await vehiclesResponse.json();
  expect(items).toHaveLength(1);
  const persisted = await page.request.get(
    base + "/api/v1/vehicles/" + items[0].id + "/services",
  );
  const persistedServices = await persisted.json();
  expect(persistedServices.maintenance[0]).toMatchObject({
    title: "Cambio de aceite QA",
    mileage: 54321,
  });
  expect(persistedServices.monthlySummary).toBeNull();
  expect(persistedServices.compliance[0]).toMatchObject({
    expires_on: "2027-06-15",
    verification_status: "USER_ENTERED",
    information_source: "USER_ENTERED",
  });
  const extra = await page.request.post(base + "/api/v1/me/vehicles", {
    headers: { "Idempotency-Key": crypto.randomUUID(), Origin: base },
    data: { kindCode: "CAR", specification: { make: "Extra", model: "QA" } },
  });
  expect(extra.status()).toBe(403);
  expect((await extra.json()).code).toBe("VEHICLE_PLAN_LIMIT");
  const technical = await page.request.post(base + "/api/v1/me/support-cases", {
    headers: { "Idempotency-Key": crypto.randomUUID(), Origin: base },
    data: {
      purpose: "TECHNICAL",
      subject: "Synthetic technical QA",
      body: "Synthetic technical support request",
    },
  });
  expect(technical.status()).toBe(403);
  expect((await technical.json()).code).toBe("PREMIUM_REQUIRED");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.reload();
  await expect(page.locator("#private")).toBeVisible();
  await page.locator('#app-navigation [data-panel="vehicle-services"]').click();
  const [reloadedServices] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith("/api/v1/vehicles/" + items[0].id + "/services") &&
        response.request().method() === "GET",
    ),
    page.locator("#customer-vehicle-list button").first().click(),
  ]);
  expect(reloadedServices.status()).toBe(200);
  expect((await reloadedServices.json()).compliance[0].expires_on).toBe(
    "2027-06-15",
  );
  await expect(page.locator("#customer-vehicle-services")).toContainText(
    "2027-06-15",
  );
  await page.locator('#app-navigation [data-panel="membership"]').click();
  await page.locator("#premium-select").click();
  await expect(page.locator("#notice")).toContainText(
    "No se realizó ningún cobro",
  );
  const membership = await page.request.get(base + "/api/v1/me/membership");
  expect(await membership.json()).toMatchObject({
    premium: false,
    vehicleLimit: 1,
    subscription: { status: "PENDING_ACTIVATION" },
  });
  await info.attach("verification", {
    body: "Real LOCAL customer password/API/D1 readback, no external payment or human Development MFA claim",
    contentType: "text/plain",
  });
});

test.use({ trace: "off", screenshot: "off", video: "off" });
