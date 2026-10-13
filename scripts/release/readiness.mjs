import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apps = ["api", "worker", "portal", "admin"];
const environments = ["development", "staging", "production"];
const gates = [
  "AUTH_EMAIL_DELIVERY_ENABLED",
  "WOMPI_PRODUCTION_RELEASE_AUTHORIZED",
  "NOTIFICATION_EXTERNAL_DELIVERY_ENABLED",
  "NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED",
  "NOTIFICATION_EMAIL_RELEASE_AUTHORIZED",
  "NOTIFICATION_WHATSAPP_RELEASE_AUTHORIZED",
];
const credentialNames = [
  "AUTH_SECRET",
  "AUTH_SECRETS",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_BYPASS_TOKEN",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "WOMPI_PUBLIC_KEY",
  "WOMPI_PRIVATE_KEY",
  "WOMPI_INTEGRITY_SECRET",
  "WOMPI_EVENTS_SECRET",
  "META_WHATSAPP_ACCESS_TOKEN",
  "META_WHATSAPP_APP_SECRET",
  "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "DEVELOPMENT_AUTOMATION_CREDENTIAL",
];
const placeholder = /REPLACE_WITH|PLACEHOLDER|YOUR[_-]|<[^>]*>/i;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** JSONC lexer preserves URL/comment text inside strings; errors never echo input. */
export function parseWranglerManifest(text) {
  try {
    let clean = "",
      string = false,
      escaped = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index],
        next = text[index + 1];
      if (string) {
        clean += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') {
        string = true;
        clean += char;
        continue;
      }
      if (char === "/" && next === "/") {
        while (index < text.length && text[index] !== "\n") index++;
        clean += "\n";
        continue;
      }
      if (char === "/" && next === "*") {
        index += 2;
        while (
          index < text.length &&
          !(text[index] === "*" && text[index + 1] === "/")
        )
          index++;
        if (index >= text.length) throw new Error();
        index++;
        clean += " ";
        continue;
      }
      clean += char;
    }
    let result = "";
    string = false;
    escaped = false;
    for (let index = 0; index < clean.length; index++) {
      const char = clean[index];
      if (string) {
        result += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') string = false;
        continue;
      }
      if (char === '"') string = true;
      if (char === "," && /^[\s]*[}\]]/.test(clean.slice(index + 1))) continue;
      result += char;
    }
    const parsed = JSON.parse(result);
    if (!object(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("INVALID_WRANGLER_MANIFEST");
  }
}

function httpsOrigin(value) {
  if (typeof value !== "string" || placeholder.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      value === url.origin &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function resourceValue(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value) &&
    !placeholder.test(value)
  );
}
function binding(config, section, field, name) {
  const rows = section
    .split(".")
    .reduce((value, part) => value?.[part], config);
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter((row) => object(row) && row[field] === name);
  return matches.length === 1 ? matches[0] : null;
}

/** Source-only checks. A positive source result never establishes provisioned resources,
 * secret readiness, deployed versions, applied migrations or verified remote behavior.
 */
