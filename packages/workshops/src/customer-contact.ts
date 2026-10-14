import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import {
  auditStatement,
  outboxStatement,
  type EventRegistry,
} from "@motorbaldi/db";
import { requireOrganizationPermission } from "@motorbaldi/authz";
import { vehiclePermissionPredicate } from "@motorbaldi/vehicles";
import { newId, type Json } from "@motorbaldi/shared";
import type { WorkshopActor } from "./access.js";
const id = z.string().uuid();
const schemas = {
  "workshop.contact.create": z
    .object({
      organizationId: id,
      vehicleId: id,
      message: z.string().trim().min(1).max(1200),
      dataSharingConsent: z.literal(true),
    })
    .strict(),
  "workshop.contact.close": z
    .object({
      organizationId: id,
      requestId: id,
      version: z.number().int().positive(),
      responseMessage: z.string().trim().min(1).max(1200),
    })
    .strict(),
};
export type CustomerWorkshopOperation = keyof typeof schemas;
export function parseCustomerWorkshopCommand(
  operation: string,
  body: unknown,
): Record<string, Json> {
  const schema = schemas[operation as CustomerWorkshopOperation];
  if (!schema)
    throw new Problem(
      400,
      "INVALID_WORKSHOP_CONTACT",
      "Unknown contact operation",
    );
  const result = schema.safeParse(body);
  if (!result.success)
    throw new Problem(
      400,
      "INVALID_WORKSHOP_CONTACT",
      "Valid contact details and explicit data-sharing consent required",
    );
  return result.data;
}
const serviceCodes =
  "'CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK'";
