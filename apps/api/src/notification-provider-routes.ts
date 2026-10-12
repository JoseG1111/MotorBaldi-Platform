import {
  applyProviderDeliveryStatus,
  verifyResendStatus,
  verifyMetaStatuses,
} from "@motorbaldi/messaging";
import type { ApiBindings } from "@motorbaldi/config";
import { Problem } from "@motorbaldi/contracts";
import { sha256Hex } from "@motorbaldi/shared";

async function rawBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader)
    throw new Problem(400, "INVALID_PROVIDER_PAYLOAD", "Body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new Problem(413, "PROVIDER_PAYLOAD_TOO_LARGE", "Body too large");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Problem(400, "INVALID_PROVIDER_PAYLOAD", "UTF-8 required");
  }
}

export async function notificationProviderRoutes(
  request: Request,
  env: ApiBindings,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const resend =
    url.pathname === "/api/v1/notifications/providers/resend/events";
  const meta = url.pathname === "/api/v1/notifications/providers/meta/events";
  if (!resend && !meta) return null;
  if (env.ENVIRONMENT !== "development")
    throw new Problem(
      503,
      "NOTIFICATIONS_UNAVAILABLE",
      "Development provider integration unavailable",
    );
  if (meta && request.method === "GET") {
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (!env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN)
      throw new Problem(
        503,
        "NOTIFICATIONS_UNAVAILABLE",
        "Webhook configuration unavailable",
      );
    if (
      token.length > 512 ||
      url.searchParams.get("hub.mode") !== "subscribe" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(challenge) ||
      (await sha256Hex(token)) !==
        (await sha256Hex(env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN))
    )
      throw new Problem(
        403,
        "INVALID_PROVIDER_SIGNATURE",
        "Webhook verification denied",
      );
    return new Response(challenge, {
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  if (request.method !== "POST")
    throw new Problem(405, "METHOD_NOT_ALLOWED", "POST required");
  if (
    resend
      ? !env.RESEND_WEBHOOK_SECRET
      : !env.META_WHATSAPP_APP_SECRET || !env.META_WHATSAPP_PHONE_NUMBER_ID
  )
    throw new Problem(
      503,
      "NOTIFICATIONS_UNAVAILABLE",
      "Webhook configuration unavailable",
    );
  const raw = await rawBody(request);
  let evidence;
  try {
    evidence = resend
      ? await verifyResendStatus(
          raw,
          request.headers,
          env.RESEND_WEBHOOK_SECRET!,
        )
      : await verifyMetaStatuses(
          raw,
          request.headers,
          env.META_WHATSAPP_APP_SECRET!,
          env.META_WHATSAPP_PHONE_NUMBER_ID!,
        );
  } catch (error) {
    const signature =
      error instanceof Error && error.message === "INVALID_PROVIDER_SIGNATURE";
    throw new Problem(
      signature ? 403 : 400,
      signature ? "INVALID_PROVIDER_SIGNATURE" : "INVALID_PROVIDER_PAYLOAD",
      "Provider evidence rejected",
    );
  }
  for (const item of evidence)
    await applyProviderDeliveryStatus(env.DB, item, requestId);
  return Response.json(
    { accepted: true },
    { headers: { "cache-control": "no-store" } },
  );
}