export function assessReleaseReadiness(manifests) {
  const issues = [];
  const resources = [];
  const issue = (environment, app, code, field) =>
    issues.push({ environment, app, code, field });
  const remember = (environment, app, kind, value) => {
    if (typeof value === "string" && !placeholder.test(value))
      resources.push({ environment, app, kind, value });
  };
  const requireResource = (environment, app, value, kind, field) => {
    if (!resourceValue(value))
      issue(
        environment,
        app,
        placeholder.test(String(value))
          ? "PLACEHOLDER_RESOURCE"
          : "MISSING_OR_INVALID_RESOURCE",
        field,
      );
    else remember(environment, app, kind, value);
  };
  const details = {};
  for (const environment of environments) {
    const configs = {};
    for (const app of apps) {
      const manifest = manifests?.[app];
      const config = manifest?.env?.[environment];
      if (!object(manifest) || !object(config)) {
        issue(
          environment,
          app,
          "MISSING_ENVIRONMENT_MANIFEST",
          `env.${environment}`,
        );
        continue;
      }
      configs[app] = config;
      requireResource(environment, app, config.name, "worker", "name");
      if (config.vars?.ENVIRONMENT !== environment)
        issue(environment, app, "ENVIRONMENT_MISMATCH", "vars.ENVIRONMENT");
      if (typeof manifest.main !== "string" || manifest.main !== "src/index.ts")
        issue(environment, app, "INVALID_ENTRYPOINT", "main");
      if (
        typeof manifest.compatibility_date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(manifest.compatibility_date) ||
        !Number.isFinite(Date.parse(manifest.compatibility_date)) ||
        new Date(manifest.compatibility_date).toISOString().slice(0, 10) !==
          manifest.compatibility_date
      )
        issue(
          environment,
          app,
          "INVALID_COMPATIBILITY_DATE",
          "compatibility_date",
        );
      const bindingRules =
        app === "api"
          ? {
              d1_databases: ["binding", ["DB"]],
              r2_buckets: ["binding", ["PRIVATE_BUCKET"]],
              "queues.producers": ["binding", ["EVENTS_QUEUE"]],
              "durable_objects.bindings": [
                "name",
                ["IDEMPOTENCY_COORDINATOR", "OUTBOX_COORDINATOR"],
              ],
              ratelimits: ["name", ["API_RATE_LIMITER", "AUTH_RATE_LIMITER"]],
              services: ["binding", []],
            }
          : app === "worker"
            ? {
                d1_databases: ["binding", ["DB"]],
                r2_buckets: ["binding", ["PRIVATE_BUCKET"]],
                "queues.producers": ["binding", ["EVENTS_QUEUE"]],
                "durable_objects.bindings": ["name", ["OUTBOX_COORDINATOR"]],
                ratelimits: ["name", []],
                services: ["binding", []],
              }
            : {
                services: ["binding", ["API_SERVICE"]],
                ratelimits: ["name", []],
              };
      for (const [section, [field, expected]] of Object.entries(bindingRules)) {
        const rows = section
          .split(".")
          .reduce((value, part) => value?.[part], config);
        if (
          rows !== undefined &&
          (!Array.isArray(rows) ||
            rows.some(
              (row) => !object(row) || !expected.includes(row[field]),
            ) ||
            new Set(rows.map((row) => row?.[field])).size !== rows.length)
        )
          issue(environment, app, "UNEXPECTED_OR_DUPLICATE_BINDING", section);
      }
      for (const name of credentialNames)
        if (Object.hasOwn(config.vars ?? {}, name))
          issue(environment, app, "CREDENTIAL_IN_SOURCE_VARS", `vars.${name}`);
      for (const name of gates) {
        const value = config.vars?.[name];
        if (value !== undefined && value !== "false")
          issue(
            environment,
            app,
            value === "true"
              ? "EXTERNAL_GATE_ENABLED"
              : "INVALID_EXTERNAL_GATE",
            `vars.${name}`,
          );
      }
      if (
        environment === "development" &&
        (config.vars?.AUTH_EMAIL_DELIVERY_ENABLED === "true" ||
          config.vars?.AUTH_EMAIL_TEST_RECIPIENT_SHA256 !== undefined)
      ) {
        const hashes = config.vars?.AUTH_EMAIL_TEST_RECIPIENT_SHA256;
        if (
          typeof hashes !== "string" ||
          !/^[a-f0-9]{64}(,[a-f0-9]{64}){0,9}$/.test(hashes) ||
          new Set(hashes.split(",")).size !== hashes.split(",").length
        )
          issue(
            environment,
            app,
            "INVALID_AUTH_EMAIL_TEST_ALLOWLIST",
            "vars.AUTH_EMAIL_TEST_RECIPIENT_SHA256",
          );
      }
      if (
        environment !== "development" &&
        Object.keys(config.vars ?? {}).some((name) =>
          name.startsWith("DEVELOPMENT_AUTOMATION_"),
        )
      )
        issue(
          environment,
          app,
          "DEVELOPMENT_AUTOMATION_OUTSIDE_DEVELOPMENT",
          "vars.DEVELOPMENT_AUTOMATION",
        );
    }
    const api = configs.api,
      worker = configs.worker;
    for (const app of ["api", "worker"]) {
      const config = configs[app];
      if (!config) continue;
      const db = binding(config, "d1_databases", "binding", "DB");
      requireResource(
        environment,
        app,
        db?.database_name,
        "database-name",
        "d1_databases.DB.database_name",
      );
      if (
        !db ||
        typeof db.database_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          db.database_id,
        )
      )
        issue(
          environment,
          app,
          placeholder.test(String(db?.database_id))
            ? "PLACEHOLDER_RESOURCE"
            : "MISSING_OR_INVALID_DATABASE_ID",
          "d1_databases.DB.database_id",
        );
      else
        remember(environment, app, "database-id", db.database_id.toLowerCase());
      if (app === "api" && db?.migrations_dir !== "../../migrations")
        issue(
          environment,
          app,
          "INVALID_MIGRATIONS_DIRECTORY",
          "d1_databases.DB.migrations_dir",
        );
      const bucket = binding(config, "r2_buckets", "binding", "PRIVATE_BUCKET");
      requireResource(
        environment,
        app,
        bucket?.bucket_name,
        "bucket",
        "r2_buckets.PRIVATE_BUCKET.bucket_name",
      );
      if (
        bucket?.jurisdiction !== undefined &&
        !["default", "eu", "fedramp"].includes(bucket.jurisdiction)
      )
        issue(
          environment,
          app,
          "INVALID_BUCKET_JURISDICTION",
          "r2_buckets.PRIVATE_BUCKET.jurisdiction",
        );
      const producer = binding(
        config,
        "queues.producers",
        "binding",
        "EVENTS_QUEUE",
      );
      requireResource(
        environment,
        app,
        producer?.queue,
        "queue",
        "queues.producers.EVENTS_QUEUE.queue",
      );
    }
    if (api) {
      if (!httpsOrigin(api.vars?.AUTH_BASE_URL))
        issue(
          environment,
          "api",
          "INVALID_OR_PLACEHOLDER_HTTPS_ORIGIN",
          "vars.AUTH_BASE_URL",
        );
      else remember(environment, "api", "origin", api.vars.AUTH_BASE_URL);
      const origins =
        typeof api.vars?.CORS_ORIGINS === "string"
          ? api.vars.CORS_ORIGINS.split(",")
          : [];
      if (
        origins.length < 2 ||
        new Set(origins).size !== origins.length ||
        !origins.every(httpsOrigin)
      )
        issue(
          environment,
          "api",
          "INVALID_OR_PLACEHOLDER_TRUSTED_ORIGINS",
          "vars.CORS_ORIGINS",
        );
      else
        for (const origin of origins)
          remember(environment, "api", "origin", origin);
      const publicOrigins =
        typeof api.vars?.PUBLIC_CORS_ORIGINS === "string"
          ? api.vars.PUBLIC_CORS_ORIGINS.split(",")
          : [];
      if (publicOrigins.some((origin) => !httpsOrigin(origin)))
        issue(
          environment,
          "api",
          "INVALID_PUBLIC_ORIGIN",
          "vars.PUBLIC_CORS_ORIGINS",
        );
      else
        for (const origin of publicOrigins)
          remember(environment, "api", "origin", origin);
      if (!["UNCONFIGURED", "RESEND"].includes(api.vars?.EMAIL_PROVIDER))
        issue(
          environment,
          "api",
          "INVALID_REMOTE_EMAIL_PROVIDER",
          "vars.EMAIL_PROVIDER",
        );
      if (
        api.vars?.WOMPI_ENVIRONMENT !== undefined &&
        api.vars.WOMPI_ENVIRONMENT !==
          (environment === "production" ? "PRODUCTION" : "SANDBOX")
      )
        issue(
          environment,
          "api",
          "PAYMENT_ENVIRONMENT_MISMATCH",
          "vars.WOMPI_ENVIRONMENT",
        );
      for (const [name, limit] of [
        ["API_RATE_LIMITER", 120],
        ["AUTH_RATE_LIMITER", 10],
      ]) {
        const rate = binding(api, "ratelimits", "name", name);
        if (
          !rate ||
          typeof rate.namespace_id !== "string" ||
          !/^\d+$/.test(rate.namespace_id) ||
          !Number.isInteger(rate.simple?.limit) ||
          rate.simple.limit < 1 ||
          rate.simple.limit > limit ||
          rate.simple?.period !== 60
        )
          issue(
            environment,
            "api",
            "MISSING_OR_INVALID_RATE_LIMIT",
            `ratelimits.${name}`,
          );
        else remember(environment, "api", "rate-namespace", rate.namespace_id);
      }
      const namespaceIds = (
        Array.isArray(api.ratelimits) ? api.ratelimits : []
      ).map((row) => row?.namespace_id);
      if (
        namespaceIds.length > 1 &&
        new Set(namespaceIds).size !== namespaceIds.length
      )
        issue(
          environment,
          "api",
          "RATE_NAMESPACE_REUSE",
          "ratelimits.namespace_id",
        );
      for (const [name, className] of [
        ["IDEMPOTENCY_COORDINATOR", "IdempotencyCoordinator"],
        ["OUTBOX_COORDINATOR", "OutboxCoordinator"],
      ]) {
        const durable = binding(api, "durable_objects.bindings", "name", name);
        if (
          !durable ||
          durable.class_name !== className ||
          durable.script_name !== undefined ||
          manifests.api?.exports?.[className]?.type !== "durable-object" ||
          manifests.api?.exports?.[className]?.storage !== "sqlite"
        )
          issue(
            environment,
            "api",
            "MISSING_OR_INVALID_DURABLE_OBJECT",
            `durable_objects.${name}`,
          );
      }
    }
    if (worker) {
      if (worker.vars?.MALWARE_SCANNER_PROVIDER !== "UNCONFIGURED")
        issue(
          environment,
          "worker",
          "INVALID_REMOTE_SCANNER_PROVIDER",
          "vars.MALWARE_SCANNER_PROVIDER",
        );
      const consumer =
        Array.isArray(worker.queues?.consumers) &&
        worker.queues.consumers.length === 1
          ? worker.queues.consumers[0]
          : null;
      requireResource(
        environment,
        "worker",
        consumer?.queue,
        "queue",
        "queues.consumers.queue",
      );
      requireResource(
        environment,
        "worker",
        consumer?.dead_letter_queue,
        "queue",
        "queues.consumers.dead_letter_queue",
      );
      if (consumer && consumer.queue === consumer.dead_letter_queue)
        issue(
          environment,
          "worker",
          "QUEUE_DLQ_REUSE",
          "queues.consumers.dead_letter_queue",
        );
      if (
        consumer?.queue !==
        binding(worker, "queues.producers", "binding", "EVENTS_QUEUE")?.queue
      )
        issue(
          environment,
          "worker",
          "QUEUE_PRODUCER_CONSUMER_MISMATCH",
          "queues",
        );
      const outbox = binding(
        worker,
        "durable_objects.bindings",
        "name",
        "OUTBOX_COORDINATOR",
      );
      if (
        !outbox ||
        outbox.class_name !== "OutboxCoordinator" ||
        outbox.script_name !== api?.name
      )
        issue(
          environment,
          "worker",
          "INVALID_OUTBOX_SERVICE_TARGET",
          "durable_objects.OUTBOX_COORDINATOR",
        );
      const crons = (worker.triggers ?? manifests.worker?.triggers)?.crons;
      if (
        !Array.isArray(crons) ||
        !crons.length ||
        !crons.every(
          (cron) =>
            typeof cron === "string" && cron.trim().split(/\s+/).length === 5,
        )
      )
        issue(
          environment,
          "worker",
          "MISSING_OR_INVALID_CRON",
          "triggers.crons",
        );
    }
    if (api && worker)
      for (const [section, field, name, fields] of [
        ["d1_databases", "binding", "DB", ["database_id", "database_name"]],
        [
          "r2_buckets",
          "binding",
          "PRIVATE_BUCKET",
          ["bucket_name", "jurisdiction"],
        ],
        ["queues.producers", "binding", "EVENTS_QUEUE", ["queue"]],
      ]) {
        const left = binding(api, section, field, name),
          right = binding(worker, section, field, name);
        if (!left || !right || fields.some((key) => left[key] !== right[key]))
          issue(
            environment,
            "worker",
            "API_WORKER_RESOURCE_MISMATCH",
            `${section}.${name}`,
          );
      }
    for (const app of ["portal", "admin"]) {
      const config = configs[app];
      if (!config) continue;
      const service = binding(config, "services", "binding", "API_SERVICE");
      if (
        !service ||
        service.service !== api?.name ||
        (service.environment !== undefined &&
          service.environment !== environment)
      )
        issue(
          environment,
          app,
          "INVALID_API_SERVICE_TARGET",
          "services.API_SERVICE",
        );
      for (const section of [
        "d1_databases",
        "r2_buckets",
        "queues",
        "durable_objects",
      ])
        if (config[section] !== undefined)
          issue(environment, app, "UNEXPECTED_PRIVILEGED_BINDING", section);
    }
    details[environment] = {
      sourceReady: false,
      gates: Object.fromEntries(
        gates.map((name) => [
          name,
          apps.some((app) => configs[app]?.vars?.[name] === "true")
            ? "ENABLED"
            : "DISABLED_BY_DEFAULT",
        ]),
      ),
      remoteVerification: "NOT_PERFORMED",
    };
  }
  const resourceEnvironments = new Map();
  for (const resource of resources) {
    const key = `${resource.kind}:${resource.value}`;
    if (!resourceEnvironments.has(key))
      resourceEnvironments.set(key, new Set());
    resourceEnvironments.get(key).add(resource.environment);
  }
  for (const resource of resources)
    if (resourceEnvironments.get(`${resource.kind}:${resource.value}`).size > 1)
      issue(
        resource.environment,
        resource.app,
        "CROSS_ENVIRONMENT_RESOURCE_REUSE",
        resource.kind,
      );
  const unique = [
    ...new Map(issues.map((item) => [JSON.stringify(item), item])).values(),
  ].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  for (const environment of environments)
    details[environment].sourceReady = !unique.some(
      (item) => item.environment === environment,
    );
  return {
    schemaVersion: 1,
    mode: "READ_ONLY_SOURCE_PREPARATION",
    ready: false,
    preparationReady:
      details.staging.sourceReady &&
      details.production.sourceReady &&
      details.development.sourceReady,
    remoteVerification: "NOT_PERFORMED",
    environments: details,
    issues: unique,
    resourceInventory: resources.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  };
}

