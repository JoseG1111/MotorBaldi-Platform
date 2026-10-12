import { execFileSync } from "node:child_process";
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
  apiVersion: "v26.0",
  templateStatus: "APPROVED",
  testRecipientSha256:
    "5b181b132cc2c1b40eb94df758a7b9048cbcd7581782bd3dd8d5a2f8aca96ad0",
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
    { templateStatus: "PENDING" as const },
    { templateStatus: "REJECTED" as const },
    { templateStatus: undefined },
    { testRecipientSha256: undefined },
    { testRecipientSha256: "" },
    { testRecipientSha256: "bad" },
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
    expect(url).toBe("https://graph.facebook.com/v26.0/123456789/messages");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
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

it("rejects a valid but nonallowlisted Development recipient without HTTP", async () => {
  const fetcher = vi.fn(async () => accepted());
  expect(
    await createMetaWhatsAppTransport(config, fetcher).send("WHATSAPP", {
      ...input(),
      recipient: "+573009999999",
    }),
  ).toEqual({ status: "REJECTED", code: "AUTHORITY_DENIED" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("read-only preflight rejects pending/malformed templates and absent token scopes", () => {
  const code = `import importlib.util
s=importlib.util.spec_from_file_location('preflight','scripts/communications/meta-development-preflight.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
base={'name':m.TEMPLATE,'language':'es','status':'PENDING','category':'UTILITY','components':[{'type':'BODY','text':'Documento {{1}}, fecha {{2}}, dias {{3}}'}]}
assert m.evaluate_template([base])['approved'] is False
base['status']='APPROVED'
assert all(m.evaluate_template([base]).values())
base['components'][0]['text']='{{1}} {{3}}'
assert m.evaluate_template([base])['body_parameters'] is False
assert m.evaluate_template([])['found'] is False
assert not any(m.evaluate_token({}).values())
assert all(m.evaluate_token({'app_id':m.APP_ID,'is_valid':True,'type':'SYSTEM_USER','scopes':['whatsapp_business_messaging','whatsapp_business_management']}).values())
print('PASS')`;
  expect(
    execFileSync("python3", ["-B", "-c", code], { encoding: "utf8" }).trim(),
  ).toBe("PASS");
});

it.each(["SOAT", "RTM"])(
  "configured v26 Spanish expiry template sends exact mocked %s parameters",
  async (documentType) => {
    const fetcher = vi.fn(async () => accepted());
    const transport = createMetaWhatsAppTransport(
      {
        ...config,
        approvedTemplateName: "motorbaldi_recordatorio_vencimiento",
        templateLanguage: "es",
      },
      fetcher,
    );
    expect(
      (
        await transport.send("WHATSAPP", {
          ...input(),
          template: "motorbaldi_recordatorio_vencimiento",
          variables: { ...input().variables, documentType },
        })
      ).status,
    ).toBe("ACCEPTED");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/v26.0/");
    const body = JSON.parse(String(init.body));
    expect(body.template.name).toBe("motorbaldi_recordatorio_vencimiento");
    expect(body.template.language.code).toBe("es");
    expect(
      body.template.components[0].parameters.map(
        (p: { text: string }) => p.text,
      ),
    ).toEqual([documentType, "2026-12-31", "15"]);
  },
);
