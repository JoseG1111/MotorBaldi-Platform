import { test, expect } from "@playwright/test";
import {
  generateKeyPairSync,
  privateDecrypt,
  createDecipheriv,
  constants,
} from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
test.beforeEach(async ({ page }) => {
  await page.route("**/api/wompi-checkout.php", (route) => {
    const { vehicle, plan } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        publicKey: "pub_test_local",
        checkoutId: "a".repeat(64),
        currency: "COP",
        amountInCents: {
          moto: { anual: 28800000, mensual: 2990000 },
          car: { anual: 95900000, mensual: 9990000 },
        }[vehicle][plan],
        reference: `REF-${vehicle.toUpperCase()}-${plan.toUpperCase()}-${"b".repeat(32)}`,
        acceptanceUrl: "https://wompi.co/terms.pdf",
        personalDataUrl: "https://wompi.co/personal.pdf",
      },
    });
  });
});
async function customer(page) {
  await page.goto("/precios");
  await page.locator(".plan-cta").last().click();
  await expect(page.locator("#payment-continue")).toBeEnabled();
  await page.locator("#subscription-name").fill("María O’Neill");
  await page.locator("#subscription-email").fill("cliente@example.com");
  await page.locator("#subscription-consent").check();
}
async function card(page) {
  await page.locator("#card-number").fill("4242 4242 4242 4242");
  await page.locator("#card-expiry").fill("12/39");
  await page.locator("#card-cvc").fill("123");
  await page.locator("#card-holder").fill("María O’Neill");
}
test("tarjeta cifra JWE y solo envía token y datos permitidos al backend", async ({
  page,
}) => {
  let encrypted = false;
  await page.route(
    "**/api/wompi-tokenization-key.php",
    (r) =>
      r.fulfill({
        json: {
          data: {
            publicKey: publicKey.export({ type: "spki", format: "pem" }),
          },
        },
      }),
  );
  await page.route(
    "https://api-sandbox.wompi.co/v1/tokens/cards",
    async (route) => {
      const body = route.request().postDataJSON();
      expect(Object.keys(body)).toEqual(["payload"]);
      const [header, wrapped, iv, ciphertext, tag] = body.payload.split(".");
      expect(JSON.parse(Buffer.from(header, "base64url"))).toEqual({
        alg: "RSA-OAEP-256",
        enc: "A256GCM",
      });
      const cek = privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(wrapped, "base64url"),
      );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        cek,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(header));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const plain = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]),
      );
      expect(plain).toEqual({
        number: "4242424242424242",
        cvc: "123",
        exp_month: "12",
        exp_year: "39",
        card_holder: "María O’Neill",
      });
      encrypted = true;
      await route.fulfill({
        json: { status: "CREATED", data: { id: "tok_test_safe" } },
      });
    },
  );
  await page.route("**/api/wompi-subscribe.php", (r) =>
    r.fulfill({ body: "Solicitud recibida" }),
  );
  await customer(page);
  await card(page);
  const sent = page.waitForRequest("**/api/wompi-subscribe.php");
  await page.locator("#payment-continue").click();
  const fields = new URLSearchParams((await sent).postData());
  expect(encrypted).toBe(true);
  expect([...fields.keys()].sort()).toEqual(
    [
      "vehicle",
      "plan",
      "checkout_id",
      "full_name",
      "email",
      "accept_all",
      "payment_source_token",
      "payment_source_type",
    ].sort(),
  );
  expect(fields.get("payment_source_token")).toBe("tok_test_safe");
  expect(fields.get("payment_source_type")).toBe("CARD");
  expect(fields.get("accept_all")).toBe("1");
});
test("Nequi espera APPROVED antes de enviar el token", async ({ page }) => {
  let polls = 0,
    posts = 0;
  await page.route("https://api-sandbox.wompi.co/v1/tokens/nequi", (r) => {
    posts++;
    return r.fulfill({
      json: { data: { id: "nequi_test_safe", status: "PENDING" } },
    });
  });
  await page.route(
    "https://api-sandbox.wompi.co/v1/tokens/nequi/nequi_test_safe",
    (r) => {
      polls++;
      return r.fulfill({
        json: {
          data: {
            id: "nequi_test_safe",
            status: polls > 1 ? "APPROVED" : "PENDING",
          },
        },
      });
    },
  );
  await page.route("**/api/wompi-subscribe.php", (r) =>
    r.fulfill({ body: "Solicitud recibida" }),
  );
  await customer(page);
  await page.locator('[data-payment-method="NEQUI"]').click();
  await page.locator("#nequi-phone").fill("3001234567");
  const sent = page.waitForRequest("**/api/wompi-subscribe.php");
  await page.locator("#payment-continue").click();
  await expect(page.locator("#subscription-status")).toContainText(
    "Abre Nequi",
  );
  await expect(page.locator("#payment-continue")).toBeDisabled();
  expect(
    new URLSearchParams((await sent).postData()).get("payment_source_type"),
  ).toBe("NEQUI");
  expect(polls).toBe(2);
  expect(posts).toBe(1);
});
test("rechazo Nequi no llega al backend y cerrar detiene la espera", async ({
  page,
}) => {
  let sent = 0;
  await page.route("**/api/wompi-subscribe.php", (r) => {
    sent++;
    return r.abort();
  });
  await page.route("https://api-sandbox.wompi.co/v1/tokens/nequi", (r) =>
    r.fulfill({
      json: { data: { id: "nequi_test_safe", status: "DECLINED" } },
    }),
  );
  await customer(page);
  await page.locator('[data-payment-method="NEQUI"]').click();
  await page.locator("#nequi-phone").fill("3001234567");
  await page.locator("#payment-continue").click();
  await expect(page.locator("#subscription-status")).toContainText(
    "no fue aprobada",
  );
  expect(sent).toBe(0);
  await page.route("https://api-sandbox.wompi.co/v1/tokens/nequi", (r) =>
    r.fulfill({ json: { data: { id: "nequi_test_safe", status: "PENDING" } } }),
  );
  await page.locator("#payment-continue").click();
  await expect(page.locator("#subscription-status")).toContainText(
    "Abre Nequi",
  );
  await page.locator("#subscription-close").click();
  await expect(page.locator("#subscription-dialog")).not.toBeVisible();
  expect(sent).toBe(0);
});
test("errores junto al campo y consentimiento obligatorio", async ({
  page,
}) => {
  await page.goto("/precios");
  await page.locator(".plan-cta").first().click();
  await expect(page.locator("#payment-continue")).toBeEnabled();
  await page.locator("#payment-continue").click();
  await expect(page.locator("#subscription-name")).toBeFocused();
  await expect(page.locator("#subscription-consent-error")).not.toBeEmpty();
  await page.locator("#subscription-name").fill("correo@example.com");
  await page.locator("#subscription-name").blur();
  await expect(page.locator("#subscription-name-error")).toContainText(
    "no un correo",
  );
  await customer(page);
  await page.locator("#payment-continue").click();
  await expect(page.locator("#card-number")).toBeFocused();
  await expect(page.locator("#card-number-error")).not.toBeEmpty();
});

