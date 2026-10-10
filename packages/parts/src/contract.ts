import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import type { Json } from "@motorbaldi/shared";

const id = z.string().uuid();
const version = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
const reason = z.string().trim().min(5).max(1000);
const text = (max: number) => z.string().trim().min(1).max(max);
export const canonicalPartStates = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export const offeringStates = ["DRAFT", "ACTIVE", "INACTIVE"] as const;
export const partsAvailability = [
  "UNKNOWN",
  "AVAILABLE",
  "UNAVAILABLE",
] as const;
export type CanonicalPartState = (typeof canonicalPartStates)[number];
export type OfferingState = (typeof offeringStates)[number];

/** Informational compatibility supplied by the catalog editor, never a verified fit guarantee. */
export const partsCompatibilitySchema = z
  .object({
    vehicleKind: text(40),
    brand: text(80).optional(),
    model: text(80).optional(),
    note: text(300).optional(),
    verified: z.literal(false).default(false),
  })
  .strict();
const mutableReference = {
  name: text(200),
  category: text(100),
  brand: text(160),
  manufacturerReference: text(160),
  description: z.string().trim().max(2000).default(""),
  unit: text(40),
  compatibility: z.array(partsCompatibilitySchema).max(30).default([]),
};
const offeringData = {
  ...mutableReference,
  locationId: id.nullable().default(null),
  canonicalPartId: id.nullable().default(null),
  partnerSku: text(160).nullable().default(null),
  priceMinor: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(null),
  currency: z.literal("COP").default("COP"),
  availability: z.enum(partsAvailability).default("UNKNOWN"),
};
export const canonicalPartDataSchema = z.object(mutableReference).strict();
export const partsOfferingDataSchema = z.object(offeringData).strict();
export type PartsCompatibility = z.infer<typeof partsCompatibilitySchema>;
export type CanonicalPartData = z.infer<typeof canonicalPartDataSchema>;
export type PartsOfferingData = z.infer<typeof partsOfferingDataSchema>;

export const partsCommandInputs = {
  "parts.canonical.create": z
    .object({
      ...mutableReference,
      status: z.literal("DRAFT").default("DRAFT"),
      reason,
    })
    .strict(),
  "parts.canonical.update": z
    .object({ ...mutableReference, partId: id, version, reason })
    .strict(),
  "parts.canonical.transition": z
    .object({
      partId: id,
      version,
      toStatus: z.enum(canonicalPartStates),
      reason,
    })
    .strict(),
  "parts.offering.create": z
    .object({
      ...offeringData,
      organizationId: id,
      status: z.literal("DRAFT").default("DRAFT"),
      reason,
    })
    .strict(),
  "parts.offering.update": z
    .object({
      ...offeringData,
      organizationId: id,
      offeringId: id,
      version,
      reason,
    })
    .strict(),
  "parts.offering.transition": z
    .object({
      organizationId: id,
      offeringId: id,
      version,
      toStatus: z.enum(offeringStates),
      reason,
    })
    .strict(),
  "parts.workshop.snapshot.add": z
    .object({
      organizationId: id,
      orderId: id,
      offeringId: id,
      version,
      reason,
    })
    .strict(),
} as const;
export type PartsOperation = keyof typeof partsCommandInputs;

export function parsePartsCommand(
  operation: string,
  input: unknown,
): Record<string, Json> {
  if (!Object.hasOwn(partsCommandInputs, operation))
    throw new Problem(
      400,
      "UNKNOWN_PARTS_OPERATION",
      "Unknown Parts operation",
    );
  const result =
    partsCommandInputs[operation as PartsOperation].safeParse(input);
  if (!result.success)
    throw new Problem(400, "INVALID_PARTS_COMMAND", "Invalid Parts command");
  return result.data;
}

/** Controlled normalization preserves punctuation and separators to avoid false strong matches. */
export function normalizeReferenceKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}
export type PartsReferenceIdentity = {
  brand: string;
  manufacturerReference: string;
};
export function partsReferenceIdentity(input: PartsReferenceIdentity) {
  return {
    brandKey: normalizeReferenceKey(input.brand),
    referenceKey: normalizeReferenceKey(input.manufacturerReference),
  };
}
export function partsStrongMatchKey(input: PartsReferenceIdentity): string {
  const identity = partsReferenceIdentity(input);
  return JSON.stringify([identity.brandKey, identity.referenceKey]);
}
export function isStrongPartsMatch(
  left: PartsReferenceIdentity,
  right: PartsReferenceIdentity,
): boolean {
  const a = partsReferenceIdentity(left),
    b = partsReferenceIdentity(right);
  return (
    Boolean(a.brandKey && a.referenceKey && b.brandKey && b.referenceKey) &&
    a.brandKey === b.brandKey &&
    a.referenceKey === b.referenceKey
  );
}

/** These capabilities require a separate approved phase contract; availability never implies stock. */
export const partsPhaseCapabilities = Object.freeze({
  publicMarketplace: false,
  stockReservation: false,
  stockDeduction: false,
  checkout: false,
  payment: false,
  sourcingAssistance: false,
  compatibilityGuarantee: false,
});
