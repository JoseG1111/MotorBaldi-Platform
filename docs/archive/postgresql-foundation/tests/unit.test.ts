import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { config } from "@motorbaldi/config";
import {
  createLogger,
  context,
  queryOperationalMetrics,
} from "@motorbaldi/observability";
import { testConfig } from "@motorbaldi/testing";
import { canonical } from "@motorbaldi/shared";
test("missing critical config fails without leaking values", () => {
  assert.throws(
    () => config({ AUTH_SECRET: "sensitive" }),
    /Invalid configuration/,
  );
});
test("remote environment rejects local credentials and TLS downgrade", () => {
  assert.throws(() =>
    config({
      ...Object.fromEntries(
        Object.entries(testConfig()).map(([k, v]) => [k, String(v)]),
      ),
      APP_ENV: "production",
      CORS_ORIGINS: "http://localhost:5173",
    }),
  );
});
test("request logger drops nested secrets, raw messages and errors", () => {
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk;
      callback();
    },
  });
  const log = createLogger(sink);
  context.run({ requestId: "req-test" }, () =>
    log.info(
      {
        event: "test",
        password: "SENSITIVE",
        nested: { token: "SENSITIVE" },
        err: new Error("SENSITIVE"),
        body: "SENSITIVE",
      },
      "SENSITIVE",
    ),
  );
  assert.ok(!output.includes("SENSITIVE"));
  assert.match(output, /req-test/);
  assert.match(output, /test/);
});
test("canonical requests compare nested object keys and retain array order", () => {
  assert.equal(
    canonical({ b: 1, a: { z: 2, y: 3 } }),
    canonical({ a: { y: 3, z: 2 }, b: 1 }),
  );
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});
test("operational metrics collector maps fixture query values", async () => {
  const responses = [
    { rows: [{ pending_count: "3", oldest_pending_age_seconds: "42" }] },
    { rows: [{ processing_lease_count: "2" }] },
    { rows: [{ unresolved_dead_letter_count: "1" }] },
  ];
  const values = await queryOperationalMetrics(
    {
      query: async () =>
        ({
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: responses.shift()!.rows,
        }) as never,
    },
    { getWaitingCount: async () => 7 },
  );
  assert.deepEqual(values, {
    outboxPendingCount: 3,
    oldestPendingAgeSeconds: 42,
    processingLeaseCount: 2,
    unresolvedDeadLetterCount: 1,
    queueWaitingCount: 7,
  });
});
