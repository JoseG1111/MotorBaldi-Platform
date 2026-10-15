import type { ApiBindings } from "@motorbaldi/config";
import { Problem } from "@motorbaldi/contracts";
import { sha256Hex } from "@motorbaldi/shared";

/** Separate, default-closed Development acceptance gate; never authorizes outbound sends. */
export function phoneOwnershipAvailable(env: ApiBindings): boolean {
  return (
    env.ENVIRONMENT === "development" &&
    env.PHONE_OWNERSHIP_VERIFICATION_ENABLED === "true" &&
    /^\+[1-9]\d{7,14}$/.test(env.PHONE_OWNERSHIP_WHATSAPP_DESTINATION ?? "") &&
    /^\d{1,32}$/.test(env.META_WHATSAPP_PHONE_NUMBER_ID ?? "") &&
    Boolean(env.META_WHATSAPP_APP_SECRET) &&
    /^[a-f0-9]{64}(,[a-f0-9]{64})*$/.test(
      env.META_WHATSAPP_TEST_RECIPIENT_SHA256 ?? "",
    )
  );
}
export async function phoneOwnershipRecipientAllowed(
  env: ApiBindings,
  phone: string,
): Promise<boolean> {
  return (
    phoneOwnershipAvailable(env) &&
    (env.META_WHATSAPP_TEST_RECIPIENT_SHA256 ?? "")
      .split(",")
      .includes(await sha256Hex(phone))
  );
}
export function requirePhoneOwnershipAvailable(env: ApiBindings) {
  if (!phoneOwnershipAvailable(env))
    throw new Problem(
      503,
      "PHONE_VERIFICATION_UNAVAILABLE",
      "Phone verification unavailable",
    );
}
