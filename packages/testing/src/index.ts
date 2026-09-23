import type { PlatformBindings } from "@motorbaldi/config";

export function testSecrets() {
  return {
    AUTH_SECRET: "local-test-auth-secret-that-is-long-enough",
    AUTH_SECRETS: JSON.stringify([
      { version: 1, value: "local-test-auth-rotation-secret-long-enough" },
    ]),
  };
}

export function testVars(overrides: Partial<PlatformBindings> = {}) {
  return {
    ENVIRONMENT: "development",
    AUTH_BASE_URL: "http://localhost:8787",
    CORS_ORIGINS: "http://localhost:5173,http://localhost:5174",
    EMAIL_PROVIDER: "DEVELOPMENT_SINK",
    MALWARE_SCANNER_PROVIDER: "DETERMINISTIC_TEST",
    ...testSecrets(),
    ...overrides,
  };
}
