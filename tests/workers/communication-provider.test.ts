import { describe, expect, it, vi } from "vitest";
import {
  createCommunicationProvider,
  type CommunicationTransport,
  type DeliveryRequest,
  type DeliveryReceipt,
} from "@motorbaldi/messaging";

/** All receipts below are explicitly local controlled fixtures, not external provider delivery evidence. */
function localTransport(
  overrides: Partial<CommunicationTransport> = {},
): CommunicationTransport {
  return {
    capabilities: {
      availability: "AVAILABLE",
      channels: ["EMAIL", "SMS", "WHATSAPP"],
      idempotency: "UNSUPPORTED",
      reconciliation: "SUPPORTED",
    },
    send: vi.fn(async () => ({
      status: "ACCEPTED" as const,
      providerReference: "local-controlled-acceptance",
    })),
    reconcile: vi.fn(async () => ({
      status: "UNKNOWN" as const,
      code: "TRANSPORT_UNKNOWN" as const,
    })),
    ...overrides,
  };
}
function request(signal = new AbortController().signal): DeliveryRequest {
  return {
    id: "logical-message-123",
    requestId: "trace-request-123",
    recipient: "member@example.test",
    template: "membership.notice",
    variables: { firstName: "Local Member" },
    signal,
  };
}
const permit = async () => {};

