import { createResendTransport } from "./resend.js";
import { createMetaWhatsAppTransport } from "./meta-whatsapp.js";

export interface NotificationTransportBindings {
  ENVIRONMENT: string;
  NOTIFICATION_EXTERNAL_DELIVERY_ENABLED?: string;
  NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED?: string;
  NOTIFICATION_EMAIL_RELEASE_AUTHORIZED?: string;
  NOTIFICATION_WHATSAPP_RELEASE_AUTHORIZED?: string;
  META_WHATSAPP_PHONE_NUMBER_KIND?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_DOMAIN_VERIFIED?: string;
  META_WHATSAPP_ACCESS_TOKEN?: string;
  META_WHATSAPP_PHONE_NUMBER_ID?: string;
  META_WHATSAPP_API_VERSION?: string;
  META_WHATSAPP_APPROVED_TEMPLATE?: string;
  META_WHATSAPP_TEMPLATE_LANGUAGE?: string;
  META_WHATSAPP_TEMPLATE_STATUS?: string;
  META_WHATSAPP_TEST_RECIPIENT_SHA256?: string;
}

/** Selection alone is not activation. Existing canonical delivery policy is checked by the caller too. */
export function configuredNotificationTransport(
  bindings: NotificationTransportBindings,
  channel: "EMAIL" | "WHATSAPP",
  options: { controlledTest?: boolean } = {},
) {
  const enabled =
    bindings.ENVIRONMENT === "development"
      ? options.controlledTest === true
        ? channel === "WHATSAPP" &&
          bindings.NOTIFICATION_CONTROLLED_WHATSAPP_TEST_ENABLED === "true"
        : bindings.NOTIFICATION_EXTERNAL_DELIVERY_ENABLED === "true"
      : bindings.ENVIRONMENT === "production" &&
        options.controlledTest !== true &&
        (channel === "EMAIL"
          ? bindings.NOTIFICATION_EMAIL_RELEASE_AUTHORIZED
          : bindings.NOTIFICATION_WHATSAPP_RELEASE_AUTHORIZED) === "true";
  if (channel === "EMAIL")
    return createResendTransport({
      environment: bindings.ENVIRONMENT,
      enabled,
      releaseAuthorized:
        bindings.NOTIFICATION_EMAIL_RELEASE_AUTHORIZED === "true",
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
    phoneNumberKind: bindings.META_WHATSAPP_PHONE_NUMBER_KIND as
      "TEST" | "BUSINESS" | undefined,
    releaseAuthorized:
      bindings.NOTIFICATION_WHATSAPP_RELEASE_AUTHORIZED === "true",
    approvedTemplateName: bindings.META_WHATSAPP_APPROVED_TEMPLATE,
    templateStatus: bindings.META_WHATSAPP_TEMPLATE_STATUS as
      "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED" | undefined,
    testRecipientSha256: bindings.META_WHATSAPP_TEST_RECIPIENT_SHA256,
    templateLanguage: bindings.META_WHATSAPP_TEMPLATE_LANGUAGE as
      "es" | "es_CO" | "es_ES" | undefined,
  });
}
