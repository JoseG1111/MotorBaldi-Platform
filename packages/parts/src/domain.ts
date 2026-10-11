import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import {
  hasDevelopmentAutomationAssurance,
  outboxStatement,
  type EventRegistry,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";
import { requireWorkshopPermission } from "@motorbaldi/workshops";
import {
  parsePartsCommand,
  partsCommandInputs,
  partsReferenceIdentity,
  type PartsOperation,
} from "./contract.js";
import {
  requirePartsActor,
  requirePartsStaff,
  requirePartsOfferingScope,
  partsOfferingPredicate,
  type PartsActor,
} from "./access.js";

type Row = Record<string, string | number | null>;
const missing = () =>
  new Problem(404, "PARTS_NOT_FOUND", "Parts resource unavailable");
const conflict = () =>
  new Problem(409, "PARTS_STATE_CONFLICT", "Parts state changed; retry safely");
const eventPayload = z
  .object({
    resourceId: z.uuid(),
    organizationId: z.uuid().nullable(),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const partsCommandEventRegistry: EventRegistry = new Map(
  Object.keys(partsCommandInputs).map((operation) => [
    `${operation}.v1:1`,
    {
      aggregateType: "parts",
      version: 1,
      payload: eventPayload,
      externalEffect: "IDEMPOTENT" as const,
    },
  ]),
);
function view(row: Row): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      [
        "last_actor_account_id",
        "actor_account_id",
        "brand_key",
        "reference_key",
      ].includes(key)
    )
      continue;
    if (key === "compatibility_json")
      result.compatibility = JSON.parse(String(value));
    else if (key === "snapshot_json")
      result.snapshot = JSON.parse(String(value));
    else
      result[key.replace(/_([a-z])/g, (_all, c: string) => c.toUpperCase())] =
        value;
  }
  return result;
}
async function offering(
  db: D1Database,
  actor: PartsActor,
  org: string,
  id: string,
) {
  const row = await db
    .prepare("SELECT * FROM parts_offerings WHERE id=? AND organization_id=?")
    .bind(id, org)
    .first<Row>();
  if (!row) throw missing();
  await requirePartsOfferingScope(
    db,
    actor,
    org,
    row.location_id as string | null,
  );
  return row;
}
async function order(
  db: D1Database,
  actor: PartsActor,
  org: string,
  id: string,
  write = false,
) {
  const row = await db
    .prepare("SELECT * FROM workshop_orders WHERE id=? AND organization_id=?")
    .bind(id, org)
    .first<Row>();
  if (!row) throw missing();
  await requireWorkshopPermission(
    db,
    actor,
    {
      organizationId: org,
      locationId: String(row.location_id),
      vehicleId: String(row.vehicle_id),
    },
    write ? "org.workshop.manage" : "org.workshop.read",
    write,
  );
  return row;
}
export async function authorizePartsCommand(
  db: D1Database,
  actor: PartsActor,
  operation: PartsOperation,
  request: Record<string, Json>,
) {
  const body = parsePartsCommand(operation, request);
  if (operation.startsWith("parts.canonical.")) {
    await requirePartsStaff(db, actor);
    return;
  }
  if (operation === "parts.workshop.snapshot.add") {
    await requirePartsActorMFA(db, actor);
    await order(
      db,
      actor,
      String(body.organizationId),
      String(body.orderId),
      true,
    );
    return;
  }
  if (operation !== "parts.offering.create")
    await offering(
      db,
      actor,
      String(body.organizationId),
      String(body.offeringId),
    );
  if (operation !== "parts.offering.transition")
    await requirePartsOfferingScope(
      db,
      actor,
      String(body.organizationId),
      body.locationId as string | null,
    );
}
function audit(
  db: D1Database,
  actor: PartsActor,
  op: string,
  id: string,
  requestId: string,
  org: string | null,
) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,organization_id) VALUES(?,?,?,'parts',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)",
    )
    .bind(newId(), actor.accountId, op, id, requestId, org);
}
const fields = [
  "name",
  "category",
  "brand",
  "manufacturer_reference",
  "brand_key",
  "reference_key",
  "description",
  "unit",
  "compatibility_json",
];
function values(body: Record<string, Json>) {
  const identity = partsReferenceIdentity({
    brand: String(body.brand),
    manufacturerReference: String(body.manufacturerReference),
  });
  return [
    body.name,
    body.category,
    body.brand,
    body.manufacturerReference,
    identity.brandKey,
    identity.referenceKey,
    body.description,
    body.unit,
    JSON.stringify(body.compatibility),
  ];
}
function snapshotSql(prefix: string, offering = false) {
  return `json_object('id',${prefix}.id,'name',${prefix}.name,'category',${prefix}.category,'brand',${prefix}.brand,'manufacturerReference',${prefix}.manufacturer_reference,'description',${prefix}.description,'unit',${prefix}.unit,'compatibility',json(${prefix}.compatibility_json),'version',${prefix}.version,'status',${prefix}.status${offering ? `,'organizationId',${prefix}.organization_id,'locationId',${prefix}.location_id,'canonicalPartId',${prefix}.canonical_part_id,'partnerSku',${prefix}.partner_sku,'priceMinor',${prefix}.price_minor,'currency',${prefix}.currency,'availability',${prefix}.availability` : ""})`;
}
export async function preparePartsCommand(
  db: D1Database,
  actor: PartsActor,
  operation: PartsOperation,
  request: Record<string, Json>,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = parsePartsCommand(operation, request);
  await authorizePartsCommand(db, actor, operation, body);
  const statements: D1PreparedStatement[] = [],
    now = utcNow();
  let resourceId: string,
    version: number,
    org: string | null = null;
  if (operation === "parts.workshop.snapshot.add") {
    org = String(body.organizationId);
    const w = await order(db, actor, org, String(body.orderId), true);
    if (
      !["DRAFT", "OPEN", "IN_PROGRESS"].includes(String(w.status)) ||
      w.version !== body.version
    )
      throw conflict();
    const f = await db
      .prepare(
        "SELECT f.*, c.version AS canonical_version,c.status AS canonical_status FROM parts_offerings f LEFT JOIN parts_canonical c ON c.id=f.canonical_part_id WHERE f.id=? AND f.organization_id=? AND f.status='ACTIVE' AND (f.location_id IS NULL OR f.location_id=?) AND (f.canonical_part_id IS NULL OR (c.status='ACTIVE' AND c.brand_key=f.brand_key AND c.reference_key=f.reference_key))",
      )
      .bind(body.offeringId, org, w.location_id)
      .first<Row>();
    if (!f) throw missing();
    resourceId = newId();
    version = Number(w.version) + 1;
    statements.push(
      db
        .prepare(
          "UPDATE workshop_orders SET version=version+1,updated_at=? WHERE id=? AND organization_id=? AND version=? AND status IN ('DRAFT','OPEN','IN_PROGRESS')",
        )
        .bind(now, w.id, org, w.version),
      audit(db, actor, operation, resourceId, requestId, org),
    );
    const frozen = {
      ...view(f),
      offeringId: f.id,
      canonicalPartId: f.canonical_part_id,
      offeringVersion: f.version,
      canonicalVersion: f.canonical_version,
      orderId: w.id,
      orderVersion: version,
      orderLocationId: w.location_id,
    };
    delete (frozen as Record<string, unknown>).canonicalStatus;
    statements.push(
      db
        .prepare(
          "INSERT INTO parts_workshop_snapshots(id,order_id,organization_id,location_id,offering_id,canonical_part_id,offering_version,canonical_version,order_version,snapshot_json,actor_account_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          resourceId,
          w.id,
          org,
          w.location_id,
          f.id,
          f.canonical_part_id,
          f.version,
          f.canonical_version,
          version,
          JSON.stringify(frozen),
          actor.accountId,
        ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO workshop_order_events(id,order_id,from_status,to_status,version,actor_account_id,reason) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          newId(),
          w.id,
          w.status,
          w.status,
          version,
          actor.accountId,
          body.reason,
        ),
    );
  } else {
    const canonical = operation.startsWith("parts.canonical."),
      create = operation.endsWith(".create"),
      transition = operation.endsWith(".transition");
    const table = canonical ? "parts_canonical" : "parts_offerings",
      resourceType = canonical ? "canonical" : "offering";
    org = canonical ? null : String(body.organizationId);
    resourceId = create
      ? newId()
      : String(canonical ? body.partId : body.offeringId);
    const current = create
      ? null
      : await db
          .prepare(
            `SELECT * FROM ${table} WHERE id=?${canonical ? "" : " AND organization_id=?"}`,
          )
          .bind(...(canonical ? [resourceId] : [resourceId, org]))
          .first<Row>();
    if (!create && !current) throw missing();
    if (current && current.version !== body.version) throw conflict();
    version = create ? 1 : Number(body.version) + 1;
    if (create) {
      const columns = [
        "id",
        ...fields,
        ...(canonical
          ? []
          : [
              "organization_id",
              "location_id",
              "canonical_part_id",
              "partner_sku",
              "price_minor",
              "currency",
              "availability",
            ]),
        "last_actor_account_id",
      ];
      const bound = [
        resourceId,
        ...values(body),
        ...(canonical
          ? []
          : [
              org,
              body.locationId,
              body.canonicalPartId,
              body.partnerSku,
              body.priceMinor,
              body.currency,
              body.availability,
            ]),
        actor.accountId,
      ];
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...bound),
      );
    } else {
      const columns = transition
        ? ["status"]
        : [
            ...fields,
            ...(canonical
              ? []
              : [
                  "location_id",
                  "canonical_part_id",
                  "partner_sku",
                  "price_minor",
                  "currency",
                  "availability",
                ]),
          ];
      const bound = transition
        ? [body.toStatus]
        : [
            ...values(body),
            ...(canonical
              ? []
              : [
                  body.locationId,
                  body.canonicalPartId,
                  body.partnerSku,
                  body.priceMinor,
                  body.currency,
                  body.availability,
                ]),
          ];
      statements.push(
        db
          .prepare(
            `UPDATE ${table} SET ${columns.map((c) => `${c}=?`).join(",")},version=version+1,updated_at=?,last_actor_account_id=? WHERE id=? AND version=?${canonical ? "" : " AND organization_id=?"}`,
          )
          .bind(
            ...bound,
            now,
            actor.accountId,
            resourceId,
            body.version,
            ...(canonical ? [] : [org]),
          ),
      );
    }
    statements.push(audit(db, actor, operation, resourceId, requestId, org));
    statements.push(
      db
        .prepare(
          `INSERT INTO parts_change_history(id,resource_type,resource_id,version,status,snapshot_json,actor_account_id,reason,request_id) SELECT ?,?,p.id,p.version,p.status,${snapshotSql("p", !canonical)},?,?,? FROM ${table} p WHERE p.id=? AND p.version=?`,
        )
        .bind(
          newId(),
          resourceType,
          actor.accountId,
          body.reason,
          requestId,
          resourceId,
          version,
        ),
    );
  }
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "parts",
        aggregateId: resourceId,
        eventType: `${operation}.v1`,
        eventVersion: 1,
        payload: { resourceId, organizationId: org, version },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      partsCommandEventRegistry,
    ).statement,
  );
  return {
    statements,
    response: {
      resourceId,
      version,
      ...(operation.startsWith("parts.canonical.")
        ? { partId: resourceId }
        : operation === "parts.workshop.snapshot.add"
          ? { snapshotId: resourceId }
          : { offeringId: resourceId }),
    },
    recover: async (error) => {
      const message = String(error);
      if (
        message.includes("UNIQUE constraint failed: parts_canonical.brand_key")
      )
        throw new Problem(
          409,
          "PARTS_REFERENCE_CONFLICT",
          "Canonical reference already exists",
        );
      if (
        /PARTS_(BOUNDARY|HISTORY_BOUNDARY|SNAPSHOT_BOUNDARY)|NOT NULL constraint failed: governance_audit_events.resource_id|UNIQUE constraint failed: parts_(change_history|workshop_snapshots)|FOREIGN KEY constraint failed/.test(
          message,
        )
      )
        throw conflict();
      return null;
    },
  };
}
export type PartsListOptions = {
  cursor?: string;
  limit?: number;
  status?: string;
};
function limit(options: PartsListOptions) {
  return Math.max(
    1,
    Math.min(
      50,
      Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 50,
    ),
  );
}
export async function getCanonicalPart(
  db: D1Database,
  actor: PartsActor,
  id: string,
) {
  await requirePartsStaff(db, actor);
  const row = await db
    .prepare("SELECT * FROM parts_canonical WHERE id=?")
    .bind(id)
    .first<Row>();
  if (!row) throw missing();
  return view(row);
}
export async function listCanonicalParts(
  db: D1Database,
  actor: PartsActor,
  options: PartsListOptions = {},
) {
  await requirePartsStaff(db, actor);
  if (options.cursor) await getCanonicalPart(db, actor, options.cursor);
  const rows = await db
    .prepare(
      "SELECT * FROM parts_canonical WHERE id>? AND (? IS NULL OR status=?) ORDER BY id LIMIT ?",
    )
    .bind(
      options.cursor ?? "",
      options.status ?? null,
      options.status ?? null,
      limit(options),
    )
    .all<Row>();
  return rows.results.map(view);
}
export async function matchCanonicalParts(
  db: D1Database,
  actor: PartsActor,
  input: { brand: string; manufacturerReference: string },
) {
  await requirePartsStaff(db, actor);
  const key = partsReferenceIdentity(input);
  const rows = await db
    .prepare(
      "SELECT * FROM parts_canonical WHERE brand_key=? AND reference_key=? ORDER BY id LIMIT 50",
    )
    .bind(key.brandKey, key.referenceKey)
    .all<Row>();
  return rows.results.map(view);
}
export async function getPartsOffering(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  id: string,
) {
  return view(await offering(db, actor, organizationId, id));
}
export async function listPartsOfferings(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  options: PartsListOptions & { locationId?: string | null } = {},
) {
  await requirePartsActor(db, actor);
  if (options.locationId !== undefined)
    await requirePartsOfferingScope(
      db,
      actor,
      organizationId,
      options.locationId,
    );
  else {
    const scope = await db
      .prepare(
        `SELECT 1 FROM (SELECT ? actor,? organization,NULL location UNION ALL SELECT ?,?,id FROM org_locations WHERE organization_id=?) s WHERE ${partsOfferingPredicate("s.actor", "s.organization", "s.location")} LIMIT 1`,
      )
      .bind(
        actor.accountId,
        organizationId,
        actor.accountId,
        organizationId,
        organizationId,
      )
      .first();
    if (!scope) throw missing();
  }
  if (options.cursor) {
    const cursor = await offering(db, actor, organizationId, options.cursor);
    if (
      options.locationId !== undefined &&
      cursor.location_id !== options.locationId
    )
      throw missing();
  }
  const rows = await db
    .prepare(
      `SELECT f.* FROM parts_offerings f CROSS JOIN (SELECT ? actor) s WHERE f.organization_id=? AND f.id>? AND (?=0 OR f.location_id IS ?) AND (? IS NULL OR f.status=?) AND ${partsOfferingPredicate("s.actor", "f.organization_id", "f.location_id")} ORDER BY f.id LIMIT ?`,
    )
    .bind(
      actor.accountId,
      organizationId,
      options.cursor ?? "",
      options.locationId === undefined ? 0 : 1,
      options.locationId ?? null,
      options.status ?? null,
      options.status ?? null,
      limit(options),
    )
    .all<Row>();
  return rows.results.map(view);
}
export async function listWorkshopPartSnapshots(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  orderId: string,
  options: PartsListOptions = {},
) {
  await order(db, actor, organizationId, orderId);
  if (options.cursor)
    await getWorkshopPartSnapshot(
      db,
      actor,
      organizationId,
      orderId,
      options.cursor,
    );
  const rows = await db
    .prepare(
      "SELECT * FROM parts_workshop_snapshots WHERE organization_id=? AND order_id=? AND id>? ORDER BY id LIMIT ?",
    )
    .bind(organizationId, orderId, options.cursor ?? "", limit(options))
    .all<Row>();
  return rows.results.map(view);
}
export async function getWorkshopPartSnapshot(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  orderId: string,
  snapshotId: string,
) {
  await order(db, actor, organizationId, orderId);
  const row = await db
    .prepare(
      "SELECT * FROM parts_workshop_snapshots WHERE id=? AND organization_id=? AND order_id=?",
    )
    .bind(snapshotId, organizationId, orderId)
    .first<Row>();
  if (!row) throw missing();
  return view(row);
}

