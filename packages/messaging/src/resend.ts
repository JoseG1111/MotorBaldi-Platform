import type { CommunicationTransport, DeliveryReceipt } from "./providers.js";

export interface ResendTransportConfig {
  environment: string;
  enabled?: boolean;
  apiKey?: string;
  from?: string;
  /** Explicit operator assertion that the sender domain is verified in Resend. */
  fromVerified?: boolean;
}
const email =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && email.test(value);
}
function receipt(
  status: "UNKNOWN" | "REJECTED" | "UNAVAILABLE",
  code:
    | "INVALID_REQUEST"
    | "CHANNEL_UNAVAILABLE"
    | "CALLER_ABORTED"
    | "TRANSPORT_REJECTED"
    | "TRANSPORT_UNKNOWN"
    | "INVALID_PROVIDER_RESPONSE"
    | "RECONCILIATION_UNAVAILABLE",
): DeliveryReceipt {
  return { status, code };
}
/** Development only. Provider acceptance never claims delivery. No automatic retries.
 * Resend retains idempotency keys for 24h; the caller must durably prevent later resends.
 */
export function createResendTransport(
  config: ResendTransportConfig,
  fetcher: typeof fetch = fetch,
): CommunicationTransport | null {
  if (
    config.environment !== "development" ||
    config.enabled !== true ||
    config.fromVerified !== true ||
    !validEmail(config.from) ||
    typeof config.apiKey !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(config.apiKey)
  )
    return null;
  const apiKey = config.apiKey;
  const from = config.from;
  async function invoke(
    url: string,
    init: RequestInit,
    expectedId?: string,
  ): Promise<DeliveryReceipt> {
    try {
      const response = await fetcher(url, { ...init, redirect: "manual" });
      if (!response.ok) {
        // A generic 429, timeout or server error does not prove non-acceptance.
        return expectedId === undefined &&
          response.status >= 400 &&
          response.status < 500 &&
          ![408, 409, 429].includes(response.status)
          ? receipt("REJECTED", "TRANSPORT_REJECTED")
          : receipt("UNKNOWN", "TRANSPORT_UNKNOWN");
      }
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("id" in body) ||
        typeof body.id !== "string" ||
        !reference.test(body.id) ||
        (expectedId !== undefined && body.id !== expectedId)
      )
        return receipt("UNKNOWN", "INVALID_PROVIDER_RESPONSE");
      return { status: "ACCEPTED", providerReference: body.id };
    } catch {
      return receipt("UNKNOWN", "TRANSPORT_UNKNOWN");
    }
  }
  return {
    capabilities: Object.freeze({
      availability: "AVAILABLE",
      channels: Object.freeze(["EMAIL"] as const),
      idempotency: "PROVIDER_ENFORCED",
      reconciliation: "SUPPORTED",
    }),
    async send(channel, request) {
      if (channel !== "EMAIL")
        return receipt("UNAVAILABLE", "CHANNEL_UNAVAILABLE");
      const variables = request.variables;
      const expiresOn = variables?.expiresOn;
      if (
        !validEmail(request.recipient) ||
        !key.test(request.idempotencyKey) ||
        request.idempotencyKey !== request.id ||
        request.template !== "vehicle-document-expiry" ||
        !variables ||
        Object.keys(variables).sort().join(",") !==
          "daysBefore,documentType,expiresOn" ||
        !["SOAT", "RTM"].includes(variables.documentType ?? "") ||
        !["30", "15", "7", "1"].includes(variables.daysBefore ?? "") ||
        typeof expiresOn !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) ||
        !Number.isFinite(Date.parse(expiresOn)) ||
        new Date(expiresOn).toISOString().slice(0, 10) !== expiresOn
      )
        return receipt("REJECTED", "INVALID_REQUEST");
      if (request.signal.aborted)
        return receipt("UNAVAILABLE", "CALLER_ABORTED");
      return invoke("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        signal: request.signal,
        body: JSON.stringify({
          from,
          to: [request.recipient],
          subject: `Recordatorio de vencimiento de ${variables.documentType}`,
          text: `Tu documento ${variables.documentType} vence el ${expiresOn}. Faltan ${variables.daysBefore} días para su vencimiento.`,
        }),
      });
    },
    async reconcile(request) {
      if (!request.providerReference)
        return receipt("UNAVAILABLE", "RECONCILIATION_UNAVAILABLE");
      if (!reference.test(request.providerReference))
        return receipt("REJECTED", "INVALID_REQUEST");
      if (request.signal.aborted)
        return receipt("UNAVAILABLE", "CALLER_ABORTED");
      return invoke(
        `https://api.resend.com/emails/${encodeURIComponent(request.providerReference)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: request.signal,
        },
        request.providerReference,
      );
    },
  };
}
