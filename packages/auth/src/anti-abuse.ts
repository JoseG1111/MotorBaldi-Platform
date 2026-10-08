import { Problem } from "@motorbaldi/contracts";
import { sha256Hex } from "@motorbaldi/shared";

export interface AntiAbuseInput {
  token: string;
  action?: string;
  hostname?: string;
  remoteIp?: string;
  idempotencyKey?: string;
}
export interface AntiAbuseVerifier {
  verify(input: AntiAbuseInput): Promise<void>;
}

interface TurnstileResponse {
  success: boolean;
  action?: string;
  hostname?: string;
}

export async function siteverifyRetryId(
  appKey: string,
  token: string,
): Promise<string> {
  const hash = await sha256Hex(JSON.stringify([appKey, token]));
  const bytes = Uint8Array.from(hash.slice(0, 32).match(/../g)!, (part) =>
    parseInt(part, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function turnstileVerifier(options: {
  secret: string;
  expectedHostname?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): AntiAbuseVerifier {
  const fetcher = options.fetcher ?? fetch;
  return {
    async verify(input) {
      if (!input.token || input.token.length > 2048)
        throw new Problem(
          403,
          "ANTI_ABUSE_REJECTED",
          "Anti-abuse verification failed",
        );
      const body = new FormData();
      body.set("secret", options.secret);
      body.set("response", input.token);
      if (input.remoteIp) body.set("remoteip", input.remoteIp);
      if (input.idempotencyKey)
        body.set("idempotency_key", input.idempotencyKey);
      let result: TurnstileResponse;
      try {
        const response = await fetcher(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          {
            method: "POST",
            body,
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
          },
        );
        if (!response.ok) throw new Error("Siteverify unavailable");
        result = await response.json<TurnstileResponse>();
      } catch {
        throw new Problem(
          503,
          "ANTI_ABUSE_UNAVAILABLE",
          "Anti-abuse verification unavailable",
        );
      }
      const expectedHostname = options.expectedHostname ?? input.hostname;
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.success !== "boolean" ||
        (result.success === true &&
          (typeof result.action !== "string" ||
            typeof result.hostname !== "string"))
      )
        throw new Problem(
          503,
          "ANTI_ABUSE_UNAVAILABLE",
          "Anti-abuse verification unavailable",
        );
      if (
        result.success !== true ||
        (input.action && result.action !== input.action) ||
        (expectedHostname && result.hostname !== expectedHostname)
      )
        throw new Problem(
          403,
          "ANTI_ABUSE_REJECTED",
          "Anti-abuse verification failed",
        );
    },
  };
}

export function remoteLeadVerifier(
  secret?: string,
  expectedHostname?: string,
): AntiAbuseVerifier {
  if (!secret || !expectedHostname)
    throw new Problem(
      503,
      "ANTI_ABUSE_UNAVAILABLE",
      "Anti-abuse verification unavailable",
    );
  const verifier = turnstileVerifier({ secret, expectedHostname });
  return {
    verify: (input) =>
      verifier.verify({ ...input, action: "lead", hostname: expectedHostname }),
  };
}

export function deterministicAntiAbuseVerifier(
  acceptedToken: string,
): AntiAbuseVerifier {
  return {
    async verify(input) {
      if (input.token !== acceptedToken)
        throw new Problem(
          403,
          "ANTI_ABUSE_REJECTED",
          "Anti-abuse verification failed",
        );
    },
  };
}
