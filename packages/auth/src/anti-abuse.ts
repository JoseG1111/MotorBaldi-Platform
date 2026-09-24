import { Problem } from "@motorbaldi/contracts";

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

export function turnstileVerifier(options: {
  secret: string;
  expectedHostname?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): AntiAbuseVerifier {
  const fetcher = options.fetcher ?? fetch;
  return {
    async verify(input) {
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
        result = await response.json<TurnstileResponse>();
      } catch {
        throw new Problem(
          503,
          "ANTI_ABUSE_UNAVAILABLE",
          "Anti-abuse verification unavailable",
        );
      }
      const expectedHostname = input.hostname ?? options.expectedHostname;
      if (
        !result.success ||
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
