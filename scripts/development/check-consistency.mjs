import { assessAutomationConsistency } from "./consistency-result.mjs";
import { execFile } from "node:child_process";
const sql = `SELECT environment FROM governance_environment_metadata WHERE singleton=1;
SELECT count(*) AS active_identities FROM development_automation_identities i JOIN iam_accounts a ON a.id=i.account_id JOIN auth_users u ON u.id=a.id WHERE i.name='development-validation' AND i.status='ACTIVE' AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.status='ACTIVE' AND u.two_factor_enabled=0;
SELECT count(*) AS forbidden_human_credentials FROM development_automation_identities i WHERE EXISTS(SELECT 1 FROM auth_credentials c WHERE c.user_id=i.account_id) OR EXISTS(SELECT 1 FROM auth_sessions c WHERE c.user_id=i.account_id) OR EXISTS(SELECT 1 FROM auth_two_factors c WHERE c.user_id=i.account_id);
SELECT count(*) AS overbroad_roles FROM development_automation_identities i JOIN iam_accounts a ON a.id=i.account_id WHERE EXISTS(SELECT 1 FROM platform_person_roles p JOIN authz_roles r ON r.id=p.role_id WHERE p.person_id=a.person_id AND r.code<>'DEVELOPMENT_AUTOMATION') OR EXISTS(SELECT 1 FROM org_memberships m JOIN org_membership_roles p ON p.membership_id=m.id JOIN authz_roles r ON r.id=p.role_id WHERE m.person_id=a.person_id AND (m.organization_id<>i.organization_id OR r.code<>'DEVELOPMENT_AUTOMATION' OR m.location_scope_type<>'SELECTED_LOCATIONS'));
SELECT count(*) AS parts_fixtures FROM development_automation_identities i JOIN org_capabilities c ON c.organization_id=i.organization_id AND c.code='PARTS' JOIN org_organizations o ON o.id=i.organization_id JOIN org_locations l ON l.id=i.location_id AND l.organization_id=o.id WHERE o.display_name='MotorBaldi Development Validation Workshop' AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.name='MotorBaldi Development Workshop Site' AND l.status='ACTIVE';
SELECT count(*) AS accepted_security_events FROM governance_security_events s JOIN development_automation_identities i ON i.account_id=s.actor_id WHERE s.code='DEVELOPMENT_AUTOMATION_AUTHENTICATED';
SELECT count(*) AS denied_security_events FROM governance_security_events s JOIN development_automation_identities i ON i.account_id=s.actor_id WHERE s.code='DEVELOPMENT_AUTOMATION_DENIED';
SELECT count(*) AS fixture_processed_events FROM integration_outbox_events e JOIN governance_audit_events a ON a.request_id=e.request_id AND a.resource_id=e.aggregate_id JOIN development_automation_identities i ON i.account_id=a.actor_id WHERE e.event_type='development.fixture.parts.enabled.v1' AND e.aggregate_type='development_automation' AND e.status='PROCESSED' AND a.action='development.fixture.parts.enabled' AND i.organization_id=e.aggregate_id;
SELECT count(*) AS unprocessed_events FROM integration_outbox_events WHERE status<>'PROCESSED';
SELECT count(*) AS active_temporary_grants FROM vehicle_access_grants g JOIN development_automation_resources r ON r.resource_type='grant' AND r.resource_id=g.id WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'));
SELECT count(*) AS missing_synthetic_resources FROM development_automation_resources r WHERE (r.resource_type='canonical' AND NOT EXISTS(SELECT 1 FROM parts_canonical t WHERE t.id=r.resource_id)) OR (r.resource_type='offering' AND NOT EXISTS(SELECT 1 FROM parts_offerings t WHERE t.id=r.resource_id)) OR (r.resource_type='vehicle' AND NOT EXISTS(SELECT 1 FROM vehicle_vehicles t WHERE t.id=r.resource_id)) OR (r.resource_type='order' AND NOT EXISTS(SELECT 1 FROM workshop_orders t WHERE t.id=r.resource_id)) OR (r.resource_type='snapshot' AND NOT EXISTS(SELECT 1 FROM parts_workshop_snapshots t WHERE t.id=r.resource_id)) OR (r.resource_type='grant' AND NOT EXISTS(SELECT 1 FROM vehicle_access_grants t WHERE t.id=r.resource_id));
SELECT count(*) AS foreign_key_violations FROM pragma_foreign_key_check;`;
function query() {
  return new Promise((resolve, reject) =>
    execFile(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "motorbaldi-core-dev",
        "--remote",
        "--config",
        "apps/api/wrangler.jsonc",
        "--env",
        "development",
        "--command",
        sql,
        "--json",
      ],
      { encoding: "utf8", maxBuffer: 1048576, timeout: 60000 },
      (error, out) => {
        if (error) reject(new Error());
        else resolve(out);
      },
    ),
  );
}
async function main() {
  if (process.argv.length !== 2) throw new Error();
  process.stdout.write(
    assessAutomationConsistency(JSON.parse(await query())) + "\n",
  );
}
main().catch((error) => {
  const codes = new Set([
    "CONSISTENCY_CHECK_UNAVAILABLE",
    "DATABASE_ENVIRONMENT_MISMATCH",
    "AUTOMATION_CONSISTENCY_FAILED",
    "AUTOMATION_EVENTS_PENDING",
    "AUTOMATION_EVIDENCE_REQUIRED",
  ]);
  const code = codes.has(error?.message)
    ? error.message
    : "CONSISTENCY_CHECK_UNAVAILABLE";
  process.stderr.write(
    `FAIL step=automation-d1-queue-consistency code=${code}\n`,
  );
  process.exitCode = 1;
});
