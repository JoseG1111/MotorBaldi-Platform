const safeKeys = new Set([
  "requestId",
  "event",
  "code",
  "status",
  "durationMs",
  "service",
  "method",
  "operation",
  "exceptionClass",
]);

export function safeLog(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, item]) =>
        safeKeys.has(key) &&
        ["string", "number", "boolean"].includes(typeof item),
    ),
  );
}

export const logger = {
  info(value: Record<string, unknown>) {
    console.log(JSON.stringify(safeLog(value)));
  },
  warn(value: Record<string, unknown>) {
    console.warn(JSON.stringify(safeLog(value)));
  },
  error(value: Record<string, unknown>) {
    console.error(JSON.stringify(safeLog(value)));
  },
};

export function safeException(error: unknown) {
  const exceptionClass =
    error instanceof TypeError
      ? "TypeError"
      : error instanceof RangeError
        ? "RangeError"
        : error instanceof Error
          ? "Error"
          : "UnknownError";
  return { exceptionClass };
}

export const errorTracker = {
  capture(
    code: string,
    requestId: string,
    error?: unknown,
    service = "motorbaldi-core",
    operation = "unknown",
  ) {
    logger.error({
      event: "error",
      code,
      requestId,
      service,
      operation,
      ...safeException(error),
    });
  },
};

export * from "./metrics.js";
