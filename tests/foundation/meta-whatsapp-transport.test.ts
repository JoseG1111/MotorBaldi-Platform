import { createCommunicationProvider } from "../../packages/messaging/src/providers.js";
import { describe, expect, it, vi } from "vitest";
import {
  createMetaWhatsAppTransport,
  type MetaWhatsAppTransportConfig,
} from "../../packages/messaging/src/meta-whatsapp.js";
import type { DeliveryRequest } from "../../packages/messaging/src/providers.js";
const config: MetaWhatsAppTransportConfig = {
  enabled: true,
  environment: "development",
  accessToken: "test-token-placeholder",
  phoneNumberId: "123456789",
  apiVersion: "v23.0",
  approvedTemplateName: "vehicle_document_expiry",
  templateLanguage: "es_CO",
};
const input = (): DeliveryRequest & { idempotencyKey: string } => ({
  id: "message-123",
  idempotencyKey: "message-123",
  requestId: "request-123",
  recipient: "+573001234567",
  template: "vehicle_document_expiry",
  variables: {
    documentType: "SOAT",
    expiresOn: "2026-12-31",
    daysBefore: "15",
  },
  signal: new AbortController().signal,
});
const accepted = () =>
  Response.json({
    messaging_product: "whatsapp",
    messages: [{ id: "wamid.test_reference" }],
  });
