import { execFile } from "node:child_process";
import { v7 as newId } from "uuid";
function query(sql) {
  return new Promise((resolve, reject) => {
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
        "--json",
        "--command",
        sql,
      ],
      { encoding: "utf8", maxBuffer: 1048576 },
      (error, output) => {
        try {
          if (error) throw error;
          const results = JSON.parse(output);
          if (results.some((r) => r.success !== true)) throw new Error();
          resolve(results.flatMap((r) => r.results ?? []));
        } catch {
          reject(new Error("Development automation bootstrap unavailable."));
        }
      },
    );
  });
}
async function main() {
  if (process.argv.length !== 2) throw new Error();
  const fixtures = await query(
    "SELECT o.id AS organizationId,l.id AS locationId FROM org_organizations o JOIN org_locations l ON l.organization_id=o.id WHERE o.display_name='MotorBaldi Development Validation Workshop' AND o.type='WORKSHOP' AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.name='MotorBaldi Development Workshop Site' AND l.status='ACTIVE' AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development');",
  );
  if (fixtures.length !== 1) throw new Error();
  const fixture = fixtures[0];
  if (
    ![fixture.organizationId, fixture.locationId].every((id) =>
      /^[0-9a-f-]{36}$/.test(id),
    )
  )
    throw new Error();
  const existing = await query(
    "SELECT count(*) AS count FROM development_automation_identities WHERE name='development-validation';",
  );
  if (existing[0]?.count === 1) {
    process.stdout.write("Development automation identity already exists.\n");
    return;
  }
  if (existing[0]?.count !== 0) throw new Error();
  const account = newId(),
    person = newId(),
    key = newId(),
    membership = newId(),
    requestId = newId();
  await query(`INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES('${account}','Development Validation Automation','automation-${account}@development.invalid',1,0);
 INSERT INTO iam_people(id,status,given_name,family_name) VALUES('${person}','ACTIVE','Development','Automation');
 INSERT INTO iam_accounts(id,person_id,status) VALUES('${account}','${person}','ACTIVE');
 INSERT INTO development_automation_identities(key_id,name,account_id,credential_version,status,organization_id,location_id,expires_at) VALUES('${key}','development-validation','${account}',1,'ACTIVE','${fixture.organizationId}','${fixture.locationId}',strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days'));
 INSERT INTO platform_person_roles(person_id,role_id,assigned_by_person_id) VALUES('${person}','platform-development-automation','${person}');
 INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES('${membership}','${fixture.organizationId}','${person}','SELECTED_LOCATIONS');
 INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES('${membership}','${fixture.organizationId}','${fixture.locationId}');
 INSERT INTO org_membership_roles(membership_id,role_id) VALUES('${membership}','org-development-automation');
 INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,organization_id,reason) VALUES('${newId()}','${account}','development.automation.provisioned','development_automation','${account}','${requestId}','${fixture.organizationId}','Owner-authorized dedicated synthetic Development validation identity');
 INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES('${newId()}','DEVELOPMENT_AUTOMATION_PROVISIONED','${account}','${requestId}');`);
  process.stdout.write("Development automation identity provisioned.\n");
}
main().catch(() => {
  process.stderr.write("Development automation bootstrap unavailable.\n");
  process.exitCode = 1;
});
