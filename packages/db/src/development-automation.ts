import { Problem, type Principal } from "@motorbaldi/contracts";
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
/** Distinct machine assurance. Never represents a human second factor. */
export function developmentAutomationPredicate(
  actor: string,
  operation?: string,
) {
  return `EXISTS(SELECT 1 FROM development_automation_identities dai JOIN development_automation_authorizations daa ON daa.account_id=dai.account_id AND daa.credential_version=dai.credential_version JOIN iam_accounts ma ON ma.id=dai.account_id JOIN iam_people mp ON mp.id=ma.person_id JOIN org_organizations mo ON mo.id=dai.organization_id JOIN org_locations ml ON ml.organization_id=mo.id AND ml.id=dai.location_id WHERE dai.account_id=${actor} AND dai.status='ACTIVE' AND dai.expires_at>${now} AND daa.expires_at>${now} AND ma.status='ACTIVE' AND mp.status='ACTIVE' AND mo.status='ACTIVE' AND mo.verification_status='VERIFIED' AND mo.display_name='MotorBaldi Development Validation Workshop' AND ml.status='ACTIVE' AND ml.name='MotorBaldi Development Workshop Site' AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development') ${operation ? `AND daa.operation=${operation}` : ""})`;
}
export async function hasDevelopmentAutomationAssurance(
  db: D1Database,
  actor: Principal,
) {
  if (!actor.automationAuthorizationId) return false;
  return !!(await db
    .prepare(
      `SELECT 1 FROM development_automation_authorizations context WHERE context.id=? AND context.account_id=? AND context.expires_at>${now} AND ${developmentAutomationPredicate("context.account_id")} AND EXISTS(SELECT 1 FROM development_automation_identities i WHERE i.account_id=context.account_id AND i.credential_version=context.credential_version)`,
    )
    .bind(actor.automationAuthorizationId, actor.accountId)
    .first());
}
export async function requireDevelopmentAutomationAssurance(
  db: D1Database,
  actor: Principal,
) {
  if (!(await hasDevelopmentAutomationAssurance(db, actor)))
    throw new Problem(
      403,
      "DEVELOPMENT_AUTOMATION_DENIED",
      "Development automation unavailable",
    );
}
