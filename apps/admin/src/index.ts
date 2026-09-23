import type { PlatformBindings } from "@motorbaldi/config";

const html = (apiBaseUrl: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MotorBaldi Admin</title>
  <style>
    body{margin:0;font-family:Inter,system-ui,sans-serif;background:#111827;color:#f8fafc}
    main{min-height:100vh;display:grid;place-items:center;padding:32px}
    section{max-width:760px;width:100%}
    h1{font-size:30px;margin:0 0 12px}
    p{line-height:1.55;color:#cbd5e1}
    code{background:#1f2937;padding:2px 6px;border-radius:4px;color:#f8fafc}
  </style>
</head>
<body><main><section><h1>MotorBaldi Admin</h1><p>Foundation admin shell. API base URL: <code>${apiBaseUrl}</code></p></section></main></body></html>`;

export default {
  async fetch(_request: Request, env: PlatformBindings) {
    return new Response(html(env.AUTH_BASE_URL), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; connect-src 'self'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  },
};
