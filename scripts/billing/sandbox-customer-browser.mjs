import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { hashPassword } from "better-auth/crypto";
import { v7 as uuid } from "uuid";
import { chromium } from "@playwright/test";
import { CUSTOMER_PLANS } from "@motorbaldi/shared/customer-plans";
import {
  requireSyntheticSandboxExecution,
  syntheticCustomerSql,
  closeSyntheticCustomerSql,
  resumeSyntheticCustomerSql,
} from "./sandbox-customer-fixture.mjs";
requireSyntheticSandboxExecution(process.argv.slice(2));
const cadence = process.argv[4] || "MONTHLY";
if (!["MONTHLY", "ANNUAL"].includes(cadence)) throw Error("Invalid cadence");
const amount = String(CUSTOMER_PLANS.prices[cadence].amountMinor);
let id = uuid(),
  email;
const password = randomBytes(36).toString("base64url");
const resumeApproved = process.argv[5] === "--resume-approved";
const resumeVoided = process.argv[5] === "--resume-voided";
const accountOnly = process.argv[5] === "--account-only";
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
function query(sql) {
  const dir = mkdtempSync(join(tmpdir(), "mb-sandbox-"));
  try {
    const file = join(dir, "query.sql");
    writeFileSync(file, sql, { mode: 0o600 });
    const r = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "motorbaldi-core-dev",
        "--remote",
        "--config",
        "apps/api/wrangler.jsonc",
        "--env",
        "development",
        "--json",
        ...(sql.trimStart().startsWith("SELECT")
          ? ["--command", sql]
          : ["--file", file]),
      ],
      { encoding: "utf8", maxBuffer: 1048576 },
    );
    if (r.status !== 0)
      throw Error("Development fixture query failed (output suppressed)");
    const start = r.stdout.search(/^\[\s*\{/m);
    if (start < 0) throw Error("Missing structured D1 result");
    const result = JSON.parse(r.stdout.slice(start));
    if (result.some((x) => !x.success)) throw Error("Query failed");
    return result.flatMap((x) => x.results || []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv[2] !== "development" || process.argv[3] !== "--execute")
  throw Error("Explicit development --execute required");
const env = query(
  "SELECT environment FROM governance_environment_metadata WHERE singleton=1",
);
if (env[0]?.environment !== "development") throw Error("Environment mismatch");
const hash = await hashPassword(password);
if (resumeApproved || resumeVoided) {
  const candidates = query(
    `SELECT DISTINCT s.account_id FROM billing_subscriptions s JOIN billing_periods p ON p.subscription_id=s.id JOIN billing_payments pay ON pay.period_id=p.id JOIN auth_users u ON u.id=s.account_id WHERE s.plan_code=${quote(CUSTOMER_PLANS.prices[cadence].planCode)} AND s.cancel_at_period_end=0 AND p.status='PAID' AND p.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND pay.status=${quote(resumeVoided ? "VOIDED" : "APPROVED")} AND pay.provider_environment='SANDBOX' AND u.name='Synthetic Sandbox Customer' AND u.email LIKE 'sandbox-customer-%@development.invalid' AND EXISTS(SELECT 1 FROM governance_audit_events a WHERE a.resource_id=u.id AND a.action='identity.development_customer_fixture.provisioned') LIMIT 1`,
  );
  if (candidates.length !== 1)
    throw Error("No approved isolated fixture available");
  id = candidates[0].account_id;
  query(
    resumeSyntheticCustomerSql({
      accountId: id,
      auditId: uuid(),
      requestId: uuid(),
      passwordHash: hash,
    }),
  );
} else
  query(
    syntheticCustomerSql({
      accountId: id,
      credentialId: uuid(),
      auditId: uuid(),
      requestId: uuid(),
      passwordHash: hash,
    }),
  );
email = `sandbox-customer-${id}@development.invalid`;
console.log(
  "Synthetic customer fixture prepared; no roles granted; raw password retained only in process memory.",
);
let browser, provider, input;
process.once("SIGINT", () => {
  input?.close();
  void browser?.close().catch(() => {});
});
try {
  const cachedChromium = join(
    homedir(),
    ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.MOTORBALDI_CHROMIUM_PATH ||
      (existsSync(cachedChromium) ? cachedChromium : undefined),
  });
  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  input = createInterface({ input: process.stdin, output: process.stdout });
  await page.goto(
    "https://motorbaldi-portal-development.josegbarrios2.workers.dev/#premium",
  );
  await page.locator("#login-form [name=email]").fill(email);
  await page.locator("#login-form [name=password]").fill(password);
  await page.locator("#login-form button").click();
  await page.locator('#private[aria-busy="false"]').waitFor({ timeout: 30000 });
  if (
    !(await page
      .locator("body")
      .evaluate((el) => el.classList.contains("signed-in")))
  )
    throw Error("Normal login failed");
  console.log("Normal Better Auth customer login passed.");
  await page.locator('[data-panel="membership"]').click();
  if (!resumeApproved && !resumeVoided && !accountOnly) {
    await page.locator("#premium-select").waitFor();
    if (cadence === "ANNUAL")
      await page.getByRole("button", { name: "Anual", exact: true }).click();
    await page.locator("#premium-select").click();
    await page
      .getByRole("button", { name: "Pagar en Wompi (pruebas)", exact: true })
      .waitFor({ timeout: 20000 });
    await page
      .getByRole("button", { name: "Pagar en Wompi (pruebas)", exact: true })
      .click();
    const link = page.getByRole("link", {
      name: "Continuar a Wompi (pruebas)",
    });
    await link.waitFor({ timeout: 20000 });
    const href = await link.getAttribute("href"),
      u = new URL(href);
    if (
      u.origin !== "https://checkout.wompi.co" ||
      u.pathname !== "/p/" ||
      u.username ||
      u.password ||
      u.hash ||
      u.searchParams.get("currency") !== "COP" ||
      !u.searchParams.get("public-key")?.startsWith("pub_test_") ||
      u.searchParams.get("amount-in-cents") !== amount
    )
      throw Error("Sandbox checkout mismatch");
    provider = await context.newPage();
    await provider.goto(href, { waitUntil: "networkidle" });
    console.log(
      "Real hosted Sandbox checkout opened; trusted host and canonical",
      cadence,
      "amount checked.",
    );
  } else
    console.log(
      "Synthetic customer account ready through normal login; no new payment initiated.",
    );
  const management = page.locator("#membership-management");
  await management.waitFor();
  if (!(await management.evaluate((el) => el.open)))
    await management.locator("summary").click();
  for await (const command of input) {
    try {
      if (command.startsWith("api:")) {
        const operation = JSON.parse(command.slice(4));
        if (
          !/^\/(?:me\/vehicles|vehicles\/[0-9a-f-]{36}(?:\/(?:services|compliance|maintenance|registration|retire))?)(?:\?[^#]*)?$/.test(
            operation.path,
          ) ||
          !["GET", "POST"].includes(operation.method)
        )
          throw Error("Only scoped vehicle test routes permitted");
        const response = await page.evaluate(async (operation) => {
          const response = await fetch("/api/v1" + operation.path, {
            method: operation.method,
            credentials: "same-origin",
            headers: {
              "content-type": "application/json",
              ...(operation.method === "POST"
                ? { "idempotency-key": crypto.randomUUID() }
                : {}),
            },
            ...(operation.method === "POST"
              ? { body: JSON.stringify(operation.body) }
              : {}),
          });
          return { status: response.status, data: await response.json() };
        }, operation);
        console.log(JSON.stringify(response));
      } else if (command === "notice")
        console.log(await page.locator("#notice").innerText());
      else if (command === "inspect")
        console.log(
          (await provider.locator("body").innerText())
            .replaceAll(email, "[synthetic-email]")
            .split("\n")
            .filter((x) => !/^\+\d/.test(x))
            .slice(-65)
            .join("\n"),
        );
      else if (command === "open-checkout") {
        const link = page.getByRole("link", {
          name: "Continuar a Wompi (pruebas)",
        });
        await link.waitFor();
        const href = await link.getAttribute("href"),
          url = new URL(href);
        if (
          url.origin !== "https://checkout.wompi.co" ||
          url.pathname !== "/p/" ||
          !url.searchParams.get("public-key")?.startsWith("pub_test_") ||
          url.searchParams.get("amount-in-cents") !== amount
        )
          throw Error("Sandbox checkout mismatch");
        provider = await context.newPage();
        await provider.goto(href, { waitUntil: "networkidle" });
      } else if (command.startsWith("portal-click:"))
        await page
          .getByRole("button", { name: command.slice(13), exact: true })
          .click();
      else if (command.startsWith("click:"))
        await provider
          .getByText(command.slice(6), { exact: true })
          .filter({ visible: true })
          .first()
          .click();
      else if (command.startsWith("select:")) {
        const { selector, value } = JSON.parse(command.slice(7));
        await provider.locator(selector).selectOption(value);
      } else if (command.startsWith("check:"))
        await provider.locator(command.slice(6)).check();
      else if (command === "fields")
        console.log(
          JSON.stringify(
            await provider.locator("input,select").evaluateAll((xs) =>
              xs.map((x) => ({
                tag: x.tagName,
                name: x.name,
                type: x.type,
                placeholder: x.placeholder,
                id: x.id,
                length: x.value.length,
                disabled: x.disabled,
                readOnly: x.readOnly,
                options:
                  x.tagName === "SELECT" && x.name !== "prefix"
                    ? [...x.options].map((o) => ({
                        value: o.value,
                        text: o.text,
                      }))
                    : undefined,
              })),
            ),
            null,
            2,
          ),
        );
      else if (command.startsWith("fill:")) {
        const { selector, value } = JSON.parse(command.slice(5));
        await provider.locator(selector).fill("");
        await provider
          .locator(selector)
          .pressSequentially(value, { delay: 15 });
      } else if (command === "verify") {
        const historyResponse = page.waitForResponse(
          (r) =>
            r.url().includes("/billing/payments") &&
            r.request().method() === "GET",
        );
        await Promise.all([
          historyResponse,
          page
            .getByRole("button", { name: "Consultar estado del pago" })
            .click(),
        ]);
        await page.locator("#membership-detail table").waitFor();
        console.log(
          (await page.locator("#membership-detail").innerText()).replaceAll(
            email,
            "[synthetic-email]",
          ),
        );
        console.log(
          query(
            `SELECT p.status,p.provider_environment,p.amount_minor,CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS authoritative_confirmation,pe.status AS period_status,s.status AS subscription_status FROM billing_payments p JOIN billing_periods pe ON pe.id=p.period_id JOIN billing_subscriptions s ON s.id=pe.subscription_id LEFT JOIN billing_payment_confirmations c ON c.payment_id=p.id WHERE s.account_id=${quote(id)};`,
          ),
        );
      } else if (command === "finish") break;
      else console.log("Unknown command");
    } catch (e) {
      console.log(
        "Controlled browser step failed:",
        String(e.message).split("\n")[0],
      );
    }
  }
} catch {
  console.log(
    "Runner stopped:",
    "DEVELOPMENT_SANDBOX_BROWSER_FAILURE (details suppressed to protect signed URLs)",
  );
  process.exitCode = 1;
} finally {
  input?.close();
  await browser?.close();
  query(
    closeSyntheticCustomerSql({
      accountId: id,
      auditId: uuid(),
      requestId: uuid(),
    }),
  );
  console.log(
    "Fixture sessions revoked, credentials cleared and reconciled account suspended; financial/audit history retained.",
  );
}
