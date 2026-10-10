import { z } from "zod";

export interface DeliveryRequest {
  /** Stable logical message ID; never regenerate it when reconciling an ambiguous send. */
  id: string;
  requestId: string;
  recipient: string;
  template: string;
  variables: Readonly<Record<string, string>>;
  signal: AbortSignal;
}
export type CommunicationOutcomeCode =
  | "INVALID_REQUEST"
  | "TRANSPORT_UNAVAILABLE"
  | "CHANNEL_UNAVAILABLE"
  | "RECONCILIATION_UNAVAILABLE"
  | "AUTHORITY_DENIED"
  | "CALLER_ABORTED"
  | "TIMED_OUT"
  | "TRANSPORT_REJECTED"
  | "TRANSPORT_UNKNOWN"
  | "INVALID_PROVIDER_RESPONSE";
/** ACCEPTED means provider acceptance only. This port never asserts delivered/read status. */
export type DeliveryReceipt =
  | { providerReference: string; status: "ACCEPTED" }
  | {
      providerReference?: string;
      status: "REJECTED" | "UNAVAILABLE" | "UNKNOWN";
      code?: CommunicationOutcomeCode;
    };
export interface EmailTransport {
  send(request: DeliveryRequest): Promise<DeliveryReceipt>;
}
export interface MessageTransport {
  send(
    channel: "SMS" | "WHATSAPP",
    request: DeliveryRequest,
  ): Promise<DeliveryReceipt>;
}
export type CommunicationChannel = "EMAIL" | "SMS" | "WHATSAPP";
export interface CommunicationCapabilities {
  availability: "AVAILABLE" | "UNAVAILABLE";
  channels: readonly CommunicationChannel[];
  /** A stable key alone is insufficient to claim provider-side deduplication. */
  idempotency: "PROVIDER_ENFORCED" | "UNSUPPORTED";
  reconciliation: "SUPPORTED" | "UNSUPPORTED";
}
export interface ReconciliationRequest {
  id: string;
  requestId: string;
  providerReference?: string;
  signal: AbortSignal;
}
export interface CommunicationTransport {
  capabilities: CommunicationCapabilities;
  send(
    channel: CommunicationChannel,
    request: DeliveryRequest & { idempotencyKey: string },
  ): Promise<DeliveryReceipt>;
  reconcile?(
    request: ReconciliationRequest & { idempotencyKey: string },
  ): Promise<DeliveryReceipt>;
}

const logicalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const providerReference = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const abortSignal = z.custom<AbortSignal>(
  (value) => value instanceof AbortSignal,
);
const variables = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    z.string().max(2048),
  )
  .refine(
    (value) =>
      Object.keys(value).length <= 32 &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16384,
  );
const deliveryInput = z
  .object({
    id: logicalId,
    requestId,
    recipient: z.string().max(320),
    template: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/),
    variables,
    signal: abortSignal,
  })
  .strict();
const reconciliationInput = z
  .object({
    id: logicalId,
    requestId,
    providerReference: providerReference.optional(),
    signal: abortSignal,
  })
  .strict();
const capabilitiesInput = z
  .object({
    availability: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    channels: z
      .array(z.enum(["EMAIL", "SMS", "WHATSAPP"]))
      .max(3)
      .refine((value) => new Set(value).size === value.length),
    idempotency: z.enum(["PROVIDER_ENFORCED", "UNSUPPORTED"]),
    reconciliation: z.enum(["SUPPORTED", "UNSUPPORTED"]),
  })
  .strict();
const outcomeCode = z.enum([
  "INVALID_REQUEST",
  "TRANSPORT_UNAVAILABLE",
  "CHANNEL_UNAVAILABLE",
  "RECONCILIATION_UNAVAILABLE",
  "AUTHORITY_DENIED",
  "CALLER_ABORTED",
  "TIMED_OUT",
  "TRANSPORT_REJECTED",
  "TRANSPORT_UNKNOWN",
  "INVALID_PROVIDER_RESPONSE",
]);
const receiptInput = z.union([
  z.object({ status: z.literal("ACCEPTED"), providerReference }).strict(),
  z
    .object({
      status: z.enum(["REJECTED", "UNAVAILABLE", "UNKNOWN"]),
      providerReference: providerReference.optional(),
      code: outcomeCode.optional(),
    })
    .strict(),
]);
const unavailableCapabilities: CommunicationCapabilities = Object.freeze({
  availability: "UNAVAILABLE",
  channels: Object.freeze([]),
  idempotency: "UNSUPPORTED",
  reconciliation: "UNSUPPORTED",
});
function outcome(
  status: "REJECTED" | "UNAVAILABLE" | "UNKNOWN",
  code: CommunicationOutcomeCode,
): DeliveryReceipt {
  return { status, code };
}

