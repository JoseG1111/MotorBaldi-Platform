import { z } from "zod";

/** Official protocols: docs.wompi.co/docs/colombia/{fuentes-de-pago,eventos,transacciones,tokens-de-aceptacion,widget-checkout-web}/. */
export type WompiEnvironment = "SANDBOX" | "PRODUCTION";
export type WompiSourceType = "CARD" | "NEQUI";
const statusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "DECLINED",
  "VOIDED",
  "ERROR",
]);
const referenceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const amountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const tokenSchema = z.string().min(1).max(8192);
const currencySchema = z.literal("COP");
const transactionSchema = z.object({
  id: identifierSchema,
  reference: referenceSchema,
  amount_in_cents: amountSchema,
  currency: currencySchema,
  status: statusSchema,
});
export type WompiTransaction = {
  id: string;
  reference: string;
  amountMinor: number;
  currency: "COP";
  status: z.infer<typeof statusSchema>;
};
export type WompiChargeResult =
  | WompiTransaction
  | {
      id: null;
      reference: string;
      amountMinor: number;
      currency: "COP";
      status: "UNKNOWN";
    };
export class WompiError extends Error {
  constructor(public readonly code: string) {
    // Do not expose provider bodies, credentials or customer details in errors.
    super(code);
    this.name = "WompiError";
  }
}
function keyPrefix(environment: WompiEnvironment) {
  if (environment !== "SANDBOX" && environment !== "PRODUCTION")
    throw new WompiError("WOMPI_ENVIRONMENT_INVALID");
  return environment === "SANDBOX" ? "test" : "prod";
}
function validateSecret(secret: string, prefix: string) {
  if (!new RegExp("^" + prefix + "[A-Za-z0-9_-]{1,256}$").test(secret))
    throw new WompiError("WOMPI_KEY_ENVIRONMENT_MISMATCH");
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** SHA256 concatenation, not HMAC/asymmetric signing. Never send the integrity secret to a browser. */
export async function wompiIntegritySignature(input: {
  environment: WompiEnvironment;
  reference: string;
  amountMinor: number;
  currency: "COP";
  integritySecret: string;
  expirationTime?: string;
}) {
  const env = keyPrefix(input.environment);
  validateSecret(input.integritySecret, env + "_integrity_");
  referenceSchema.parse(input.reference);
  amountSchema.parse(input.amountMinor);
  currencySchema.parse(input.currency);
  if (input.expirationTime !== undefined)
    z.iso.datetime({ precision: 3 }).parse(input.expirationTime);
  return sha256(
    input.reference +
      input.amountMinor +
      input.currency +
      (input.expirationTime ?? "") +
      input.integritySecret,
  );
}
function equalChecksum(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right))
    return false;
  let difference = 0;
  const a = left.toLowerCase(),
    b = right.toLowerCase();
  for (let index = 0; index < 64; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function signedValue(data: unknown, path: string) {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path) ||
    path.length > 256
  )
    throw new WompiError("WOMPI_EVENT_INVALID");
  let value: unknown = data;
  for (const part of path.split(".")) {
    if (
      ["__proto__", "prototype", "constructor"].includes(part) ||
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    )
      throw new WompiError("WOMPI_EVENT_INVALID");
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value === "string" && value.length <= 8192) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new WompiError("WOMPI_EVENT_INVALID");
}
/** Only signed fields are returned as authoritative; unsigned reference/currency require reconciliation against the recorded transaction. */
export async function verifyWompiWebhook(
  payload: unknown,
  options: {
    environment: WompiEnvironment;
    eventsSecret: string;
    checksumHeader?: string;
  },
) {
  const expected = keyPrefix(options.environment);
  validateSecret(options.eventsSecret, expected + "_events_");
  const parsed = z
    .object({
      event: z.literal("transaction.updated"),
      environment: z.enum(["test", "prod"]),
      timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      data: z.record(z.string(), z.unknown()),
      signature: z.object({
        properties: z.array(z.string()).min(3).max(50),
        checksum: z.string(),
      }),
    })
    .safeParse(payload);
  if (!parsed.success || parsed.data.environment !== expected)
    throw new WompiError("WOMPI_EVENT_INVALID");
  const event = parsed.data,
    properties = event.signature.properties;
  if (
    new Set(properties).size !== properties.length ||
    ![
      "transaction.id",
      "transaction.status",
      "transaction.amount_in_cents",
    ].every((path) => properties.includes(path))
  )
    throw new WompiError("WOMPI_EVENT_INVALID");
  const checksum = await sha256(
    properties.map((path) => signedValue(event.data, path)).join("") +
      event.timestamp +
      options.eventsSecret,
  );
  if (
    !equalChecksum(checksum, event.signature.checksum) ||
    (options.checksumHeader !== undefined &&
      !equalChecksum(checksum, options.checksumHeader))
  )
    throw new WompiError("WOMPI_EVENT_SIGNATURE_INVALID");
  const transaction = z
    .object({
      id: identifierSchema,
      status: statusSchema,
      amount_in_cents: amountSchema,
    })
    .safeParse(event.data.transaction);
  if (!transaction.success) throw new WompiError("WOMPI_EVENT_INVALID");
  return {
    id: transaction.data.id,
    status: transaction.data.status,
    amountMinor: transaction.data.amount_in_cents,
    reference: properties.includes("transaction.reference")
      ? referenceSchema.parse(signedValue(event.data, "transaction.reference"))
      : null,
    currency: properties.includes("transaction.currency")
      ? currencySchema.parse(signedValue(event.data, "transaction.currency"))
      : null,
    timestamp: event.timestamp,
  };
}

