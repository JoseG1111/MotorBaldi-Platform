import type { Principal } from "@motorbaldi/contracts";
import { Problem } from "@motorbaldi/contracts";
import { hasVehiclePermission } from "@motorbaldi/vehicles";

export type WorkshopActor = Principal & { personId: string };
export type WorkshopContext = {
  vehicleId: string;
  organizationId: string;
  locationId: string;
};
export async function requireWorkshopPermission(
  db: D1Database,
  actor: WorkshopActor,
  context: WorkshopContext,
  permission: string,
  write = false,
) {
  const { vehicleId, organizationId, locationId } = context;
  const row = await db
    .prepare(
      `SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN org_memberships m ON m.person_id=p.id JOIN org_organizations o ON o.id=m.organization_id JOIN org_locations l ON l.organization_id=o.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_role_permissions rp ON rp.role_id=mr.role_id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION'
 WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND o.id=? AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.id=? AND l.status='ACTIVE' AND m.status='ACTIVE'
 AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code=?
 AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=l.id))
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK')) OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK'))) LIMIT 1`,
    )
    .bind(
      actor.accountId,
      actor.personId,
      organizationId,
      locationId,
      permission,
    )
    .first();
  if (
    !row ||
    !(await hasVehiclePermission(
      db,
      actor,
      vehicleId,
      write ? "vehicle.workshop.write" : "vehicle.workshop.read",
      context,
    ))
  )
    throw new Problem(404, "WORKSHOP_NOT_FOUND", "Workshop order not found");
}
export async function requireWorkshopAssignee(
  db: D1Database,
  personId: string,
  context: WorkshopContext,
) {
  const row = await db
    .prepare(
      `SELECT 1 FROM iam_people p JOIN org_memberships m ON m.person_id=p.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE p.id=? AND p.status='ACTIVE' AND m.organization_id=? AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code='org.workshop.execute' AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=m.organization_id AND ml.location_id=?)) LIMIT 1`,
    )
    .bind(personId, context.organizationId, context.locationId)
    .first();
  if (!row)
    throw new Problem(
      400,
      "INVALID_WORKSHOP_ASSIGNEE",
      "Active location-scoped workshop executor required",
    );
}

export async function listWorkshopLocations(
  db: D1Database,
  actor: WorkshopActor,
  organizationId: string,
  permission = "org.workshop.read",
) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT l.id,l.name FROM org_locations l JOIN org_organizations o ON o.id=l.organization_id JOIN org_memberships m ON m.organization_id=o.id JOIN iam_people p ON p.id=m.person_id JOIN iam_accounts a ON a.person_id=p.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' JOIN authz_role_permissions rp ON rp.role_id=r.id
 WHERE o.id=? AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.status='ACTIVE' AND p.id=? AND a.id=? AND p.status='ACTIVE' AND a.status='ACTIVE' AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code=?
 AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=l.id))
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK')) OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK'))) ORDER BY l.id LIMIT 50`,
    )
    .bind(organizationId, actor.personId, actor.accountId, permission)
    .all<{ id: string; name: string }>();
  return rows.results;
}
