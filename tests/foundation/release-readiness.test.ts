import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runtimePath = "../../scripts/release/readiness.mjs";
const {
  assessReleaseReadiness,
  collectReleaseReadiness,
  inventoryFiles,
  parseWranglerManifest,
} = await import(runtimePath);

function environmentFixture(environment: string, index: number) {
  const database = {
    binding: "DB",
    database_name: `core-${environment}`,
    database_id: `00000000-0000-4000-8000-00000000000${index}`,
  };
  const bucket = {
    binding: "PRIVATE_BUCKET",
    bucket_name: `private-${environment}`,
  };
  const producers = [
    { binding: "EVENTS_QUEUE", queue: `events-${environment}` },
  ];
  return {
    api: {
      name: `api-${environment}`,
      vars: {
        ENVIRONMENT: environment,
        AUTH_BASE_URL: `https://api.${environment}.example.test`,
        CORS_ORIGINS: `https://portal.${environment}.example.test,https://admin.${environment}.example.test`,
        EMAIL_PROVIDER: "UNCONFIGURED",
        AUTH_EMAIL_DELIVERY_ENABLED: "false",
        WOMPI_PRODUCTION_RELEASE_AUTHORIZED: "false",
        NOTIFICATION_EXTERNAL_DELIVERY_ENABLED: "false",
        NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED: "false",
      },
      d1_databases: [{ ...database, migrations_dir: "../../migrations" }],
      r2_buckets: [{ ...bucket }],
      queues: { producers: structuredClone(producers) },
      durable_objects: {
        bindings: [
          {
            name: "IDEMPOTENCY_COORDINATOR",
            class_name: "IdempotencyCoordinator",
          },
          { name: "OUTBOX_COORDINATOR", class_name: "OutboxCoordinator" },
        ],
      },
      ratelimits: [
        {
          name: "API_RATE_LIMITER",
          namespace_id: `${index}001`,
          simple: { limit: 120, period: 60 },
        },
        {
          name: "AUTH_RATE_LIMITER",
          namespace_id: `${index}002`,
          simple: { limit: 10, period: 60 },
        },
      ],
    },
    worker: {
      name: `worker-${environment}`,
      vars: {
        ENVIRONMENT: environment,
        MALWARE_SCANNER_PROVIDER: "UNCONFIGURED",
        NOTIFICATION_EXTERNAL_DELIVERY_ENABLED: "false",
      },
      d1_databases: [{ ...database }],
      r2_buckets: [{ ...bucket }],
      queues: {
        producers: structuredClone(producers),
        consumers: [
          {
            queue: `events-${environment}`,
            dead_letter_queue: `events-dlq-${environment}`,
          },
        ],
      },
      durable_objects: {
        bindings: [
          {
            name: "OUTBOX_COORDINATOR",
            class_name: "OutboxCoordinator",
            script_name: `api-${environment}`,
          },
        ],
      },
    },
    portal: {
      name: `portal-${environment}`,
      vars: { ENVIRONMENT: environment },
      services: [{ binding: "API_SERVICE", service: `api-${environment}` }],
    },
    admin: {
      name: `admin-${environment}`,
      vars: { ENVIRONMENT: environment },
      services: [{ binding: "API_SERVICE", service: `api-${environment}` }],
    },
  };
}
function fixture() {
  const development = environmentFixture("development", 1),
    staging = environmentFixture("staging", 2),
    production = environmentFixture("production", 3);
  const base = { main: "src/index.ts", compatibility_date: "2026-09-23" };
  return {
    api: {
      ...base,
      exports: {
        IdempotencyCoordinator: { type: "durable-object", storage: "sqlite" },
        OutboxCoordinator: { type: "durable-object", storage: "sqlite" },
      },
      env: {
        development: development.api,
        staging: staging.api,
        production: production.api,
      },
    },
    worker: {
      ...base,
      triggers: { crons: ["*/5 * * * *"] },
      env: {
        development: development.worker,
        staging: staging.worker,
        production: production.worker,
      },
    },
    portal: {
      ...base,
      env: {
        development: development.portal,
        staging: staging.portal,
        production: production.portal,
      },
    },
    admin: {
      ...base,
      env: {
        development: development.admin,
        staging: staging.admin,
        production: production.admin,
      },
    },
  };
}
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "motorbaldi-readiness-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("read-only release source readiness", () => {
  it("accepts complete isolated source while withholding remote readiness", () => {
    const result = assessReleaseReadiness(fixture());
    expect(result.issues).toEqual([]);
    expect(result.preparationReady).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.remoteVerification).toBe("NOT_PERFORMED");
    expect(result.environments.production.sourceReady).toBe(true);
    expect(
      result.environments.production.gates.AUTH_EMAIL_DELIVERY_ENABLED,
    ).toBe("DISABLED_BY_DEFAULT");
  });
  it("parses JSONC without corrupting HTTPS URLs or comment characters inside strings", () => {
    expect(
      parseWranglerManifest(
        '{/* comment */"url":"https://api.test/a//b", "literal":"comma,}",// line\n"rows":[1,2,],}',
      ),
    ).toEqual({
      url: "https://api.test/a//b",
      literal: "comma,}",
      rows: [1, 2],
    });
    for (const malformed of [
      '{"key":',
      "{/* unterminated",
      "[1,2]",
      '{"key":"synthetic-sensitive-value"} trailing',
    ])
      expect(() => parseWranglerManifest(malformed)).toThrow(
        "INVALID_WRANGLER_MANIFEST",
      );
  });
  it("rejects malformed binding collections, extra privilege and reused API/auth namespaces", () => {
    const manifests = fixture();
    manifests.api.env.production.ratelimits[1]!.namespace_id =
      manifests.api.env.production.ratelimits[0]!.namespace_id;
    manifests.api.env.production.d1_databases.push({
      ...manifests.api.env.production.d1_databases[0]!,
      binding: "UNEXPECTED_DATABASE",
    });
    Object.assign(manifests.portal.env.production, {
      r2_buckets: [
        { binding: "PRIVATE_BUCKET", bucket_name: "unexpected-access" },
      ],
    });
    const result = assessReleaseReadiness(manifests);
    expect(result.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        "RATE_NAMESPACE_REUSE",
        "UNEXPECTED_OR_DUPLICATE_BINDING",
        "UNEXPECTED_PRIVILEGED_BINDING",
      ]),
    );
    const malformed = assessReleaseReadiness({
      api: {
        env: { production: { vars: "invalid", ratelimits: {}, queues: [] } },
      },
    });
    expect(malformed.preparationReady).toBe(false);
    expect(malformed.ready).toBe(false);
    expect(
      malformed.issues.map((issue: { code: string }) => issue.code),
    ).toContain("MISSING_ENVIRONMENT_MANIFEST");
  });
  it("detects incomplete production and does not inherit Development bindings", () => {
    const manifests = fixture();
    manifests.api.env.production.d1_databases[0]!.database_id =
      "REPLACE_WITH_PRODUCTION_D1_DATABASE_ID";
    manifests.api.env.production.vars.AUTH_BASE_URL =
      "https://REPLACE_WITH_PRODUCTION_API_WORKER_URL";
    manifests.portal.env.production.services = [];
    manifests.worker.env.production.queues.consumers = [];
    const result = assessReleaseReadiness(manifests);
    expect(result.preparationReady).toBe(false);
    expect(result.environments.production.sourceReady).toBe(false);
    expect(result.environments.staging.sourceReady).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        "PLACEHOLDER_RESOURCE",
        "INVALID_OR_PLACEHOLDER_HTTPS_ORIGIN",
        "INVALID_API_SERVICE_TARGET",
        "MISSING_OR_INVALID_RESOURCE",
      ]),
    );
  });
  it("rejects cross-environment D1, private bucket, queues, Workers, origins and rate namespaces", () => {
    const manifests = fixture();
    manifests.api.env.production.d1_databases = structuredClone(
      manifests.api.env.staging.d1_databases,
    );
    manifests.worker.env.production.d1_databases = structuredClone(
      manifests.worker.env.staging.d1_databases,
    );
    manifests.api.env.production.r2_buckets = structuredClone(
      manifests.api.env.staging.r2_buckets,
    );
    manifests.worker.env.production.r2_buckets = structuredClone(
      manifests.worker.env.staging.r2_buckets,
    );
    manifests.api.env.production.queues = structuredClone(
      manifests.api.env.staging.queues,
    );
    manifests.worker.env.production.queues = structuredClone(
      manifests.worker.env.staging.queues,
    );
    manifests.admin.env.production.name = manifests.admin.env.staging.name;
    manifests.api.env.production.vars.AUTH_BASE_URL =
      manifests.api.env.staging.vars.AUTH_BASE_URL;
    manifests.api.env.production.ratelimits = structuredClone(
      manifests.api.env.staging.ratelimits,
    );
    const result = assessReleaseReadiness(manifests);
    const reused = result.issues.filter(
      (issue: { code: string }) =>
        issue.code === "CROSS_ENVIRONMENT_RESOURCE_REUSE",
    );
    expect(
      new Set(reused.map((issue: { field: string }) => issue.field)),
    ).toEqual(
      new Set([
        "database-id",
        "database-name",
        "bucket",
        "queue",
        "worker",
        "origin",
        "rate-namespace",
      ]),
    );
    expect(result.environments.production.sourceReady).toBe(false);
    expect(result.environments.staging.sourceReady).toBe(false);
    expect(result.environments.development.sourceReady).toBe(true);
  });
  it("rejects enabled or malformed gates and never exposes credential values in reports", () => {
    const manifests = fixture();
    manifests.api.env.production.vars.WOMPI_PRODUCTION_RELEASE_AUTHORIZED =
      "true";
    manifests.api.env.staging.vars.AUTH_EMAIL_DELIVERY_ENABLED = "true";
    manifests.worker.env.production.vars.NOTIFICATION_EXTERNAL_DELIVERY_ENABLED =
      "yes";
    Object.assign(manifests.api.env.production.vars, {
      AUTH_SECRET: "synthetic-sensitive-value",
      DEVELOPMENT_AUTOMATION_ENABLED: "true",
      TURNSTILE_BYPASS_TOKEN: "synthetic-bypass-value",
    });
    const result = assessReleaseReadiness(manifests);
    expect(result.preparationReady).toBe(false);
    expect(result.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        "EXTERNAL_GATE_ENABLED",
        "INVALID_EXTERNAL_GATE",
        "CREDENTIAL_IN_SOURCE_VARS",
        "DEVELOPMENT_AUTOMATION_OUTSIDE_DEVELOPMENT",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-value");
    expect(JSON.stringify(result)).not.toContain("synthetic-bypass-value");
  });
  it("rejects independent Production notification channel release switches and incomplete Development auth test allowlists", () => {
    for (const gate of [
      "NOTIFICATION_EMAIL_RELEASE_AUTHORIZED",
      "NOTIFICATION_WHATSAPP_RELEASE_AUTHORIZED",
    ]) {
      const manifests = fixture();
      Object.assign(manifests.worker.env.production.vars, { [gate]: "true" });
      const result = assessReleaseReadiness(manifests);
      expect(result.preparationReady).toBe(false);
      expect(result.issues).toContainEqual({
        environment: "production",
        app: "worker",
        code: "EXTERNAL_GATE_ENABLED",
        field: "vars." + gate,
      });
    }
    const manifests = fixture();
    manifests.api.env.development.vars.AUTH_EMAIL_DELIVERY_ENABLED = "true";
    expect(assessReleaseReadiness(manifests).issues).toContainEqual({
      environment: "development",
      app: "api",
      code: "INVALID_AUTH_EMAIL_TEST_ALLOWLIST",
      field: "vars.AUTH_EMAIL_TEST_RECIPIENT_SHA256",
    });
    Object.assign(manifests.api.env.development.vars, {
      AUTH_EMAIL_TEST_RECIPIENT_SHA256: "a".repeat(64),
    });
    expect(
      assessReleaseReadiness(manifests).issues.some(
        (issue: { code: string }) =>
          issue.code === "INVALID_AUTH_EMAIL_TEST_ALLOWLIST",
      ),
    ).toBe(false);
  });
  it("detects environment, binding, queue/DLQ and service isolation failures", () => {
    const manifests = fixture();
    manifests.api.env.production.vars.ENVIRONMENT = "staging";
    manifests.worker.env.production.r2_buckets[0]!.bucket_name =
      "unmatched-private-bucket";
    manifests.worker.env.production.queues.consumers[0]!.dead_letter_queue =
      "events-production";
    manifests.worker.env.production.durable_objects.bindings[0]!.script_name =
      "api-development";
    manifests.portal.env.production.services[0]!.service = "api-development";
    manifests.api.env.production.vars.CORS_ORIGINS =
      "https://portal.production.example.test/path,http://admin.production.example.test";
    manifests.api.env.production.ratelimits[1]!.simple.limit = 100;
    const result = assessReleaseReadiness(manifests);
    expect(result.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        "ENVIRONMENT_MISMATCH",
        "API_WORKER_RESOURCE_MISMATCH",
        "QUEUE_DLQ_REUSE",
        "INVALID_OUTBOX_SERVICE_TARGET",
        "INVALID_API_SERVICE_TARGET",
        "INVALID_OR_PLACEHOLDER_TRUSTED_ORIGINS",
        "MISSING_OR_INVALID_RATE_LIMIT",
      ]),
    );
  });
  it("uses deterministic inventory digests and notices artifact modification without printing bytes", () => {
    const root = directory();
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "worker.js"), "export default {};");
    writeFileSync(join(root, "assets", "logo.svg"), "<svg></svg>");
    writeFileSync(join(root, ".env"), "SYNTHETIC_PRIVATE_VALUE=fixture-only");
    writeFileSync(join(root, "credentials.json"), '{"synthetic":"private"}');
    const first = inventoryFiles(root, "artifacts"),
      second = inventoryFiles(root, "artifacts");
    expect(first).toEqual(second);
    expect(first.complete).toBe(true);
    expect(first.files.map((file: { path: string }) => file.path)).toEqual([
      "assets/logo.svg",
      "worker.js",
    ]);
    expect(first.files[1].sha256).toBe(
      createHash("sha256").update("export default {};").digest("hex"),
    );
    expect(JSON.stringify(first)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    writeFileSync(join(root, "worker.js"), "export default {changed:true};");
    expect(inventoryFiles(root, "artifacts").sha256).not.toBe(first.sha256);
    symlinkSync(join(root, ".env"), join(root, "linked.js"));
    const excluded = inventoryFiles(root, "artifacts");
    expect(excluded.complete).toBe(false);
    expect(excluded.issues).toContainEqual({
      code: "SYMLINK_EXCLUDED",
      path: "linked.js",
    });
    expect(excluded.files).toHaveLength(2);
  });
  it("detects empty and noncontiguous SQL migration inventories", () => {
    const root = directory();
    expect(inventoryFiles(root, "migrations").complete).toBe(false);
    writeFileSync(
      join(root, "0001_first.sql"),
      "CREATE TABLE synthetic (id TEXT);",
    );
    writeFileSync(
      join(root, "0003_third.sql"),
      "CREATE INDEX synthetic_id ON synthetic(id);",
    );
    expect(inventoryFiles(root, "migrations").issues).toContainEqual({
      code: "NONCONTIGUOUS_MIGRATION_INVENTORY",
      path: ".",
    });
    writeFileSync(
      join(root, "0002_second.sql"),
      "ALTER TABLE synthetic ADD COLUMN note TEXT;",
    );
    expect(inventoryFiles(root, "migrations").complete).toBe(true);
  });
  it("collects missing source/build/git evidence as explicit deficiencies without creating resources", () => {
    const root = directory();
    const result = collectReleaseReadiness(root);
    expect(result.ready).toBe(false);
    expect(result.preparationReady).toBe(false);
    expect(result.loadingIssues).toContainEqual({
      code: "GIT_REVISION_UNAVAILABLE",
      path: ".",
    });
    expect(
      result.loadingIssues.filter(
        (issue: { code: string }) =>
          issue.code === "MISSING_OR_INVALID_WRANGLER_MANIFEST",
      ),
    ).toHaveLength(4);
    expect(result.inventory.migrations.complete).toBe(false);
    expect(result.inventory.artifacts["api-production"].complete).toBe(false);
    expect(result.inventory.git.contentMatchToArtifacts).toBe("UNVERIFIED");
    expect(result.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.operationalPrerequisites).toContain(
      "Separate authorization for production deployment and any destructive operation",
    );
  });
});
