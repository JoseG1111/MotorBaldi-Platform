export interface NormalizedProviderStatus {
  provider: "RESEND" | "META_WHATSAPP";
  evidenceId: string;
  providerReference: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  occurredAt: string;
  payloadSha256: string;
}
const encoder = new TextEncoder();
const invalidSignature = () => new Error("INVALID_PROVIDER_SIGNATURE");
const invalidPayload = () => new Error("INVALID_PROVIDER_PAYLOAD");
function bounded(raw: string): void {
  if (
    typeof raw !== "string" ||
    raw.length > 65536 ||
    encoder.encode(raw).length > 65536
  )
    throw invalidPayload();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidPayload();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw invalidPayload();
  return value;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:=+/-]{0,255}$/.test(value)
  )
    throw invalidPayload();
  return value;
}
function parse(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw));
  } catch {
    throw invalidPayload();
  }
}
async function sha256(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function hmac(
  keyBytes: Uint8Array<ArrayBuffer>,
  value: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index++)
    difference |= left[index]! ^ (right[index] ?? 0);
  return difference === 0;
}
function base64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 1024)
    throw invalidSignature();
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw invalidSignature();
  }
}
/** Svix IDs remain stable on retries; persistence must deduplicate evidenceId. */
export async function verifyResendStatus(
  raw: string,
  headers: Headers,
  secret: string,
  now: Date = new Date(),
): Promise<NormalizedProviderStatus[]> {
  bounded(raw);
  const evidenceId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  try {
    if (
      !evidenceId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(evidenceId) ||
      !timestamp ||
      !/^\d{1,12}$/.test(timestamp) ||
      !signatures ||
      signatures.length > 4096 ||
      !Number.isFinite(now.getTime()) ||
      Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300 ||
      !secret.startsWith("whsec_")
    )
      throw invalidSignature();
    const expected = await hmac(
      base64(secret.slice(6)),
      `${evidenceId}.${timestamp}.${raw}`,
    );
    let matched = false;
    const candidates = signatures.split(" ");
    if (candidates.length > 20) throw invalidSignature();
    for (const candidate of candidates) {
      if (!candidate.startsWith("v1,")) continue;
      try {
        matched = equal(expected, base64(candidate.slice(3))) || matched;
      } catch {
        /* Other valid rotation signatures may still match. */
      }
    }
    if (!matched) throw invalidSignature();
  } catch {
    throw invalidSignature();
  }
  const body = parse(raw);
  if (typeof body.type !== "string") throw invalidPayload();
  const statuses: Record<string, NormalizedProviderStatus["status"]> = {
    "email.sent": "SENT",
    "email.delivered": "DELIVERED",
    "email.bounced": "FAILED",
    "email.failed": "FAILED",
  };
  const status = Object.hasOwn(statuses, body.type)
    ? statuses[body.type]
    : undefined;
  // Opens are tracking signals, not proof a human read the message.
  if (!status) return [];
  const providerReference = id(record(body.data).email_id);
  if (
    typeof body.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(
      body.created_at,
    ) ||
    !Number.isFinite(Date.parse(body.created_at))
  )
    throw invalidPayload();
  return [
    {
      provider: "RESEND",
      evidenceId: evidenceId!,
      providerReference,
      status,
      occurredAt: new Date(body.created_at).toISOString(),
      payloadSha256: await sha256(raw),
    },
  ];
}
/** Meta signs the raw body without a replay timestamp; durable evidence deduplication is required. */
export async function verifyMetaStatuses(
  raw: string,
  headers: Headers,
  appSecret: string,
  phoneNumberId: string,
): Promise<NormalizedProviderStatus[]> {
  bounded(raw);
  try {
    const signature = headers.get("x-hub-signature-256");
    if (
      !signature ||
      !/^sha256=[a-f0-9]{64}$/.test(signature) ||
      typeof appSecret !== "string" ||
      !appSecret.length ||
      appSecret.length > 1024
    )
      throw invalidSignature();
    const supplied = Uint8Array.from(signature.slice(7).match(/../g)!, (pair) =>
      Number.parseInt(pair, 16),
    );
    if (!equal(await hmac(encoder.encode(appSecret), raw), supplied))
      throw invalidSignature();
  } catch {
    throw invalidSignature();
  }
  if (!/^\d{1,32}$/.test(phoneNumberId)) throw invalidPayload();
  const body = parse(raw);
  if (body.object !== "whatsapp_business_account") throw invalidPayload();
  const result: NormalizedProviderStatus[] = [];
  const seen = new Set<string>();
  let count = 0;
  let changeCount = 0;
  const payloadSha256 = await sha256(raw);
  for (const entry of array(body.entry)) {
    for (const change of array(record(entry).changes)) {
      if (++changeCount > 100) throw invalidPayload();
      const changed = record(change);
      if (changed.field !== "messages") continue;
      const value = record(changed.value);
      if (
        value.messaging_product !== "whatsapp" ||
        record(value.metadata).phone_number_id !== phoneNumberId
      )
        throw invalidPayload();
      if (value.statuses === undefined) continue;
      for (const item of array(value.statuses)) {
        if (++count > 100) throw invalidPayload();
        const statusObject = record(item);
        const providerReference = id(statusObject.id);
        if (
          typeof statusObject.timestamp !== "string" ||
          !/^\d{1,12}$/.test(statusObject.timestamp)
        )
          throw invalidPayload();
        const milliseconds = Number(statusObject.timestamp) * 1000;
        if (!Number.isFinite(milliseconds) || milliseconds > 253402300799000)
          throw invalidPayload();
        const mapped: Record<string, NormalizedProviderStatus["status"]> = {
          sent: "SENT",
          delivered: "DELIVERED",
          read: "READ",
          failed: "FAILED",
        };
        if (typeof statusObject.status !== "string") throw invalidPayload();
        if (statusObject.status === "deleted") continue;
        if (!Object.hasOwn(mapped, statusObject.status)) throw invalidPayload();
        const status = mapped[statusObject.status]!;
        const evidenceId = await sha256(
          JSON.stringify([
            providerReference,
            status,
            String(Number(statusObject.timestamp)),
          ]),
        );
        if (seen.has(evidenceId)) continue;
        seen.add(evidenceId);
        result.push({
          provider: "META_WHATSAPP",
          evidenceId,
          providerReference,
          status,
          occurredAt: new Date(milliseconds).toISOString(),
          payloadSha256,
        });
      }
    }
  }
  return result;
}
