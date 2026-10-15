import { createHmac, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyMetaStatuses,
  verifyMetaPhoneChallenges,
  verifyResendStatus,
} from "../../packages/messaging/src/provider-webhooks.js";
const now = new Date("2026-10-12T12:00:00Z");
const secret = `whsec_${Buffer.from("synthetic-signing-fixture").toString("base64")}`;
const appSecret = "synthetic-app-fixture";
const resend = (type = "email.delivered") =>
  JSON.stringify({
    type,
    created_at: now.toISOString(),
    data: {
      email_id: "email-001",
      to: ["private@example.com"],
      subject: "private content",
    },
  });
function resendHeaders(raw: string, timestamp = String(now.getTime() / 1000)) {
  return new Headers({
    "svix-id": "msg_fixture1",
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${createHmac(
      "sha256",
      Buffer.from(secret.slice(6), "base64"),
    )
      .update(`msg_fixture1.${timestamp}.${raw}`)
      .digest("base64")}`,
  });
}
const statuses = [
  {
    id: "wamid.fixture==",
    status: "delivered",
    timestamp: String(now.getTime() / 1000),
    recipient_id: "private-recipient",
    errors: [{ message: "private error" }],
  },
];
function metaBody(items: unknown[] = statuses, phone = "12345") {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phone },
              messages: [{ text: { body: "private inbound content" } }],
              statuses: items,
            },
          },
        ],
      },
    ],
  });
}
const metaHeaders = (raw: string) =>
  new Headers({
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`,
  });
describe("signed provider status normalization", () => {
  it.each([
    ["email.sent", "SENT"],
    ["email.delivered", "DELIVERED"],
    ["email.bounced", "FAILED"],
    ["email.failed", "FAILED"],
  ])("normalizes Resend %s without private fields", async (type, status) => {
    const raw = resend(type);
    expect(
      await verifyResendStatus(raw, resendHeaders(raw), secret, now),
    ).toEqual([
      {
        provider: "RESEND",
        evidenceId: "msg_fixture1",
        providerReference: "email-001",
        status,
        occurredAt: now.toISOString(),
        payloadSha256: createHash("sha256").update(raw).digest("hex"),
      },
    ]);
  });
  it("does not treat opens or inbound emails as read status", async () => {
    for (const type of ["email.opened", "email.received"]) {
      const raw = resend(type);
      expect(
        await verifyResendStatus(raw, resendHeaders(raw), secret, now),
      ).toEqual([]);
    }
  });
  it("accepts one matching rotation signature and rejects malformed/missing secrets", async () => {
    const raw = resend();
    const headers = resendHeaders(raw);
    headers.set(
      "svix-signature",
      `v1,invalid v2,unrecognized ${headers.get("svix-signature")}`,
    );
    expect(await verifyResendStatus(raw, headers, secret, now)).toHaveLength(1);
    for (const badSecret of ["", "whsec_!", "whsec_d3Jvbmc="])
      await expect(
        verifyResendStatus(raw, headers, badSecret, now),
      ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
    await expect(
      verifyResendStatus(raw, new Headers(), secret, now),
    ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
  });
  it.each([-301, 301])(
    "rejects replay/future timestamps outside the window (%s)",
    async (offset) => {
      const raw = resend();
      await expect(
        verifyResendStatus(
          raw,
          resendHeaders(raw, String(now.getTime() / 1000 + offset)),
          secret,
          now,
        ),
      ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
    },
  );
  it.each([-300, 300])(
    "accepts signed timestamps at the tolerance boundary (%s)",
    async (offset) => {
      const raw = resend();
      expect(
        await verifyResendStatus(
          raw,
          resendHeaders(raw, String(now.getTime() / 1000 + offset)),
          secret,
          now,
        ),
      ).toHaveLength(1);
    },
  );
  it("verifies signature before JSON and sanitizes malformed payload errors", async () => {
    const raw = "private malformed JSON";
    await expect(
      verifyResendStatus(raw, new Headers(), secret, now),
    ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
    await expect(
      verifyResendStatus(raw, resendHeaders(raw), secret, now),
    ).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
    const good = resend();
    await expect(
      verifyResendStatus(good + " ", resendHeaders(good), secret, now),
    ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
  });
  it("bounds raw UTF-8 bytes before cryptographic processing", async () => {
    for (const raw of ["x".repeat(65537), "é".repeat(32769)]) {
      await expect(
        verifyResendStatus(raw, new Headers(), secret, now),
      ).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
      await expect(
        verifyMetaStatuses(raw, new Headers(), appSecret, "12345"),
      ).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
    }
  });
  it("normalizes Meta statuses with stable evidence IDs and no PII", async () => {
    for (const [input, output] of [
      ["sent", "SENT"],
      ["delivered", "DELIVERED"],
      ["read", "READ"],
      ["failed", "FAILED"],
    ]) {
      const raw = metaBody([{ ...statuses[0], status: input }]);
      const result = await verifyMetaStatuses(
        raw,
        metaHeaders(raw),
        appSecret,
        "12345",
      );
      expect(result).toEqual([
        {
          provider: "META_WHATSAPP",
          providerReference: "wamid.fixture==",
          status: output,
          occurredAt: now.toISOString(),
          evidenceId: createHash("sha256")
            .update(
              JSON.stringify([
                "wamid.fixture==",
                output,
                String(now.getTime() / 1000),
              ]),
            )
            .digest("hex"),
          payloadSha256: createHash("sha256").update(raw).digest("hex"),
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });
  it("deduplicates Meta evidence across duplicates and retries", async () => {
    const raw = metaBody([statuses[0], statuses[0]]);
    const first = await verifyMetaStatuses(
      raw,
      metaHeaders(raw),
      appSecret,
      "12345",
    );
    expect(first).toHaveLength(1);
    expect(
      await verifyMetaStatuses(raw, metaHeaders(raw), appSecret, "12345"),
    ).toEqual(first);
  });
  it("rejects Meta tampering, missing signature and wrong app secret before parsing", async () => {
    const raw = metaBody();
    for (const [body, headers, key] of [
      [raw + " ", metaHeaders(raw), appSecret],
      [raw, new Headers(), appSecret],
      [raw, metaHeaders(raw), "wrong"],
    ] as const)
      await expect(
        verifyMetaStatuses(body, headers, key, "12345"),
      ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
    await expect(
      verifyMetaStatuses("bad json", new Headers(), appSecret, "12345"),
    ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
  });
  it("rejects wrong phone, wrong shape and over 100 statuses", async () => {
    for (const raw of [
      metaBody(statuses, "67890"),
      JSON.stringify({ object: "page", entry: [] }),
      metaBody(Array.from({ length: 101 }, () => statuses[0])),
      metaBody([{ id: "bad", status: "delivered", timestamp: "bad" }]),
      metaBody([{ id: "bad", status: "invented", timestamp: "1" }]),
    ])
      await expect(
        verifyMetaStatuses(raw, metaHeaders(raw), appSecret, "12345"),
      ).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
  });
  it("ignores inbound message content and deleted status", async () => {
    const raw = metaBody([{ ...statuses[0], status: "deleted" }]);
    expect(
      await verifyMetaStatuses(raw, metaHeaders(raw), appSecret, "12345"),
    ).toEqual([]);
  });
});

describe("signed inbound Meta phone challenges", () => {
  const token = "a".repeat(64);
  const message = {
    type: "text",
    text: { body: `MotorBaldi ${token}` },
    from: "573001234567",
    id: "wamid.challenge==",
    timestamp: String(now.getTime() / 1000),
  };
  function inbound(items: unknown[] = [message], phone = "12345", changes = 1) {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: Array.from({ length: changes }, () => ({
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phone },
              messages: items,
            },
          })),
        },
      ],
    });
  }
  const verify = (raw: string) =>
    verifyMetaPhoneChallenges(raw, metaHeaders(raw), appSecret, "12345", now);
  it("returns only the exact recent inbound challenge fields", async () => {
    const raw = inbound([
      { ...message, text: { body: `  MotorBaldi ${token}\n` } },
    ]);
    expect(await verify(raw)).toEqual([
      {
        token,
        sender: "+573001234567",
        providerReference: message.id,
        occurredAt: now.toISOString(),
      },
    ]);
  });
  it("rejects forged signatures before parsing", async () => {
    await expect(
      verifyMetaPhoneChallenges(
        "bad json",
        metaHeaders(inbound()),
        appSecret,
        "12345",
        now,
      ),
    ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
    const raw = inbound();
    await expect(
      verifyMetaPhoneChallenges(
        raw + " ",
        metaHeaders(raw),
        appSecret,
        "12345",
        now,
      ),
    ).rejects.toThrow("INVALID_PROVIDER_SIGNATURE");
  });
  it("rejects wrong phone metadata", async () => {
    await expect(verify(inbound([message], "67890"))).rejects.toThrow(
      "INVALID_PROVIDER_PAYLOAD",
    );
  });
  it.each([-601, 31])(
    "rejects a challenge outside the time window (%s)",
    async (offset) => {
      await expect(
        verify(
          inbound([
            { ...message, timestamp: String(now.getTime() / 1000 + offset) },
          ]),
        ),
      ).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
    },
  );
  it.each([-600, 30])("accepts the timestamp boundary (%s)", async (offset) => {
    expect(
      await verify(
        inbound([
          { ...message, timestamp: String(now.getTime() / 1000 + offset) },
        ]),
      ),
    ).toHaveLength(1);
  });
  it.each([
    "012345678",
    "+573001234567",
    "1234567",
    "1234567890123456",
    "sender",
  ])("rejects invalid sender %s", async (from) => {
    await expect(verify(inbound([{ ...message, from }]))).rejects.toThrow(
      "INVALID_PROVIDER_PAYLOAD",
    );
  });
  it("rejects invalid provider references", async () => {
    await expect(
      verify(inbound([{ ...message, id: "invalid reference" }])),
    ).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
  });
  it("ignores unrelated text and message types", async () => {
    expect(
      await verify(
        inbound([
          { type: "image" },
          { ...message, text: { body: "hello" } },
          { ...message, text: { body: `MotorBaldi ${token.toUpperCase()}` } },
          { ...message, text: { body: `MotorBaldi ${token} extra` } },
        ]),
      ),
    ).toEqual([]);
  });
  it("bounds body bytes, messages and changes across entries", async () => {
    for (const raw of [
      "é".repeat(32769),
      inbound(Array.from({ length: 101 }, () => message)),
      inbound([message, message], "12345", 51),
      inbound([], "12345", 101),
    ]) {
      await expect(verify(raw)).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
    }
    const body = JSON.parse(inbound([], "12345", 51));
    body.entry.push(body.entry[0]);
    await expect(verify(JSON.stringify(body))).rejects.toThrow(
      "INVALID_PROVIDER_PAYLOAD",
    );
    expect(
      await verify(inbound(Array.from({ length: 100 }, () => message))),
    ).toHaveLength(100);
  });
});
