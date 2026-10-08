import type { PortalBindings } from "@motorbaldi/config";

import { portalPage, portalScript } from "./page.js";
import {
  turnstileTestCsp,
  turnstileTestPage,
  turnstileTestScript,
} from "./turnstile-test.js";

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
    if (
      url.pathname === "/turnstile-test" ||
      url.pathname === "/turnstile-test.js"
    ) {
      if (env.ENVIRONMENT !== "development")
        return new Response(null, { status: 404 });
      if (request.method !== "GET") return new Response(null, { status: 405 });
      if (url.pathname === "/turnstile-test.js")
        return new Response(turnstileTestScript, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      if (!env.TURNSTILE_SITE_KEY) return new Response(null, { status: 503 });
      return new Response(turnstileTestPage(env.TURNSTILE_SITE_KEY), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": turnstileTestCsp,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
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
