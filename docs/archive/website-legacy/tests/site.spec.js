import { test, expect } from "@playwright/test";

const jump = async (page, selector, offset = 0) => {
  await page.locator(selector).evaluate(
    (element, offset) =>
      window.scrollTo({
        top: element.getBoundingClientRect().top + scrollY + offset,
        behavior: "instant",
      }),
    offset,
  );
  await page.waitForTimeout(1000);
};

test("hero conserva fotografía y rota cada 6,8 segundos; pausa y controles", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".hero-media img")).toHaveAttribute(
    "src",
    /hero-motorbaldi-1600/,
  );
  await expect(page.locator("#hero-rotator-count")).toHaveText("01 / 03");
  await page.clock.fastForward(6900);
  await expect(page.locator("#hero-rotator-count")).toHaveText("02 / 03");
  await page.locator("#hero-rotator-pause").click();
  await page.clock.fastForward(14000);
  await expect(page.locator("#hero-rotator-count")).toHaveText("02 / 03");
  await page.locator('[data-hero-dot="2"]').click();
  await expect(page.locator("#hero-rotator-count")).toHaveText("03 / 03");
  await page.locator("#hero-rotator-pause").click();
  await page.clock.fastForward(6900);
  await expect(page.locator("#hero-rotator-count")).toHaveText("01 / 03");
});

test("las entradas esperan al scroll incluso después de 2,6 segundos", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForTimeout(3200);
  const form = page.locator(".quote-form");
  await expect(form).not.toHaveClass(/is-v12-visible/);
  await jump(page, "#contacto");
  await expect(form).toHaveClass(/is-v12-visible/);
  await expect(form).toHaveCSS("opacity", "1");
});

