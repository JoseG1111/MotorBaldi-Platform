import type { CommunicationTransport, DeliveryReceipt } from "./providers.js";

/** Operator configuration only. No client-controlled endpoint or template selection. */
export interface MetaWhatsAppTransportConfig {
  enabled?: boolean;
  environment: string;
  accessToken?: string;
  phoneNumberId?: string;
  apiVersion?: string;
  approvedTemplateName?: string;
  templateLanguage?: "es" | "es_CO" | "es_ES";
}
export type MetaWhatsAppFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function dateOnly(value: unknown): value is string {
  if (!matches(value, /^\d{4}-\d{2}-\d{2}$/)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Development-only Cloud API port. Acceptance is not delivery. No automatic retry,
 * provider deduplication, or reconciliation is promised; the dispatch ledger must
 * quarantine ambiguous sends. Meta-owned protocol examples:
 * https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive
 */
export function createMetaWhatsAppTransport(
  config: MetaWhatsAppTransportConfig,
  fetcher: MetaWhatsAppFetch = (url, init) => fetch(url, init),
): CommunicationTransport {
  // Snapshot trusted configuration so later mutations cannot change dispatch.
  const settings = { ...config };
  const available =
    settings.enabled === true &&
    settings.environment === "development" &&
    matches(settings.accessToken, /^[\x21-\x7e]{1,4096}$/) &&
    matches(settings.phoneNumberId, /^[1-9][0-9]{0,31}$/) &&
    matches(settings.apiVersion, /^v[1-9][0-9]?\.0$/) &&
    matches(settings.approvedTemplateName, /^[a-z][a-z0-9_]{0,127}$/) &&
    ["es", "es_CO", "es_ES"].includes(settings.templateLanguage ?? "");
  const unavailable: DeliveryReceipt = {
    status: "UNAVAILABLE",
    code: "TRANSPORT_UNAVAILABLE",
  };
  return {
    capabilities: Object.freeze({
      availability: available ? "AVAILABLE" : "UNAVAILABLE",
      channels: Object.freeze(available ? ["WHATSAPP" as const] : []),
      idempotency: "UNSUPPORTED",
      reconciliation: "UNSUPPORTED",
    }),
    async send(channel, request) {
      if (!available) return { ...unavailable };
      if (channel !== "WHATSAPP")
        return { status: "UNAVAILABLE", code: "CHANNEL_UNAVAILABLE" };
      const vars = request?.variables;
      if (
        !request ||
        !matches(request.recipient, /^\+[1-9][0-9]{7,14}$/) ||
        !matches(request.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/) ||
        request.idempotencyKey !== request.id ||
        !matches(request.requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) ||
        request.template !== settings.approvedTemplateName ||
        !(request.signal instanceof AbortSignal) ||
        !object(vars) ||
        Object.keys(vars).sort().join(",") !==
          "daysBefore,documentType,expiresOn" ||
        !["SOAT", "RTM"].includes(vars.documentType ?? "") ||
        !dateOnly(vars.expiresOn) ||
        !["30", "15", "7", "1"].includes(vars.daysBefore ?? "")
      ) {
        return { status: "REJECTED", code: "INVALID_REQUEST" };
      }
      if (request.signal.aborted)
        return { status: "UNAVAILABLE", code: "CALLER_ABORTED" };
      try {
        const response = await fetcher(
          `https://graph.facebook.com/${settings.apiVersion}/${settings.phoneNumberId}/messages`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${settings.accessToken}`,
              "Content-Type": "application/json",
            },
            signal: request.signal,
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: request.recipient.slice(1),
              type: "template",
              template: {
                name: settings.approvedTemplateName,
                language: { code: settings.templateLanguage },
                components: [
                  {
                    type: "body",
                    parameters: [
                      vars.documentType,
                      vars.expiresOn,
                      vars.daysBefore,
                    ].map((text) => ({ type: "text", text })),
                  },
                ],
              },
            }),
          },
        );
        // A 4xx is a known rejection only with a shaped Graph error response.
        const body: unknown = await response.json();
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          object(body) &&
          object(body.error) &&
          typeof body.error.code === "number" &&
          Number.isInteger(body.error.code)
        ) {
          return { status: "REJECTED", code: "TRANSPORT_REJECTED" };
        }
        if (
          response.ok &&
          object(body) &&
          body.messaging_product === "whatsapp" &&
          !Object.hasOwn(body, "error") &&
          Array.isArray(body.messages) &&
          body.messages.length === 1 &&
          object(body.messages[0]) &&
          matches(body.messages[0].id, /^wamid\.[A-Za-z0-9_+/=-]{1,249}$/)
        ) {
          return { status: "ACCEPTED", providerReference: body.messages[0].id };
        }
        return { status: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" };
      } catch {
        return {
          status: "UNKNOWN",
          code: request.signal.aborted ? "CALLER_ABORTED" : "TRANSPORT_UNKNOWN",
        };
      }
    },
  };
}
