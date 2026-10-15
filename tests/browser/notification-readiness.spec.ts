import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const emailId = "00000000-0000-4000-8000-000000000001";
const phoneId = "00000000-0000-4000-8000-000000000002";
function readiness(channel: string, contacts: string[], eligible = true) {
  return {
    channel,
    transportAvailable: false,
    policyEnabled: false,
    entitlementEligible: eligible,
    verifiedContactMethodIds: contacts,
    preferenceConfigurable: eligible && contacts.length > 0,
    deliveryAvailable: false,
    unavailableReasons: [
      "GENERAL_DELIVERY_UNAVAILABLE",
      "TRANSPORT_UNAVAILABLE",
      "POLICY_DISABLED",
      ...(!eligible ? ["PREMIUM_REQUIRED"] : []),
      ...(!contacts.length ? ["VERIFIED_CONTACT_REQUIRED"] : []),
    ],
  };
}
async function setup(page: Page, enabled = false) {
  const state = {
    enabled,
    version: enabled ? 3 : 0,
    channels: [readiness("EMAIL", [emailId]), readiness("WHATSAPP", [], false)],
    saves: [] as Record<string, unknown>[],
    conflict: false,
  };
  const errors: string[] = [],
    unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const paths: Record<string, unknown> = {
    "/me": { accountId: "synthetic-account", personId: "synthetic-person" },
    "/me/workspaces": [
      { id: "PERSONAL", type: "PERSONAL", name: "Mi espacio" },
    ],
    "/me/profile": { given_name: "Ana", family_name: "García", version: 1 },
    "/me/phone-verification/capability": { available: false },
    "/me/contact-methods": [
      {
        id: emailId,
        type: "EMAIL",
        raw_value: "ana@example.test",
        verification_status: "VERIFIED",
      },
      {
        id: phoneId,
        type: "PHONE",
        raw_value: "+573000000000",
        verification_status: "UNVERIFIED",
      },
    ],
    "/directory/organizations": { items: [], nextCursor: null },
    "/auth/capabilities": {
      registrationAvailable: false,
      recoveryAvailable: false,
    },
    "/public/parts": { items: [], nextCursor: null },
    "/me/notifications": { items: [], nextCursor: null },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace("/api/v1", "");
    if (path === "/me/notification-preferences") {
      if (request.method() === "POST") {
        state.saves.push(request.postDataJSON());
        expect(request.headers()["idempotency-key"]).toBeTruthy();
        if (state.conflict)
          return route.fulfill({
            status: 409,
            json: {
              code: "NOTIFICATION_STATE_CONFLICT",
              title: "Actualiza tus preferencias",
            },
          });
        state.enabled = request.postDataJSON().enabled;
        state.version++;
        return route.fulfill({
          json: { enabled: state.enabled, version: state.version },
        });
      }
      return route.fulfill({
        json: {
          externalDeliveryAvailable: false,
          channels: state.channels,
          items: [
            {
              category: "TRANSACTIONAL",
              channel: "EMAIL",
              enabled: state.enabled,
              version: state.version,
              contactMethodId: state.enabled ? emailId : null,
            },
          ],
        },
      });
    }
    if (request.method() === "GET" && Object.hasOwn(paths, path))
      return route.fulfill({ json: paths[path] });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 501,
      json: { code: "UNMOCKED_BROWSER_QA_REQUEST" },
    });
  });
  await page.goto("http://127.0.0.1:4174");
  await expect(page.locator("body")).toHaveClass(/signed-in/);
  await page.locator('[data-panel="notifications"]').click();
  await expect(
    page.locator('[data-notification-channel="EMAIL"]'),
  ).toBeVisible();
  return {
    state,
    errors,
    unexpected,
    contacts: paths["/me/contact-methods"] as Array<{
      verification_status: string;
    }>,
  };
}

