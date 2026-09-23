import { cloudflarePool } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/workers/**/*.test.ts"],
    pool: cloudflarePool({
      wrangler: { configPath: "apps/api/wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: {
          ENVIRONMENT: "development",
          AUTH_BASE_URL: "https://api.test",
          CORS_ORIGINS: "https://api.test",
          AUTH_SECRET: "local-test-auth-secret-that-is-long-enough",
          AUTH_SECRETS: '[{"version":1,"value":"local-test-auth-rotation-secret-long-enough"}]',
          EMAIL_PROVIDER: "DEVELOPMENT_SINK",
          MALWARE_SCANNER_PROVIDER: "DETERMINISTIC_TEST",
        },
        d1Databases: ["DB"],
        r2Buckets: ["PRIVATE_BUCKET"],
        queueProducers: { EVENTS_QUEUE: "motorbaldi-events-dev" },
        durableObjects: {
          IDEMPOTENCY_COORDINATOR: "IdempotencyCoordinator",
          OUTBOX_COORDINATOR: "OutboxCoordinator",
        },
      },
    }),
  },
});
