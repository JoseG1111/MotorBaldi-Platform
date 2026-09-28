import type { PortalBindings } from "@motorbaldi/config";

import { portalPage, portalScript } from "./page.js";

export default {
  async fetch(request: Request, env: PortalBindings) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const upstream = new URL(
        url.pathname + url.search,
        "https://api.internal",
      );
      return env.API_SERVICE.fetch(new Request(upstream, request));
    }
    if (url.pathname === "/app.js")
      return new Response(portalScript, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    if (request.method !== "GET") return new Response(null, { status: 405 });
    return new Response(
      env.ENVIRONMENT === "local"
        ? portalPage
        : portalPage.replace(
            'id="signup-section"',
            'id="signup-section" class="hidden"',
          ),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'unsafe-inline'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      },
    );
  },
} satisfies ExportedHandler<PortalBindings>;
