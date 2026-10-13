import { sha256Hex } from "@motorbaldi/shared";
import type { DeliveryReceipt } from "./providers.js";

export interface AuthEmailTransportConfig {
  environment: string;
  enabled?: boolean;
  apiKey?: string;
  from?: string;
  fromVerified?: boolean;
  /** Development only: one to ten distinct SHA-256 hashes of trimmed lowercase emails. */
  testRecipientHashes?: string;
  authBaseUrl: string;
  trustedOrigins: readonly string[];
}
export type AuthEmailKind = "VERIFY_EMAIL" | "PASSWORD_RESET";
const email =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const validEmail = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 254 && email.test(value);
const opaque = /^[A-Za-z0-9_-]{16,512}$/;
const jwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function developmentRecipients(value: unknown): ReadonlySet<string> | null {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}(,[a-f0-9]{64}){0,9}$/.test(value)
  )
    return null;
  const hashes = value.split(",");
  return new Set(hashes).size === hashes.length ? new Set(hashes) : null;
}

/** Dedicated transactional auth templates. Never enables general notification delivery.
 * Provider acceptance is not a delivery claim; ambiguous failures are never retried.
 */
export function createAuthEmailTransport(
  config: AuthEmailTransportConfig,
  fetcher: typeof fetch = fetch,
) {
  const recipients =
    config.environment === "development"
      ? developmentRecipients(config.testRecipientHashes)
      : null;
  if (
    (config.environment === "development" && !recipients) ||
    !["development", "staging", "production"].includes(config.environment) ||
    config.enabled !== true ||
    config.fromVerified !== true ||
    !validEmail(config.from) ||
    typeof config.apiKey !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(config.apiKey) ||
    !exactHttpsOrigin(config.authBaseUrl) ||
    !config.trustedOrigins.length ||
    !config.trustedOrigins.every(exactHttpsOrigin)
  )
    return null;
  const apiKey = config.apiKey;
  const from = config.from;
  function actionUrl(
    kind: AuthEmailKind,
    raw: string,
    token: string,
  ): string | null {
    try {
      const url = new URL(raw);
      if (
        url.origin !== config.authBaseUrl ||
        url.username ||
        url.password ||
        url.hash ||
        raw.length > 8192 ||
        !["VERIFY_EMAIL", "PASSWORD_RESET"].includes(kind)
      )
        return null;
      const expected =
        kind === "VERIFY_EMAIL"
          ? "/api/v1/auth/verify-email"
          : `/api/v1/auth/reset-password/${token}`;
      if (
        url.pathname !== expected ||
        (kind === "VERIFY_EMAIL" ? !jwt.test(token) : !opaque.test(token))
      )
        return null;
      const keys = [...url.searchParams.keys()];
      if (
        keys.length !== (kind === "VERIFY_EMAIL" ? 2 : 1) ||
        keys.filter((k) => k === "callbackURL").length !== 1 ||
        (kind === "VERIFY_EMAIL" &&
          (keys.filter((k) => k === "token").length !== 1 ||
            url.searchParams.get("token") !== token))
      )
        return null;
      const callback = new URL(url.searchParams.get("callbackURL") ?? "");
      if (
        !config.trustedOrigins.includes(callback.origin) ||
        callback.username ||
        callback.password ||
        callback.search ||
        callback.hash ||
        callback.pathname !==
          (kind === "VERIFY_EMAIL" ? "/login" : "/reset-password")
      )
        return null;
      if (kind === "PASSWORD_RESET") {
        callback.searchParams.set("token", token);
        return callback.href;
      }
      return url.href;
    } catch {
      return null;
    }
  }
  return {
    async send(request: {
      kind: AuthEmailKind;
      recipient: string;
      url: string;
      token: string;
      idempotencyKey: string;
      signal: AbortSignal;
    }): Promise<DeliveryReceipt> {
      const link = actionUrl(request.kind, request.url, request.token);
      const recipient =
        typeof request.recipient === "string"
          ? request.recipient.trim().toLowerCase()
          : "";
      if (
        !validEmail(recipient) ||
        !link ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(request.idempotencyKey)
      )
        return { status: "REJECTED", code: "INVALID_REQUEST" };
      if (request.signal.aborted)
        return { status: "UNAVAILABLE", code: "CALLER_ABORTED" };
      if (recipients && !recipients.has(await sha256Hex(recipient)))
        return { status: "REJECTED", code: "AUTHORITY_DENIED" };
      try {
        const response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          redirect: "manual",
          signal: request.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": request.idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [recipient],
            subject:
              request.kind === "VERIFY_EMAIL"
                ? "Verifica tu correo en MotorBaldi"
                : "Restablece tu contraseña de MotorBaldi",
            text:
              request.kind === "VERIFY_EMAIL"
                ? `Confirma tu correo en MotorBaldi: ${link}\nEste enlace vence en 1 hora. Si no creaste esta cuenta, ignora este mensaje.`
                : `Restablece tu contraseña de MotorBaldi: ${link}\nEste enlace vence en 1 hora y solo puede usarse una vez. Si no solicitaste este cambio, ignora este mensaje.`,
          }),
        });
        if (!response.ok)
          return response.status >= 400 &&
            response.status < 500 &&
            ![408, 409, 429].includes(response.status)
            ? { status: "REJECTED", code: "TRANSPORT_REJECTED" }
            : { status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" };
        const body: unknown = await response.json();
        if (
          !body ||
          typeof body !== "object" ||
          !("id" in body) ||
          typeof body.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.id)
        )
          return { status: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" };
        return { status: "ACCEPTED", providerReference: body.id };
      } catch {
        return { status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" };
      }
    },
  };
}
