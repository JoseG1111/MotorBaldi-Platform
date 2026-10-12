import { CUSTOMER_PLANS } from "@motorbaldi/shared/customer-plans";

export const premiumVehicleLimit = CUSTOMER_PLANS.premium.vehicleLimit;
export const additionalVehicleFixtureCount = premiumVehicleLimit + 1;

/** Validate the actual public server catalog against the owner-approved policy. */
export function assertApprovedDevelopmentPlans(plans) {
  const prices = Object.entries(CUSTOMER_PLANS.prices);
  if (
    !Array.isArray(plans) ||
    plans.length !== prices.length ||
    prices.some(([period, price]) => {
      const matching = plans.filter((row) => row?.code === price.planCode);
      return (
        matching.length !== 1 ||
        matching[0].amount_minor !== price.amountMinor ||
        matching[0].currency !== price.currency ||
        matching[0].vehicle_limit !== premiumVehicleLimit ||
        matching[0].period !== (period === "MONTHLY" ? "MONTH" : "YEAR")
      );
    })
  )
    throw new Error("Owner-approved server plan mismatch");
}