function sanitizedTransaction(data: unknown): WompiTransaction {
  const parsed = transactionSchema.safeParse(data);
  if (!parsed.success) throw new WompiError("WOMPI_RESPONSE_INVALID");
  const value = parsed.data;
  return {
    id: value.id,
    reference: value.reference,
    amountMinor: value.amount_in_cents,
    currency: value.currency,
    status: value.status,
  };
}
const chargeInputSchema = z.object({
  reference: referenceSchema,
  amountMinor: amountSchema,
  currency: currencySchema,
  sourceId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sourceType: z.enum(["CARD", "NEQUI"]),
  customerEmail: z.email().max(320),
  acceptanceToken: tokenSchema,
  personalDataToken: tokenSchema,
  recurrent: z.boolean().optional(),
});
export type WompiChargeInput = z.infer<typeof chargeInputSchema>;
export function createWompiAdapter(options: {
  environment: WompiEnvironment;
  privateKey: string;
  publicKey: string;
  integritySecret: string;
  productionApproved?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const config = { ...options };
  const prefix = keyPrefix(config.environment);
  if (config.environment === "PRODUCTION" && config.productionApproved !== true)
    throw new WompiError("WOMPI_PRODUCTION_DISABLED");
  validateSecret(config.privateKey, "prv_" + prefix + "_");
  validateSecret(config.publicKey, "pub_" + prefix + "_");
  validateSecret(config.integritySecret, prefix + "_integrity_");
  const base =
    config.environment === "SANDBOX"
      ? "https://sandbox.wompi.co/v1"
      : "https://production.wompi.co/v1";
  const fetcher = config.fetch ?? fetch;
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(30000)
    .parse(config.timeoutMs ?? 10000);
  async function request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new WompiError("WOMPI_REQUEST_ABORTED");
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new WompiError("WOMPI_REQUEST_UNKNOWN"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    try {
      // No redirects: credentials cannot cross to an unapproved host. No automatic retry.
      const response = await Promise.race([
        fetcher(base + path, {
          ...init,
          signal: controller.signal,
          redirect: "error",
        }),
        aborted,
      ]);
      if (!response.ok)
        throw new WompiError(
          response.status >= 500 ||
            response.status === 408 ||
            response.status === 429
            ? "WOMPI_REQUEST_UNKNOWN"
            : "WOMPI_REQUEST_REJECTED",
        );
      const body: unknown = await Promise.race([response.json(), aborted]);
      const envelope = z.object({ data: z.unknown() }).safeParse(body);
      if (!envelope.success) throw new WompiError("WOMPI_RESPONSE_INVALID");
      return envelope.data.data;
    } catch (error) {
      if (error instanceof WompiError) throw error;
      throw new WompiError("WOMPI_REQUEST_UNKNOWN");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (rejectAbort)
        controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
  const privateHeaders = {
    authorization: "Bearer " + config.privateKey,
    "content-type": "application/json",
    accept: "application/json",
  };
  return {
    async getMerchantAcceptance(signal?: AbortSignal) {
      // The key-in-URL merchant endpoint is deprecated on October 31, 2026.
      const data = await request(
        "/merchants/info",
        {
          headers: {
            "x-merchant-public-key": config.publicKey,
            accept: "application/json",
          },
        },
        signal,
      );
      const contract = z.object({
        acceptance_token: tokenSchema,
        permalink: z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            ["wompi.co", "wompi.com"].some(
              (host) =>
                url.hostname === host || url.hostname.endsWith("." + host),
            )
          );
        }),
      });
      const merchant = z
        .object({
          presigned_acceptance: contract,
          presigned_personal_data_auth: contract,
        })
        .safeParse(data);
      if (!merchant.success) throw new WompiError("WOMPI_RESPONSE_INVALID");
      return {
        acceptance: {
          token: merchant.data.presigned_acceptance.acceptance_token,
          permalink: merchant.data.presigned_acceptance.permalink,
        },
        personalData: {
          token: merchant.data.presigned_personal_data_auth.acceptance_token,
          permalink: merchant.data.presigned_personal_data_auth.permalink,
        },
      };
    },
    async createSource(
      token: string,
      type: WompiSourceType,
      customerEmail: string,
      acceptanceToken: string,
      personalDataToken: string,
      signal?: AbortSignal,
    ): Promise<{
      id: number | null;
      type: WompiSourceType;
      status: "AVAILABLE" | "VOIDED" | "UNKNOWN";
    }> {
      z.enum(["CARD", "NEQUI"]).parse(type);
      tokenSchema.parse(acceptanceToken);
      tokenSchema.parse(personalDataToken);
      z.email().max(320).parse(customerEmail);
      if (
        !new RegExp(
          "^" +
            (type === "CARD" ? "tok_" : "nequi_") +
            prefix +
            "_[A-Za-z0-9_-]{1,256}$",
        ).test(token)
      )
        throw new WompiError("WOMPI_TOKEN_ENVIRONMENT_MISMATCH");
      if (type === "NEQUI") {
        const approval = await request(
          "/tokens/nequi/" + encodeURIComponent(token),
          {
            headers: {
              authorization: "Bearer " + config.publicKey,
              accept: "application/json",
            },
          },
          signal,
        );
        const parsed = z
          .object({ id: z.literal(token), status: z.literal("APPROVED") })
          .safeParse(approval);
        if (!parsed.success)
          throw new WompiError("WOMPI_NEQUI_APPROVAL_REQUIRED");
      }
      try {
        const data = await request(
          "/payment_sources",
          {
            method: "POST",
            headers: privateHeaders,
            body: JSON.stringify({
              type,
              token,
              customer_email: customerEmail,
              acceptance_token: acceptanceToken,
              accept_personal_auth: personalDataToken,
            }),
          },
          signal,
        );
        const parsed = z
          .object({
            id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            type: z.literal(type),
            status: z.enum(["AVAILABLE", "VOIDED"]),
          })
          .safeParse(data);
        if (!parsed.success) throw new WompiError("WOMPI_RESPONSE_INVALID");
        return parsed.data;
      } catch (error) {
        if (
          error instanceof WompiError &&
          error.code === "WOMPI_REQUEST_REJECTED"
        )
          throw error;
        return { id: null, type, status: "UNKNOWN" };
      }
    },
    async chargeSource(
      input: WompiChargeInput,
      signal?: AbortSignal,
    ): Promise<WompiChargeResult> {
      const parsed = chargeInputSchema.parse(input);
      const signature = await wompiIntegritySignature({
        environment: config.environment,
        integritySecret: config.integritySecret,
        reference: parsed.reference,
        amountMinor: parsed.amountMinor,
        currency: parsed.currency,
      });
      try {
        const data = await request(
          "/transactions",
          {
            method: "POST",
            headers: privateHeaders,
            body: JSON.stringify({
              reference: parsed.reference,
              amount_in_cents: parsed.amountMinor,
              currency: parsed.currency,
              payment_source_id: parsed.sourceId,
              ...(parsed.sourceType === "CARD"
                ? { payment_method: { installments: 1 } }
                : {}),
              customer_email: parsed.customerEmail,
              acceptance_token: parsed.acceptanceToken,
              accept_personal_auth: parsed.personalDataToken,
              signature,
              ...(parsed.recurrent !== undefined
                ? { recurrent: parsed.recurrent }
                : {}),
            }),
          },
          signal,
        );
        const transaction = sanitizedTransaction(data);
        if (
          transaction.reference !== parsed.reference ||
          transaction.amountMinor !== parsed.amountMinor ||
          transaction.currency !== parsed.currency
        )
          throw new WompiError("WOMPI_RESPONSE_INVALID");
        return transaction;
      } catch (error) {
        if (
          error instanceof WompiError &&
          error.code === "WOMPI_REQUEST_REJECTED"
        )
          throw error;
        // Reference uniqueness alone cannot prove exactly-once after an ambiguous POST.
        return {
          id: null,
          reference: parsed.reference,
          amountMinor: parsed.amountMinor,
          currency: parsed.currency,
          status: "UNKNOWN",
        };
      }
    },
    async reconcile(transactionId: string, signal?: AbortSignal) {
      identifierSchema.parse(transactionId);
      const transaction = sanitizedTransaction(
        await request(
          "/transactions/" + encodeURIComponent(transactionId),
          { headers: privateHeaders },
          signal,
        ),
      );
      if (transaction.id !== transactionId)
        throw new WompiError("WOMPI_RESPONSE_INVALID");
      return transaction;
    },
    // No reference search endpoint is asserted by the official integration docs.
  };
}