/** Only explicitly allowed artifact/SQL files are hashed. Symlinks and secret files are excluded. */
export function inventoryFiles(root, kind) {
  const files = [],
    issues = [];
  const allowed =
    kind === "migrations"
      ? /^\d{4}_[A-Za-z0-9_-]+\.sql$/
      : /\.(?:js|mjs|css|wasm|map|json|html|webp|png|svg)$/i;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const absolute = join(directory, entry.name),
        path = relative(root, absolute).split("\\").join("/");
      if (entry.isSymbolicLink()) {
        issues.push({ code: "SYMLINK_EXCLUDED", path });
        continue;
      }
      if (entry.isDirectory()) {
        if (kind === "artifacts" && !entry.name.startsWith(".")) walk(absolute);
        continue;
      }
      if (
        !entry.isFile() ||
        !allowed.test(entry.name) ||
        /(?:^|[._-])(?:secret|credentials|dotenv)(?:[._-]|$)/i.test(entry.name)
      )
        continue;
      const bytes = readFileSync(absolute);
      files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
      throw new Error();
    walk(root);
  } catch {
    issues.push({ code: "MISSING_OR_UNREADABLE_INVENTORY", path: "." });
  }
  if (!files.length) issues.push({ code: "EMPTY_INVENTORY", path: "." });
  if (kind === "migrations") {
    const prefixes = files.map((file) => Number(file.path.slice(0, 4)));
    if (
      new Set(prefixes).size !== prefixes.length ||
      prefixes.some((value, index) => value !== index + 1)
    )
      issues.push({ code: "NONCONTIGUOUS_MIGRATION_INVENTORY", path: "." });
  }
  return {
    files,
    sha256: sha256(JSON.stringify(files)),
    issues,
    complete: issues.length === 0,
  };
}