test("saves verified email intent with CAS while delivery stays unavailable", async ({
  page,
}) => {
  const { state, errors, unexpected } = await setup(page);
  const email = page.locator('[data-notification-channel="EMAIL"]');
  await expect(email.getByRole("combobox")).toHaveValue(emailId);
  await expect(email.getByRole("option")).toHaveText(["ana@example.test"]);
  await expect(page.locator(".notification-channel-note")).toContainText(
    "El envío por correo y WhatsApp aún no está disponible.",
  );
  await expect(email.getByRole("button")).toHaveText("Guardar preferencia");
  await email
    .getByRole("button", { name: "Guardar preferencia de correo electrónico" })
    .click();
  await expect(email).toContainText("Preferencia guardada: activada.");
  expect(state.saves[0]).toEqual({
    category: "TRANSACTIONAL",
    channel: "EMAIL",
    enabled: true,
    contactMethodId: emailId,
    version: 0,
  });
  await email
    .getByRole("button", {
      name: "Desactivar preferencia de correo electrónico",
    })
    .click();
  await expect(email).toContainText("Preferencia guardada: desactivada.");
  expect(state.saves[1]).toEqual({
    category: "TRANSACTIONAL",
    channel: "EMAIL",
    enabled: false,
    contactMethodId: null,
    version: 1,
  });
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("requires current verified contacts and premium, but keeps opt-out available", async ({
  page,
}) => {
  const { state } = await setup(page, true);
  const whatsapp = page.locator('[data-notification-channel="WHATSAPP"]');
  await expect(whatsapp).toContainText("requieren Premium");
  await expect(whatsapp).toContainText("Agregar un teléfono no lo verifica");
  await expect(whatsapp.getByRole("button")).toBeDisabled();
  state.channels[0] = readiness("EMAIL", []);
  await page.locator("#notifications-refresh").click();
  const email = page.locator('[data-notification-channel="EMAIL"]');
  await expect(email.getByRole("combobox")).toBeDisabled();
  await expect(email.getByRole("button")).toBeEnabled();
  await email.getByRole("button").click();
  await expect(email).toContainText("Preferencia guardada: desactivada.");
  expect(state.saves[0]).toMatchObject({
    enabled: false,
    contactMethodId: null,
    version: 3,
  });
  await expect(email.getByRole("button")).toBeDisabled();
  expect(state.saves).toHaveLength(1);
});

test("can save WhatsApp intent only when readiness supplies an existing verified phone", async ({
  page,
}) => {
  const { state, contacts } = await setup(page);
  contacts[1]!.verification_status = "VERIFIED";
  state.channels[1] = readiness("WHATSAPP", [phoneId]);
  await page.locator("#notifications-refresh").click();
  const whatsapp = page.locator('[data-notification-channel="WHATSAPP"]');
  await expect(whatsapp.getByRole("combobox")).toHaveValue(phoneId);
  await whatsapp.getByRole("button").click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0]).toEqual({
    category: "TRANSACTIONAL",
    channel: "WHATSAPP",
    enabled: true,
    contactMethodId: phoneId,
    version: 0,
  });
  await expect(page.locator(".notification-channel-note")).toContainText(
    "eso no activa el envío",
  );
});

test("does not claim a save after version conflict and permits refresh recovery", async ({
  page,
}) => {
  const { state } = await setup(page);
  state.conflict = true;
  const email = page.locator('[data-notification-channel="EMAIL"]');
  await email.getByRole("button").click();
  await expect(email).toContainText("Preferencia guardada: desactivada.");
  await expect(page.locator("#notifications-status")).not.toHaveText("");
  await expect(email.getByRole("button")).toBeEnabled();
  state.conflict = false;
  state.version = 7;
  await page.locator("#notifications-refresh").click();
  await expect(page.locator("#notifications-status")).toHaveText("");
  await email.getByRole("button").click();
  await expect(email).toContainText("Preferencia guardada: activada.");
  expect(state.saves[1]?.version).toBe(7);
});

test("discards preference responses from the previous workspace", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/me/notification-preferences", async (route) => {
    started();
    await waiting;
    await route.fulfill({
      json: {
        items: [],
        channels: [readiness("EMAIL", [emailId])],
        externalDeliveryAvailable: false,
      },
    });
  });
  await page.locator("#notifications-refresh").click();
  await requested;
  await page.locator("#workspace").dispatchEvent("change");
  release();
  await expect(page.locator("#notifications-panel")).toBeHidden();
  await expect(page.locator("#notification-preferences section")).toHaveCount(
    0,
  );
  await expect(page.locator("#notifications-status")).not.toHaveText(
    /Preferencia guardada/,
  );
});

test("notification readiness stays accessible and contained across supported viewports", async ({
  page,
}, testInfo) => {
  const { errors, unexpected } = await setup(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.locator('[data-notification-channel="WHATSAPP"]'),
    ).toContainText("Agregar un teléfono no lo verifica");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator('[data-notification-channel="SMS"]')).toHaveCount(
      0,
    );
    await expect(page.locator("#notification-preferences")).not.toContainText(
      "SMS",
    );
    const cards = await page
      .locator("#notification-preferences > section")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
        }),
      );
    expect(cards).toHaveLength(4);
    if (viewport.width > 640) {
      expect(cards[0]!.y).toBe(cards[1]!.y);
      expect(cards[1]!.x - cards[0]!.right).toBeGreaterThanOrEqual(16);
    } else {
      expect(cards[0]!.x).toBe(cards[1]!.x);
      expect(cards[1]!.y - cards[0]!.bottom).toBeGreaterThanOrEqual(16);
    }
    const buttons = await page
      .locator("#notifications-panel button")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect(),
            style = getComputedStyle(node);
          return {
            height: box.height,
            lineHeight: Number.parseFloat(style.lineHeight),
            padding:
              Number.parseFloat(style.paddingTop) +
              Number.parseFloat(style.paddingBottom),
            border:
              Number.parseFloat(style.borderTopWidth) +
              Number.parseFloat(style.borderBottomWidth),
          };
        }),
      );
    expect(
      buttons.every((button) => button.height >= 44 && button.height <= 60),
    ).toBe(true);
    expect(
      buttons.every(
        (button) =>
          button.height - button.padding - button.border <
          button.lineHeight * 1.5,
      ),
    ).toBe(true);
    await expect(
      page.locator('[data-notification-channel="EMAIL"] button'),
    ).toHaveAttribute(
      "aria-label",
      "Guardar preferencia de correo electrónico",
    );
    await expect(
      page.locator('[data-notification-channel="WHATSAPP"] button'),
    ).toHaveAttribute("aria-label", "Guardar preferencia de WhatsApp");

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(
        "synthetic-notification-readiness-" + viewport.width + ".png",
      ),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});
