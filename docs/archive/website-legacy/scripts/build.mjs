// Copy only publishable files. Does not expose documentation or tests.
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(".");
const out = path.join(root, "dist");
const files = [
  "index.html",
  "pricing.html",
  "politica-de-privacidad.html",
  "terminos.html",
  "404.html",
  "robots.txt",
  "sitemap.xml",
  "favicon-v6.ico",
  "favicon.ico",
  "manifest-v8.webmanifest",
  ".htaccess",
];
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
for (const file of files)
  await fs.copyFile(path.join(root, file), path.join(out, file));
await fs.cp(path.join(root, "assets"), path.join(out, "assets"), {
  recursive: true,
});
await fs.cp(path.join(root, "api"), path.join(out, "api"), {
  recursive: true,
});
console.log("Build completo. Publica el CONTENIDO de dist/ en public_html/.");
