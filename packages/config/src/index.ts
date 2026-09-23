import { z } from "zod";

export type PlatformEnvironment =
  "local" | "development" | "staging" | "production";

export interface QueueMessage {
  eventId: string;
  requestId: string;
}

export interface PlatformBindings {
  DB: D1Database;
  PRIVATE_BUCKET?: R2Bucket;
  EVENTS_QUEUE?: Queue<QueueMessage>;
  IDEMPOTENCY_COORDINATOR?: DurableObjectNamespace;
  OUTBOX_COORDINATOR?: DurableObjectNamespace;
  API_RATE_LIMITER?: RateLimit;
  AUTH_RATE_LIMITER?: RateLimit;
  ENVIRONMENT: PlatformEnvironment;
  AUTH_BASE_URL: string;
  CORS_ORIGINS: string;
  AUTH_SECRET: string;
  AUTH_SECRETS?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_BYPASS_TOKEN?: string;
  EMAIL_PROVIDER?: string;
  MALWARE_SCANNER_PROVIDER?: string;
}

export interface RuntimeConfig {
  environment: PlatformEnvironment;
  authBaseUrl: string;
  corsOrigins: readonly string[];
  authSecret: string;
  authSecrets: readonly { version: number; value: string }[];
  turnstileSecretKey?: string;
  turnstileBypassToken?: string;
  emailProvider: "UNCONFIGURED" | "DEVELOPMENT_SINK";
  malwareScannerProvider: "UNCONFIGURED" | "DETERMINISTIC_TEST";
}

const secretEntry = z
  .object({
    version: z.number().int().nonnegative(),
    value: z.string().min(32),
  })
  .strict();

const schema = z.object({
  ENVIRONMENT: z.enum(["local", "development", "staging", "production"]),
  AUTH_BASE_URL: z.string().url(),
  CORS_ORIGINS: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  AUTH_SECRETS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return [];
      try {
        return z.array(secretEntry).min(1).parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid AUTH_SECRETS" });
        return z.NEVER;
      }
    }),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_BYPASS_TOKEN: z.string().optional(),
  EMAIL_PROVIDER: z
    .enum(["UNCONFIGURED", "DEVELOPMENT_SINK"])
    .default("UNCONFIGURED"),
  MALWARE_SCANNER_PROVIDER: z
    .enum(["UNCONFIGURED", "DETERMINISTIC_TEST"])
    .default("UNCONFIGURED"),
});

export function runtimeConfig(env: PlatformBindings): RuntimeConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      "Invalid configuration: " +
        [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(
          ", ",
        ),
    );
  }
  const c = parsed.data;
  const corsOrigins = c.CORS_ORIGINS.split(",").map((origin) => origin.trim());
  if (corsOrigins.some((origin) => new URL(origin).origin !== origin))
    throw new Error("CORS requires exact origins");
  if (["staging", "production"].includes(c.ENVIRONMENT)) {
    if (
      !c.AUTH_BASE_URL.startsWith("https://") ||
      corsOrigins.some((origin) => !origin.startsWith("https://"))
    ) {
      throw new Error("Remote environments require HTTPS origins");
    }
    if (!c.AUTH_SECRETS.length)
      throw new Error(
        "Remote environments require AUTH_SECRETS rotation keyring",
      );
    if (c.TURNSTILE_BYPASS_TOKEN)
      throw new Error("Turnstile bypass is forbidden remotely");
    if (c.EMAIL_PROVIDER !== "UNCONFIGURED")
      throw new Error(
        "Production email provider is intentionally unconfigured in CF-0",
      );
  }
  return {
    environment: c.ENVIRONMENT,
    authBaseUrl: c.AUTH_BASE_URL,
    corsOrigins,
    authSecret: c.AUTH_SECRET,
    authSecrets: c.AUTH_SECRETS,
    turnstileSecretKey: c.TURNSTILE_SECRET_KEY,
    turnstileBypassToken: c.TURNSTILE_BYPASS_TOKEN,
    emailProvider: c.EMAIL_PROVIDER,
    malwareScannerProvider: c.MALWARE_SCANNER_PROVIDER,
  };
}
