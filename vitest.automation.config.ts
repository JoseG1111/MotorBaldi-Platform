import { cloudflarePool } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/automation/**/*.test.ts"],
    // Bound isolate startup contention as the real D1/API suite grows.
    maxWorkers: 4,
    pool: cloudflarePool({
      wrangler: { configPath: "apps/api/wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-08-22",
        bindings: {
          ENVIRONMENT: "development",
          AUTH_BASE_URL:
            "https://motorbaldi-api-development.josegbarrios2.workers.dev",
          CORS_ORIGINS:
            "https://motorbaldi-admin-development.josegbarrios2.workers.dev",
          AUTH_SECRET: "local-test-auth-secret-that-is-long-enough",
          AUTH_SECRETS:
            '[{"version":1,"value":"local-test-auth-rotation-secret-long-enough"}]',
          EMAIL_PROVIDER: "DEVELOPMENT_SINK",
          DEVELOPMENT_AUTOMATION_ENABLED: "true",
          DEVELOPMENT_AUTOMATION_CREDENTIAL: JSON.stringify({
            keyId: "33333333-3333-4333-8333-333333333333",
            version: 1,
            secret: "local_automation_test_key_material_12345678",
          }),
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
