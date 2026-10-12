import { describe, expect, it, vi } from "vitest";
import {
  createResendTransport,
  type ResendTransportConfig,
} from "../../packages/messaging/src/resend.js";

const config: ResendTransportConfig = {
  environment: "development",
  enabled: true,
  apiKey: "test-placeholder",
  from: "reminders@example.com",
  fromVerified: true,
};
const request = () => ({
  id: "message-0001",
  requestId: "request-1",
  recipient: "owner@example.com",
  template: "vehicle-document-expiry",
  variables: {
    documentType: "SOAT",
    expiresOn: "2027-01-01",
    daysBefore: "30",
  },
  signal: new AbortController().signal,
  idempotencyKey: "message-0001",
});
const mockFetch = (response: Response) =>
  vi.fn<typeof fetch>().mockResolvedValue(response);
describe("development Resend transport", () => {
  it("requires explicit development activation and verified sender configuration", () => {
    for (const patch of [
      { enabled: undefined },
      { environment: "production" },
      { environment: "staging" },
      { apiKey: undefined },
      { apiKey: "bad\r\nheader" },
      { fromVerified: false },
      { from: "Name <sender@example.com>" },
    ]) {
      const fetcher = mockFetch(Response.json({ id: "email-1" }));
      expect(
        createResendTransport({ ...config, ...patch }, fetcher),
      ).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("sends exactly the fixed Spanish template and stable idempotency key", async () => {
    const fetcher = mockFetch(Response.json({ id: "email-1" }));
    const transport = createResendTransport(config, fetcher)!;
    expect(await transport.send("EMAIL", request())).toEqual({
      status: "ACCEPTED",
      providerReference: "email-1",
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: "Bearer test-placeholder",
        "Content-Type": "application/json",
        "Idempotency-Key": "message-0001",
      },
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      from: "reminders@example.com",
      to: ["owner@example.com"],
      subject: "Recordatorio de vencimiento de SOAT",
      text: "Tu documento SOAT vence el 2027-01-01. Faltan 30 días para su vencimiento.",
    });
  });
  it("rejects hostile recipients, content, dates and idempotency keys before dispatch", async () => {
    const fetcher = mockFetch(Response.json({ id: "email-1" }));
    const transport = createResendTransport(config, fetcher)!;
    for (const patch of [
      { recipient: "owner@example.com\r\nBcc: victim@example.com" },
      { recipient: "a@example.com,b@example.com" },
      { template: "marketing" },
      { idempotencyKey: "different-key" },
      { variables: { ...request().variables, arbitrary: "advertisement" } },
      { variables: { ...request().variables, documentType: "<script>" } },
      { variables: { ...request().variables, daysBefore: "0" } },
      { variables: { ...request().variables, expiresOn: "2027-02-30" } },
    ]) {
      expect(await transport.send("EMAIL", { ...request(), ...patch })).toEqual(
        { status: "REJECTED", code: "INVALID_REQUEST" },
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 422])(
    "marks permanent HTTP %s rejection without retaining raw errors",
    async (status) => {
      const fetcher = mockFetch(
        new Response("private provider error", { status }),
      );
      expect(
        await createResendTransport(config, fetcher)!.send("EMAIL", request()),
      ).toEqual({ status: "REJECTED", code: "TRANSPORT_REJECTED" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([408, 409, 429, 500, 503])(
    "treats HTTP %s as ambiguous and never retries",
    async (status) => {
      const fetcher = mockFetch(
        new Response("private provider error", { status }),
      );
      expect(
        await createResendTransport(config, fetcher)!.send("EMAIL", request()),
      ).toEqual({ status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("handles network/timeout failures and invalid acceptance responses conservatively", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("secret network details"));
    expect(
      await createResendTransport(config, fetcher)!.send("EMAIL", request()),
    ).toEqual({ status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" });
    for (const body of [{}, { id: "bad/id" }, { id: 42 }])
      expect(
        await createResendTransport(
          config,
          mockFetch(Response.json(body)),
        )!.send("EMAIL", request()),
      ).toEqual({ status: "UNKNOWN", code: "INVALID_PROVIDER_RESPONSE" });
  });
  it("reconciles only a known ID with GET and reports acceptance, never delivery", async () => {
    const fetcher = mockFetch(
      Response.json({ id: "email-1", last_event: "delivered" }),
    );
    const transport = createResendTransport(config, fetcher)!;
    const input = {
      id: request().id,
      requestId: "request-2",
      idempotencyKey: request().id,
      signal: request().signal,
    };
    expect(await transport.reconcile!(input)).toEqual({
      status: "UNAVAILABLE",
      code: "RECONCILIATION_UNAVAILABLE",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await transport.reconcile!({ ...input, providerReference: "email-1" }),
    ).toEqual({ status: "ACCEPTED", providerReference: "email-1" });
    expect(fetcher.mock.calls[0]).toEqual([
      "https://api.resend.com/emails/email-1",
      {
        method: "GET",
        headers: { Authorization: "Bearer test-placeholder" },
        signal: input.signal,
        redirect: "manual",
      },
    ]);
    expect(
      await transport.reconcile!({ ...input, providerReference: "../emails" }),
    ).toEqual({ status: "REJECTED", code: "INVALID_REQUEST" });
  });
  it("does not dispatch unsupported channels or aborted requests", async () => {
    const fetcher = mockFetch(Response.json({ id: "email-1" }));
    const transport = createResendTransport(config, fetcher)!;
    expect(await transport.send("SMS", request())).toMatchObject({
      status: "UNAVAILABLE",
      code: "CHANNEL_UNAVAILABLE",
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await transport.send("EMAIL", {
        ...request(),
        signal: controller.signal,
      }),
    ).toMatchObject({ status: "UNAVAILABLE", code: "CALLER_ABORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
