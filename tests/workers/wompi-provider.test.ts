import { describe, expect, it } from "vitest";
import {
  createWompiAdapter,
  verifyWompiWebhook,
  wompiIntegritySignature,
  type WompiChargeInput,
} from "../../packages/payments/src/wompi.js";

// All transport fixtures are injected; no request reaches Wompi or creates a real charge.
const config = {
  environment: "SANDBOX" as const,
  privateKey: "prv_test_fixture",
  publicKey: "pub_test_fixture",
  integritySecret: "test_integrity_fixture",
};
const charge: WompiChargeInput = {
  reference: "membership_2026_10",
  amountMinor: 2990000,
  currency: "COP",
  sourceId: 3891,
  sourceType: "CARD",
  customerEmail: "customer@example.test",
  acceptanceToken: "accepted-contract",
  personalDataToken: "accepted-personal-data",
  recurrent: true,
};
const transaction = {
  id: "1234-1610641025-49201",
  reference: charge.reference,
  amount_in_cents: charge.amountMinor,
  currency: "COP",
  status: "PENDING",
  customer_email: charge.customerEmail,
  payment_method: { last_four: "4242" },
  token: "must-not-return",
};
function transport(
  handler: (url: string, init: RequestInit) => Promise<Response>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, fetcher };
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function documentedEvent() {
  // Documented event shape with a deliberately fictional local secret and independent SHA256 checksum.
  return {
    event: "transaction.updated",
    environment: "prod",
    data: {
      transaction: {
        id: "1234-1610641025-49201",
        amount_in_cents: 4490000,
        reference: "MZQ3X2DE2SMX",
        customer_email: "fixture@example.test",
        currency: "COP",
        status: "APPROVED",
      },
    },
    signature: {
      properties: [
        "transaction.id",
        "transaction.status",
        "transaction.amount_in_cents",
      ],
      checksum:
        "7b82c93b394f0994eb77db7e29dcd595ebb8a4218a959c282b42c2bd4ad92652",
    },
    timestamp: 1530291411,
  };
}
const eventOptions = {
  environment: "PRODUCTION" as const,
  eventsSecret: "prod_events_LOCAL_FIXTURE",
};

