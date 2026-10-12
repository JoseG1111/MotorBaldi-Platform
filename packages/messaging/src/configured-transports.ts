import { createResendTransport } from "./resend.js";
import { createMetaWhatsAppTransport } from "./meta-whatsapp.js";

export interface NotificationTransportBindings {
  ENVIRONMENT: string;
  NOTIFICATION_EXTERNAL_DELIVERY_ENABLED?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_DOMAIN_VERIFIED?: string;
  META_WHATSAPP_ACCESS_TOKEN?: string;
  META_WHATSAPP_PHONE_NUMBER_ID?: string;
  META_WHATSAPP_API_VERSION?: string;
  META_WHATSAPP_APPROVED_TEMPLATE?: string;
  META_WHATSAPP_TEMPLATE_LANGUAGE?: string;
}

/** Selection alone is not activation. Existing canonical delivery policy is checked by the caller too. */
export function configuredNotificationTransport(
  bindings: NotificationTransportBindings,
  channel: "EMAIL" | "WHATSAPP",
) {
  const enabled =
    bindings.ENVIRONMENT === "development" &&
    bindings.NOTIFICATION_EXTERNAL_DELIVERY_ENABLED === "true";
  if (channel === "EMAIL")
    return createResendTransport({
      environment: bindings.ENVIRONMENT,
      enabled,
      apiKey: bindings.RESEND_API_KEY,
      from: bindings.RESEND_FROM,
      fromVerified: bindings.RESEND_DOMAIN_VERIFIED === "true",
    });
  return createMetaWhatsAppTransport({
    environment: bindings.ENVIRONMENT,
    enabled,
    accessToken: bindings.META_WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: bindings.META_WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: bindings.META_WHATSAPP_API_VERSION,
    approvedTemplateName: bindings.META_WHATSAPP_APPROVED_TEMPLATE,
    templateLanguage: bindings.META_WHATSAPP_TEMPLATE_LANGUAGE as
      "es" | "es_CO" | "es_ES" | undefined,
  });
}