/** Inject a configured future transport or null. No provider, credentials, delivery promises or retries are invented. */
export function createCommunicationProvider(options: {
  transport: CommunicationTransport | null;
  timeoutMs?: number;
}) {
  const timeout = z
    .number()
    .int()
    .positive()
    .max(30000)
    .safeParse(options.timeoutMs ?? 10000);
  const capabilities = options.transport
    ? capabilitiesInput.safeParse(options.transport.capabilities)
    : { success: true as const, data: unavailableCapabilities };
  if (
    !timeout.success ||
    !capabilities.success ||
    (options.transport && typeof options.transport.send !== "function") ||
    (options.transport &&
      capabilities.data.reconciliation === "SUPPORTED" &&
      typeof options.transport.reconcile !== "function")
  )
    throw new Error("INVALID_COMMUNICATION_CONFIGURATION");
  const transport = options.transport;
  const advertised: CommunicationCapabilities = Object.freeze({
    ...capabilities.data,
    channels: Object.freeze([...capabilities.data.channels]),
  });

  async function bounded(
    signal: AbortSignal,
    authorize: () => Promise<void>,
    invoke: (signal: AbortSignal) => Promise<DeliveryReceipt>,
  ): Promise<DeliveryReceipt> {
    if (signal.aborted) return outcome("UNAVAILABLE", "CALLER_ABORTED");
    const controller = new AbortController();
    let dispatched = false;
    let complete!: (receipt: DeliveryReceipt) => void;
    const cancelled = new Promise<DeliveryReceipt>((resolve) => {
      complete = resolve;
    });
    const cancel = (code: "CALLER_ABORTED" | "TIMED_OUT") => {
      controller.abort();
      complete(outcome(dispatched ? "UNKNOWN" : "UNAVAILABLE", code));
    };
    const callerAbort = () => cancel("CALLER_ABORTED");
    signal.addEventListener("abort", callerAbort, { once: true });
    const timer = setTimeout(() => cancel("TIMED_OUT"), timeout.data);
    try {
      const task = (async () => {
        try {
          await authorize();
        } catch {
          return outcome("REJECTED", "AUTHORITY_DENIED");
        }
        // A slow authorization cannot cause a later send after the caller deadline.
        if (controller.signal.aborted) return cancelled;
        dispatched = true;
        try {
          const raw = await invoke(controller.signal);
          const receipt = receiptInput.safeParse(raw);
          if (!receipt.success)
            return outcome("UNKNOWN", "INVALID_PROVIDER_RESPONSE");
          if (receipt.data.status === "ACCEPTED") return receipt.data;
          return {
            ...receipt.data,
            code:
              receipt.data.code ??
              (receipt.data.status === "REJECTED"
                ? "TRANSPORT_REJECTED"
                : receipt.data.status === "UNAVAILABLE"
                  ? "TRANSPORT_UNAVAILABLE"
                  : "TRANSPORT_UNKNOWN"),
          };
        } catch {
          return outcome("UNKNOWN", "TRANSPORT_UNKNOWN");
        }
      })();
      return await Promise.race([task, cancelled]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", callerAbort);
    }
  }
  return {
    capabilities: advertised,
    async send(
      channel: CommunicationChannel,
      request: DeliveryRequest,
      authorizeCurrentAuthority: () => Promise<void>,
    ): Promise<DeliveryReceipt> {
      const parsed = deliveryInput.safeParse(request);
      if (
        !parsed.success ||
        !["EMAIL", "SMS", "WHATSAPP"].includes(channel) ||
        (channel === "EMAIL"
          ? !z.email().safeParse(parsed.data.recipient).success
          : !/^\+[1-9][0-9]{7,14}$/.test(parsed.data.recipient))
      )
        return outcome("REJECTED", "INVALID_REQUEST");
      if (!transport || advertised.availability === "UNAVAILABLE")
        return outcome("UNAVAILABLE", "TRANSPORT_UNAVAILABLE");
      if (!advertised.channels.includes(channel))
        return outcome("UNAVAILABLE", "CHANNEL_UNAVAILABLE");
      const input = parsed.data;
      return bounded(input.signal, authorizeCurrentAuthority, (signal) =>
        transport.send(channel, {
          ...input,
          variables: Object.freeze({ ...input.variables }),
          signal,
          idempotencyKey: input.id,
        }),
      );
    },
    async reconcile(
      request: ReconciliationRequest,
      authorizeCurrentAuthority: () => Promise<void>,
    ): Promise<DeliveryReceipt> {
      const parsed = reconciliationInput.safeParse(request);
      if (!parsed.success) return outcome("REJECTED", "INVALID_REQUEST");
      if (!transport || advertised.availability === "UNAVAILABLE")
        return outcome("UNAVAILABLE", "TRANSPORT_UNAVAILABLE");
      if (advertised.reconciliation !== "SUPPORTED" || !transport.reconcile)
        return outcome("UNAVAILABLE", "RECONCILIATION_UNAVAILABLE");
      const input = parsed.data;
      return bounded(input.signal, authorizeCurrentAuthority, (signal) =>
        transport.reconcile!({ ...input, signal, idempotencyKey: input.id }),
      );
    },
  };
}
