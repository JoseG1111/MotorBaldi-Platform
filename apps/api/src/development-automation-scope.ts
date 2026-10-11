import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  requirePartsStaff,
  requirePartsOfferingScope,
  partsReferenceIdentity,
} from "@motorbaldi/parts";
import type { Json } from "@motorbaldi/shared";

type Actor = Principal & {
  personId: string;
  automationAuthorizationId?: string;
};
type Scope = { organization_id: string; location_id: string };
const denied = () =>
  new Problem(403, "DEVELOPMENT_AUTOMATION_SCOPE", "Automation scope denied");
const missing = () => new Problem(404, "NOT_FOUND", "Resource unavailable");
const operations = new Set([
  "parts.canonical.create",
  "parts.canonical.update",
  "parts.canonical.transition",
  "parts.offering.create",
  "parts.offering.update",
  "parts.offering.transition",
  "parts.workshop.snapshot.add",
  "vehicle.create",
  "vehicle.grant.create",
  "vehicle.grant.revoke",
  "workshop.order.create",
  "workshop.order.transition",
  "development.fixture.parts.enable",
]);
async function scope(db: D1Database, actor: Actor): Promise<Scope> {
  const row = await db
    .prepare(
      `SELECT i.organization_id,i.location_id FROM development_automation_identities i JOIN development_automation_authorizations a ON a.account_id=i.account_id AND a.credential_version=i.credential_version JOIN org_organizations o ON o.id=i.organization_id JOIN org_locations l ON l.id=i.location_id AND l.organization_id=o.id WHERE a.id=? AND i.account_id=? AND i.name='development-validation' AND i.status='ACTIVE' AND a.expires_at>? AND (i.expires_at IS NULL OR i.expires_at>?) AND o.display_name='MotorBaldi Development Validation Workshop' AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.name='MotorBaldi Development Workshop Site' AND l.status='ACTIVE' AND EXISTS(SELECT 1 FROM iam_accounts ma JOIN iam_people mp ON mp.id=ma.person_id JOIN org_memberships m ON m.person_id=ma.person_id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id JOIN org_membership_locations ml ON ml.membership_id=m.id AND ml.organization_id=m.organization_id WHERE ma.id=i.account_id AND ma.status='ACTIVE' AND mp.status='ACTIVE' AND m.organization_id=i.organization_id AND ml.location_id=i.location_id AND m.location_scope_type='SELECTED_LOCATIONS' AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND r.scope='ORGANIZATION' AND r.code='DEVELOPMENT_AUTOMATION' AND rp.permission_code='org.read') AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE environment='development')`,
    )
    .bind(
      actor.automationAuthorizationId,
      actor.accountId,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .first<Scope>();
  if (!row) throw denied();
  return row;
}
async function owned(db: D1Database, actor: Actor, type: string, id: unknown) {
  if (
    typeof id !== "string" ||
    !(await db
      .prepare(
        "SELECT 1 FROM development_automation_resources WHERE account_id=? AND resource_type=? AND resource_id=?",
      )
      .bind(actor.accountId, type, id)
      .first())
  )
    throw missing();
}
function view(row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
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
    if (key === "compatibility_json" || key === "snapshot_json")
      result[key === "compatibility_json" ? "compatibility" : "snapshot"] =
        JSON.parse(String(value));
    else
      result[key.replace(/_([a-z])/g, (_all, c: string) => c.toUpperCase())] =
        value;
  }
  return result;
}
export async function automationRoute(
  db: D1Database,
  request: Request,
  actor: Actor,
): Promise<Response | null> {
  if (!actor.automationAuthorizationId) return null;
  const current = await scope(db, actor),
    url = new URL(request.url),
    path = url.pathname,
    get = request.method === "GET",
    post = request.method === "POST";
  const reply = (value: unknown) =>
    Response.json(value, { headers: { "cache-control": "no-store" } });
  const org = path.match(/^\/api\/v1\/organizations\/([^/]+)(?:\/(.*))?$/);
  if (org && org[1] !== current.organization_id) throw missing();
  if (
    url.searchParams.has("locationId") &&
    url.searchParams.get("locationId") !== current.location_id
  )
    throw missing();
  if (get && path === "/api/v1/me")
    return reply({
      accountId: actor.accountId,
      personId: actor.personId,
      mfaEnabled: false,
      authenticationMethod: "DEVELOPMENT_AUTOMATION",
    });
  if (get && path === "/api/v1/admin/organizations")
    return reply({
      items: (
        await db
          .prepare(
            "SELECT id,type,display_name,verification_status,status FROM org_organizations WHERE id=?",
          )
          .bind(current.organization_id)
          .all()
      ).results,
      nextCursor: null,
    });
  if (get && org && org[2] === "locations")
    return reply({
      items: (
        await db
          .prepare(
            "SELECT id,name,status FROM org_locations WHERE id=? AND organization_id=?",
          )
          .bind(current.location_id, current.organization_id)
          .all()
      ).results,
      nextCursor: null,
    });
  if (get && org && org[2] === "permissions") {
    const now = new Date().toISOString();
    const rows = await db
      .prepare(
        `SELECT DISTINCT rp.permission_code AS code FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' AND r.code='DEVELOPMENT_AUTOMATION' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE m.person_id=? AND m.organization_id=? AND m.status='ACTIVE' AND m.valid_from<=? AND (m.valid_to IS NULL OR m.valid_to>?) AND (m.location_scope_type='SELECTED_LOCATIONS' AND EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=m.organization_id AND ml.location_id=?)) AND rp.permission_code IN ('org.read','org.parts.manage','org.workshop.read','org.workshop.manage') ORDER BY rp.permission_code`,
      )
      .bind(
        actor.personId,
        current.organization_id,
        now,
        now,
        current.location_id,
      )
      .all<{ code: string }>();
    return reply({ permissions: rows.results.map((row) => row.code) });
  }
  if (get && org && org[2] === "capabilities")
    return reply(
      (
        await db
          .prepare(
            "SELECT code FROM org_capabilities WHERE organization_id=? AND code IN ('PARTS','WORKSHOP') ORDER BY code",
          )
          .bind(current.organization_id)
          .all()
      ).results,
    );
  if (post && path === "/api/v1/development/automation/fixtures/parts/enable")
    return null;
  const canonical = path.match(
      /^\/api\/v1\/admin\/parts(?:\/([^/]+)(?:\/(update|transition))?)?$/,
    ),
    catalog = org?.[2]?.match(/^parts-catalog(?:\/(match))?$/),
    offering = org?.[2]?.match(
      /^parts-offerings(?:\/([^/]+)(?:\/(update|transition))?)?$/,
    );
  const workshop = org?.[2]?.match(
    /^workshop\/orders(?:\/([^/]+)(?:\/(transition|parts(?:\/offerings)?))?)?$/,
  );
  if (canonical || catalog || offering || workshop) {
    if (!get && !post) throw denied();
    if (get && canonical) await requirePartsStaff(db, actor);
    if (get && (catalog || offering || workshop?.[2]?.startsWith("parts")))
      await requirePartsOfferingScope(
        db,
        actor,
        current.organization_id,
        current.location_id,
      );
    if (catalog && !get) throw denied();
    if (canonical?.[1] && canonical[1] !== "match")
      await owned(db, actor, "canonical", canonical[1]);
    if (offering?.[1]) await owned(db, actor, "offering", offering[1]);
    if (workshop?.[1]) await owned(db, actor, "order", workshop[1]);
    if (
      get &&
      (catalog ||
        (canonical && (!canonical[1] || canonical[1] === "match")) ||
        (offering && !offering[1]) ||
        workshop?.[2]?.startsWith("parts"))
    ) {
      const type =
        catalog || canonical
          ? "canonical"
          : workshop?.[2] === "parts"
            ? "snapshot"
            : "offering";
      const table =
        type === "canonical"
          ? "parts_canonical"
          : type === "snapshot"
            ? "parts_workshop_snapshots"
            : "parts_offerings";
      const clauses = ["r.account_id=?", "r.resource_type=?", "t.id>?"];
      const values: (string | number)[] = [
        actor.accountId,
        type,
        url.searchParams.get("cursor") ?? "",
      ];
      if (url.searchParams.has("cursor"))
        await owned(db, actor, type, url.searchParams.get("cursor"));
      if (type !== "canonical") {
        clauses.push("t.organization_id=?");
        values.push(current.organization_id);
      }
      if (type === "offering") {
        clauses.push("t.location_id=?");
        values.push(current.location_id);
      }
      if (type === "snapshot") {
        clauses.push("t.order_id=?");
        values.push(workshop![1]!);
      }
      if (catalog || workshop?.[2] === "parts/offerings")
        clauses.push("t.status='ACTIVE'");
      if (url.searchParams.has("status")) {
        clauses.push("t.status=?");
        values.push(url.searchParams.get("status")!);
      }
      if (canonical?.[1] === "match" || catalog?.[1]) {
        const key = partsReferenceIdentity({
          brand: url.searchParams.get("brand") ?? "",
          manufacturerReference:
            url.searchParams.get("manufacturerReference") ?? "",
        });
        clauses.push("t.brand_key=?", "t.reference_key=?");
        values.push(key.brandKey, key.referenceKey);
      }
      const limit = Number(url.searchParams.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw denied();
      values.push(limit);
      return reply(
        (
          await db
            .prepare(
              `SELECT t.* FROM ${table} t JOIN development_automation_resources r ON r.resource_id=t.id WHERE ${clauses.join(" AND ")} ORDER BY t.id LIMIT ?`,
            )
            .bind(...values)
            .all()
        ).results.map(view),
      );
    }
    if (get && workshop && !workshop[1])
      return reply({
        items: (
          await db
            .prepare(
              "SELECT w.id,w.vehicle_id,w.location_id,w.description,w.status,w.assigned_person_id,w.final_record_id,w.version FROM workshop_orders w JOIN development_automation_resources r ON r.resource_id=w.id AND r.resource_type='order' AND r.account_id=? WHERE w.organization_id=? AND w.location_id=? ORDER BY w.id LIMIT 30",
            )
            .bind(actor.accountId, current.organization_id, current.location_id)
            .all()
        ).results,
        nextCursor: null,
      });
    if (
      post &&
      ((canonical?.[1] && !canonical[2]) ||
        (offering?.[1] && !offering[2]) ||
        (workshop?.[1] && !workshop[2]) ||
        workshop?.[2] === "parts/offerings")
    )
      throw denied();
    return null;
  }
  const available = org?.[2]?.match(/^workshop\/locations\/([^/]+)\/vehicles$/);
  if (get && available) {
    if (available[1] !== current.location_id) throw missing();
    return reply({
      items: (
        await db
          .prepare(
            "SELECT v.id,v.kind_code FROM vehicle_vehicles v JOIN development_automation_resources r ON r.resource_id=v.id AND r.resource_type='vehicle' AND r.account_id=? ORDER BY v.id LIMIT 30",
          )
          .bind(actor.accountId)
          .all()
      ).results,
    });
  }
  if (post && path === "/api/v1/admin/vehicles") return null;
  const vehicle = path.match(
    /^\/api\/v1\/admin\/vehicles\/([^/]+)(?:\/grants(?:\/([^/]+)\/revoke)?)?$/,
  );
  if (
    vehicle &&
    ((get && !path.endsWith("/grants") && !vehicle[2]) ||
      (post && path.includes("/grants")))
  ) {
    await owned(db, actor, "vehicle", vehicle[1]);
    if (vehicle[2]) await owned(db, actor, "grant", vehicle[2]);
    return null;
  }
  throw denied();
}
export async function validateAutomationCommand(
  db: D1Database,
  actor: Actor,
  operation: string,
  input: Json,
): Promise<void> {
  if (!actor.automationAuthorizationId) return;
  const current = await scope(db, actor);
  if (
    !operations.has(operation) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    throw denied();
  const body = input as Record<string, Json>;
  if (
    !(await db
      .prepare(
        "SELECT 1 FROM development_automation_authorizations WHERE id=? AND account_id=? AND operation=? AND expires_at>?",
      )
      .bind(
        actor.automationAuthorizationId,
        actor.accountId,
        operation,
        new Date().toISOString(),
      )
      .first())
  )
    throw denied();
  if (
    body.organizationId !== undefined &&
    body.organizationId !== current.organization_id
  )
    throw missing();
  if (body.locationId !== undefined && body.locationId !== current.location_id)
    throw missing();
  if (typeof body.reason !== "string" || !body.reason.startsWith("Synthetic"))
    throw denied();
  if (operation === "development.fixture.parts.enable") {
    if (
      body.organizationId !== current.organization_id ||
      body.locationId !== current.location_id ||
      Object.keys(body).some(
        (key) => !["organizationId", "locationId", "reason"].includes(key),
      )
    )
      throw denied();
    return;
  }
  for (const [field, type] of [
    ["partId", "canonical"],
    ["canonicalPartId", "canonical"],
    ["offeringId", "offering"],
    ["orderId", "order"],
    ["vehicleId", "vehicle"],
    ["grantId", "grant"],
  ])
    if (body[field!] != null) await owned(db, actor, type!, body[field!]);
  if (operation === "vehicle.create") {
    const specification = body.specification;
    if (
      !specification ||
      typeof specification !== "object" ||
      Array.isArray(specification) ||
      specification.brand !== "Synthetic Development" ||
      typeof specification.model !== "string" ||
      !specification.model.startsWith("Parts validation ") ||
      Object.keys(specification).some(
        (key) => !["brand", "model"].includes(key),
      )
    )
      throw denied();
  }
  if (
    operation === "vehicle.grant.create" &&
    (body.organizationId !== current.organization_id ||
      body.locationId !== current.location_id ||
      body.personId != null ||
      !["vehicle.workshop.read", "vehicle.workshop.write"].includes(
        String(body.permissionCode),
      ))
  )
    throw denied();
  if (
    operation === "workshop.order.create" &&
    (body.locationId !== current.location_id ||
      body.organizationId !== current.organization_id ||
      body.assignedPersonId != null ||
      typeof body.description !== "string" ||
      !body.description.startsWith("Synthetic Development"))
  )
    throw denied();
  if (
    operation === "workshop.order.transition" &&
    body.toStatus !== "CANCELLED"
  )
    throw denied();
  if (
    (operation.endsWith(".create") || operation.endsWith(".update")) &&
    operation.startsWith("parts.")
  ) {
    if (
      body.brand !== "Synthetic Development" ||
      typeof body.name !== "string" ||
      !body.name.startsWith("Synthetic") ||
      body.category !== "VALIDATION" ||
      !Array.isArray(body.compatibility) ||
      body.compatibility.length !== 0
    )
      throw denied();
    if (
      operation.startsWith("parts.offering.") &&
      body.locationId !== current.location_id
    )
      throw denied();
  }
}
export function automationResourceClaim(
  db: D1Database,
  actor: Actor,
  operation: string,
  response: Json,
): D1PreparedStatement[] {
  if (
    !actor.automationAuthorizationId ||
    !response ||
    typeof response !== "object" ||
    Array.isArray(response)
  )
    return [];
  const claims: Record<string, [string, string]> = {
    "parts.canonical.create": ["canonical", "partId"],
    "parts.offering.create": ["offering", "offeringId"],
    "parts.workshop.snapshot.add": ["snapshot", "snapshotId"],
    "vehicle.create": ["vehicle", "vehicleId"],
    "vehicle.grant.create": ["grant", "grantId"],
    "workshop.order.create": ["order", "orderId"],
  };
  const claim = claims[operation];
  if (!claim) return [];
  const id = response[claim[1]];
  if (typeof id !== "string") throw denied();
  return [
    db
      .prepare(
        `INSERT INTO development_automation_resources(account_id,resource_type,resource_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM development_automation_authorizations a JOIN development_automation_identities i ON i.account_id=a.account_id AND i.credential_version=a.credential_version WHERE a.id=? AND a.account_id=? AND a.operation=? AND a.expires_at>? AND i.status='ACTIVE' AND i.name='development-validation' AND (i.expires_at IS NULL OR i.expires_at>?) AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE environment='development'))`,
      )
      .bind(
        actor.accountId,
        claim[0],
        id,
        actor.automationAuthorizationId,
        actor.accountId,
        operation,
        new Date().toISOString(),
        new Date().toISOString(),
      ),
  ];
}
