import { beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import type { PlatformBindings } from "@motorbaldi/config";

const testEnv = env as unknown as PlatformBindings;
const worker = (
  workerExports as unknown as {
    default: { fetch: (request: Request) => Promise<Response> };
  }
).default;

beforeEach(async () => {
  await testEnv.DB.prepare(
    "CREATE TABLE IF NOT EXISTS governance_environment_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), environment TEXT NOT NULL)",
  ).run();
  await testEnv.DB.prepare(
    "CREATE TABLE IF NOT EXISTS governance_idempotency_records (scope TEXT NOT NULL, key TEXT NOT NULL, operation TEXT NOT NULL, account_id TEXT NOT NULL, organization_id TEXT, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', PRIMARY KEY(scope, key))",
  ).run();
  await testEnv.DB.prepare(
    "INSERT OR IGNORE INTO governance_environment_metadata(singleton, environment) VALUES (1, 'development')",
  ).run();
});

describe("api worker runtime", () => {
  it("responds to health inside Workers runtime", async () => {
    const response = await worker.fetch(new Request("https://api.test/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("fails closed on unauthenticated principal", async () => {
    const response = await worker.fetch(
      new Request("https://api.test/api/v1/principal"),
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("serializes duplicate idempotency requests through Durable Objects", async () => {
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "same-key-123",
    };
    const body = JSON.stringify({ value: "same" });
    const [first, second] = await Promise.all([
      worker.fetch(
        new Request("https://api.test/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers,
          body,
        }),
      ),
      worker.fetch(
        new Request("https://api.test/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers,
          body,
        }),
      ),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const payloads = [await first.json(), await second.json()] as {
      replayed: boolean;
    }[];
    expect(payloads.some((payload) => payload.replayed === false)).toBe(true);
    expect(payloads.some((payload) => payload.replayed === true)).toBe(true);
  });
});
