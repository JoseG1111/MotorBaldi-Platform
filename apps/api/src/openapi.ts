export const openapi = {
  openapi: "3.0.3",
  info: { title: "MotorBaldi Platform Foundation", version: "0.1.0" },
  paths: {
    "/health": {
      get: { responses: { "200": { description: "Worker responding" } } },
    },
    "/health/dependencies": {
      get: {
        responses: {
          "200": { description: "Dependency status" },
          "503": {
            description: "Database unavailable or environment mismatch",
          },
        },
      },
    },
    "/api/v1/principal": {
      get: {
        responses: {
          "200": { description: "Authenticated principal" },
          "401": { description: "Authentication required" },
        },
      },
    },
    "/api/v1/openapi.json": {
      get: { responses: { "200": { description: "OpenAPI document" } } },
    },
  },
};
