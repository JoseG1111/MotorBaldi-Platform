import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { testConfig, eventually } from "@motorbaldi/testing";
test("compiled API and worker boot with least-privilege role and drain on SIGTERM", async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("Port unavailable");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const c = testConfig();
  const db = new URL(c.DATABASE_URL);
  db.username = "motorbaldi_runtime";
  db.password = "motorbaldi_local_runtime";
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(c).map(([k, v]) => [
        k,
        Array.isArray(v)
          ? k === "TRUSTED_PROXIES" && v.length === 0
            ? "none"
            : v.join(",")
          : String(v),
      ]),
    ),
    PORT: String(port),
    DATABASE_URL: db.toString(),
  };
  const api = spawn(process.execPath, ["build/apps/api/src/main.js"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const worker = spawn(process.execPath, ["build/apps/worker/src/main.js"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let started = false;
  worker.stdout.on("data", (chunk) => {
    if (String(chunk).includes("worker_started")) started = true;
  });
  let diagnostics = "";
  for (const child of [api, worker])
    child.stderr.on("data", (chunk) => {
      diagnostics += String(chunk);
    });
  try {
    await eventually(async () => {
      if (api.exitCode !== null || worker.exitCode !== null)
        throw new Error(diagnostics);
      try {
        return (
          started &&
          (await fetch("http://127.0.0.1:" + port + "/health/ready")).status ===
            200
        );
      } catch {
        return false;
      }
    }, 15000);
    assert.equal(
      (await fetch("http://127.0.0.1:" + port + "/api/v1/principal")).status,
      401,
    );
  } finally {
    for (const child of [api, worker]) {
      const exit = once(child, "exit");
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
        const [code] = await exit;
        clearTimeout(timeout);
        assert.equal(code, 0, diagnostics);
      }
    }
  }
});
