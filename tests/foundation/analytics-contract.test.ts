import { describe, expect, it } from "vitest";
import {
  analyticsReportSchema,
  analyticsCapabilities,
  validateAnalyticsSourceEvent,
  canonicalPartsReportSchema,
  organizationPartsReportSchema,
  platformQueueReportSchema,
  parseAnalyticsReport,
} from "../../packages/analytics/src/contract.js";
import { partsCommandEventRegistry } from "../../packages/parts/src/domain.js";
import { marketplaceCommandEventRegistry } from "../../packages/parts/src/marketplace.js";
const organizationId = "11111111-1111-4111-8111-111111111111",
  resourceId = "22222222-2222-4222-8222-222222222222";
const common = {
  schemaVersion: 1,
  classification: "INTERNAL",
  observedAt: "2026-10-11T03:00:00.123Z",
};
const canonical = () => ({
  ...common,
  kind: "CANONICAL_PARTS",
  scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
  provenance: { mode: "CURRENT_STATE", sourceTables: ["parts_canonical"] },
  counts: { DRAFT: 0, ACTIVE: 2, ARCHIVED: 1 },
});
const organization = () => ({
  ...common,
  kind: "ORGANIZATION_PARTS",
  scope: {
    type: "ORGANIZATION",
    organizationId,
    locationId: null,
    resourceScope: "AUTHORIZED",
  },
  provenance: {
    mode: "CURRENT_STATE",
    sourceTables: [
      "parts_offerings",
      "marketplace_listings",
      "marketplace_eligible_sources",
    ],
  },
  counts: {
    offerings: { DRAFT: 0, ACTIVE: 2, INACTIVE: 1 },
    listings: { DRAFT: 0, PENDING_REVIEW: 1, PUBLISHED: 1, SUSPENDED: 0 },
    discoverable: 0,
  },
});
const queue = () => ({
  ...common,
  kind: "PLATFORM_QUEUE",
  scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
  provenance: {
    mode: "CURRENT_STATE",
    sourceTables: ["integration_outbox_events", "integration_dead_letters"],
  },
  counts: {
    PENDING: 0,
    PROCESSING: 1,
    PROCESSED: 8,
    DEAD: 0,
    liveLeases: 1,
    unresolvedDeadLetters: 0,
  },
});
describe("Scoped operational analytics contract", () => {
  it("accepts only versioned current-state reports with explicit UTC provenance", () => {
    expect(Object.isFrozen(analyticsCapabilities)).toBe(true);
    expect(analyticsCapabilities).toMatchObject({
      readOnly: true,
      currentState: true,
      profiling: false,
      forecasting: false,
      financialEstimates: false,
      thirdPartyTelemetry: false,
      exports: false,
      reportPersistence: false,
    });
    for (const [schema, report] of [
      [canonicalPartsReportSchema, canonical()],
      [organizationPartsReportSchema, organization()],
      [platformQueueReportSchema, queue()],
    ] as const) {
      expect(schema.safeParse(report).success).toBe(true);
      expect(parseAnalyticsReport(report)).toEqual(report);
      expect(analyticsReportSchema.safeParse(report).success).toBe(true);
    }
  });
  it("counts published state separately from currently discoverable records and preserves authoritative zero counts", () => {
    const report = parseAnalyticsReport(organization());
    expect(report).toMatchObject({
      counts: { listings: { PUBLISHED: 1 }, discoverable: 0 },
    });
    const zero = canonical();
    zero.counts = { DRAFT: 0, ACTIVE: 0, ARCHIVED: 0 };
    expect(parseAnalyticsReport(zero)).toEqual(zero);
    expect(
      organizationPartsReportSchema.safeParse({
        ...organization(),
        counts: { ...organization().counts, discoverable: 2 },
      }).success,
    ).toBe(false);
    expect(
      platformQueueReportSchema.safeParse({
        ...queue(),
        counts: { ...queue().counts, liveLeases: 2 },
      }).success,
    ).toBe(false);
  });
  it("rejects unknown, omitted, fractional, negative and unsafe counts without silently defaulting to zero", () => {
    expect(
      canonicalPartsReportSchema.safeParse({
        ...canonical(),
        counts: { DRAFT: Number.MAX_SAFE_INTEGER, ACTIVE: 1, ARCHIVED: 0 },
      }).success,
    ).toBe(false);
    for (const value of [
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "2",
      null,
      undefined,
    ])
      expect(
        canonicalPartsReportSchema.safeParse({
          ...canonical(),
          counts: { ...canonical().counts, ACTIVE: value },
        }).success,
      ).toBe(false);
    expect(
      canonicalPartsReportSchema.safeParse({
        ...canonical(),
        counts: { ACTIVE: 1, ARCHIVED: 0 },
      }).success,
    ).toBe(false);
    expect(
      canonicalPartsReportSchema.safeParse({
        ...canonical(),
        counts: { ...canonical().counts, UNKNOWN: 0 },
      }).success,
    ).toBe(false);
    expect(
      organizationPartsReportSchema.safeParse({
        ...organization(),
        counts: {
          ...organization().counts,
          listings: { ...organization().counts.listings, ACTIVE: 1 },
        },
      }).success,
    ).toBe(false);
  });
  it("fails closed on absent evidence, unsupported schema versions and ambiguous observation times", () => {
    for (const value of [
      null,
      undefined,
      {},
      [],
      { ...canonical(), schemaVersion: 2 },
      { ...canonical(), classification: "PUBLIC" },
    ])
      expect(() => parseAnalyticsReport(value)).toThrow();
    for (const observedAt of [
      "",
      "2026-10-11",
      "2026-10-11T03:00:00+00:00",
      "2026-10-11T03:00:00.123-05:00",
      "2026-13-40T03:00:00.123Z",
    ])
      expect(
        canonicalPartsReportSchema.safeParse({ ...canonical(), observedAt })
          .success,
      ).toBe(false);
  });
  it("requires exact source tables and disallows materialized, historical or event-content provenance", () => {
    for (const provenance of [
      { mode: "CURRENT_STATE", sourceTables: [] },
      { mode: "CURRENT_STATE", sourceTables: ["auth_users"] },
      {
        mode: "CURRENT_STATE",
        sourceTables: ["parts_canonical", "auth_users"],
      },
      { mode: "PREDICTION", sourceTables: ["parts_canonical"] },
      {
        mode: "CURRENT_STATE",
        sourceTables: ["parts_canonical"],
        eventPayload: { customerId: resourceId },
      },
    ])
      expect(
        canonicalPartsReportSchema.safeParse({ ...canonical(), provenance })
          .success,
      ).toBe(false);
    expect(queue().provenance.sourceTables).toEqual([
      "integration_outbox_events",
      "integration_dead_letters",
    ]);
  });
  it("exposes no source rows, PII, commercial amounts, credentials or unapproved analytics measures", () => {
    for (const name of [
      "rows",
      "eventPayload",
      "accountId",
      "personId",
      "customerId",
      "vehicleId",
      "vin",
      "plate",
      "email",
      "phone",
      "addressLine1",
      "latitude",
      "cookie",
      "token",
      "priceMinor",
      "revenue",
      "commission",
      "prediction",
      "notes",
    ]) {
      expect(
        analyticsReportSchema.safeParse({
          ...organization(),
          [name]: "PRIVATE",
        }).success,
      ).toBe(false);
      expect(
        organizationPartsReportSchema.safeParse({
          ...organization(),
          counts: { ...organization().counts, [name]: 1 },
        }).success,
      ).toBe(false);
    }
    expect(
      organizationPartsReportSchema.safeParse({
        ...organization(),
        scope: { ...organization().scope, accountId: resourceId },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(parseAnalyticsReport(organization()))).not.toContain(
      "PRIVATE",
    );
  });
  it("keeps platform and selected organization scopes structurally distinct", () => {
    expect(
      canonicalPartsReportSchema.safeParse({
        ...canonical(),
        scope: { type: "PLATFORM", resourceScope: "OWNED_SYNTHETIC" },
      }).success,
    ).toBe(true);
    expect(
      platformQueueReportSchema.safeParse({
        ...queue(),
        scope: { type: "PLATFORM", resourceScope: "OWNED_SYNTHETIC" },
      }).success,
    ).toBe(false);
    expect(
      canonicalPartsReportSchema.safeParse({
        ...canonical(),
        scope: { type: "PLATFORM" },
      }).success,
    ).toBe(false);
    expect(
      platformQueueReportSchema.safeParse({
        ...queue(),
        scope: { type: "PLATFORM" },
      }).success,
    ).toBe(false);

    expect(
      organizationPartsReportSchema.safeParse({
        ...organization(),
        scope: {
          type: "ORGANIZATION",
          organizationId,
          locationId: resourceId,
          resourceScope: "AUTHORIZED",
        },
      }).success,
    ).toBe(true);
    for (const scope of [
      { type: "PLATFORM" },
      {
        type: "ORGANIZATION",
        organizationId: "foreign",
        locationId: null,
        resourceScope: "AUTHORIZED",
      },
      { type: "ORGANIZATION", organizationId },
      { type: "ORGANIZATION", organizationId, locationId: "wrong" },
    ])
      expect(
        organizationPartsReportSchema.safeParse({ ...organization(), scope })
          .success,
      ).toBe(false);
    expect(
      canonicalPartsReportSchema.safeParse({
        ...canonical(),
        scope: organization().scope,
      }).success,
    ).toBe(false);
  });
  it("preserves existing Parts and Marketplace event reference contracts without expanding payloads", () => {
    for (const [registry, aggregate] of [
      [partsCommandEventRegistry, "parts"],
      [marketplaceCommandEventRegistry, "marketplace"],
    ] as const) {
      expect(registry.size).toBeGreaterThan(0);
      for (const [key, contract] of registry) {
        expect(key).toMatch(/\.v1:1$/);
        expect(contract.aggregateType).toBe(aggregate);
        expect(contract.version).toBe(1);
        expect(contract.externalEffect).toBe("IDEMPOTENT");
        const payload = { resourceId, organizationId, version: 1 };
        expect(contract.payload.safeParse(payload).success).toBe(true);
        const event = {
          aggregate_type: aggregate,
          event_type: key.split(":")[0],
          event_version: 1,
          payload_json: JSON.stringify(payload),
          external_effect_policy: "IDEMPOTENT",
        };
        expect(() => validateAnalyticsSourceEvent(event)).not.toThrow();
        for (const extra of [
          { event_version: 2 },
          { aggregate_type: "analytics" },
          { event_type: "analytics.report.v1" },
          { payload_json: "invalid" },
          {
            payload_json: JSON.stringify({
              ...payload,
              customerId: resourceId,
            }),
          },
          { snapshot: payload },
          { external_effect_policy: "NON_IDEMPOTENT" },
        ])
          expect(() =>
            validateAnalyticsSourceEvent({ ...event, ...extra }),
          ).toThrow("Operational analytics evidence unavailable");

        for (const privateField of [
          "customerId",
          "vin",
          "plate",
          "priceMinor",
          "name",
          "snapshot",
          "report",
          "actorId",
        ])
          expect(
            contract.payload.safeParse({
              ...payload,
              [privateField]: "PRIVATE",
            }).success,
          ).toBe(false);
        expect(
          contract.payload.safeParse({
            ...payload,
            version: Number.MAX_SAFE_INTEGER + 1,
          }).success,
        ).toBe(false);
      }
    }
  });
});
