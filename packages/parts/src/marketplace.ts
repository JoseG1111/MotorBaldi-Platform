import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import {
  outboxStatement,
  type EventRegistry,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";
import {
  partsOfferingPredicate,
  requirePartsOfferingScope,
  requirePartsStaff,
  type PartsActor,
} from "./access.js";

const uuid = z.uuid();
const update = z
  .object({
    organizationId: uuid,
    listingId: uuid,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const marketplaceCommandInputs = {
  "marketplace.listing.create": z
    .object({
      organizationId: uuid,
      offeringId: uuid,
      generalLocation: z.string().trim().min(1).max(160),
      reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  "marketplace.listing.submit": update,
  "marketplace.listing.approve": update,
  "marketplace.listing.reject": update,
  "marketplace.listing.withdraw": update,
  "marketplace.listing.suspend": update,
};
export type MarketplaceOperation = keyof typeof marketplaceCommandInputs;
export const marketplaceCapabilities = Object.freeze({
  discovery: true,
  orders: false,
  checkout: false,
  payments: false,
  wompi: false,
  reservations: false,
  inventoryDeductions: false,
  commissions: false,
  transactionFees: false,
  media: false,
  automaticFulfillment: false,
});
const eventPayload = z
  .object({
    resourceId: uuid,
    organizationId: uuid,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const marketplaceCommandEventRegistry: EventRegistry = new Map(
  Object.keys(marketplaceCommandInputs).map((op) => [
    `${op}.v1:1`,
    {
      aggregateType: "marketplace",
      version: 1,
      payload: eventPayload,
      externalEffect: "IDEMPOTENT" as const,
    },
  ]),
);
type Row = Record<string, string | number | null>;
const missing = () =>
  new Problem(404, "MARKETPLACE_NOT_FOUND", "Marketplace resource unavailable");
const conflict = () =>
  new Problem(
    409,
    "MARKETPLACE_STATE_CONFLICT",
    "Marketplace state changed; retry safely",
  );
export function parseMarketplaceCommand(
  operation: MarketplaceOperation,
  input: unknown,
): Record<string, Json> {
  const parsed = marketplaceCommandInputs[operation].safeParse(input);
  if (!parsed.success)
    throw new Problem(400, "VALIDATION_ERROR", "Invalid marketplace command");
  return parsed.data;
}
const isStaff = (op: MarketplaceOperation) =>
  [
    "marketplace.listing.approve",
    "marketplace.listing.reject",
    "marketplace.listing.suspend",
  ].includes(op);
async function ownedOffering(
  db: D1Database,
  actor: PartsActor,
  offeringId: string,
) {
  if (
    actor.automationAuthorizationId &&
    !(await db
      .prepare(
        "SELECT 1 FROM development_automation_resources WHERE account_id=? AND resource_type='offering' AND resource_id=?",
      )
      .bind(actor.accountId, offeringId)
      .first())
  )
    throw missing();
}
async function listing(db: D1Database, id: string, org: string) {
  const row = await db
    .prepare(
      "SELECT * FROM marketplace_listings WHERE id=? AND organization_id=?",
    )
    .bind(id, org)
    .first<Row>();
  if (!row) throw missing();
  return row;
}
export async function authorizeMarketplaceCommand(
  db: D1Database,
  actor: PartsActor,
  operation: MarketplaceOperation,
  input: Record<string, Json>,
) {
  const body = parseMarketplaceCommand(operation, input);
  const f =
    operation === "marketplace.listing.create"
      ? await db
          .prepare(
            "SELECT * FROM parts_offerings WHERE id=? AND organization_id=?",
          )
          .bind(body.offeringId, body.organizationId)
          .first<Row>()
      : await listing(db, String(body.listingId), String(body.organizationId));
  if (!f) throw missing();
  if (isStaff(operation)) await requirePartsStaff(db, actor);
  else
    await requirePartsOfferingScope(
      db,
      actor,
      String(body.organizationId),
      f.location_id as string | null,
    );
  if (operation === "marketplace.listing.submit") {
    const current = await db
      .prepare(
        "SELECT location_id FROM parts_offerings WHERE id=? AND organization_id=?",
      )
      .bind(f.offering_id, body.organizationId)
      .first<Row>();
    if (!current) throw missing();
    await requirePartsOfferingScope(
      db,
      actor,
      String(body.organizationId),
      current.location_id as string | null,
    );
  }
  await ownedOffering(
    db,
    actor,
    String(operation === "marketplace.listing.create" ? f.id : f.offering_id),
  );
}
async function source(
  db: D1Database,
  offeringId: string,
  org: string,
  generalLocation: string,
) {
  const row = await db
    .prepare(
      "SELECT *,json_set(source_json,'$.generalLocation',?) AS snapshot_json FROM marketplace_eligible_sources WHERE offering_id=? AND organization_id=?",
    )
    .bind(generalLocation, offeringId, org)
    .first<Row>();
  if (!row)
    throw new Problem(
      409,
      "MARKETPLACE_SOURCE_INELIGIBLE",
      "Active verified PARTS source required",
    );
  if (
    row.location_id !== null &&
    JSON.parse(String(row.source_json)).generalLocation !== generalLocation
  )
    throw new Problem(
      400,
      "MARKETPLACE_LOCATION_INVALID",
      "Use the partner site's general city and region",
    );
  return row;
}
export async function prepareMarketplaceCommand(
  db: D1Database,
  actor: PartsActor,
  operation: MarketplaceOperation,
  input: Record<string, Json>,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = parseMarketplaceCommand(operation, input);
  await authorizeMarketplaceCommand(db, actor, operation, body);
  const org = String(body.organizationId),
    now = utcNow(),
    statements: D1PreparedStatement[] = [];
  let id: string, version: number, status: string;
  if (operation === "marketplace.listing.create") {
    id = newId();
    version = 1;
    status = "DRAFT";
    const s = await source(
      db,
      String(body.offeringId),
      org,
      String(body.generalLocation),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO marketplace_listings(id,organization_id,offering_id,location_id,status,version,offering_version,canonical_version,snapshot_json,general_location,last_actor_account_id,last_operation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          org,
          body.offeringId,
          s.location_id,
          status,
          version,
          s.offering_version,
          s.canonical_version,
          s.snapshot_json,
          body.generalLocation,
          actor.accountId,
          operation,
          now,
          now,
        ),
    );
  } else {
    const old = await listing(db, String(body.listingId), org);
    id = String(old.id);
    version = Number(old.version) + 1;
    if (old.version !== body.version) throw conflict();
    status =
      operation === "marketplace.listing.submit"
        ? "PENDING_REVIEW"
        : operation === "marketplace.listing.approve"
          ? "PUBLISHED"
          : operation === "marketplace.listing.reject"
            ? "DRAFT"
            : "SUSPENDED";
    if (
      ["marketplace.listing.approve", "marketplace.listing.reject"].includes(
        operation,
      ) &&
      old.status !== "PENDING_REVIEW"
    )
      throw conflict();
    let snapshot = old.snapshot_json,
      offeringVersion = old.offering_version,
      canonicalVersion = old.canonical_version,
      locationId = old.location_id,
      generalLocation = old.general_location;
    if (
      operation === "marketplace.listing.submit" ||
      operation === "marketplace.listing.approve"
    ) {
      if (operation === "marketplace.listing.submit") {
        const current = await db
          .prepare(
            "SELECT location_id,source_json FROM marketplace_eligible_sources WHERE offering_id=? AND organization_id=?",
          )
          .bind(old.offering_id, org)
          .first<Row>();
        if (!current)
          throw new Problem(
            409,
            "MARKETPLACE_SOURCE_INELIGIBLE",
            "Active verified PARTS source required",
          );
        locationId = current.location_id;
        if (current.location_id !== null)
          generalLocation = String(
            JSON.parse(String(current.source_json)).generalLocation,
          );
      }
      const s = await source(
        db,
        String(old.offering_id),
        org,
        String(generalLocation),
      );
      if (
        operation === "marketplace.listing.approve" &&
        (s.snapshot_json !== old.snapshot_json ||
          s.offering_version !== old.offering_version ||
          s.canonical_version !== old.canonical_version)
      )
        throw conflict();
      if (operation === "marketplace.listing.submit") {
        snapshot = s.snapshot_json;
        offeringVersion = s.offering_version;
        canonicalVersion = s.canonical_version;
      }
    }
    statements.push(
      db
        .prepare(
          "UPDATE marketplace_listings SET status=?,version=?,offering_version=?,canonical_version=?,snapshot_json=?,location_id=?,general_location=?,last_actor_account_id=?,last_operation=?,updated_at=? WHERE id=? AND organization_id=? AND version=?",
        )
        .bind(
          status,
          version,
          offeringVersion,
          canonicalVersion,
          snapshot,
          locationId,
          generalLocation,
          actor.accountId,
          operation,
          now,
          id,
          org,
          body.version,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,organization_id) VALUES(?,?,?,'marketplace',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)",
      )
      .bind(newId(), actor.accountId, operation, id, requestId, org),
  );
  statements.push(
    db
      .prepare(
        "INSERT INTO marketplace_listing_history(id,listing_id,organization_id,version,status,operation,snapshot_json,actor_account_id,reason,request_id) SELECT ?,id,organization_id,version,status,last_operation,snapshot_json,last_actor_account_id,?,? FROM marketplace_listings WHERE id=? AND version=?",
      )
      .bind(
        newId(),
        String(body.reason ?? "Partner listing created"),
        requestId,
        id,
        version,
      ),
  );
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "marketplace",
        aggregateId: id,
        eventType: `${operation}.v1`,
        eventVersion: 1,
        payload: { resourceId: id, organizationId: org, version },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      marketplaceCommandEventRegistry,
    ).statement,
  );
  return {
    statements,
    response: {
      resourceId: id,
      listingId: id,
      organizationId: org,
      version,
      status,
    },
    recover: async (error) => {
      if (
        String(error).includes("MARKETPLACE_BOUNDARY") ||
        String(error).includes(
          "NOT NULL constraint failed: governance_audit_events.resource_id",
        )
      )
        throw conflict();
      if (
        String(error).includes(
          "UNIQUE constraint failed: marketplace_listings.offering_id",
        )
      )
        throw new Problem(
          409,
          "MARKETPLACE_LISTING_EXISTS",
          "An offering already has a listing",
        );
      return null;
    },
  };
}
export type MarketplaceListOptions = {
  cursor?: string;
  limit?: number;
  query?: string;
  category?: string;
};
function limit(options: MarketplaceListOptions) {
  return Math.min(50, Math.max(1, options.limit ?? 20));
}
const eligible =
  "l.status='PUBLISHED' AND l.offering_version=s.offering_version AND l.canonical_version=s.canonical_version AND l.snapshot_json=json_set(s.source_json,'$.generalLocation',l.general_location) AND (s.location_id IS NULL OR json_extract(s.source_json,'$.generalLocation')=l.general_location)";
function publicView(row: Row): Record<string, Json> {
  const s = JSON.parse(String(row.snapshot_json)) as Record<string, Json>;
  const fields = [
    "name",
    "category",
    "brand",
    "manufacturerReference",
    "description",
    "unit",
    "compatibility",
    "priceMinor",
    "currency",
    "priceIndicative",
    "availability",
    "lastUpdatedAt",
    "partnerBusinessName",
    "country",
    "generalLocation",
    "compatibilityNotice",
    "availabilityNotice",
  ];
  return {
    listingId: String(row.id),
    ...Object.fromEntries(fields.map((field) => [field, s[field] ?? null])),
  };
}
export async function listMarketplacePublic(
  db: D1Database,
  options: MarketplaceListOptions = {},
) {
  const q = options.query?.trim().slice(0, 100) ?? "",
    category = options.category?.trim().slice(0, 100) ?? "";
  const result = await db
    .prepare(
      `SELECT l.id,l.snapshot_json FROM marketplace_listings l JOIN marketplace_eligible_sources s ON s.offering_id=l.offering_id WHERE ${eligible} AND l.id>? AND (?='' OR instr(lower(json_extract(l.snapshot_json,'$.name')),lower(?))>0 OR instr(lower(json_extract(l.snapshot_json,'$.brand')),lower(?))>0) AND (?='' OR json_extract(l.snapshot_json,'$.category')=?) ORDER BY l.id LIMIT ?`,
    )
    .bind(options.cursor ?? "", q, q, q, category, category, limit(options))
    .all<Row>();
  return result.results.map(publicView);
}
export async function getMarketplacePublic(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT l.id,l.snapshot_json FROM marketplace_listings l JOIN marketplace_eligible_sources s ON s.offering_id=l.offering_id WHERE l.id=? AND ${eligible}`,
    )
    .bind(id)
    .first<Row>();
  if (!row) throw missing();
  return publicView(row);
}
function privateView(row: Row): Record<string, Json> {
  return {
    listingId: String(row.id),
    organizationId: String(row.organization_id),
    offeringId: String(row.offering_id),
    locationId: row.location_id ?? null,
    status: String(row.status),
    version: Number(row.version),
    offeringVersion: Number(row.offering_version),
    canonicalVersion: Number(row.canonical_version),
    snapshot: JSON.parse(String(row.snapshot_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
async function requireMarketplaceOrganizationScope(
  db: D1Database,
  actor: PartsActor,
  org: string,
) {
  try {
    await requirePartsOfferingScope(db, actor, org, null);
    return;
  } catch (error) {
    if (!(error instanceof Problem) || error.status !== 404) throw error;
  }
  const locations = await db
    .prepare(
      "SELECT id FROM org_locations WHERE organization_id=? AND status='ACTIVE' ORDER BY id",
    )
    .bind(org)
    .all<{ id: string }>();
  for (const location of locations.results) {
    try {
      await requirePartsOfferingScope(db, actor, org, location.id);
      return;
    } catch (error) {
      if (!(error instanceof Problem) || error.status !== 404) throw error;
    }
  }
  throw missing();
}
function ownershipPredicate(actor: PartsActor) {
  return actor.automationAuthorizationId
    ? "EXISTS(SELECT 1 FROM development_automation_resources owned WHERE owned.account_id=scope.actor AND owned.resource_type='offering' AND owned.resource_id=l.offering_id)"
    : "1=1";
}
export async function listMarketplaceOwned(
  db: D1Database,
  actor: PartsActor,
  org: string,
  options: MarketplaceListOptions = {},
) {
  await requireMarketplaceOrganizationScope(db, actor, org);
  const rows = await db
    .prepare(
      `SELECT l.* FROM marketplace_listings l CROSS JOIN (SELECT ? AS actor) scope WHERE l.organization_id=? AND l.id>? AND ${partsOfferingPredicate("scope.actor", "l.organization_id", "l.location_id")} AND ${ownershipPredicate(actor)} ORDER BY l.id LIMIT ?`,
    )
    .bind(actor.accountId, org, options.cursor ?? "", limit(options))
    .all<Row>();
  return rows.results.map(privateView);
}
export async function listMarketplaceReview(
  db: D1Database,
  actor: PartsActor,
  options: MarketplaceListOptions & {
    status?: "DRAFT" | "PENDING_REVIEW" | "PUBLISHED" | "SUSPENDED";
  } = {},
) {
  await requirePartsStaff(db, actor);
  const rows = await db
    .prepare(
      `SELECT l.* FROM marketplace_listings l CROSS JOIN (SELECT ? AS actor) scope WHERE l.status=? AND l.id>? AND ${ownershipPredicate(actor)} ORDER BY l.id LIMIT ?`,
    )
    .bind(
      actor.accountId,
      options.status ?? "PENDING_REVIEW",
      options.cursor ?? "",
      limit(options),
    )
    .all<Row>();
  return rows.results.map(privateView);
}

/** Private partner view; never resolve a foreign listing through public discovery. */
export async function getMarketplaceOwned(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  listingId: string,
) {
  const row = await listing(db, listingId, organizationId);
  await requirePartsOfferingScope(
    db,
    actor,
    organizationId,
    row.location_id as string | null,
  );
  await ownedOffering(db, actor, String(row.offering_id));
  return privateView(row);
}
