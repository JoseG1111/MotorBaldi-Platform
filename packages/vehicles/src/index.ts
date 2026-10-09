export type VehicleActor = { accountId: string; personId: string };

/** Claims, relationships, identifiers, and garage entries never imply access. */
export async function hasVehiclePermission(
  db: D1Database,
  actor: VehicleActor,
  vehicleId: string,
  permissionCode: string,
  resourceContext?: { organizationId: string; locationId: string | null },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS allowed
       FROM iam_accounts a
       JOIN iam_people p ON p.id=a.person_id
       WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE'
         AND EXISTS (
           SELECT 1 FROM vehicle_access_grants g
           WHERE g.vehicle_id=? AND g.permission_code=?
             AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             AND g.revoked_at IS NULL
             AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             AND (? IS NULL OR g.person_id=p.id OR (g.organization_id=? AND (g.location_id IS NULL OR g.location_id IS ?)))
             AND (
               g.person_id=p.id
               OR (
                 g.organization_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM org_memberships m
                   JOIN org_organizations o ON o.id=m.organization_id
                   WHERE m.person_id=p.id AND m.organization_id=g.organization_id
                     AND m.status='ACTIVE' AND o.status='ACTIVE'
                     AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     AND (
                       g.location_id IS NULL
                       OR (
                         m.location_scope_type='ALL_LOCATIONS'
                         AND EXISTS (
                           SELECT 1 FROM org_locations l
                           WHERE l.id=g.location_id AND l.organization_id=g.organization_id
                             AND l.status='ACTIVE'
                         )
                       )
                       OR EXISTS (
                         SELECT 1 FROM org_membership_locations ml
                         JOIN org_locations l ON l.id=ml.location_id AND l.organization_id=ml.organization_id
                         WHERE ml.membership_id=m.id AND ml.organization_id=m.organization_id
                           AND ml.location_id=g.location_id AND l.status='ACTIVE'
                       )
                     )
                 )
               )
             )
         )
       LIMIT 1`,
    )
    .bind(
      actor.accountId,
      actor.personId,
      vehicleId,
      permissionCode,
      resourceContext?.organizationId ?? null,
      resourceContext?.organizationId ?? null,
      resourceContext?.locationId ?? null,
    )
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

export * from "./commands.js";
