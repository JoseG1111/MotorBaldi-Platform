import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  auditStatement,
  outboxStatement,
  requireDevelopmentAutomationAssurance,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import { z } from "zod";
export function automationCommitGuard(
  db: D1Database,
  actor: Principal,
  operation: string,
  requestId: string,
) {
  return db
    .prepare(
      `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) SELECT ?,?,'development.automation.command.authorized','development_automation',CASE WHEN EXISTS(SELECT 1 FROM development_automation_authorizations a JOIN development_automation_identities i ON i.account_id=a.account_id AND i.credential_version=a.credential_version JOIN iam_accounts ma ON ma.id=i.account_id JOIN iam_people mp ON mp.id=ma.person_id JOIN org_organizations o ON o.id=i.organization_id JOIN org_locations l ON l.id=i.location_id AND l.organization_id=o.id WHERE a.id=? AND a.account_id=? AND a.operation=? AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND i.status='ACTIVE' AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ma.status='ACTIVE' AND mp.status='ACTIVE' AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND o.display_name='MotorBaldi Development Validation Workshop' AND l.status='ACTIVE' AND l.name='MotorBaldi Development Workshop Site' AND EXISTS(SELECT 1 FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id JOIN org_membership_locations ml ON ml.membership_id=m.id AND ml.organization_id=m.organization_id AND ml.location_id=i.location_id WHERE m.person_id=ma.person_id AND m.organization_id=i.organization_id AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND m.location_scope_type='SELECTED_LOCATIONS' AND r.scope='ORGANIZATION' AND r.code='DEVELOPMENT_AUTOMATION' AND rp.permission_code=CASE WHEN a.operation LIKE 'workshop.%' OR a.operation='parts.workshop.snapshot.add' THEN 'org.workshop.manage' WHEN a.operation LIKE 'parts.offering.%' OR a.operation='development.fixture.parts.enable' THEN 'org.parts.manage' ELSE 'org.read' END) AND (a.operation NOT LIKE 'vehicle.%' AND a.operation NOT LIKE 'parts.canonical.%' OR EXISTS(SELECT 1 FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE pr.person_id=ma.person_id AND r.scope='PLATFORM' AND r.code='DEVELOPMENT_AUTOMATION' AND rp.permission_code=CASE WHEN a.operation LIKE 'vehicle.%' THEN 'platform.vehicle.manage' ELSE 'platform.catalog.manage' END)) AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development')) THEN ? ELSE NULL END,?`,
    )
    .bind(
      newId(),
      actor.accountId,
      actor.automationAuthorizationId,
      actor.accountId,
      operation,
      actor.accountId,
      requestId,
    );
}
export async function prepareDevelopmentPartsFixture(
  db: D1Database,
  actor: Principal,
  body: Json,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  await requireDevelopmentAutomationAssurance(db, actor);
  const input = z
    .object({
      organizationId: z.uuid(),
      locationId: z.uuid(),
      reason: z.literal("Synthetic Development PARTS fixture enable"),
    })
    .strict()
    .parse(body);
  const row = await db
    .prepare(
      "SELECT 1 FROM development_automation_identities i JOIN org_organizations o ON o.id=i.organization_id JOIN org_locations l ON l.id=i.location_id AND l.organization_id=o.id WHERE i.account_id=? AND i.organization_id=? AND i.location_id=? AND i.status='ACTIVE' AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND o.display_name='MotorBaldi Development Validation Workshop' AND l.status='ACTIVE' AND l.name='MotorBaldi Development Workshop Site'",
    )
    .bind(actor.accountId, input.organizationId, input.locationId)
    .first();
  if (!row)
    throw new Problem(
      403,
      "DEVELOPMENT_AUTOMATION_SCOPE",
      "Automation scope denied",
    );
  const registry = new Map([
    [
      "development.fixture.parts.enabled.v1:1",
      {
        aggregateType: "development_automation",
        version: 1,
        payload: z
          .object({ organizationId: z.uuid(), locationId: z.uuid() })
          .strict(),
        externalEffect: "IDEMPOTENT" as const,
      },
    ],
  ]);
  return {
    response: {
      enabled: true,
      organizationId: input.organizationId,
      locationId: input.locationId,
    },
    statements: [
      db
        .prepare(
          "INSERT OR IGNORE INTO org_capabilities(organization_id,code) VALUES(?,'PARTS')",
        )
        .bind(input.organizationId),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "development.fixture.parts.enabled",
        resourceType: "organization",
        resourceId: input.organizationId,
        organizationId: input.organizationId,
        requestId,
        reason: input.reason,
      }),
      outboxStatement(
        db,
        {
          aggregateType: "development_automation",
          aggregateId: input.organizationId,
          eventType: "development.fixture.parts.enabled.v1",
          eventVersion: 1,
          payload: {
            organizationId: input.organizationId,
            locationId: input.locationId,
          },
          requestId,
          externalEffectPolicy: "IDEMPOTENT",
        },
        registry,
      ).statement,
    ],
  };
}
