import { Problem, type Principal } from "@motorbaldi/contracts";
export type PartsActor = Principal & { personId: string };

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export function partsStaffPredicate(actor: string) {
  return `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN platform_person_roles pr ON pr.person_id=p.id JOIN authz_roles r ON r.id=pr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=${actor} AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND r.scope='PLATFORM' AND r.code IN ('PLATFORM_SUPERADMIN','CATALOG_ADMIN') AND rp.permission_code='platform.catalog.manage')`;
}
export function partsOfferingPredicate(
  actor: string,
  org: string,
  location: string,
) {
  return `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN org_memberships m ON m.person_id=p.id JOIN org_organizations o ON o.id=m.organization_id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE a.id=${actor} AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1) AND o.id=${org} AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND m.status='ACTIVE' AND m.valid_from<=${now} AND (m.valid_to IS NULL OR m.valid_to>${now}) AND r.scope='ORGANIZATION' AND r.code IN ('OWNER','ADMIN') AND rp.permission_code='org.parts.manage' AND ((${location} IS NULL AND m.location_scope_type='ALL_LOCATIONS') OR (${location} IS NOT NULL AND EXISTS(SELECT 1 FROM org_locations l WHERE l.id=${location} AND l.organization_id=o.id AND l.status='ACTIVE') AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=${location})))) AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='PARTS') OR (${location} IS NOT NULL AND EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=${location} AND c.code='PARTS'))))`;
}
export async function requirePartsActor(db: D1Database, actor: PartsActor) {
  if (!actor.mfaEnabled)
    throw new Problem(
      403,
      "MFA_REQUIRED",
      "Assured multi-factor authentication required",
    );
  if (
    !(await db
      .prepare(
        "SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
      )
      .bind(actor.accountId, actor.personId)
      .first())
  )
    throw new Problem(403, "FORBIDDEN", "Access denied");
}
export async function requirePartsStaff(db: D1Database, actor: PartsActor) {
  await requirePartsActor(db, actor);
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${partsStaffPredicate("?")}`)
      .bind(actor.accountId)
      .first())
  )
    throw new Problem(403, "FORBIDDEN", "Access denied");
}
export async function requirePartsOfferingScope(
  db: D1Database,
  actor: PartsActor,
  organizationId: string,
  locationId: string | null,
) {
  await requirePartsActor(db, actor);
  // A one-row input relation prevents repeating untrusted values in SQL text.
  const row = await db
    .prepare(
      `SELECT 1 FROM (SELECT ? AS actor,? AS organization,? AS location) scope WHERE ${partsOfferingPredicate("scope.actor", "scope.organization", "scope.location")}`,
    )
    .bind(actor.accountId, organizationId, locationId)
    .first();
  if (!row)
    throw new Problem(404, "PARTS_NOT_FOUND", "Parts scope unavailable");
}
