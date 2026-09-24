import type { AdminBindings } from "@motorbaldi/config";

const page = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Administración MotorBaldi</title><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#111827;color:#f8fafc}main{min-height:100vh;display:grid;place-items:center;padding:32px}section{max-width:760px;width:100%}h1{font-size:30px;margin:0 0 12px}p{line-height:1.55;color:#cbd5e1}</style></head><body><main><section><h1>Administración MotorBaldi</h1><p>El espacio de administración está en preparación.</p></section></main></body></html>`;

export default {
  async fetch(request: Request, env: AdminBindings) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const upstream = new URL(
        url.pathname + url.search,
        "https://api.internal",
      );
      return env.API_SERVICE.fetch(new Request(upstream, request));
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    return new Response(page, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  },
} satisfies ExportedHandler<AdminBindings>;
