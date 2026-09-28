import { spawnSync } from "node:child_process";
import { v7 } from "uuid";

const [environment, accountId, reason, execute] = process.argv.slice(2);
if (!(
  ["local", "development", "staging", "production"].includes(environment) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    accountId ?? "",
  ) &&
  typeof reason === "string" &&
  reason.trim().length >= 5 &&
  reason.length <= 1000 &&
  execute === "--execute"
)) {
  throw new Error(
    "Usage: node scripts/phase1/bootstrap-staff.mjs <environment> <existing-verified-account-uuid> <reason> --execute",
  );
}
const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
const requestId = v7();
const account = quoted(accountId);
const identity = `(SELECT a.person_id FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id WHERE a.id=${account} AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND (SELECT environment FROM governance_environment_metadata WHERE singleton=1)=${quoted(environment)})`;
const sql = `INSERT INTO platform_person_roles(person_id,role_id,assigned_by_person_id) VALUES(
  CASE WHEN NOT EXISTS(SELECT 1 FROM platform_person_roles WHERE role_id='platform-superadmin' AND person_id<>${identity}) THEN ${identity} ELSE NULL END,
  'platform-superadmin',${identity}) ON CONFLICT(person_id,role_id) DO NOTHING;
INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason)
SELECT ${quoted(v7())},${account},'platform.superadmin.bootstrapped','iam_person',${identity},${quoted(requestId)},${quoted(reason.trim())}
WHERE EXISTS(SELECT 1 FROM platform_person_roles WHERE person_id=${identity} AND role_id='platform-superadmin')
AND NOT EXISTS(SELECT 1 FROM governance_audit_events WHERE action='platform.superadmin.bootstrapped' AND resource_id=${identity});
INSERT INTO governance_security_events(id,code,actor_id,request_id)
SELECT ${quoted(v7())},'PLATFORM_SUPERADMIN_BOOTSTRAPPED',${account},${quoted(requestId)}
WHERE EXISTS(SELECT 1 FROM governance_audit_events WHERE action='platform.superadmin.bootstrapped' AND request_id=${quoted(requestId)});`;
const args = [
  "exec",
  "wrangler",
  "d1",
  "execute",
  "DB",
  environment === "local" ? "--local" : "--remote",
  "--config",
  "apps/api/wrangler.jsonc",
  "--command",
  sql,
  "--yes",
];
if (environment !== "local") args.push("--env", environment);
const result = spawnSync("pnpm", args, { stdio: "inherit" });
if (result.status !== 0) throw new Error("Platform staff bootstrap failed");
console.log(
  "Platform staff bootstrap command completed; verify the audit and role rows before granting further access.",
);