export async function requirePartsActorMFA(db: D1Database, actor: PartsActor) {
  await requirePartsActor(db, actor);
  if (await hasDevelopmentAutomationAssurance(db, actor)) return;
  if (
    !(await db
      .prepare(
        "SELECT 1 FROM auth_users u WHERE u.id=? AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1)",
      )
      .bind(actor.accountId)
      .first())
  )
    throw new Problem(
      403,
      "MFA_REQUIRED",
      "Assured multi-factor authentication required",
    );
}
export async function listCanonicalPartsForOrganization(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  options: PartsListOptions & { locationId?: string | null } = {},
) {
  await requirePartsOfferingScope(
    db,
    actor,
    organizationId,
    options.locationId ?? null,
  );
  if (
    options.cursor &&
    !(await db
      .prepare("SELECT 1 FROM parts_canonical WHERE id=? AND status='ACTIVE'")
      .bind(options.cursor)
      .first())
  )
    throw missing();
  const rows = await db
    .prepare(
      "SELECT * FROM parts_canonical WHERE status='ACTIVE' AND id>? ORDER BY id LIMIT ?",
    )
    .bind(options.cursor ?? "", limit(options))
    .all<Row>();
  return rows.results.map(view);
}
export async function matchCanonicalPartsForOrganization(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  input: {
    locationId?: string | null;
    brand: string;
    manufacturerReference: string;
  },
) {
  await requirePartsOfferingScope(
    db,
    actor,
    organizationId,
    input.locationId ?? null,
  );
  const key = partsReferenceIdentity(input);
  const rows = await db
    .prepare(
      "SELECT * FROM parts_canonical WHERE status='ACTIVE' AND brand_key=? AND reference_key=? LIMIT 50",
    )
    .bind(key.brandKey, key.referenceKey)
    .all<Row>();
  return rows.results.map(view);
}

/** Select sources only within an already authorized Workshop operation, never a global commercial catalog. */
export async function listWorkshopPartsOfferings(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  orderId: string,
  options: PartsListOptions = {},
) {
  await requirePartsActorMFA(db, actor);
  const w = await order(db, actor, organizationId, orderId, true);
  const rows = await db
    .prepare(
      "SELECT f.* FROM parts_offerings f LEFT JOIN parts_canonical c ON c.id=f.canonical_part_id WHERE f.organization_id=? AND (f.location_id IS NULL OR f.location_id=?) AND f.status='ACTIVE' AND f.id>? AND (f.canonical_part_id IS NULL OR (c.status='ACTIVE' AND c.brand_key=f.brand_key AND c.reference_key=f.reference_key)) ORDER BY f.id LIMIT ?",
    )
    .bind(organizationId, w.location_id, options.cursor ?? "", limit(options))
    .all<Row>();
  return rows.results.map(view);
}
