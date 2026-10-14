/** Synthetic browser QA server. Serves the real Worker handlers; never connects to D1 or Development. */
import { createServer } from "node:http";
import admin from "../../apps/admin/src/index.js";
import portal from "../../apps/portal/src/index.js";
import type { AdminBindings, PortalBindings } from "@motorbaldi/config";

for (const [port, worker, bindings] of [
  [4173, admin, {} as AdminBindings],
  [4174, portal, { ENVIRONMENT: "development" } as PortalBindings],
] as const) {
  createServer(async (incoming, outgoing) => {
    try {
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method,
      });
      // Browser tests intercept every API request with explicit synthetic fixtures.
      if (new URL(request.url).pathname.startsWith("/api/")) {
        outgoing.writeHead(501, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ code: "UNMOCKED_BROWSER_QA_REQUEST" }));
        return;
      }
      const response = await worker.fetch(
        request,
        bindings as AdminBindings & PortalBindings,
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end("Browser QA server failed");
    }
  }).listen(port, "127.0.0.1");
}
