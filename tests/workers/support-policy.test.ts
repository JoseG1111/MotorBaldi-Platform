import { describe, expect, it } from "vitest";
import {
  evaluateSupportUsage,
  parseSupportPolicy,
  supportAvailability,
  supportPolicyBounds,
} from "../../packages/messaging/src/support-policy.js";

const policy = {
  enabled: true,
  timeZone: "America/Bogota",
  weekly: [
    { day: 1, opensAt: "09:00", closesAt: "12:00" },
    { day: 1, opensAt: "13:00", closesAt: "17:00" },
  ],
  usage: { windowSeconds: 3600, maxRequests: 2 },
};
const instant = "2026-10-12T14:00:00.000Z"; // Monday 09:00 in Bogotá.

describe("configured human guidance policy", () => {
  it("defaults to disabled without inventing hours, contacts or usage benefits", () => {
    expect(parseSupportPolicy()).toEqual({ enabled: false });
    expect(supportAvailability({}, instant)).toEqual({
      state: "UNCONFIGURED",
      channelConfigured: false,
      providerReady: false,
      guaranteed: false,
    });
    expect(
      evaluateSupportUsage({}, instant, {
        windowStartedAt: null,
        requestCount: 0,
      }),
    ).toEqual({
      allowed: false,
      reason: "UNCONFIGURED",
      windowStartedAt: null,
      windowEndsAt: null,
      currentCount: 0,
      nextCount: null,
    });
  });

  it.each([
    { enabled: true },
    { ...policy, timeZone: undefined },
    { ...policy, weekly: [] },
    { ...policy, usage: undefined },
    { ...policy, unlimited: true },
    { ...policy, enabled: "true" },
    { ...policy, timeZone: "Imaginary/Timezone" },
    { ...policy, timeZone: "+05:00" },
    { ...policy, usage: { windowSeconds: 0, maxRequests: 2 } },
    { ...policy, usage: { windowSeconds: 1, maxRequests: 0 } },
    {
      ...policy,
      usage: {
        windowSeconds: supportPolicyBounds.maximumWindowSeconds + 1,
        maxRequests: 1,
      },
    },
    {
      ...policy,
      usage: {
        windowSeconds: 1,
        maxRequests: supportPolicyBounds.maximumRequests + 1,
      },
    },
    { ...policy, usage: { windowSeconds: 1.5, maxRequests: 1 } },
    { ...policy, usage: { windowSeconds: 1, maxRequests: 1, unlimited: true } },
  ])("rejects incomplete, unlimited or invalid enabled policy %#", (value) => {
    expect(() => parseSupportPolicy(value)).toThrow("INVALID_SUPPORT_POLICY");
  });

  it.each(
    [
      [{ day: 0, opensAt: "09:00", closesAt: "12:00" }],
      [{ day: 8, opensAt: "09:00", closesAt: "12:00" }],
      [{ day: 1, opensAt: "9:00", closesAt: "12:00" }],
      [{ day: 1, opensAt: "24:00", closesAt: "24:00" }],
      [{ day: 1, opensAt: "09:00", closesAt: "09:00" }],
      [{ day: 1, opensAt: "22:00", closesAt: "02:00" }],
      [
        { day: 1, opensAt: "09:00", closesAt: "12:00" },
        { day: 1, opensAt: "11:59", closesAt: "13:00" },
      ],
      [
        { day: 1, opensAt: "09:00", closesAt: "12:00" },
        { day: 1, opensAt: "09:00", closesAt: "12:00" },
      ],
      [{ day: 1, opensAt: "09:00", closesAt: "12:00", guaranteed: true }],
    ].map((weekly) => ({ weekly })),
  )(
    "rejects overlapping, implicit overnight or malformed schedule %#",
    ({ weekly }) => {
      expect(() => parseSupportPolicy({ ...policy, weekly })).toThrow(
        "INVALID_SUPPORT_POLICY",
      );
    },
  );

  it("rejects full around-the-clock coverage even when configured as separate explicit days", () => {
    expect(() =>
      parseSupportPolicy({
        ...policy,
        weekly: Array.from({ length: 7 }, (_, index) => ({
          day: index + 1,
          opensAt: "00:00",
          closesAt: "24:00",
        })),
      }),
    ).toThrow("INVALID_SUPPORT_POLICY");
  });

  it("allows adjacent intervals and returns an immutable canonical policy", () => {
    const source = {
      ...policy,
      weekly: [
        { day: 1, opensAt: "12:00", closesAt: "13:00" },
        { day: 1, opensAt: "09:00", closesAt: "12:00" },
      ],
    };
    const result = parseSupportPolicy(source);
    expect(result.weekly?.[0]?.opensAt).toBe("09:00");
    source.weekly[0]!.opensAt = "00:00";
    expect(result.weekly?.[1]?.opensAt).toBe("12:00");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.weekly)).toBe(true);
    expect(Object.isFrozen(result.weekly?.[0])).toBe(true);
  });

  it.each([
    ["2026-10-12T13:59:59.999Z", "CLOSED"],
    ["2026-10-12T14:00:00.000Z", "AVAILABLE"],
    ["2026-10-12T16:59:59.999Z", "AVAILABLE"],
    ["2026-10-12T17:00:00.000Z", "CLOSED"],
    ["2026-10-12T18:00:00.000Z", "AVAILABLE"],
    ["2026-10-12T22:00:00.000Z", "CLOSED"],
    ["2026-10-13T14:00:00.000Z", "CLOSED"],
  ])("computes Bogotá opening/lunch/closing boundaries at %s", (now, state) => {
    expect(supportAvailability(policy, now)).toMatchObject({
      state,
      providerReady: false,
      guaranteed: false,
      channelConfigured: false,
    });
  });

  it("computes local weekly date across a UTC midnight without confusing the day", () => {
    const mondayLate = {
      ...policy,
      weekly: [{ day: 1, opensAt: "23:00", closesAt: "24:00" }],
    };
    expect(
      supportAvailability(mondayLate, "2026-10-13T04:59:59.999Z").state,
    ).toBe("AVAILABLE");
    expect(
      supportAvailability(mondayLate, "2026-10-13T05:00:00.000Z").state,
    ).toBe("CLOSED");
  });

  it("uses actual spring-forward civil time and a fall-back repeated hour in an IANA timezone", () => {
    const sunday = {
      ...policy,
      timeZone: "America/New_York",
      weekly: [{ day: 7, opensAt: "01:30", closesAt: "03:30" }],
    };
    expect(supportAvailability(sunday, "2026-03-08T06:29:59.999Z").state).toBe(
      "CLOSED",
    );
    expect(supportAvailability(sunday, "2026-03-08T06:30:00.000Z").state).toBe(
      "AVAILABLE",
    );
    expect(supportAvailability(sunday, "2026-03-08T07:00:00.000Z").state).toBe(
      "AVAILABLE",
    );
    expect(supportAvailability(sunday, "2026-03-08T07:30:00.000Z").state).toBe(
      "CLOSED",
    );
    const repeated = {
      ...sunday,
      weekly: [{ day: 7, opensAt: "01:30", closesAt: "02:00" }],
    };
    expect(
      supportAvailability(repeated, "2026-11-01T05:30:00.000Z").state,
    ).toBe("AVAILABLE");
    expect(
      supportAvailability(repeated, "2026-11-01T06:30:00.000Z").state,
    ).toBe("AVAILABLE");
  });

  it.each([
    "2026-02-30T09:00:00.000Z",
    "2025-02-29T09:00:00.000Z",
    "2026-10-12T09:00:00-05:00",
    "2026-10-12T14:00:00Z",
    "2026-10-12",
    "2026-10-12T24:00:00.000Z",
    "2026-10-12T14:00:60.000Z",
  ])("rejects noncanonical or unreal UTC timestamp %s", (now) => {
    expect(() => supportAvailability(policy, now)).toThrow(
      "INVALID_SUPPORT_TIMESTAMP",
    );
  });

  it("handles a real leap-day instant instead of normalizing an invalid date", () => {
    const leap = {
      ...policy,
      timeZone: "UTC",
      weekly: [{ day: 4, opensAt: "09:00", closesAt: "10:00" }],
    };
    expect(supportAvailability(leap, "2024-02-29T09:00:00.000Z").state).toBe(
      "AVAILABLE",
    );
  });

  it("offers an opt-in canonical WhatsApp contact without claiming provider readiness", () => {
    const configured = { ...policy, whatsapp: { phoneE164: "+573001234567" } };
    expect(parseSupportPolicy(configured).whatsapp).toEqual({
      phoneE164: "+573001234567",
      link: "https://wa.me/573001234567",
    });
    expect(supportAvailability(configured, instant)).toMatchObject({
      state: "AVAILABLE",
      channelConfigured: true,
      providerReady: false,
      guaranteed: false,
    });
    expect(
      supportAvailability({ ...configured, enabled: false }, instant),
    ).toMatchObject({ state: "UNCONFIGURED", channelConfigured: false });
  });

  it.each([
    { phoneE164: "573001234567" },
    { phoneE164: "+0000000" },
    { phoneE164: "+573001234567", link: "http://wa.me/573001234567" },
    {
      phoneE164: "+573001234567",
      link: "https://wa.me/573001234567?text=private-customer-data",
    },
    { phoneE164: "+573001234567", link: "https://wa.me/573001234567#fragment" },
    {
      phoneE164: "+573001234567",
      link: "https://wa.me.evil.test/573001234567",
    },
    {
      phoneE164: "+573001234567",
      link: "https://user:password@wa.me/573001234567",
    },
    { phoneE164: "+573001234567", link: "https://wa.me:443/573001234567" },
    { phoneE164: "+573001234567", link: "https://wa.me/573009999999" },
  ])(
    "rejects unsolicited, unsafe or PII-prefilled contact links %#",
    (whatsapp) => {
      expect(() => parseSupportPolicy({ ...policy, whatsapp })).toThrow(
        "INVALID_SUPPORT_POLICY",
      );
    },
  );

  it("proposes a count from an atomic durable snapshot without consuming it in memory", () => {
    const snapshot = { windowStartedAt: instant, requestCount: 1 };
    const a = evaluateSupportUsage(
        policy,
        "2026-10-12T14:30:00.000Z",
        snapshot,
      ),
      b = evaluateSupportUsage(policy, "2026-10-12T14:30:00.000Z", snapshot);
    expect(a).toEqual({
      allowed: true,
      reason: "ALLOWED",
      windowStartedAt: instant,
      windowEndsAt: "2026-10-12T15:00:00.000Z",
      currentCount: 1,
      nextCount: 2,
    });
    expect(b).toEqual(a);
    expect(snapshot.requestCount).toBe(1);
    expect(
      evaluateSupportUsage(policy, "2026-10-12T14:30:00.000Z", {
        ...snapshot,
        requestCount: 2,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "LIMIT_REACHED",
      nextCount: null,
    });
  });

  it("starts a usage window only as a proposal and resets at the exact UTC boundary", () => {
    expect(
      evaluateSupportUsage(policy, instant, {
        windowStartedAt: null,
        requestCount: 0,
      }),
    ).toMatchObject({
      allowed: true,
      windowStartedAt: instant,
      currentCount: 0,
      nextCount: 1,
    });
    expect(
      evaluateSupportUsage(policy, "2026-10-12T14:59:59.999Z", {
        windowStartedAt: instant,
        requestCount: 2,
      }),
    ).toMatchObject({ allowed: false, reason: "LIMIT_REACHED" });
    expect(
      evaluateSupportUsage(policy, "2026-10-12T15:00:00.000Z", {
        windowStartedAt: instant,
        requestCount: 2,
      }),
    ).toMatchObject({
      allowed: true,
      windowStartedAt: "2026-10-12T15:00:00.000Z",
      currentCount: 0,
      nextCount: 1,
    });
  });

  it.each([
    { windowStartedAt: null, requestCount: 1 },
    { windowStartedAt: instant, requestCount: -1 },
    { windowStartedAt: instant, requestCount: 1.5 },
    { windowStartedAt: instant, requestCount: Number.MAX_SAFE_INTEGER + 1 },
    { windowStartedAt: "2026-10-12T15:00:00.000Z", requestCount: 0 },
    { windowStartedAt: instant, requestCount: 0, unlimited: true },
  ])(
    "rejects inconsistent or unbounded durable usage snapshot %#",
    (snapshot) => {
      expect(() => evaluateSupportUsage(policy, instant, snapshot)).toThrow(
        "INVALID_SUPPORT_USAGE",
      );
    },
  );

  it("rejects accessor and prototype configuration without executing an accessor", () => {
    let executed = false;
    const accessor = {
      get enabled() {
        executed = true;
        return true;
      },
    };
    expect(() => parseSupportPolicy(accessor)).toThrow(
      "INVALID_SUPPORT_POLICY",
    );
    expect(executed).toBe(false);
    expect(() => parseSupportPolicy(Object.create({ enabled: true }))).toThrow(
      "INVALID_SUPPORT_POLICY",
    );
  });
});
