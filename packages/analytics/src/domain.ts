import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import { developmentAutomationPredicate } from "@motorbaldi/db";
import {
  partsOfferingPredicate,
  partsStaffPredicate,
  requirePartsOfferingScope,
  requirePartsStaff,
  type PartsActor,
} from "@motorbaldi/parts";
import {
  parseAnalyticsReport,
  type CanonicalPartsReport,
  type OrganizationPartsReport,
  type PlatformQueueReport,
} from "./contract.js";

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observation = { observed_at: z.iso.datetime({ precision: 3 }) };
const canonicalRow = z
  .object({ ...observation, DRAFT: count, ACTIVE: count, ARCHIVED: count })
  .strict();
const organizationRow = z
  .object({
    ...observation,
    offering_DRAFT: count,
    offering_ACTIVE: count,
    offering_INACTIVE: count,
    listing_DRAFT: count,
    listing_PENDING_REVIEW: count,
    listing_PUBLISHED: count,
    listing_SUSPENDED: count,
    discoverable: count,
  })
  .strict();
const queueRow = z
  .object({
    ...observation,
    PENDING: count,
    PROCESSING: count,
    PROCESSED: count,
    DEAD: count,
    liveLeases: count,
    unresolvedDeadLetters: count,
  })
  .strict();
function unavailable() {
  return new Problem(
    503,
    "ANALYTICS_EVIDENCE_UNAVAILABLE",
    "Operational analytics evidence unavailable",
  );
}
async function evidence<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw unavailable();
  }
}
function checked<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw unavailable();
  return result.data;
}
/** Both the exact principal and its exact signed read context remain current inside the aggregate query. */
function currentActorPredicate() {
  return `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=scope.actor AND p.id=scope.person AND a.status='ACTIVE' AND p.status='ACTIVE') AND ((scope.context_id IS NULL AND NOT EXISTS(SELECT 1 FROM development_automation_identities d WHERE d.account_id=scope.actor)) OR (scope.context_id IS NOT NULL AND ${developmentAutomationPredicate("scope.actor")} AND EXISTS(SELECT 1 FROM development_automation_authorizations context JOIN development_automation_identities identity ON identity.account_id=context.account_id AND identity.credential_version=context.credential_version WHERE context.id=scope.context_id AND context.account_id=scope.actor AND context.operation='http.read' AND context.expires_at>${now} AND identity.status='ACTIVE' AND identity.expires_at>${now})))`;
}
function ownedPredicate(resourceType: string, id: string) {
  return `(scope.context_id IS NULL OR EXISTS(SELECT 1 FROM development_automation_resources owned WHERE owned.account_id=scope.actor AND owned.resource_type='${resourceType}' AND owned.resource_id=${id}))`;
}
const scopeSql =
  "WITH scope AS (SELECT ? AS actor,? AS person,? AS context_id)";
function identityBindings(actor: PartsActor) {
  return [
    actor.accountId,
    actor.personId,
    actor.automationAuthorizationId ?? null,
  ];
}
function scopeKind(actor: PartsActor) {
  return actor.automationAuthorizationId
    ? ("OWNED_SYNTHETIC" as const)
    : ("AUTHORIZED" as const);
}

export async function queryCanonicalPartsReport(
  db: D1Database,
  actor: PartsActor,
): Promise<CanonicalPartsReport> {
  return evidence(async () => {
    await requirePartsStaff(db, actor);
    const raw = await db
      .prepare(
        `${scopeSql}, authorized AS (SELECT * FROM scope WHERE ${currentActorPredicate()} AND ${partsStaffPredicate("scope.actor")}), sources AS (SELECT f.status FROM parts_canonical f CROSS JOIN authorized scope WHERE ${ownedPredicate("canonical", "f.id")}) SELECT ${now} AS observed_at,(SELECT COUNT(*) FROM sources WHERE status='DRAFT') AS DRAFT,(SELECT COUNT(*) FROM sources WHERE status='ACTIVE') AS ACTIVE,(SELECT COUNT(*) FROM sources WHERE status='ARCHIVED') AS ARCHIVED FROM authorized`,
      )
      .bind(...identityBindings(actor))
      .first();
    const row = checked(canonicalRow, raw);
    return parseAnalyticsReport({
      schemaVersion: 1,
      classification: "INTERNAL",
      kind: "CANONICAL_PARTS",
      observedAt: row.observed_at,
      scope: { type: "PLATFORM", resourceScope: scopeKind(actor) },
      provenance: { mode: "CURRENT_STATE", sourceTables: ["parts_canonical"] },
      counts: { DRAFT: row.DRAFT, ACTIVE: row.ACTIVE, ARCHIVED: row.ARCHIVED },
    }) as CanonicalPartsReport;
  });
}