describe("explicit communication provider outcomes", () => {
  it("defines acceptance only and forwards the unchanged logical key and request ID after fresh authority", async () => {
    const order: string[] = [],
      sent: DeliveryRequest[] = [],
      transport = localTransport({
        send: vi.fn(async (_channel, input) => {
          order.push("send");
          sent.push(input);
          return {
            status: "ACCEPTED" as const,
            providerReference: "local-acceptance-only",
          };
        }),
      });
    const provider = createCommunicationProvider({ transport });
    const result = await provider.send("EMAIL", request(), async () => {
      order.push("authorize");
    });
    expect(order).toEqual(["authorize", "send"]);
    expect(result).toEqual({
      status: "ACCEPTED" as const,
      providerReference: "local-acceptance-only",
    });
    expect(result).not.toHaveProperty("delivered");
    expect(sent[0]).toMatchObject({
      id: "logical-message-123",
      idempotencyKey: "logical-message-123",
      requestId: "trace-request-123",
    });
    expect(provider.capabilities.idempotency).toBe("UNSUPPORTED");
    expect(Object.isFrozen(sent[0]!.variables)).toBe(true);
  });
  it("makes zero calls for unconfigured or unavailable transports and unsupported channels", async () => {
    const send = vi.fn(
        async () =>
          ({
            status: "ACCEPTED" as const,
            providerReference: "local-fixture",
          }) as const,
      ),
      authority = vi.fn(permit);
    const disabled = createCommunicationProvider({
      transport: localTransport({
        send,
        capabilities: {
          availability: "UNAVAILABLE",
          channels: ["EMAIL"],
          idempotency: "UNSUPPORTED",
          reconciliation: "UNSUPPORTED",
        },
      }),
    });
    expect(await disabled.send("EMAIL", request(), authority)).toEqual({
      status: "UNAVAILABLE",
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(
      await createCommunicationProvider({ transport: null }).send(
        "EMAIL",
        request(),
        authority,
      ),
    ).toEqual({ status: "UNAVAILABLE", code: "TRANSPORT_UNAVAILABLE" });
    const emailOnly = createCommunicationProvider({
      transport: localTransport({
        send,
        capabilities: {
          availability: "AVAILABLE",
          channels: ["EMAIL"],
          idempotency: "UNSUPPORTED",
          reconciliation: "UNSUPPORTED",
        },
      }),
    });
    expect(
      await emailOnly.send(
        "SMS",
        { ...request(), recipient: "+573001234567" },
        authority,
      ),
    ).toEqual({ status: "UNAVAILABLE", code: "CHANNEL_UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
    expect(authority).not.toHaveBeenCalled();
  });
  it("denies invalid or oversized private inputs without authority or transport calls", async () => {
    const transport = localTransport(),
      authority = vi.fn(permit),
      provider = createCommunicationProvider({ transport });
    for (const input of [
      { ...request(), recipient: "invalid" },
      { ...request(), id: "short" },
      { ...request(), requestId: "secret\nheader" },
      { ...request(), template: "../private" },
      { ...request(), variables: { firstName: "x".repeat(2049) } },
      {
        ...request(),
        variables: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`field${i}`, "value"]),
        ),
      },
      { ...request(), extra: "untrusted status" },
    ])
      expect(await provider.send("EMAIL", input, authority)).toEqual({
        status: "REJECTED",
        code: "INVALID_REQUEST",
      });
    expect(
      await provider.send(
        "WHATSAPP",
        { ...request(), recipient: "3001234567" },
        authority,
      ),
    ).toEqual({ status: "REJECTED", code: "INVALID_REQUEST" });
    expect(
      await provider.send(
        "SMS",
        { ...request(), recipient: "+573001234567" },
        authority,
      ),
    ).toMatchObject({ status: "ACCEPTED" });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(authority).toHaveBeenCalledTimes(1);
  });
  it("checks current authority for every send and reconciliation without leaking denial details", async () => {
    const transport = localTransport(),
      provider = createCommunicationProvider({ transport });
    const deny = async () => {
      throw new Error(
        "PRIVATE recipient member@example.test password=not-a-real-secret",
      );
    };
    const sent = await provider.send("EMAIL", request(), deny);
    expect(sent).toEqual({ status: "REJECTED", code: "AUTHORITY_DENIED" });
    expect(
      await provider.reconcile(
        {
          id: request().id,
          requestId: request().requestId,
          signal: request().signal,
        },
        deny,
      ),
    ).toEqual(sent);
    expect(JSON.stringify(sent)).not.toContain("PRIVATE");
    expect(transport.send).not.toHaveBeenCalled();
    expect(transport.reconcile).not.toHaveBeenCalled();
  });
  it("reports ambiguous thrown effects as UNKNOWN and never retries", async () => {
    const transport = localTransport({
      send: vi.fn(async () => {
        throw new Error(
          "PRIVATE provider response body including recipient and credential",
        );
      }),
    });
    const result = await createCommunicationProvider({ transport }).send(
      "EMAIL",
      request(),
      permit,
    );
    expect(result).toEqual({
      status: "UNKNOWN" as const,
      code: "TRANSPORT_UNKNOWN",
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.reconcile).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("bounds a transport ignoring abort and marks an in-flight timeout unknown", async () => {
    let signal: AbortSignal | undefined;
    const transport = localTransport({
      send: vi.fn(async (_channel, input) => {
        signal = input.signal;
        return new Promise<DeliveryReceipt>(() => {});
      }),
    });
    const result = await createCommunicationProvider({
      transport,
      timeoutMs: 20,
    }).send("EMAIL", request(), permit);
    expect(result).toEqual({ status: "UNKNOWN" as const, code: "TIMED_OUT" });
    expect(signal?.aborted).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it("aborts before dispatch without an effect and marks abort after dispatch unknown", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const transport = localTransport(),
      provider = createCommunicationProvider({ transport });
    expect(
      await provider.send("EMAIL", request(cancelled.signal), permit),
    ).toEqual({ status: "UNAVAILABLE", code: "CALLER_ABORTED" });
    expect(transport.send).not.toHaveBeenCalled();
    const caller = new AbortController();
    let begin!: () => void;
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const ambiguous = localTransport({
      send: vi.fn(async () => {
        begin();
        return new Promise<DeliveryReceipt>(() => {});
      }),
    });
    const pending = createCommunicationProvider({ transport: ambiguous }).send(
      "EMAIL",
      request(caller.signal),
      permit,
    );
    await entered;
    caller.abort();
    expect(await pending).toEqual({
      status: "UNKNOWN" as const,
      code: "CALLER_ABORTED",
    });
    expect(ambiguous.send).toHaveBeenCalledTimes(1);
  });
  it("never sends later when authority completes after the deadline", async () => {
    let allow!: () => void;
    const authority = new Promise<void>((resolve) => {
        allow = resolve;
      }),
      transport = localTransport();
    const result = await createCommunicationProvider({
      transport,
      timeoutMs: 20,
    }).send("EMAIL", request(), () => authority);
    expect(result).toEqual({ status: "UNAVAILABLE", code: "TIMED_OUT" });
    allow();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("rejects malformed or delivery-claiming provider receipts as ambiguous without leaking extra data", async () => {
    const transport = localTransport({
      send: vi.fn(
        async () =>
          ({
            status: "ACCEPTED" as const,
            providerReference: "local-reference",
            delivered: true,
            privateBody: "PRIVATE",
          }) as unknown as DeliveryReceipt,
      ),
    });
    const result = await createCommunicationProvider({ transport }).send(
      "EMAIL",
      request(),
      permit,
    );
    expect(result).toEqual({
      status: "UNKNOWN" as const,
      code: "INVALID_PROVIDER_RESPONSE",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("preserves explicit rejection and reconciles with the same logical id without another send", async () => {
    const transport = localTransport({
      send: vi.fn(async () => ({ status: "REJECTED" as const })),
      reconcile: vi.fn(async () => ({
        status: "ACCEPTED" as const,
        providerReference: "local-reconciled-acceptance",
      })),
    });
    const provider = createCommunicationProvider({ transport });
    expect(await provider.send("EMAIL", request(), permit)).toEqual({
      status: "REJECTED",
      code: "TRANSPORT_REJECTED",
    });
    const result = await provider.reconcile(
      {
        id: request().id,
        requestId: "trace-reconcile-123",
        providerReference: "local-reconciled-acceptance",
        signal: request().signal,
      },
      permit,
    );
    expect(result).toMatchObject({ status: "ACCEPTED" });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: request().id,
        requestId: "trace-reconcile-123",
      }),
    );
  });
  it("declares reconciliation limitations and validates capability configuration", async () => {
    const transport = localTransport({
      capabilities: {
        availability: "AVAILABLE",
        channels: ["EMAIL"],
        idempotency: "PROVIDER_ENFORCED",
        reconciliation: "UNSUPPORTED",
      },
    });
    expect(
      await createCommunicationProvider({ transport }).reconcile(
        {
          id: request().id,
          requestId: request().requestId,
          signal: request().signal,
        },
        permit,
      ),
    ).toEqual({ status: "UNAVAILABLE", code: "RECONCILIATION_UNAVAILABLE" });
    expect(transport.reconcile).not.toHaveBeenCalled();
    expect(() =>
      createCommunicationProvider({
        transport: localTransport({ reconcile: undefined }),
      }),
    ).toThrow("INVALID_COMMUNICATION_CONFIGURATION");
    expect(() =>
      createCommunicationProvider({ transport: null, timeoutMs: 0 }),
    ).toThrow("INVALID_COMMUNICATION_CONFIGURATION");
    expect(() =>
      createCommunicationProvider({
        transport: localTransport({ send: undefined }),
      }),
    ).toThrow("INVALID_COMMUNICATION_CONFIGURATION");
  });
});
