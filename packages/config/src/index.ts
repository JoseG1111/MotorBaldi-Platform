import { z } from "zod";

export type PlatformEnvironment =
  "local" | "development" | "staging" | "production";
export interface QueueMessage {
  eventId: string;
  requestId: string;
}
interface CommonBindings {
  ENVIRONMENT: PlatformEnvironment;
}

export interface ApiBindings extends CommonBindings {
  DB: D1Database;
  PRIVATE_BUCKET: R2Bucket;
  EVENTS_QUEUE: Queue<QueueMessage>;
  IDEMPOTENCY_COORDINATOR: DurableObjectNamespace;
  OUTBOX_COORDINATOR: DurableObjectNamespace;
  API_RATE_LIMITER: RateLimit;
  AUTH_RATE_LIMITER: RateLimit;
  AUTH_BASE_URL: string;
  CORS_ORIGINS: string;
  AUTH_SECRET: string;
  AUTH_SECRETS?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_EXPECTED_HOSTNAME?: string;
  TURNSTILE_BYPASS_TOKEN?: string;
  EMAIL_PROVIDER?: string;
}
export interface BackgroundWorkerBindings extends CommonBindings {
  DB: D1Database;
  PRIVATE_BUCKET: R2Bucket;
  EVENTS_QUEUE: Queue<QueueMessage>;
  OUTBOX_COORDINATOR: DurableObjectNamespace;
  MALWARE_SCANNER_PROVIDER?: string;
}
export interface PortalBindings extends CommonBindings {
  API_SERVICE: Fetcher;
}
export interface AdminBindings extends CommonBindings {
  API_SERVICE: Fetcher;
}

export interface ApiConfig {
  environment: PlatformEnvironment;
  authBaseUrl: string;
  corsOrigins: readonly string[];
  authSecret: string;
  authSecrets: readonly { version: number; value: string }[];
  turnstileSecretKey?: string;
  turnstileExpectedHostname?: string;
  turnstileBypassToken?: string;
  emailProvider: "UNCONFIGURED" | "DEVELOPMENT_SINK";
}
export interface BackgroundWorkerConfig {
  environment: PlatformEnvironment;
  malwareScannerProvider: "UNCONFIGURED" | "DETERMINISTIC_TEST";
}

const environment = z.enum(["local", "development", "staging", "production"]);
const remote = (value: PlatformEnvironment) =>
  value === "staging" || value === "production";
const secretEntry = z
  .object({
    version: z.number().int().nonnegative(),
    value: z.string().min(32),
  })
  .strict();
const apiSchema = z.object({
  ENVIRONMENT: environment,
  AUTH_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  AUTH_SECRETS: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_EXPECTED_HOSTNAME: z.string().optional(),
  TURNSTILE_BYPASS_TOKEN: z.string().optional(),
  EMAIL_PROVIDER: z
    .enum(["UNCONFIGURED", "DEVELOPMENT_SINK"])
    .default("UNCONFIGURED"),
});

function parseSecrets(value?: string) {
  if (!value) return [];
  try {
    return z.array(secretEntry).min(1).parse(JSON.parse(value));
  } catch {
    throw new Error("Invalid configuration: AUTH_SECRETS");
  }
}

export function apiConfig(env: ApiBindings): ApiConfig {
  const parsed = apiSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      "Invalid configuration: " +
        [
          ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
        ].join(", "),
    );
  const c = parsed.data;
  const corsOrigins = c.CORS_ORIGINS.split(",").map((origin) => origin.trim());
  if (corsOrigins.some((origin) => new URL(origin).origin !== origin))
    throw new Error("CORS requires exact origins");
  const authSecrets = parseSecrets(c.AUTH_SECRETS);
  if (remote(c.ENVIRONMENT)) {
    if (
      !c.AUTH_BASE_URL.startsWith("https://") ||
      corsOrigins.some((origin) => !origin.startsWith("https://"))
    )
      throw new Error("Remote environments require HTTPS origins");
    if (!authSecrets.length)
      throw new Error(
        "Remote environments require AUTH_SECRETS rotation keyring",
      );
    if (c.TURNSTILE_BYPASS_TOKEN)
      throw new Error("Turnstile bypass is forbidden remotely");
    if (!env.API_RATE_LIMITER || !env.AUTH_RATE_LIMITER)
      throw new Error("Remote environments require both rate limit bindings");
  }
  return {
    environment: c.ENVIRONMENT,
    authBaseUrl: c.AUTH_BASE_URL,
    corsOrigins,
    authSecret: c.AUTH_SECRET,
    authSecrets,
    turnstileSecretKey: c.TURNSTILE_SECRET_KEY,
    turnstileExpectedHostname: c.TURNSTILE_EXPECTED_HOSTNAME,
    turnstileBypassToken: c.TURNSTILE_BYPASS_TOKEN,
    emailProvider: c.EMAIL_PROVIDER,
  };
}

const workerSchema = z.object({
  ENVIRONMENT: environment,
  MALWARE_SCANNER_PROVIDER: z
    .enum(["UNCONFIGURED", "DETERMINISTIC_TEST"])
    .default("UNCONFIGURED"),
});
export function backgroundWorkerConfig(
  env: BackgroundWorkerBindings,
): BackgroundWorkerConfig {
  const c = workerSchema.parse(env);
  if (remote(c.ENVIRONMENT) && c.MALWARE_SCANNER_PROVIDER !== "UNCONFIGURED")
    throw new Error("Remote scanner must be explicitly integrated");
  return {
    environment: c.ENVIRONMENT,
    malwareScannerProvider: c.MALWARE_SCANNER_PROVIDER,
  };
}
