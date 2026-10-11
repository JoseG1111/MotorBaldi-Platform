import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  hasDevelopmentAutomationAssurance,
  auditStatement,
} from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";
export interface Actor {
  accountId: string;
  personId: string | null;
  active: boolean;
  permissions: ReadonlySet<string>;
}
export interface Resource {
  type: string;
  id: string;
  organizationId?: string;
}
export interface Context {
  requestId: string;
  now: Date;
  organizationId?: string;
}
export type Policy = (
  actor: Actor,
  resource: Resource,
  context: Context,
) => boolean;
export function authorization(
  policies: ReadonlyMap<string, Policy> = new Map(),
) {
  const registered = new Map(policies);
  return {
    can(
      actor: Actor | null,
      action: string,
      resource: Resource,
      context: Context,
    ): boolean {
      if (!actor?.active || !actor.permissions.has(action)) return false;
      const policy = registered.get(action);
      if (!policy) return false;
      try {
        return policy(actor, resource, context) === true;
      } catch {
        return false;
      }
    },
  };
}
export const { can } = authorization();

export async function requirePlatformPermission(
  db: D1Database,
  principal: Principal & { personId: string },
  permission: string,
  options: { mfa?: boolean } = {},
) {
  const grant = await db
    .prepare(
      "SELECT 1 FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id AND r.scope='PLATFORM' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE pr.person_id=? AND rp.permission_code=? LIMIT 1",
    )
    .bind(principal.personId, permission)
    .first();
  if (!grant) throw new Problem(403, "FORBIDDEN", "Access denied");
  if (
    options.mfa &&
    !principal.mfaEnabled &&
    !(await hasDevelopmentAutomationAssurance(db, principal))
  )
    throw new Problem(
      403,
      "MFA_REQUIRED",
      "Multi-factor authentication required",
    );
}

export async function requireOrganizationPermission(
  db: D1Database,
  principal: Principal & { personId: string },
  organizationId: string,
  permission: string,
  locationId?: string,
) {
  const row = await db
    .prepare(
      "SELECT m.id,m.location_scope_type,o.status FROM org_memberships m JOIN org_organizations o ON o.id=m.organization_id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE m.person_id=? AND m.organization_id=? AND m.status='ACTIVE' AND rp.permission_code=? LIMIT 1",
    )
    .bind(principal.personId, organizationId, permission)
    .first<{ id: string; location_scope_type: string; status: string }>();
  if (!row || row.status !== "ACTIVE")
    throw new Problem(403, "FORBIDDEN", "Access denied");
  if (locationId && row.location_scope_type === "SELECTED_LOCATIONS") {
    const allowed = await db
      .prepare(
        "SELECT 1 FROM org_membership_locations WHERE membership_id=? AND organization_id=? AND location_id=?",
      )
      .bind(row.id, organizationId, locationId)
      .first();
    if (!allowed) throw new Problem(403, "FORBIDDEN", "Access denied");
  }
  return row.id;
}

export const platformRoleCodes = [
  "PLATFORM_SUPERADMIN",
  "OPERATIONS_ADMIN",
  "VERIFICATION_AGENT",
  "SUPPORT_AGENT",
  "FINANCE_ADMIN",
  "CRM_AGENT",
  "CATALOG_ADMIN",
  "AUDITOR",
] as const;

export async function assignPlatformRoles(
  db: D1Database,
  actor: Principal & { personId: string },
  targetPersonId: string,
  roles: string[],
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.roles.manage", {
    mfa: true,
  });
  if (
    !reason.trim() ||
    roles.length > platformRoleCodes.length ||
    new Set(roles).size !== roles.length ||
    roles.some(
      (role) =>
        !platformRoleCodes.includes(role as (typeof platformRoleCodes)[number]),
    )
  )
    throw new Problem(400, "INVALID_PLATFORM_ROLES", "Invalid role assignment");
  const target = await db
    .prepare(
      "SELECT 1 FROM iam_accounts a JOIN auth_users u ON u.id=a.id JOIN iam_people p ON p.id=a.person_id WHERE a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 LIMIT 1",
    )
    .bind(targetPersonId)
    .first();
  if (!target)
    throw new Problem(404, "PERSON_NOT_FOUND", "Verified account required");
  try {
    await db.batch([
      ...roles.map((role) =>
        db
          .prepare(
            "INSERT INTO platform_person_roles(person_id,role_id,assigned_by_person_id) SELECT ?,id,? FROM authz_roles WHERE scope='PLATFORM' AND code=? ON CONFLICT(person_id,role_id) DO NOTHING",
          )
          .bind(targetPersonId, actor.personId, role),
      ),
      db
        .prepare(
          `DELETE FROM platform_person_roles WHERE person_id=? AND role_id NOT IN (SELECT id FROM authz_roles WHERE scope='PLATFORM' ${roles.length ? `AND code IN (${roles.map(() => "?").join(",")})` : "AND 0"})`,
        )
        .bind(targetPersonId, ...roles),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "platform.roles.assigned",
        resourceType: "iam_person",
        resourceId: targetPersonId,
        reason,
        requestId,
      }),
      db
        .prepare(
          "INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES(?,'PLATFORM_ROLES_CHANGED',?,?)",
        )
        .bind(newId(), actor.accountId, requestId),
    ]);
  } catch (error) {
    if (String(error).includes("LAST_PLATFORM_SUPERADMIN_REQUIRED"))
      throw new Problem(
        409,
        "LAST_PLATFORM_SUPERADMIN_REQUIRED",
        "At least one super administrator required",
      );
    throw error;
  }
}
