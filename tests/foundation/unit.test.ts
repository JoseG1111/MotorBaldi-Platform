import { describe, expect, it } from "vitest";
import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import { canonical } from "@motorbaldi/shared";
import { openapi } from "@motorbaldi/api/openapi";

describe("foundation contracts", () => {
  it("builds stable idempotency scopes", () => {
    const scope = buildIdempotencyScope({
      accountId: "018f0000-0000-7000-8000-000000000001",
      operation: "foundation.test",
    });
    expect(scope.scope).toBe(
      canonical({
        accountId: "018f0000-0000-7000-8000-000000000001",
        operation: "foundation.test",
        organizationId: null,
      }),
    );
    expect(scope.ttlSeconds).toBe(3600);
  });

  it("publishes the foundation OpenAPI routes", () => {
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/health/dependencies",
        "/api/v1/principal",
        "/api/v1/openapi.json",
      ]),
    );
  });
});
