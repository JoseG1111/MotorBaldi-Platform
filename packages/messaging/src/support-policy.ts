/** Human guidance configuration only. This module grants no membership, record access, diagnosis, delivery or contractual guarantee. */
export const supportPolicyBounds = Object.freeze({
  maximumWindowSeconds: 31 * 24 * 60 * 60,
  maximumRequests: 1000,
});
export type WeeklyOpening = Readonly<{
  day: number;
  opensAt: string;
  closesAt: string;
}>;
export type SupportPolicy = Readonly<{
  enabled: boolean;
  timeZone?: string;
  weekly?: readonly WeeklyOpening[];
  usage?: Readonly<{ windowSeconds: number; maxRequests: number }>;
  whatsapp?: Readonly<{ phoneE164: string; link: string }>;
}>;
export class SupportPolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_SUPPORT_POLICY"
      | "INVALID_SUPPORT_TIMESTAMP"
      | "INVALID_SUPPORT_USAGE",
  ) {
    super(code);
    this.name = "SupportPolicyError";
  }
}
function object(
  value: unknown,
  names: readonly string[],
  code:
    | "INVALID_SUPPORT_POLICY"
    | "INVALID_SUPPORT_USAGE" = "INVALID_SUPPORT_POLICY",
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new SupportPolicyError(code);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !names.includes(key),
    )
  )
    throw new SupportPolicyError(code);
  for (const key of Object.keys(value))
    if (!Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty("value"))
      throw new SupportPolicyError(code);
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  code:
    | "INVALID_SUPPORT_POLICY"
    | "INVALID_SUPPORT_USAGE" = "INVALID_SUPPORT_POLICY",
) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new SupportPolicyError(code);
  return value;
}
function minute(time: unknown, end = false) {
  if (
    typeof time !== "string" ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)
  ) {
    if (end && time === "24:00") return 1440;
    throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
  }
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
/** Canonical UTC with milliseconds; round-trip equality rejects normalized invalid dates, local offsets and leap-second claims. */
function utc(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    throw new SupportPolicyError("INVALID_SUPPORT_TIMESTAMP");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new SupportPolicyError("INVALID_SUPPORT_TIMESTAMP");
  return date;
}
/** No hours, contact or limits are inferred. Disabled policies may be staged, but supplied fields remain strictly validated. */
export function parseSupportPolicy(input: unknown = {}): SupportPolicy {
  const value = object(input, [
    "enabled",
    "timeZone",
    "weekly",
    "usage",
    "whatsapp",
  ]);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
  const enabled = value.enabled === true;
  let timeZone: string | undefined;
  if (value.timeZone !== undefined) {
    if (
      typeof value.timeZone !== "string" ||
      value.timeZone.length > 128 ||
      !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value.timeZone)
    )
      throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
    try {
      timeZone = new Intl.DateTimeFormat("en-GB", {
        timeZone: value.timeZone,
      }).resolvedOptions().timeZone;
    } catch {
      throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
    }
  }
  let weekly: readonly WeeklyOpening[] | undefined;
  if (value.weekly !== undefined) {
    if (!Array.isArray(value.weekly) || value.weekly.length > 100)
      throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
    const intervals = value.weekly
      .map((item) => {
        const row = object(item, ["day", "opensAt", "closesAt"]),
          day = integer(row.day, 1, 7),
          starts = minute(row.opensAt),
          ends = minute(row.closesAt, true);
        if (ends <= starts)
          throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
        return {
          day,
          opensAt: row.opensAt as string,
          closesAt: row.closesAt as string,
          starts,
          ends,
        };
      })
      .sort(
        (left, right) => left.day - right.day || left.starts - right.starts,
      );
    let total = 0;
    for (let index = 0; index < intervals.length; index++) {
      const current = intervals[index]!,
        previous = intervals[index - 1];
      if (
        previous &&
        previous.day === current.day &&
        previous.ends > current.starts
      )
        throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
      total += current.ends - current.starts;
    }
    // This assistance contract deliberately excludes an around-the-clock schedule.
    if (total === 7 * 1440)
      throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
    weekly = Object.freeze(
      intervals.map((row) =>
        Object.freeze({
          day: row.day,
          opensAt: row.opensAt,
          closesAt: row.closesAt,
        }),
      ),
    );
  }
  let usage: SupportPolicy["usage"];
  if (value.usage !== undefined) {
    const row = object(value.usage, ["windowSeconds", "maxRequests"]);
    usage = Object.freeze({
      windowSeconds: integer(
        row.windowSeconds,
        1,
        supportPolicyBounds.maximumWindowSeconds,
      ),
      maxRequests: integer(
        row.maxRequests,
        1,
        supportPolicyBounds.maximumRequests,
      ),
    });
  }
  let whatsapp: SupportPolicy["whatsapp"];
  if (value.whatsapp !== undefined) {
    const row = object(value.whatsapp, ["phoneE164", "link"]);
    if (
      typeof row.phoneE164 !== "string" ||
      !/^\+[1-9][0-9]{6,14}$/.test(row.phoneE164)
    )
      throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
    const link = "https://wa.me/" + row.phoneE164.slice(1);
    // Fixed canonical host/path; reject userinfo, alternate phone, query text, ports and fragments.
    if (row.link !== undefined && row.link !== link)
      throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
    whatsapp = Object.freeze({ phoneE164: row.phoneE164, link });
  }
  if (enabled && (!timeZone || !weekly?.length || !usage))
    throw new SupportPolicyError("INVALID_SUPPORT_POLICY");
  return Object.freeze({
    enabled,
    ...(timeZone ? { timeZone } : {}),
    ...(weekly ? { weekly } : {}),
    ...(usage ? { usage } : {}),
    ...(whatsapp ? { whatsapp } : {}),
  });
}
/** AVAILABLE describes only the configured weekly schedule, never provider readiness or guaranteed human service. DST follows the named timezone at the supplied real UTC instant. */
export function supportAvailability(policy: unknown, nowUtc: string) {
  const validated = parseSupportPolicy(policy),
    now = utc(nowUtc);
  if (!validated.enabled)
    return {
      state: "UNCONFIGURED" as const,
      channelConfigured: false,
      providerReady: false as const,
      guaranteed: false as const,
    };
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: validated.timeZone!,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  const day =
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
      field("weekday"),
    ) + 1;
  const localMinute = Number(field("hour")) * 60 + Number(field("minute"));
  const open = validated.weekly!.some(
    (row) =>
      row.day === day &&
      minute(row.opensAt) <= localMinute &&
      localMinute < minute(row.closesAt, true),
  );
  return {
    state: open ? ("AVAILABLE" as const) : ("CLOSED" as const),
    timeZone: validated.timeZone!,
    channelConfigured: validated.whatsapp !== undefined,
    providerReady: false as const,
    guaranteed: false as const,
  };
}
export type SupportUsageSnapshot = Readonly<{
  windowStartedAt: string | null;
  requestCount: number;
}>;
/** A read-only decision for an atomic D1 quota snapshot. The caller must validate authorization/schedule and persist the proposed count/window in the same transaction as case creation; this does not reserve a request. */
export function evaluateSupportUsage(
  policy: unknown,
  nowUtc: string,
  snapshot: SupportUsageSnapshot,
) {
  const validated = parseSupportPolicy(policy),
    now = utc(nowUtc),
    value = object(
      snapshot,
      ["windowStartedAt", "requestCount"],
      "INVALID_SUPPORT_USAGE",
    );
  const count = integer(
    value.requestCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "INVALID_SUPPORT_USAGE",
  );
  const start =
    value.windowStartedAt === null ? null : utc(value.windowStartedAt);
  if (
    (start === null && count !== 0) ||
    (start !== null && start.getTime() > now.getTime())
  )
    throw new SupportPolicyError("INVALID_SUPPORT_USAGE");
  if (!validated.enabled)
    return {
      allowed: false,
      reason: "UNCONFIGURED" as const,
      windowStartedAt: null,
      windowEndsAt: null,
      currentCount: 0,
      nextCount: null,
    };
  const windowMs = validated.usage!.windowSeconds * 1000;
  const expired = start === null || now.getTime() >= start.getTime() + windowMs;
  const windowStartedAt = expired ? nowUtc : start!.toISOString(),
    currentCount = expired ? 0 : count;
  const windowEndsAt = new Date(
    new Date(windowStartedAt).getTime() + windowMs,
  ).toISOString();
  const allowed = currentCount < validated.usage!.maxRequests;
  return {
    allowed,
    reason: allowed ? ("ALLOWED" as const) : ("LIMIT_REACHED" as const),
    windowStartedAt,
    windowEndsAt,
    currentCount,
    nextCount: allowed ? currentCount + 1 : null,
  };
}