test("cada plan solicita el vehículo y período correctos", async ({ page }) => {
  await page.goto("/precios");
  await expect(page.locator('[data-vehicle="moto"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".plan-cta")).toHaveCount(2);
  await expect(page.locator(".price")).toHaveText(["$288.000", "$29.900"]);
  for (const vehicle of ["car", "moto"]) {
    await page.locator(`[data-vehicle="${vehicle}"]`).click();
    for (const [index, plan] of ["anual", "mensual"].entries()) {
      const request = page.waitForRequest("**/api/wompi-checkout.php");
      const response = page.waitForResponse("**/api/wompi-checkout.php");
      await page.locator(".plan-cta").nth(index).click();
      expect((await request).postDataJSON()).toEqual({ vehicle, plan });
      const data = await (await response).json();
      const expected = data.amountInCents / 100;
      await expect(page.locator("#subscription-first-charge")).toHaveText(
        `$${new Intl.NumberFormat("es-CO").format(expected)} COP`,
      );
      await expect(page.locator("#payment-continue")).toBeVisible();
      await page.locator("#subscription-close").click();
    }
  }
});

test("el modal conserva precio y CTA accesibles en móvil y tablet", async ({
  page,
}) => {
  for (const viewport of [
    { width: 320, height: 740 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/precios");
    await page.locator(".plan-cta").first().click();
    const panel = page.locator(".subscription-panel");
    await expect(page.locator("#subscription-price")).toHaveText(
      /\$288\.000 COP/,
    );
    await page.locator("#payment-continue").scrollIntoViewIfNeeded();
    await expect(page.locator("#payment-continue")).toBeVisible();
    const dimensions = await panel.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    await page.locator("#subscription-close").click();
  }
});

test("URLs antiguas redirigen y conservan query y ancla", async ({
  page,
  request,
}) => {
  for (const [oldPath, newPath] of [
    ["index.html", "/"],
    ["pricing.html", "/precios"],
    ["terminos.html", "/terminos"],
    ["politica-de-privacidad.html", "/politica-de-privacidad"],
  ]) {
    const response = await request.get(`/${oldPath}?origen=test`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe(`${newPath}?origen=test`);
    expect((await request.get(newPath)).status()).toBe(200);
  }
  await page.goto("/index.html#contacto");
  await expect(page).toHaveURL(/\/#contacto$/);
  await page.goto("/precios");
  await expect(page.locator('a[href*=".html"]')).toHaveCount(0);
});

test("un servidor no disponible explica el error sin abrir el cobro", async ({
  page,
}) => {
  await page.route("**/api/wompi-checkout.php", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Pagos temporalmente no disponibles." },
    }),
  );
  await page.goto("/precios");
  await page.locator(".plan-cta").first().click();
  await expect(page.locator("#subscription-status")).toHaveText(
    "Pagos temporalmente no disponibles.",
  );
  await expect(page.locator("#payment-continue")).toBeDisabled();
});