test("Servicios avanza con scroll, conserva selección manual y muestra todo el panel", async ({
  page,
}) => {
  await page.goto("/");
  const metrics = await page.locator("#servicios").evaluate((e) => ({
    top: e.getBoundingClientRect().top + scrollY,
    travel: e.offsetHeight - innerHeight,
  }));
  for (const [index, progress] of [0.05, 0.25, 0.45, 0.65, 0.85].entries()) {
    await page.evaluate(
      (y) => scrollTo({ top: y, behavior: "instant" }),
      metrics.top + metrics.travel * progress,
    );
    await page.waitForTimeout(900);
    await expect(page.locator(".service-tab.is-active")).toHaveAttribute(
      "data-index",
      String(index),
    );
    await expect(page.locator("#service-count")).toHaveText(`0${index + 1}`);
    const r = await page.locator("#service-panel").boundingBox();
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(901);
  }
  await page.locator("#service-tab-parts").click();
  await page.waitForTimeout(2300);
  await page.mouse.wheel(0, 12);
  await expect(page.locator("#service-tab-parts")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.locator("#service-tab-history").click();
  await expect(page.locator("#service-link")).not.toHaveAttribute("target");
  await page.locator("#service-link").click();
  await expect(page).toHaveURL(/#plataforma$/);
});

test("cambios rápidos no mezclan imágenes ni textos", async ({ page }) => {
  await page.route("**/repuestos.webp", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto("/");
  await jump(page, "#servicios", 120);
  await page.locator("#service-tab-parts").click();
  await page.locator("#service-tab-assist").click();
  await expect(page.locator("#service-image")).toHaveAttribute(
    "src",
    /asistencia.webp/,
  );
  await page.waitForTimeout(1200);
  await expect(page.locator("#service-image")).toHaveAttribute(
    "src",
    /asistencia.webp/,
  );
  await jump(page, "#nosotros");
  await page.locator('[data-vehicle="moto"]').click();
  await expect(page.locator("#vehicle-image")).toHaveAttribute("src", /motos/);
  await expect(page.locator('input[value="Motocicleta"]')).toBeChecked();
  await jump(page, "#contacto");
  await page.getByText("Carro", { exact: true }).last().click();
  await expect(page.locator('[data-vehicle="car"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("formulario valida, preselecciona y prepara WhatsApp sin enviar mensajes", async ({
  page,
}) => {
  let hubspotPayload;
  await page.route("**/api/hubspot.php", async (route) => {
    hubspotPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await page.goto("/");
  await page.evaluate(() => {
    window.open = () => ({
      closed: false,
      opener: null,
      location: {
        replace: (url) => {
          window.preparedURL = url;
        },
      },
      close: () => {},
    });
  });
  await jump(page, "#plataforma", 100);
  await page
    .locator('[data-form-service="Información sobre la plataforma"]')
    .click();
  await expect(page.locator("#service")).toHaveValue(
    "Información sobre la plataforma",
  );
  await page.waitForTimeout(700);
  await page.locator(".submit-button").click();
  await expect(page.locator("#details")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.locator("#name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#consent")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.locator("#name").fill("Ana Motor");
  await page.locator("#email").fill("ana@example.com");
  await page.locator("#phone").fill("+57 300 123 4567");
  await page
    .locator("#details")
    .fill("Renault Duster 2022, cambio de aceite & revisión.");
  await page.locator("#consent").check();
  await page.locator(".submit-button").click();
  await expect(page.locator("#form-result")).toBeVisible();
  expect(hubspotPayload).toMatchObject({
    name: "Ana Motor",
    email: "ana@example.com",
    phone: "+57 300 123 4567",
    vehicle: "Automóvil",
    service: "Información sobre la plataforma",
    consent: true,
    company_website: "",
  });
  const url = await page.evaluate(() => window.preparedURL);
  expect(url).toMatch(/^https:\/\/wa.me\/573104602615\?text=/);
  expect(new URL(url).searchParams.get("text")).toContain(
    "cambio de aceite & revisión.",
  );
  await jump(page, "#pioneros");
  await page
    .locator('[data-form-service="Programa de pioneros MB-100"]')
    .click();
  await expect(page.locator("#service")).toHaveValue(
    "Programa de pioneros MB-100",
  );
});

test("un error de HubSpot no pierde los datos y ofrece WhatsApp directo", async ({
  page,
}) => {
  await page.route("**/api/hubspot.php", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        message: "No pudimos registrar tu solicitud.",
      }),
    }),
  );
  await page.goto("/");
  await page.evaluate(() => {
    window.popupClosed = false;
    window.open = () => ({
      closed: false,
      opener: null,
      location: { replace: () => {} },
      close: () => {
        window.popupClosed = true;
      },
    });
  });
  await jump(page, "#contacto");
  await page.locator("#name").fill("Ana Motor");
  await page.locator("#email").fill("ana@example.com");
  await page.locator("#phone").fill("+57 300 123 4567");
  await page.locator("#service").selectOption("Mantenimiento");
  await page
    .locator("#details")
    .fill("Quiero programar mantenimiento preventivo.");
  await page.locator("#consent").check();
  await page.locator(".submit-button").click();
  await expect(page.locator("#form-error")).toBeVisible();
  await expect(page.locator("#name")).toHaveValue("Ana Motor");
  expect(await page.evaluate(() => window.popupClosed)).toBe(true);
  await expect(page.locator(".submit-button")).toBeEnabled();
});

test("menú móvil y pestañas se pueden usar con teclado; FAQ", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".menu-toggle").click();
  await expect(page.locator("#mobile-menu")).toBeVisible();
  await expect(page.locator(".menu-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu-toggle")).toBeFocused();
  await page.locator(".menu-toggle").click();
  await page.locator('#mobile-menu a[href="#servicios"]').click();
  await expect(page.locator("#mobile-menu")).not.toBeVisible();
  await expect(page.locator("#services-title")).toBeFocused();
  await page.locator("#service-tab-maintenance").click();
  await page.keyboard.press("End");
  await expect(page.locator("#service-tab-history")).toBeFocused();
  await expect
    .poll(async () => {
      const tab = await page.locator("#service-tab-history").boundingBox();
      return tab.x >= 0 && tab.x + tab.width <= 391;
    })
    .toBe(true);
  await jump(page, "#preguntas");
  await page.locator("summary").first().click();
  await expect(page.locator(".faq-list details[open]")).toHaveCount(1);
});

for (const [width, height] of [
  [320, 740],
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
]) {
  test(`recorrido completo ${width}×${height}, imágenes reales y sin desbordamientos`, async ({
    page,
  }, testInfo) => {
    const errors = [];
    const failures = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(response.url());
    });
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.waitForTimeout(1700);
    expect(
      await page
        .locator("#inicio")
        .evaluate((e) => e.getBoundingClientRect().top),
    ).toBe(0);
    for (const id of [
      "inicio",
      "universo",
      "servicios",
      "nosotros",
      "plataforma",
      "pioneer-transition",
      "pioneros",
      "como-funciona",
      "preguntas",
      "contacto",
    ]) {
      await jump(
        page,
        "#" + id,
        id === "servicios" && width >= 1180 && height >= 800 ? 150 : 0,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        id,
      ).toBe(true);
      if (testInfo.project.name === "chromium" && [390, 1440].includes(width))
        await page.screenshot({ path: `docs/qa/${width}-${id}.png` });
      if (id === "pioneros") {
        const head = await page.locator(".pass-head").boundingBox();
        const code = await page.locator(".pass-code").boundingBox();
        const foot = await page.locator(".pass-foot").boundingBox();
        expect(head.y + head.height).toBeLessThan(code.y);
        expect(code.y + code.height).toBeLessThan(foot.y);
      }
      if (id === "plataforma" && width >= 1180 && height >= 800) {
        await jump(page, "#plataforma", 120);
        const card = await page.locator(".device-card").boundingBox();
        expect(card.y + card.height).toBeLessThanOrEqual(height + 1);
      }
    }
    expect(
      await page
        .locator("img")
        .evaluateAll((images) =>
          images
            .filter((e) => !e.complete || !e.naturalWidth)
            .map((e) => e.src),
        ),
    ).toEqual([]);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  });
}

test("movimiento reducido y sin JavaScript mantienen el contenido accesible", async ({
  browser,
}) => {
  for (const javascriptEnabled of [true, false]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
      javaScriptEnabled: javascriptEnabled,
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5174/");
    await expect(page.locator(".pioneer-transition")).not.toBeVisible();
    await jump(page, "#contacto");
    if (javascriptEnabled)
      await expect(page.locator(".quote-form")).toHaveCSS("opacity", "1");
    else {
      await expect(page.locator(".quote-form")).not.toBeVisible();
      await expect(page.locator("noscript a")).toBeVisible();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await context.close();
  }
});

test("páginas auxiliares, anclas y metadatos de producción", async ({
  page,
  request,
}) => {
  await page.goto("/");
  expect(
    await page
      .locator('a[href^="#"]')
      .evaluateAll((links) =>
        links
          .map((a) => a.getAttribute("href"))
          .filter((h) => h.length > 1 && !document.getElementById(h.slice(1))),
      ),
  ).toEqual([]);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://motorbaldi.com/",
  );
  for (const path of [
    "/politica-de-privacidad",
    "/terminos",
    "/robots.txt",
    "/sitemap.xml",
    "/manifest-v8.webmanifest",
  ])
    expect((await request.get(path)).status()).toBe(200);
  expect((await request.get("/no-existe")).status()).toBe(404);
  expect((await request.get("/README.md")).status()).toBe(404);
});
