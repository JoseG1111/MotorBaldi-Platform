import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import { validateEvent } from "@motorbaldi/db";
import {
  marketplaceCommandEventRegistry,
  partsCommandEventRegistry,
} from "@motorbaldi/parts";

/** Reports describe present authorized D1 facts, never inferred commercial outcomes. */
export const analyticsSchemaVersion = 1 as const;
export const analyticsCapabilities = Object.freeze({
  readOnly: true,
  currentState: true,
  profiling: false,
  forecasting: false,
  financialEstimates: false,
  thirdPartyTelemetry: false,
  exports: false,
  reportPersistence: false,
});
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = {
  schemaVersion: z.literal(analyticsSchemaVersion),
  classification: z.literal("INTERNAL"),
  observedAt: z.iso.datetime({ precision: 3 }),
};
const platformScope = z
  .object({
    type: z.literal("PLATFORM"),
    resourceScope: z.enum(["AUTHORIZED", "OWNED_SYNTHETIC"]),
  })
  .strict();
const queueScope = z
  .object({
    type: z.literal("PLATFORM"),
    resourceScope: z.literal("AUTHORIZED"),
  })
  .strict();
export const organizationAnalyticsScopeSchema = z
  .object({
    type: z.literal("ORGANIZATION"),
    organizationId: z.uuid(),
    locationId: z.uuid().nullable(),
    resourceScope: z.enum(["AUTHORIZED", "OWNED_SYNTHETIC"]),
  })
  .strict();
const canonicalCounts = z
  .object({ DRAFT: count, ACTIVE: count, ARCHIVED: count })
  .strict();
const offeringCounts = z
  .object({ DRAFT: count, ACTIVE: count, INACTIVE: count })
  .strict();
const listingCounts = z
  .object({
    DRAFT: count,
    PENDING_REVIEW: count,
    PUBLISHED: count,
    SUSPENDED: count,
  })
  .strict();
const safeTotal = (values: number[]) =>
  values.reduce((sum, value) => sum + BigInt(value), 0n) <=
  BigInt(Number.MAX_SAFE_INTEGER);
export const canonicalPartsReportSchema = z
  .object({
    ...base,
    kind: z.literal("CANONICAL_PARTS"),
    scope: platformScope,
    provenance: z
      .object({
        mode: z.literal("CURRENT_STATE"),
        sourceTables: z.tuple([z.literal("parts_canonical")]),
      })
      .strict(),
    counts: canonicalCounts,
  })
  .strict()
  .refine(
    (report) => safeTotal(Object.values(report.counts)),
    "Unsafe total count",
  );
export const organizationPartsReportSchema = z
  .object({
    ...base,
    kind: z.literal("ORGANIZATION_PARTS"),
    scope: organizationAnalyticsScopeSchema,
    provenance: z
      .object({
        mode: z.literal("CURRENT_STATE"),
        sourceTables: z.tuple([
          z.literal("parts_offerings"),
          z.literal("marketplace_listings"),
          z.literal("marketplace_eligible_sources"),
        ]),
      })
      .strict(),
    counts: z
      .object({
        offerings: offeringCounts,
        listings: listingCounts,
        discoverable: count,
      })
      .strict(),
  })
  .strict()
  .refine(
    (report) =>
      report.counts.discoverable <= report.counts.listings.PUBLISHED &&
      safeTotal(Object.values(report.counts.offerings)) &&
      safeTotal(Object.values(report.counts.listings)),
    "Inconsistent operational counts",
  );
export const platformQueueReportSchema = z
  .object({
    ...base,
    kind: z.literal("PLATFORM_QUEUE"),
    scope: queueScope,
    provenance: z
      .object({
        mode: z.literal("CURRENT_STATE"),
        sourceTables: z.tuple([
          z.literal("integration_outbox_events"),
          z.literal("integration_dead_letters"),
        ]),
      })
      .strict(),
    counts: z
      .object({
        PENDING: count,
        PROCESSING: count,
        PROCESSED: count,
        DEAD: count,
        liveLeases: count,
        unresolvedDeadLetters: count,
      })
      .strict(),
  })
  .strict()
  .refine(
    (report) =>
      report.counts.liveLeases <= report.counts.PROCESSING &&
      safeTotal([
        report.counts.PENDING,
        report.counts.PROCESSING,
        report.counts.PROCESSED,
        report.counts.DEAD,
      ]),
    "Inconsistent Queue counts",
  );
export const analyticsReportSchema = z.discriminatedUnion("kind", [
  canonicalPartsReportSchema,
  organizationPartsReportSchema,
  platformQueueReportSchema,
]);
export type CanonicalPartsReport = z.infer<typeof canonicalPartsReportSchema>;
export type OrganizationPartsReport = z.infer<
  typeof organizationPartsReportSchema
>;
export type PlatformQueueReport = z.infer<typeof platformQueueReportSchema>;
export type AnalyticsReport = z.infer<typeof analyticsReportSchema>;
export type OrganizationAnalyticsScope = z.infer<
  typeof organizationAnalyticsScopeSchema
>;
export type AnalyticsReportKind = AnalyticsReport["kind"];
function unavailable() {
  return new Problem(
    503,
    "ANALYTICS_EVIDENCE_UNAVAILABLE",
    "Operational analytics evidence unavailable",
  );
}
export function parseAnalyticsReport(value: unknown): AnalyticsReport {
  const result = analyticsReportSchema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
const sourceEventSchema = z
  .object({
    aggregate_type: z.enum(["parts", "marketplace"]),
    event_type: z.string().min(1).max(100),
    event_version: z.literal(1),
    payload_json: z.string().max(1024),
    external_effect_policy: z.literal("IDEMPOTENT"),
  })
  .strict();
export type AnalyticsSourceEvent = z.infer<typeof sourceEventSchema>;
/** Validate existing versioned minimal references without adding telemetry or retention. */
export function validateAnalyticsSourceEvent(value: unknown): void {
  const parsed = sourceEventSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  try {
    validateEvent(
      parsed.data,
      parsed.data.aggregate_type === "parts"
        ? partsCommandEventRegistry
        : marketplaceCommandEventRegistry,
    );
  } catch {
    throw unavailable();
  }
}