describe("Wompi sandbox-first cryptographic adapter", () => {
  it("matches independent SHA256 vectors for the documented integrity algorithm and expiry position", async () => {
    const input = {
      environment: "PRODUCTION" as const,
      reference: "sk8-438k4-xmxm392-sn2m",
      amountMinor: 2490000,
      currency: "COP" as const,
      integritySecret: "prod_integrity_LOCAL_FIXTURE",
    };
    expect(await wompiIntegritySignature(input)).toBe(
      "ed7908baf0b593b7f36e232902027c702570e249bd8f19a29cf9302d752cc8d9",
    );
    expect(
      await wompiIntegritySignature({
        ...input,
        expirationTime: "2023-06-09T20:28:50.000Z",
      }),
    ).toBe("e7c81d98aff6f794fb004e29043c2ce1133b99f8cf6e2c2cd9b102c5e4040cd4");
  });

  it("accepts a documented-shape webhook with an independent checksum and returns only signed non-PII fields", async () => {
    const result = await verifyWompiWebhook(documentedEvent(), eventOptions);
    expect(result).toEqual({
      id: "1234-1610641025-49201",
      status: "APPROVED",
      amountMinor: 4490000,
      reference: null,
      currency: null,
      timestamp: 1530291411,
    });
    expect(JSON.stringify(result)).not.toContain("fixture@example.test");
  });

  it("follows dynamic signed-property order and accepts additional valid nested fields", async () => {
    const event = documentedEvent();
    event.signature.properties = [
      "transaction.amount_in_cents",
      "transaction.reference",
      "transaction.status",
      "transaction.currency",
      "transaction.id",
    ];
    event.signature.checksum = await digest(
      "4490000MZQ3X2DE2SMXAPPROVEDCOP1234-1610641025-49201" +
        event.timestamp +
        eventOptions.eventsSecret,
    );
    expect(
      await verifyWompiWebhook(event, {
        ...eventOptions,
        checksumHeader: event.signature.checksum.toUpperCase(),
      }),
    ).toMatchObject({ reference: "MZQ3X2DE2SMX", currency: "COP" });
    await expect(
      verifyWompiWebhook(event, {
        ...eventOptions,
        checksumHeader: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "WOMPI_EVENT_SIGNATURE_INVALID" });
  });

  it.each(["id", "status", "amount_in_cents", "timestamp"])(
    "rejects tampering with signed %s",
    async (field) => {
      const event = documentedEvent();
      if (field === "timestamp") event.timestamp++;
      else
        Object.assign(event.data.transaction, {
          [field]: field === "amount_in_cents" ? 1 : "tampered",
        });
      await expect(
        verifyWompiWebhook(event, eventOptions),
      ).rejects.toMatchObject({ code: "WOMPI_EVENT_SIGNATURE_INVALID" });
    },
  );

  it.each([
    "transaction.status",
    "transaction.amount_in_cents",
    "transaction.id",
  ])(
    "requires binding of %s even when an incomplete digest is cryptographically valid",
    async (missing) => {
      const event = documentedEvent();
      event.signature.properties = [
        "transaction.id",
        "transaction.status",
        "transaction.amount_in_cents",
        "transaction.reference",
      ].filter((property) => property !== missing);
      const values = event.signature.properties.map((path) =>
        String(
          event.data.transaction[
            path.split(".")[1] as keyof typeof event.data.transaction
          ],
        ),
      );
      event.signature.checksum = await digest(
        values.join("") + event.timestamp + eventOptions.eventsSecret,
      );
      await expect(
        verifyWompiWebhook(event, eventOptions),
      ).rejects.toMatchObject({ code: "WOMPI_EVENT_INVALID" });
    },
  );

  it.each([
    "transaction.__proto__.id",
    "constructor.name",
    "transaction.prototype",
    "transaction.missing",
    "transaction",
    "transaction.id.",
  ])("rejects unsafe or non-scalar property path %s", async (path) => {
    const event = documentedEvent();
    event.signature.properties.push(path);
    await expect(verifyWompiWebhook(event, eventOptions)).rejects.toMatchObject(
      { code: "WOMPI_EVENT_INVALID" },
    );
  });

  it("rejects webhook environment/secret mismatch and unsupported event types", async () => {
    const event = documentedEvent();
    await expect(
      verifyWompiWebhook({ ...event, environment: "test" }, eventOptions),
    ).rejects.toMatchObject({ code: "WOMPI_EVENT_INVALID" });
    await expect(
      verifyWompiWebhook(event, {
        environment: "SANDBOX",
        eventsSecret: eventOptions.eventsSecret,
      }),
    ).rejects.toMatchObject({ code: "WOMPI_KEY_ENVIRONMENT_MISMATCH" });
    await expect(
      verifyWompiWebhook(
        { ...event, event: "nequi_token.updated" },
        eventOptions,
      ),
    ).rejects.toMatchObject({ code: "WOMPI_EVENT_INVALID" });
  });

  it("denies production by default and rejects mixed keys without issuing a request", () => {
    expect(() =>
      createWompiAdapter({ ...config, environment: "PRODUCTION" }),
    ).toThrow("WOMPI_PRODUCTION_DISABLED");
    expect(() =>
      createWompiAdapter({ ...config, privateKey: "prv_prod_fixture" }),
    ).toThrow("WOMPI_KEY_ENVIRONMENT_MISMATCH");
    expect(() =>
      createWompiAdapter({
        ...config,
        integritySecret: "prod_integrity_fixture",
      }),
    ).toThrow("WOMPI_KEY_ENVIRONMENT_MISMATCH");
    expect(() =>
      createWompiAdapter({ ...config, environment: "invalid" as never }),
    ).toThrow("WOMPI_ENVIRONMENT_INVALID");
    expect(() =>
      createWompiAdapter({
        environment: "PRODUCTION",
        productionApproved: true,
        privateKey: "prv_prod_fixture",
        publicKey: "pub_prod_fixture",
        integritySecret: "prod_integrity_fixture",
      }),
    ).not.toThrow();
  });

  it("uses the current merchant endpoint and extracts both acceptance documents without exposing merchant PII", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({
        data: {
          merchant_name: "private merchant",
          presigned_acceptance: {
            acceptance_token: "terms",
            permalink: "https://wompi.co/terms.pdf",
          },
          presigned_personal_data_auth: {
            acceptance_token: "personal",
            permalink: "https://wompi.com/personal.pdf",
          },
        },
      }),
    );
    expect(
      await createWompiAdapter({
        ...config,
        fetch: fetcher,
      }).getMerchantAcceptance(),
    ).toEqual({
      acceptance: { token: "terms", permalink: "https://wompi.co/terms.pdf" },
      personalData: {
        token: "personal",
        permalink: "https://wompi.com/personal.pdf",
      },
    });
    expect(calls[0]?.url).toBe("https://sandbox.wompi.co/v1/merchants/info");
    expect(
      new Headers(calls[0]?.init.headers).get("x-merchant-public-key"),
    ).toBe(config.publicKey);
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(
      false,
    );
  });

  it("creates a CARD source with two explicit consent tokens and strips sensitive provider fields", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({
        data: {
          id: 3891,
          type: "CARD",
          status: "AVAILABLE",
          token: "sensitive",
          customer_email: charge.customerEmail,
          public_data: { last_four: "4242" },
        },
      }),
    );
    const adapter = createWompiAdapter({ ...config, fetch: fetcher });
    expect(
      await adapter.createSource(
        "tok_test_fixture",
        "CARD",
        charge.customerEmail,
        "terms",
        "personal",
      ),
    ).toEqual({ id: 3891, type: "CARD", status: "AVAILABLE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://sandbox.wompi.co/v1/payment_sources");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      type: "CARD",
      token: "tok_test_fixture",
      customer_email: charge.customerEmail,
      acceptance_token: "terms",
      accept_personal_auth: "personal",
    });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer " + config.privateKey,
    );
  });

  it.each(["PENDING", "DECLINED"])(
    "refuses creating a Nequi source before approval (%s)",
    async (status) => {
      const { calls, fetcher } = transport(async () =>
        Response.json({ data: { id: "nequi_test_fixture", status } }),
      );
      await expect(
        createWompiAdapter({ ...config, fetch: fetcher }).createSource(
          "nequi_test_fixture",
          "NEQUI",
          charge.customerEmail,
          "terms",
          "personal",
        ),
      ).rejects.toMatchObject({ code: "WOMPI_NEQUI_APPROVAL_REQUIRED" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init.method).toBeUndefined();
    },
  );

  it("creates an approved reusable Nequi source using distinct public/private authentication", async () => {
    const { calls, fetcher } = transport(async (url) =>
      Response.json({
        data: url.includes("/tokens/nequi/")
          ? {
              id: "nequi_test_fixture",
              status: "APPROVED",
              phone_number: "private",
            }
          : {
              id: 3891,
              type: "NEQUI",
              status: "AVAILABLE",
              customer_email: charge.customerEmail,
            },
      }),
    );
    expect(
      await createWompiAdapter({ ...config, fetch: fetcher }).createSource(
        "nequi_test_fixture",
        "NEQUI",
        charge.customerEmail,
        "terms",
        "personal",
      ),
    ).toEqual({ id: 3891, type: "NEQUI", status: "AVAILABLE" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://sandbox.wompi.co/v1/tokens/nequi/nequi_test_fixture",
      "https://sandbox.wompi.co/v1/payment_sources",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer " + config.publicKey,
    );
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe(
      "Bearer " + config.privateKey,
    );
  });

  it("charges exact integer COP cents and returns only whitelisted transaction fields", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({ data: transaction }),
    );
    const adapter = createWompiAdapter({ ...config, fetch: fetcher });
    expect(await adapter.chargeSource(charge)).toEqual({
      id: transaction.id,
      reference: charge.reference,
      amountMinor: 2990000,
      currency: "COP",
      status: "PENDING",
    });
    const request = JSON.parse(String(calls[0]?.init.body));
    expect(request).toEqual({
      reference: charge.reference,
      amount_in_cents: 2990000,
      currency: "COP",
      payment_source_id: 3891,
      payment_method: { installments: 1 },
      customer_email: charge.customerEmail,
      acceptance_token: charge.acceptanceToken,
      accept_personal_auth: charge.personalDataToken,
      signature: await wompiIntegritySignature({ ...config, ...charge }),
      recurrent: true,
    });
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.url).toBe("https://sandbox.wompi.co/v1/transactions");
    expect(request).not.toHaveProperty("idempotency_key");
    expect(adapter).not.toHaveProperty("findByReference");
  });

  it.each([0, -1, 29900.1, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid integer cents %s before any request",
    async (amountMinor) => {
      const { calls, fetcher } = transport(async () =>
        Response.json({ data: transaction }),
      );
      await expect(
        createWompiAdapter({ ...config, fetch: fetcher }).chargeSource({
          ...charge,
          amountMinor,
        }),
      ).rejects.toBeTruthy();
      expect(calls).toHaveLength(0);
    },
  );

  it("rejects missing consent, unsupported PSE sources and mismatched source environments before transport", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({ data: transaction }),
    );
    const adapter = createWompiAdapter({ ...config, fetch: fetcher });
    await expect(
      adapter.chargeSource({ ...charge, personalDataToken: "" }),
    ).rejects.toBeTruthy();
    await expect(
      adapter.chargeSource({ ...charge, currency: "USD" as never }),
    ).rejects.toBeTruthy();
    await expect(
      adapter.createSource(
        "tok_test_fixture",
        "PSE" as never,
        charge.customerEmail,
        "terms",
        "personal",
      ),
    ).rejects.toBeTruthy();
    await expect(
      adapter.createSource(
        "tok_prod_fixture",
        "CARD",
        charge.customerEmail,
        "terms",
        "personal",
      ),
    ).rejects.toMatchObject({ code: "WOMPI_TOKEN_ENVIRONMENT_MISMATCH" });
    expect(calls).toHaveLength(0);
  });

  it.each(["network", "timeout", "503", "malformed", "mismatched"])(
    "leaves create outcome UNKNOWN after %s and never retries",
    async (failure) => {
      const { calls, fetcher } = transport(async () => {
        if (failure === "network")
          throw new Error("must not expose private provider details");
        if (failure === "timeout") return new Promise<Response>(() => {});
        if (failure === "503")
          return Response.json({ error: "must not expose" }, { status: 503 });
        if (failure === "malformed") return Response.json({ unexpected: true });
        return Response.json({ data: { ...transaction, amount_in_cents: 1 } });
      });
      const result = await createWompiAdapter({
        ...config,
        fetch: fetcher,
        timeoutMs: 5,
      }).chargeSource(charge);
      expect(result).toEqual({
        id: null,
        reference: charge.reference,
        amountMinor: charge.amountMinor,
        currency: "COP",
        status: "UNKNOWN",
      });
      expect(calls).toHaveLength(1);
      if (failure === "timeout")
        expect(calls[0]?.init.signal?.aborted).toBe(true);
    },
  );

  it("keeps ambiguous source creation UNKNOWN without retrying or returning token/PII", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({ error: "private" }, { status: 500 }),
    );
    expect(
      await createWompiAdapter({ ...config, fetch: fetcher }).createSource(
        "tok_test_fixture",
        "CARD",
        charge.customerEmail,
        "terms",
        "personal",
      ),
    ).toEqual({ id: null, type: "CARD", status: "UNKNOWN" });
    expect(calls).toHaveLength(1);
  });

  it("reconciles only an explicit transaction id using private authentication", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({ data: { ...transaction, status: "APPROVED" } }),
    );
    const adapter = createWompiAdapter({ ...config, fetch: fetcher });
    expect(await adapter.reconcile(transaction.id)).toMatchObject({
      id: transaction.id,
      status: "APPROVED",
    });
    expect(calls[0]?.url).toBe(
      "https://sandbox.wompi.co/v1/transactions/" + transaction.id,
    );
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer " + config.privateKey,
    );
    await expect(adapter.reconcile("../../external")).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });
  it("forces one installment for CARD and omits card fields for NEQUI without inventing PSE recurrence", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({ data: transaction }),
    );
    const adapter = createWompiAdapter({ ...config, fetch: fetcher });
    await adapter.chargeSource({ ...charge, sourceType: "NEQUI" });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty(
      "payment_method",
    );
    await expect(
      adapter.chargeSource({ ...charge, sourceType: "PSE" as never }),
    ).rejects.toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("honors an in-flight caller abort as an ambiguous outcome and never retries", async () => {
    const controller = new AbortController();
    const { calls, fetcher } = transport(async () => {
      controller.abort();
      return new Promise<Response>(() => {});
    });
    const result = await createWompiAdapter({
      ...config,
      fetch: fetcher,
    }).chargeSource(charge, controller.signal);
    expect(result.status).toBe("UNKNOWN");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  it("never exposes provider failure bodies and never retries a rejected charge", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json(
        {
          error: {
            customer_email: charge.customerEmail,
            credential: "private-provider-payload",
          },
        },
        { status: 422 },
      ),
    );
    await expect(
      createWompiAdapter({ ...config, fetch: fetcher }).chargeSource(charge),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "WOMPI_REQUEST_REJECTED",
        message: "WOMPI_REQUEST_REJECTED",
      }),
    );
    expect(calls).toHaveLength(1);
  });

  it("snapshots validated configuration so later mutation cannot switch credentials or integrity environment", async () => {
    const { calls, fetcher } = transport(async () =>
      Response.json({ data: transaction }),
    );
    const mutable = { ...config, fetch: fetcher };
    const adapter = createWompiAdapter(mutable);
    mutable.privateKey = "prv_prod_not_allowed";
    mutable.integritySecret = "prod_integrity_not_allowed";
    await adapter.chargeSource(charge);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer " + config.privateKey,
    );
    expect(JSON.parse(String(calls[0]?.init.body)).signature).toBe(
      await wompiIntegritySignature({ ...config, ...charge }),
    );
  });

  it("rejects unsafe acceptance document links instead of returning active hostile URLs", async () => {
    const { fetcher } = transport(async () =>
      Response.json({
        data: {
          presigned_acceptance: {
            acceptance_token: "terms",
            permalink: "javascript:alert(1)",
          },
          presigned_personal_data_auth: {
            acceptance_token: "personal",
            permalink: "https://wompi.com/personal.pdf",
          },
        },
      }),
    );
    await expect(
      createWompiAdapter({ ...config, fetch: fetcher }).getMerchantAcceptance(),
    ).rejects.toMatchObject({ code: "WOMPI_RESPONSE_INVALID" });
  });
});
