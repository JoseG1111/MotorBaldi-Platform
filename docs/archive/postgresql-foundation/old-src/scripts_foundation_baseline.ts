import { performance } from "node:perf_hooks";
import { createApp } from "@motorbaldi/api/app";
import { testConfig } from "@motorbaldi/testing";
const start = performance.now();
const server = await createApp(testConfig());
try {
  await server.app.listen(0, "127.0.0.1");
  const address = server.fastify.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const bootMs = performance.now() - start;
  const durations = [];
  for (let i = 0; i < 100; i++) {
    const before = performance.now();
    const res = await fetch(
      "http://127.0.0.1:" + address.port + "/health/live",
    );
    await res.text();
    if (res.status !== 200) throw new Error("HTTP failure");
    durations.push(performance.now() - before);
  }
  durations.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      bootMs,
      requests: 100,
      p50Ms: durations[50],
      p95Ms: durations[95],
      poolMax: 5,
      workerConcurrency: 2,
    }),
  );
} finally {
  await server.close();
}