// Organization type is descriptive; the canonical Workshop service capabilities establish eligibility.
const workshop = `o.status='ACTIVE' AND o.verification_status='VERIFIED' AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code IN (${serviceCodes})) OR EXISTS(SELECT 1 FROM org_location_capabilities c JOIN org_locations l ON l.id=c.location_id AND l.organization_id=c.organization_id WHERE c.organization_id=o.id AND l.status='ACTIVE' AND c.code IN (${serviceCodes})))`;
const active = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE')`;
const owner = `EXISTS(SELECT 1 FROM vehicle_relationships r JOIN vehicle_vehicles v ON v.id=r.vehicle_id WHERE r.vehicle_id=? AND r.person_id=? AND r.relationship_type='OWNER' AND r.ended_at IS NULL AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
const staff = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN org_memberships m ON m.person_id=p.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND m.organization_id=o.id AND m.status='ACTIVE' AND m.location_scope_type='ALL_LOCATIONS' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code=?)`;
function createBindings(actor: WorkshopActor, body: Record<string, Json>) {
  return [
    actor.accountId,
    actor.personId,
    String(body.vehicleId),
    actor.personId,
    actor.accountId,
    actor.personId,
    String(body.vehicleId),
    "vehicle.read",
    null,
    null,
    null,
  ];
}
async function requireStaff(
  db: D1Database,
  actor: WorkshopActor,
  organizationId: string,
  permission: string,
) {
  await requireOrganizationPermission(db, actor, organizationId, permission);
  const row = await db
    .prepare(
      `SELECT 1 FROM org_organizations o WHERE o.id=? AND ${workshop} AND ${staff}`,
    )
    .bind(organizationId, actor.accountId, actor.personId, permission)
    .first();
  if (!row)
    throw new Problem(
      404,
      "WORKSHOP_CONTACT_NOT_FOUND",
      "Workshop contacts unavailable",
    );
}
export async function authorizeCustomerWorkshopCommand(
  db: D1Database,
  actor: WorkshopActor,
  operation: CustomerWorkshopOperation,
  input: Record<string, Json>,
) {
  const body = parseCustomerWorkshopCommand(operation, input);
  if (operation === "workshop.contact.create") {
    const row = await db
      .prepare(
        `SELECT 1 FROM org_organizations o WHERE o.id=? AND ${workshop} AND ${active} AND ${owner} AND ${vehiclePermissionPredicate}`,
      )
      .bind(String(body.organizationId), ...createBindings(actor, body))
      .first();
    if (!row)
      throw new Problem(
        404,
        "WORKSHOP_CONTACT_NOT_FOUND",
        "Active owned vehicle and verified workshop required",
      );
  } else {
    await requireStaff(
      db,
      actor,
      String(body.organizationId),
      "org.workshop.manage",
    );
    if (!actor.mfaEnabled)
      throw new Problem(
        403,
        "MFA_REQUIRED",
        "Multi-factor authentication required",
      );
    const row = await db
      .prepare(
        "SELECT 1 FROM workshop_contact_requests WHERE id=? AND organization_id=? AND status='OPEN' AND version=?",
      )
      .bind(
        String(body.requestId),
        String(body.organizationId),
        Number(body.version),
      )
      .first();
    if (!row)
      throw new Problem(
        409,
        "WORKSHOP_CONTACT_CONFLICT",
        "Contact request changed or unavailable",
      );
  }
  return body;
}
export const customerWorkshopEventContracts: EventRegistry = new Map(
  ["requested", "closed"].map((action) => [
    `workshop.contact.${action}.v1:1`,
    {
      aggregateType: "workshop_contact_request",
      version: 1,
      payload: z
        .object({
          requestId: id,
          organizationId: id,
          vehicleId: id,
          status: z.enum(["OPEN", "CLOSED"]),
          version: z.number().int().positive(),
        })
        .strict(),
      externalEffect: "IDEMPOTENT" as const,
    },
  ]),
);
export async function prepareCustomerWorkshopCommand(
  db: D1Database,
  actor: WorkshopActor,
  operation: CustomerWorkshopOperation,
  input: Record<string, Json>,
  correlationId: string,
) {
  const body = await authorizeCustomerWorkshopCommand(
    db,
    actor,
    operation,
    input,
  );
  const creating = operation === "workshop.contact.create",
    requestId = creating ? newId() : String(body.requestId),
    version = creating ? 1 : Number(body.version) + 1,
    status = creating ? "OPEN" : "CLOSED";
  const existing = creating
    ? null
    : await db
        .prepare(
          "SELECT vehicle_id FROM workshop_contact_requests WHERE id=? AND organization_id=?",
        )
        .bind(requestId, String(body.organizationId))
        .first<{ vehicle_id: string }>();
  const vehicleId = creating ? String(body.vehicleId) : existing!.vehicle_id;
  const mutation = creating
    ? db
        .prepare(
          `INSERT INTO workshop_contact_requests(id,organization_id,vehicle_id,created_by_account_id,message,data_sharing_consent) SELECT ?,o.id,?,?,?,1 FROM org_organizations o WHERE o.id=? AND ${workshop} AND ${active} AND ${owner} AND ${vehiclePermissionPredicate}`,
        )
        .bind(
          requestId,
          vehicleId,
          actor.accountId,
          String(body.message),
          String(body.organizationId),
          ...createBindings(actor, body),
        )
    : db
        .prepare(
          `UPDATE workshop_contact_requests SET status='CLOSED',response_message=?,version=version+1,closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),closed_by_account_id=? WHERE id=? AND organization_id=? AND version=? AND status='OPEN' AND EXISTS(SELECT 1 FROM org_organizations o WHERE o.id=workshop_contact_requests.organization_id AND ${workshop} AND ${staff})`,
        )
        .bind(
          String(body.responseMessage),
          actor.accountId,
          requestId,
          String(body.organizationId),
          Number(body.version),
          actor.accountId,
          actor.personId,
          "org.workshop.manage",
        );
  // A failed guarded mutation must abort the entire batch, including downstream effects.
  const history = db
    .prepare(
      `INSERT INTO workshop_contact_request_history(id,request_id,version,status,actor_account_id,correlation_id,response_message) VALUES(?,(SELECT CASE WHEN changes()=1 THEN id ELSE NULL END FROM workshop_contact_requests WHERE id=? AND version=? AND status=?),?,?,?,?,?)`,
    )
    .bind(
      newId(),
      requestId,
      version,
      status,
      version,
      status,
      actor.accountId,
      correlationId,
      creating ? null : String(body.responseMessage),
    );
  const response = {
    id: requestId,
    requestId,
    organizationId: String(body.organizationId),
    vehicleId,
    status,
    version,
  };
  return {
    requestId,
    response,
    guard: {
      table: "workshop_contact_request_history",
      column: "request_id",
      code: "WORKSHOP_CONTACT_CONFLICT",
      message: "Contact authority or version changed",
    },
    statements: [
      mutation,
      history,
      auditStatement(db, {
        actorId: actor.accountId,
        action: operation,
        resourceType: "workshop_contact_request",
        resourceId: requestId,
        organizationId: String(body.organizationId),
        requestId: correlationId,
      }),
      outboxStatement(
        db,
        {
          aggregateType: "workshop_contact_request",
          aggregateId: requestId,
          eventType: `workshop.contact.${creating ? "requested" : "closed"}.v1`,
          eventVersion: 1,
          payload: {
            requestId,
            organizationId: String(body.organizationId),
            vehicleId,
            status,
            version,
          },
          requestId: correlationId,
          externalEffectPolicy: "IDEMPOTENT",
        },
        customerWorkshopEventContracts,
      ).statement,
    ],
  };
}
export async function discoverCustomerWorkshops(
  db: D1Database,
  actor: WorkshopActor,
  q = "",
  cursor = "",
) {
  if (q.length > 120 || cursor.length > 36)
    throw new Problem(400, "INVALID_WORKSHOP_SEARCH", "Invalid search");
  const rows = await db
    .prepare(
      `SELECT o.id,o.display_name AS displayName,o.country_code AS countryCode FROM org_organizations o WHERE ${workshop} AND ${active} AND o.id>? AND instr(lower(o.display_name),lower(?))>0 ORDER BY o.id LIMIT 31`,
    )
    .bind(actor.accountId, actor.personId, cursor, q.trim())
    .all();
  return {
    items: rows.results.slice(0, 30),
    nextCursor: rows.results.length > 30 ? rows.results[29]!.id : null,
  };
}
const projection = `c.id,c.organization_id AS organizationId,o.display_name AS organizationName,c.vehicle_id AS vehicleId,c.message,c.status,c.version,c.created_at AS createdAt,c.closed_at AS closedAt,c.response_message AS responseMessage`;
export async function listCustomerWorkshopContacts(
  db: D1Database,
  actor: WorkshopActor,
  cursor = "",
) {
  if (cursor.length > 36)
    throw new Problem(400, "INVALID_WORKSHOP_SEARCH", "Invalid cursor");
  const rows = await db
    .prepare(
      `SELECT ${projection} FROM workshop_contact_requests c JOIN org_organizations o ON o.id=c.organization_id WHERE c.created_by_account_id=? AND ${active} AND c.id>? ORDER BY c.id LIMIT 31`,
    )
    .bind(actor.accountId, actor.accountId, actor.personId, cursor)
    .all();
  return {
    items: rows.results.slice(0, 30),
    nextCursor: rows.results.length > 30 ? rows.results[29]!.id : null,
  };
}
export async function listOrganizationWorkshopContacts(
  db: D1Database,
  actor: WorkshopActor,
  organizationId: string,
  cursor = "",
) {
  if (cursor.length > 36)
    throw new Problem(400, "INVALID_WORKSHOP_SEARCH", "Invalid cursor");
  await requireStaff(db, actor, organizationId, "org.workshop.read");
  const rows = await db
    .prepare(
      `SELECT ${projection} FROM workshop_contact_requests c JOIN org_organizations o ON o.id=c.organization_id WHERE o.id=? AND ${workshop} AND ${staff} AND c.id>? ORDER BY c.id LIMIT 31`,
    )
    .bind(
      organizationId,
      actor.accountId,
      actor.personId,
      "org.workshop.read",
      cursor,
    )
    .all();
  return {
    items: rows.results.slice(0, 30),
    nextCursor: rows.results.length > 30 ? rows.results[29]!.id : null,
  };
}
