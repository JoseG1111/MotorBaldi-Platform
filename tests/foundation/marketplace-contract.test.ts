import { describe, expect, it } from "vitest";
import {
  marketplaceCapabilities,
  marketplaceCommandInputs,
} from "../../packages/parts/src/marketplace.js";
const organizationId = "11111111-1111-4111-8111-111111111111";
const offeringId = "22222222-2222-4222-8222-222222222222";
const listingId = "33333333-3333-4333-8333-333333333333";
describe("Approved discovery-only marketplace contract", () => {
  it("keeps commerce, financial, media and fulfillment capabilities disabled", () => {
    expect(marketplaceCapabilities.discovery).toBe(true);
    expect(
      Object.entries(marketplaceCapabilities)
        .filter(([key]) => key !== "discovery")
        .every(([, enabled]) => enabled === false),
    ).toBe(true);
    expect(Object.isFrozen(marketplaceCapabilities)).toBe(true);
  });
  it("rejects publication flags, raw snapshots and commercial fields from partners", () => {
    for (const field of [
      "published",
      "approved",
      "snapshot",
      "priceMinor",
      "partnerSku",
      "mediaUrl",
      "customerId",
      "vehicleId",
      "plate",
      "vin",
      "commissionRate",
    ]) {
      expect(
        marketplaceCommandInputs["marketplace.listing.create"].safeParse({
          organizationId,
          offeringId,
          generalLocation: "Bogotá, Cundinamarca",
          [field]: true,
        }).success,
      ).toBe(false);
    }
  });
  it("requires bounded reviewed locality and canonical resource identifiers", () => {
    const schema = marketplaceCommandInputs["marketplace.listing.create"];
    expect(
      schema.safeParse({
        organizationId,
        offeringId,
        generalLocation: "Bogotá, Cundinamarca",
      }).success,
    ).toBe(true);
    for (const generalLocation of ["", " ", "x".repeat(161)])
      expect(
        schema.safeParse({ organizationId, offeringId, generalLocation })
          .success,
      ).toBe(false);
    expect(
      schema.safeParse({
        organizationId: "foreign",
        offeringId,
        generalLocation: "City",
      }).success,
    ).toBe(false);
  });
  it("requires a positive safe version and bounded reason for every lifecycle action", () => {
    for (const [operation, schema] of Object.entries(
      marketplaceCommandInputs,
    )) {
      if (operation.endsWith("create")) continue;
      const input = {
        organizationId,
        listingId,
        version: 1,
        reason: "Reviewed publication",
      };
      expect(schema.safeParse(input).success).toBe(true);
      for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
        expect(schema.safeParse({ ...input, version }).success).toBe(false);
      for (const reason of ["", " ", "x".repeat(501)])
        expect(schema.safeParse({ ...input, reason }).success).toBe(false);
      expect(
        schema.safeParse({ ...input, sessionId: "untrusted", mfaEnabled: true })
          .success,
      ).toBe(false);
    }
  });
});