export function collectReleaseReadiness(root) {
  const manifests = {},
    manifestInventory = [],
    loadingIssues = [];
  for (const app of apps) {
    const path = `apps/${app}/wrangler.jsonc`;
    try {
      const absolute = join(root, path);
      if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink())
        throw new Error();
      const contents = readFileSync(absolute);
      manifests[app] = parseWranglerManifest(contents.toString("utf8"));
      manifestInventory.push({
        path,
        bytes: contents.length,
        sha256: sha256(contents),
      });
    } catch {
      loadingIssues.push({
        code: "MISSING_OR_INVALID_WRANGLER_MANIFEST",
        path,
      });
    }
  }
  const report = assessReleaseReadiness(manifests);
  const migrations = inventoryFiles(join(root, "migrations"), "migrations");
  const artifacts = {};
  for (const environment of ["staging", "production"])
    for (const app of apps)
      artifacts[`${app}-${environment}`] = inventoryFiles(
        join(root, "dist", `${app}-${environment}`),
        "artifacts",
      );
  let git;
  try {
    const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty =
      execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).length !== 0;
    if (!/^[a-f0-9]{40,64}$/.test(revision) || !/^[a-f0-9]{40,64}$/.test(tree))
      throw new Error();
    git = {
      revision,
      tree,
      worktreeDirty: dirty,
      contentMatchToArtifacts: "UNVERIFIED",
    };
  } catch {
    git = {
      revision: null,
      tree: null,
      worktreeDirty: null,
      contentMatchToArtifacts: "UNVERIFIED",
    };
    loadingIssues.push({ code: "GIT_REVISION_UNAVAILABLE", path: "." });
  }
  const inventory = {
    git,
    manifests: manifestInventory,
    migrations,
    artifacts,
  };
  return {
    ...report,
    preparationReady:
      report.preparationReady &&
      !loadingIssues.length &&
      migrations.complete &&
      Object.values(artifacts).every((item) => item.complete),
    loadingIssues,
    inventory,
    inventorySha256: sha256(JSON.stringify(inventory)),
    operationalPrerequisites: [
      "Actual per-environment resource and deployment inventory",
      "Protected secret presence and rotation verification without secret values",
      "Deployed artifact to source revision matching",
      "Applied migration history and D1 environment identity",
      "Tested rollback version compatibility with current schema",
      "Verified D1 backup/export and private R2 recovery procedure",
      "Isolated restore rehearsal and integrity checks",
      "Queue/DLQ and canonical outbox recovery/replay plan",
      "Operator approved recovery targets and incident ownership",
      "Separate authorization for production deployment and any destructive operation",
    ],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node scripts/release/readiness.mjs\n");
    process.exitCode = 2;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const report = collectReleaseReadiness(root);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.preparationReady ? 0 : 1;
  }
}