export async function queryOrganizationPartsReport(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  locationId: string | null,
): Promise<OrganizationPartsReport> {
  return evidence(async () => {
    if (
      !z.uuid().safeParse(organizationId).success ||
      (locationId !== null && !z.uuid().safeParse(locationId).success)
    )
      throw new Problem(400, "VALIDATION_ERROR", "Invalid report scope");
    await requirePartsOfferingScope(db, actor, organizationId, locationId);
    const raw = await db
      .prepare(
        `WITH scope AS (SELECT ? AS actor,? AS person,? AS context_id,? AS organization,? AS location),authorized AS (SELECT * FROM scope WHERE ${currentActorPredicate()} AND ${partsOfferingPredicate("scope.actor", "scope.organization", "scope.location")}),offerings AS (SELECT f.status FROM parts_offerings f CROSS JOIN authorized scope WHERE f.organization_id=scope.organization AND (scope.location IS NULL OR f.location_id=scope.location) AND ${ownedPredicate("offering", "f.id")}),listings AS (SELECT l.* FROM marketplace_listings l CROSS JOIN authorized scope WHERE l.organization_id=scope.organization AND (scope.location IS NULL OR l.location_id=scope.location) AND ${ownedPredicate("offering", "l.offering_id")}),visible AS (SELECT l.id FROM listings l JOIN marketplace_eligible_sources s ON s.offering_id=l.offering_id WHERE l.status='PUBLISHED' AND l.offering_version=s.offering_version AND l.canonical_version=s.canonical_version AND l.snapshot_json=json_set(s.source_json,'$.generalLocation',l.general_location) AND (s.location_id IS NULL OR json_extract(s.source_json,'$.generalLocation')=l.general_location)) SELECT ${now} AS observed_at,(SELECT COUNT(*) FROM offerings WHERE status='DRAFT') AS offering_DRAFT,(SELECT COUNT(*) FROM offerings WHERE status='ACTIVE') AS offering_ACTIVE,(SELECT COUNT(*) FROM offerings WHERE status='INACTIVE') AS offering_INACTIVE,(SELECT COUNT(*) FROM listings WHERE status='DRAFT') AS listing_DRAFT,(SELECT COUNT(*) FROM listings WHERE status='PENDING_REVIEW') AS listing_PENDING_REVIEW,(SELECT COUNT(*) FROM listings WHERE status='PUBLISHED') AS listing_PUBLISHED,(SELECT COUNT(*) FROM listings WHERE status='SUSPENDED') AS listing_SUSPENDED,(SELECT COUNT(DISTINCT id) FROM visible) AS discoverable FROM authorized`,
      )
      .bind(...identityBindings(actor), organizationId, locationId)
      .first();
    const row = checked(organizationRow, raw);
    return parseAnalyticsReport({
      schemaVersion: 1,
      classification: "INTERNAL",
      kind: "ORGANIZATION_PARTS",
      observedAt: row.observed_at,
      scope: {
        type: "ORGANIZATION",
        organizationId,
        locationId,
        resourceScope: scopeKind(actor),
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
        offerings: {
          DRAFT: row.offering_DRAFT,
          ACTIVE: row.offering_ACTIVE,
          INACTIVE: row.offering_INACTIVE,
        },
        listings: {
          DRAFT: row.listing_DRAFT,
          PENDING_REVIEW: row.listing_PENDING_REVIEW,
          PUBLISHED: row.listing_PUBLISHED,
          SUSPENDED: row.listing_SUSPENDED,
        },
        discoverable: row.discoverable,
      },
    }) as OrganizationPartsReport;
  });
}
function queueAuthorityPredicate() {
  return `scope.context_id IS NULL AND ${currentActorPredicate()} AND EXISTS(SELECT 1 FROM iam_accounts a JOIN auth_users u ON u.id=a.id JOIN platform_person_roles pr ON pr.person_id=a.person_id JOIN authz_roles r ON r.id=pr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=scope.actor AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=a.id AND tf.verified=1) AND r.scope='PLATFORM' AND r.code IN ('PLATFORM_SUPERADMIN','AUDITOR') AND rp.permission_code='platform.audit.read')`;
}
export async function queryPlatformQueueReport(
  db: D1Database,
  actor: PartsActor,
): Promise<PlatformQueueReport> {
  return evidence(async () => {
    if (actor.automationAuthorizationId)
      throw new Problem(403, "FORBIDDEN", "Access denied");
    if (!actor.mfaEnabled)
      throw new Problem(
        403,
        "MFA_REQUIRED",
        "Assured multi-factor authentication required",
      );
    const authorized = await db
      .prepare(
        `${scopeSql} SELECT 1 FROM scope WHERE ${queueAuthorityPredicate()}`,
      )
      .bind(...identityBindings(actor))
      .first();
    if (!authorized) throw new Problem(403, "FORBIDDEN", "Access denied");
    const raw = await db
      .prepare(
        `${scopeSql}, authorized AS (SELECT * FROM scope WHERE ${queueAuthorityPredicate()}) SELECT ${now} AS observed_at,(SELECT COUNT(*) FROM integration_outbox_events WHERE status='PENDING') AS PENDING,(SELECT COUNT(*) FROM integration_outbox_events WHERE status='PROCESSING') AS PROCESSING,(SELECT COUNT(*) FROM integration_outbox_events WHERE status='PROCESSED') AS PROCESSED,(SELECT COUNT(*) FROM integration_outbox_events WHERE status='DEAD') AS DEAD,(SELECT COUNT(*) FROM integration_outbox_events WHERE status='PROCESSING' AND lease_until>${now}) AS liveLeases,(SELECT COUNT(*) FROM integration_dead_letters WHERE resolved_at IS NULL) AS unresolvedDeadLetters FROM authorized`,
      )
      .bind(...identityBindings(actor))
      .first();
    const row = checked(queueRow, raw);
    return parseAnalyticsReport({
      schemaVersion: 1,
      classification: "INTERNAL",
      kind: "PLATFORM_QUEUE",
      observedAt: row.observed_at,
      scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
      provenance: {
        mode: "CURRENT_STATE",
        sourceTables: ["integration_outbox_events", "integration_dead_letters"],
      },
      counts: {
        PENDING: row.PENDING,
        PROCESSING: row.PROCESSING,
        PROCESSED: row.PROCESSED,
        DEAD: row.DEAD,
        liveLeases: row.liveLeases,
        unresolvedDeadLetters: row.unresolvedDeadLetters,
      },
    }) as PlatformQueueReport;
  });
}
