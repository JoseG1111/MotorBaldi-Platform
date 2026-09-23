import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
const server = spawn(process.execPath, ["scripts/serve.mjs", "dist"], {
  env: { ...process.env, PORT: "5175" },
  stdio: "ignore",
});
let browser;
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:5175")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  const shots = [];
  await fs.mkdir("docs/qa", { recursive: true });
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto("http://127.0.0.1:5175/");
    await page.locator("#hero-rotator-pause").click();
    // Visit every viewport first, including the content below the fold in tall sections.
    const total = await page.evaluate(
      () => document.documentElement.scrollHeight,
    );
    for (let y = 0; y < total; y += 500) {
      await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), y);
      await page.waitForTimeout(60);
    }
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map((img) => img.decode().catch(() => {})),
      ),
    );
    const selections = [
      "#inicio",
      ".universe-cards",
      "#servicios>.shell",
      "#nosotros",
      "#plataforma>.shell",
      ".pioneer-transition-sticky",
      "#pioneros",
      "#como-funciona",
      "#preguntas",
      "#contacto",
      ".site-footer",
    ];
    for (const [index, selector] of selections.entries()) {
      const target = page.locator(selector);
      await target.evaluate((e) =>
        scrollTo({
          top: e.getBoundingClientRect().top + scrollY,
          behavior: "instant",
        }),
      );
      await page.waitForTimeout(1100);
      const file = `${width}-full-${index}.png`;
      await target.screenshot({
        path: `docs/qa/${file}`,
        animations: "disabled",
      });
      shots.push({ file, title: `${width}px · ${selector}` });
    }
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    for (let i = 1; i < 3; i++) {
      await page.locator(`[data-hero-dot="${i}"]`).click();
      await page.waitForTimeout(1000);
      const file = `${width}-hero-frase-${i + 1}.png`;
      await page.locator("#inicio").screenshot({ path: `docs/qa/${file}` });
      shots.push({ file, title: `${width}px · Hero, frase ${i + 1}` });
    }
    for (const path of [
      "politica-de-privacidad.html",
      "terminos.html",
      "404.html",
    ]) {
      await page.goto(`http://127.0.0.1:5175/${path}`);
      const file = `${width}-${path}.png`;
      await page.screenshot({ path: `docs/qa/${file}`, fullPage: true });
      shots.push({ file, title: `${width}px · ${path}` });
    }
    await page.close();
  }
  await fs.writeFile(
    "docs/qa/galeria.html",
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MotorBaldi · Revisión visual</title><style>body{background:#eeeae3;color:#171a1c;font:16px system-ui;margin:32px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}figure{margin:0;background:white;padding:16px;border-radius:12px}img{width:100%;max-height:600px;object-fit:contain;object-position:top}a{color:inherit}h1{font-size:32px}figcaption{margin-top:12px}</style><h1>MotorBaldi · Revisión visual</h1><p>Capturas de la versión local de producción a 390 y 1440 px. Abre cada imagen para verla completa.</p><main>${shots.map(({ file, title }) => `<figure><a href="${file}"><img loading="lazy" src="${file}" alt="${title}"></a><figcaption>${title}</figcaption></figure>`).join("")}</main></html>`,
  );
  console.log(`${shots.length} capturas guardadas en docs/qa/galeria.html`);
} finally {
  await browser?.close();
  server.kill();
}