describe("development-only Meta WhatsApp transport", () => {
  it.each([
    {},
    { enabled: false },
    { enabled: undefined },
    { environment: "production" },
    { environment: "staging" },
    { accessToken: undefined },
    { phoneNumberId: undefined },
    { apiVersion: undefined },
    { approvedTemplateName: undefined },
    { templateLanguage: undefined },
    { phoneNumberId: "1/../../other" },
    { apiVersion: "https://example.invalid" },
    { accessToken: "bad\nheader" },
  ])(
    "fails closed for incomplete/disabled/nondevelopment configuration %j",
    async (override) => {
      const fetcher = vi.fn(async () => accepted());
      const transport = createMetaWhatsAppTransport(
        Object.keys(override).length
          ? { ...config, ...override }
          : { environment: "development" },
        fetcher,
      );
      expect(transport.capabilities.availability).toBe("UNAVAILABLE");
      expect((await transport.send("WHATSAPP", input())).status).toBe(
        "UNAVAILABLE",
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("sends the exact approved template payload with bearer headers and acceptance only", async () => {
    const fetcher = vi.fn(async () => accepted());
    const transport = createMetaWhatsAppTransport(config, fetcher);
    const request = input();
    expect(transport.capabilities).toEqual({
      availability: "AVAILABLE",
      channels: ["WHATSAPP"],
      idempotency: "UNSUPPORTED",
      reconciliation: "UNSUPPORTED",
    });
    expect(transport.reconcile).toBeUndefined();
    expect(await transport.send("WHATSAPP", request)).toEqual({
      status: "ACCEPTED",
      providerReference: "wamid.test_reference",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://graph.facebook.com/v23.0/123456789/messages");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: request.signal,
      headers: {
        Authorization: "Bearer test-token-placeholder",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001234567",
      type: "template",
      template: {
        name: "vehicle_document_expiry",
        language: { code: "es_CO" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "SOAT" },
              { type: "text", text: "2026-12-31" },
              { type: "text", text: "15" },
            ],
          },
        ],
      },
    });
  });
  it.each([
    { recipient: "573001234567" },
    { recipient: "+0123456789" },
    { template: "unapproved" },
    { idempotencyKey: "another-message" },
    {
      variables: {
        documentType: "OTHER",
        expiresOn: "2026-12-31",
        daysBefore: "15",
      },
    },
    {
      variables: {
        documentType: "RTM",
        expiresOn: "2026-02-30",
        daysBefore: "15",
      },
    },
    {
      variables: {
        documentType: "RTM",
        expiresOn: "2026-12-31",
        daysBefore: "14",
      },
    },
    {
      variables: {
        documentType: "SOAT",
        expiresOn: "2026-12-31",
        daysBefore: "15",
        arbitrary: "value",
      },
    },
  ])("rejects invalid input before fetch %j", async (override) => {
    const fetcher = vi.fn(async () => accepted());
    expect(
      await createMetaWhatsAppTransport(config, fetcher).send("WHATSAPP", {
        ...input(),
        ...(override as Partial<DeliveryRequest & { idempotencyKey: string }>),
      }),
    ).toEqual({ status: "REJECTED", code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 429])(
    "recognizes shaped Graph rejection %s without retry",
    async (status) => {
      const fetcher = vi.fn(async () =>
        Response.json({ error: { code: 100 } }, { status }),
      );
      expect(
        await createMetaWhatsAppTransport(config, fetcher).send(
          "WHATSAPP",
          input(),
        ),
      ).toEqual({ status: "REJECTED", code: "TRANSPORT_REJECTED" });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it.each([408, 500, 502, 503])(
    "quarantines ambiguous HTTP %s",
    async (status) => {
      expect(
        (
          await createMetaWhatsAppTransport(config, async () =>
            Response.json({ error: { code: 100 } }, { status }),
          ).send("WHATSAPP", input())
        ).status,
      ).toBe("UNKNOWN");
    },
  );
  it.each([
    {},
    { messages: [{ id: "invented" }] },
    { messaging_product: "whatsapp", messages: [{ id: "" }] },
    {
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.test" }],
      error: { code: 100 },
    },
  ])("requires a real-shaped acceptance %j", async (body) => {
    expect(
      (
        await createMetaWhatsAppTransport(config, async () =>
          Response.json(body),
        ).send("WHATSAPP", input())
      ).status,
    ).toBe("UNKNOWN");
  });
  it("treats malformed 4xx and malformed success bodies as unknown", async () => {
    for (const status of [200, 429])
      expect(
        (
          await createMetaWhatsAppTransport(
            config,
            async () => new Response("not-json", { status }),
          ).send("WHATSAPP", input())
        ).status,
      ).toBe("UNKNOWN");
  });
  it("treats network failure and dispatched abort as unknown", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network failure");
    });
    expect(
      (
        await createMetaWhatsAppTransport(config, fetcher).send(
          "WHATSAPP",
          input(),
        )
      ).status,
    ).toBe("UNKNOWN");
    const controller = new AbortController();
    const aborting = createMetaWhatsAppTransport(config, async () => {
      controller.abort();
      throw new Error("aborted");
    });
    expect(
      await aborting.send("WHATSAPP", {
        ...input(),
        signal: controller.signal,
      }),
    ).toEqual({ status: "UNKNOWN", code: "CALLER_ABORTED" });
  });
  it("never dispatches an already aborted request or unsupported channel", async () => {
    const fetcher = vi.fn(async () => accepted());
    const transport = createMetaWhatsAppTransport(config, fetcher);
    const controller = new AbortController();
    controller.abort();
    expect(
      await transport.send("WHATSAPP", {
        ...input(),
        signal: controller.signal,
      }),
    ).toEqual({ status: "UNAVAILABLE", code: "CALLER_ABORTED" });
    for (const channel of ["EMAIL", "SMS"] as const)
      expect(await transport.send(channel, input())).toEqual({
        status: "UNAVAILABLE",
        code: "CHANNEL_UNAVAILABLE",
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("preserves an opaque padded Meta message ID through the shared provider boundary", async () => {
  const transport = createMetaWhatsAppTransport(config, async () =>
    Response.json({
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.QVNDSUk=" }],
    }),
  );
  const r = input();
  expect(
    await createCommunicationProvider({ transport }).send(
      "WHATSAPP",
      {
        id: r.id,
        requestId: r.requestId,
        recipient: r.recipient,
        template: r.template,
        variables: r.variables,
        signal: r.signal,
      },
      async () => {},
    ),
  ).toEqual({ status: "ACCEPTED", providerReference: "wamid.QVNDSUk=" });
});
