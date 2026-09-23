// Local-only development server. Node >= 22; npm install is not required.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(process.argv[2] || ".");
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};
http
  .createServer(async (req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    try {
      const requested = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      // This server serves marketing only, never PHP source or monorepo internals.
      const publicPaths = new Set(['/', '/index.html', '/pricing.html', '/precios', '/precios/', '/terminos', '/terminos/', '/terminos.html', '/politica-de-privacidad', '/politica-de-privacidad/', '/politica-de-privacidad.html', '/404', '/404/', '/404.html', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/favicon-v6.ico', '/manifest-v8.webmanifest']);
      if (!publicPaths.has(requested) && !/^\/assets\/[a-zA-Z0-9_./-]+$/.test(requested)) {
        res.writeHead(404).end('Not found');
        return;
      }
      if (requested.includes("\0")) {
        res.writeHead(400).end();
        return;
      }
      const legacy = {
        "/index.html": "/",
        "/pricing.html": "/precios",
        "/terminos.html": "/terminos",
        "/politica-de-privacidad.html": "/politica-de-privacidad",
        "/404.html": "/404",
      };
      const routes = {
        "/precios": "/pricing.html",
        "/terminos": "/terminos.html",
        "/politica-de-privacidad": "/politica-de-privacidad.html",
        "/404": "/404.html",
      };
      const normalized = requested.replace(/\/+$/, "");
      const redirect =
        legacy[requested] ||
        (routes[normalized] && normalized !== requested ? normalized : null);
      if (redirect) {
        res
          .writeHead(301, {
            Location: redirect + new URL(req.url, "http://localhost").search,
          })
          .end();
        return;
      }
      const file = path.resolve(
        root,
        "." +
          (routes[requested] ||
            (requested.endsWith("/") ? requested + "index.html" : requested)),
      );
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      if (
        requested
          .split("/")
          .some((part) => part.startsWith(".") && part !== ".")
      ) {
        res.writeHead(403).end();
        return;
      }
      const data = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (error instanceof URIError) {
        res.writeHead(400).end("Invalid URL");
        return;
      }
      const page = await fs
        .readFile(path.join(root, "404.html"))
        .catch(() => "Not found");
      res
        .writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
        .end(req.method === "HEAD" ? undefined : page);
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`MotorBaldi -> http://localhost:${port}\nCtrl+C para detener.`),
  )
  .on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
