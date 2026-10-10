import { describe, expect, it } from "vitest";
import {
  isStrongPartsMatch,
  normalizeReferenceKey,
  parsePartsCommand,
  partsCommandInputs,
  partsPhaseCapabilities,
  partsStrongMatchKey,
} from "../../packages/parts/src/contract.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const offeringId = "22222222-2222-4222-8222-222222222222";
const data = {
  name: "Oil filter",
  category: "Filters",
  brand: "Bosch",
  manufacturerReference: "OF-100",
  unit: "unit",
  reason: "Initial catalog entry",
};

describe("Parts domain contract", () => {
  it("creates only drafts with explicit informational defaults", () => {
    expect(parsePartsCommand("parts.canonical.create", data)).toMatchObject({
      status: "DRAFT",
      description: "",
      compatibility: [],
    });
    expect(
      parsePartsCommand("parts.offering.create", { ...data, organizationId }),
    ).toMatchObject({
      status: "DRAFT",
      locationId: null,
      canonicalPartId: null,
      partnerSku: null,
      priceMinor: null,
      currency: "COP",
      availability: "UNKNOWN",
    });
    expect(() =>
      parsePartsCommand("parts.canonical.create", {
        ...data,
        status: "ACTIVE",
      }),
    ).toThrow();
  });

  it("accepts optional locations and bounded COP prices without stock claims", () => {
    const schema = partsCommandInputs["parts.offering.create"];
    expect(
      schema.safeParse({
        ...data,
        organizationId,
        locationId: offeringId,
        priceMinor: 0,
        availability: "AVAILABLE",
      }).success,
    ).toBe(true);
    for (const priceMinor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        schema.safeParse({ ...data, organizationId, priceMinor }).success,
      ).toBe(false);
    expect(
      schema.safeParse({ ...data, organizationId, currency: "USD" }).success,
    ).toBe(false);
  });

  it("rejects commerce, PII, and organization fields outside their scoped schema", () => {
    for (const key of [
      "stockQuantity",
      "payment",
      "checkout",
      "quantity",
      "vin",
      "plate",
      "vehicleId",
      "organizationId",
      "priceMinor",
      "partnerSku",
    ])
      expect(
        partsCommandInputs["parts.canonical.create"].safeParse({
          ...data,
          [key]: key === "priceMinor" ? 0 : "unexpected",
        }).success,
      ).toBe(false);
    for (const key of [
      "stockQuantity",
      "payment",
      "checkout",
      "quantity",
      "vehicleId",
    ])
      expect(
        partsCommandInputs["parts.offering.create"].safeParse({
          ...data,
          organizationId,
          [key]: 1,
        }).success,
      ).toBe(false);
  });

  it("requires bounded references and full mutable update data with CAS version", () => {
    const schema = partsCommandInputs["parts.canonical.update"];
    expect(
      schema.safeParse({ ...data, partId: offeringId, version: 1 }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        partId: offeringId,
        version: 1,
        reason: data.reason,
        name: data.name,
      }).success,
    ).toBe(false);
    for (const version of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])
      expect(
        schema.safeParse({ ...data, partId: offeringId, version }).success,
      ).toBe(false);
    for (const manufacturerReference of ["  ", "x".repeat(161)])
      expect(
        schema.safeParse({
          ...data,
          partId: offeringId,
          version: 1,
          manufacturerReference,
        }).success,
      ).toBe(false);
  });

  it("supports only unverified bounded structured compatibility", () => {
    const schema = partsCommandInputs["parts.canonical.create"];
    const compatibility = [{ vehicleKind: "CAR", brand: "Mazda", model: "3" }];
    expect(
      parsePartsCommand("parts.canonical.create", { ...data, compatibility })
        .compatibility,
    ).toEqual([{ ...compatibility[0], verified: false }]);
    for (const claim of [
      { verified: true },
      { vin: "VIN" },
      { plate: "ABC" },
      { vehicleIds: [offeringId] },
      { guarantee: true },
    ])
      expect(
        schema.safeParse({
          ...data,
          compatibility: [{ vehicleKind: "CAR", ...claim }],
        }).success,
      ).toBe(false);
    expect(
      schema.safeParse({
        ...data,
        compatibility: Array.from({ length: 31 }, () => ({
          vehicleKind: "CAR",
        })),
      }).success,
    ).toBe(false);
  });

  it("uses only controlled exact brand/reference identity, preserving separators", () => {
    expect(normalizeReferenceKey("  ｂｏｓｃｈ\t  OF-100  ")).toBe(
      "BOSCH OF-100",
    );
    expect(
      isStrongPartsMatch(
        { brand: " Bosch ", manufacturerReference: "of-100" },
        { brand: "BOSCH", manufacturerReference: "OF-100" },
      ),
    ).toBe(true);
    expect(
      isStrongPartsMatch(
        { brand: "Bosch", manufacturerReference: "OF-100" },
        { brand: "Bosch", manufacturerReference: "OF100" },
      ),
    ).toBe(false);
    expect(
      isStrongPartsMatch(
        { brand: "", manufacturerReference: "OF-100" },
        { brand: "", manufacturerReference: "OF-100" },
      ),
    ).toBe(false);
    expect(
      partsStrongMatchKey({ brand: "A:B", manufacturerReference: "C" }),
    ).not.toBe(
      partsStrongMatchKey({ brand: "A", manufacturerReference: "B:C" }),
    );
    const renamed = { ...data, name: "Another name" };
    expect(partsStrongMatchKey(renamed)).toBe(partsStrongMatchKey(data));
  });

  it("requires scoped snapshots and rejects transaction totals", () => {
    const snapshot = {
      organizationId,
      orderId: offeringId,
      offeringId,
      version: 1,
      reason: "Attach operational part snapshot",
    };
    expect(
      partsCommandInputs["parts.workshop.snapshot.add"].safeParse(snapshot)
        .success,
    ).toBe(true);
    for (const key of ["quantity", "totalMinor", "payment", "quotationId"])
      expect(
        partsCommandInputs["parts.workshop.snapshot.add"].safeParse({
          ...snapshot,
          [key]: 1,
        }).success,
      ).toBe(false);
    expect(
      partsCommandInputs["parts.offering.transition"].safeParse({
        organizationId,
        offeringId,
        version: 1,
        reason: data.reason,
        toStatus: "ARCHIVED",
      }).success,
    ).toBe(false);
    expect(() => parsePartsCommand("toString", {})).toThrow(
      "Unknown Parts operation",
    );
  });

  it("keeps future capabilities disabled", () => {
    expect(
      Object.values(partsPhaseCapabilities).every(
        (enabled) => enabled === false,
      ),
    ).toBe(true);
    expect(Object.isFrozen(partsPhaseCapabilities)).toBe(true);
  });
});
