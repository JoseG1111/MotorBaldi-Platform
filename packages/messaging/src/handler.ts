import type { Event } from "@motorbaldi/db/outbox";
export type FailureKind =
  "RETRYABLE" | "PERMANENT" | "UNKNOWN_EXTERNAL_OUTCOME";
export class HandlerFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly code: string = kind,
  ) {
    super(/^[A-Z_]{1,64}$/.test(code) ? code : kind);
  }
}
export interface HandlerContext {
  signal: AbortSignal;
  idempotencyKey: string;
}
export type Handler = (event: Event, context: HandlerContext) => Promise<void>;
export async function boundedHandler(
  handler: Handler,
  event: Event,
  timeoutMs = 10000,
) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handler(event, { signal: abort.signal, idempotencyKey: event.id }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(
            new HandlerFailure("UNKNOWN_EXTERNAL_OUTCOME", "HANDLER_TIMEOUT"),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}
