import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
test("marketing dev server refuses Core, environment and PHP source", async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ["scripts/serve.mjs"], {
    env: { ...process.env, PORT: String(address.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await once(child.stdout, "data");
    const base = "http://127.0.0.1:" + address.port;
    assert.equal((await fetch(base)).status, 200);
    for (const path of [
      "/package.json",
      "/.env",
      "/api/wompi-common.php",
      "/apps/api/src/main.ts",
      "/assets/..%2fpackage.json",
    ])
      assert.ok([403, 404].includes((await fetch(base + path)).status), path);
  } finally {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    await stopped;
  }
});
