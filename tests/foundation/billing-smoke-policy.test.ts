import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CUSTOMER_PLANS } from "@motorbaldi/shared/customer-plans";
const policyPath = "../../scripts/billing/smoke-policy.mjs";
const {
  assertApprovedDevelopmentPlans,
  premiumVehicleLimit,
  additionalVehicleFixtureCount,
} = (await import(policyPath)) as {
  assertApprovedDevelopmentPlans: (plans: unknown) => void;
  premiumVehicleLimit: number;
  additionalVehicleFixtureCount: number;
};
const plans = () =>
  Object.entries(CUSTOMER_PLANS.prices).map(([period, price]) => ({
    code: price.planCode,
    amount_minor: price.amountMinor,
    currency: price.currency,
    period: period === "MONTHLY" ? "MONTH" : "YEAR",
    vehicle_limit: CUSTOMER_PLANS.premium.vehicleLimit,
  }));
describe("Development billing smoke uses the approved customer catalog", () => {
  it("accepts the actual three-vehicle catalog at the exact approved prices", () => {
    expect(plans().map((row) => row.amount_minor)).toEqual([2990000, 28800000]);
    expect(() => assertApprovedDevelopmentPlans(plans())).not.toThrow();
    expect(() =>
      assertApprovedDevelopmentPlans(plans().reverse()),
    ).not.toThrow();
    expect(premiumVehicleLimit).toBe(3);
    expect(additionalVehicleFixtureCount).toBe(4);
    expect(additionalVehicleFixtureCount).toBe(
      CUSTOMER_PLANS.premium.vehicleLimit + 1,
    );
  });
  it.each([
    { vehicle_limit: 2 },
    { vehicle_limit: 4 },
    { amount_minor: 1 },
    { amount_minor: 29900 },
    { currency: "USD" },
    { period: "YEAR" },
  ])("rejects changed monthly plan %j", (patch) => {
    const rows = plans();
    Object.assign(rows[0]!, patch);
    expect(() => assertApprovedDevelopmentPlans(rows)).toThrow(
      "Owner-approved server plan mismatch",
    );
  });
  it("rejects a changed annual price or period", () => {
    for (const patch of [{ amount_minor: 2990000 }, { period: "MONTH" }]) {
      const rows = plans();
      Object.assign(rows[1]!, patch);
      expect(() => assertApprovedDevelopmentPlans(rows)).toThrow();
    }
  });
  it("rejects missing, duplicate, extra, and malformed public plans", () => {
    const rows = plans();
    for (const invalid of [
      null,
      {},
      [],
      rows.slice(0, 1),
      [rows[0], rows[0]],
      [...rows, { ...rows[0], code: "UNAPPROVED" }],
    ])
      expect(() => assertApprovedDevelopmentPlans(invalid)).toThrow();
  });
  it("imports the typed workspace catalog through native Node for the deployed smoke script", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { CUSTOMER_PLANS } from '@motorbaldi/shared/customer-plans'; import { assertApprovedDevelopmentPlans, additionalVehicleFixtureCount } from './scripts/billing/smoke-policy.mjs'; const plans=Object.entries(CUSTOMER_PLANS.prices).map(([period,p])=>({code:p.planCode,amount_minor:p.amountMinor,currency:p.currency,period:period==='MONTHLY'?'MONTH':'YEAR',vehicle_limit:CUSTOMER_PLANS.premium.vehicleLimit})); assertApprovedDevelopmentPlans(plans); console.log(JSON.stringify({limit:CUSTOMER_PLANS.premium.vehicleLimit,fixtures:additionalVehicleFixtureCount}));`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({ limit: 3, fixtures: 4 });
  });
});
