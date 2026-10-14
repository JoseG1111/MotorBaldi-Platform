/** Development-only synthetic D1 cron/Queue probe; creates no sessions/credentials/payment/privileged roles.
 * It is infrastructure evidence, never proof of an authenticated customer or human MFA journey.
 */
import { v7 as newId } from "uuid";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
const execute = promisify(execFile);
const root = ".local/qa/vehicle-reminder-remote";
await mkdir(root, { recursive: true });
const fixture = Object.fromEntries(
  [
    "account",
    "person",
    "vehicle",
    "contact",
    "preference",
    "grant",
    "relationship",
    "soat",
    "rtm",
  ].map((name) => [name, newId()]),
);
const calendar = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const expiry = (days) =>
  new Date(Date.parse(calendar + "T00:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
await writeFile(
  root + "/fixture.json",
  JSON.stringify({ ...fixture, calendar }),
);
async function sql(command) {
  const { stdout } = await execute(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "motorbaldi-core-dev",
      "--remote",
      "--env",
      "development",
      "--config",
      "apps/api/wrangler.jsonc",
      "--command",
      command,
      "--json",
    ],
    { timeout: 60000, maxBuffer: 2000000 },
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.some((item) => !item.success))
    throw new Error("D1_PROBE_FAILED");
  return result.flatMap((item) => item.results ?? []);
}
let seeded = false;
try {
  const identity = await sql(
    "SELECT environment FROM governance_environment_metadata WHERE singleton=1",
  );
  if (identity[0]?.environment !== "development")
    throw new Error("WRONG_ENVIRONMENT");
  // No verified human identity is simulated: no password, credential, session or staff role exists.
  seeded = true;
  await sql(`
    INSERT INTO auth_users(id,name,email,email_verified) VALUES('${fixture.account}','Synthetic reminder cron QA','${fixture.account}@example.test',0);
    INSERT INTO iam_people(id,status,given_name,family_name) VALUES('${fixture.person}','ACTIVE','Synthetic','Reminder QA');
    INSERT INTO iam_accounts(id,person_id) VALUES('${fixture.account}','${fixture.person}');
    INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,verified_at,source) VALUES('${fixture.contact}','${fixture.person}','EMAIL','${fixture.account}@example.test','${fixture.account}@example.test','VERIFIED',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'DEVELOPMENT_SYNTHETIC_FIXTURE');
    INSERT INTO vehicle_vehicles(id,kind_code,specification_json) VALUES('${fixture.vehicle}','CAR','{"make":"Synthetic QA","model":"Reminder cron"}');
    INSERT INTO vehicle_relationships(id,vehicle_id,relationship_type,person_id) VALUES('${fixture.relationship}','${fixture.vehicle}','OWNER','${fixture.person}');
    INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES('${fixture.grant}','${fixture.vehicle}','${fixture.person}','vehicle.read','${fixture.account}');
    INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id) VALUES('${fixture.preference}','${fixture.account}','TRANSACTIONAL','EMAIL',1,'${fixture.contact}');
    INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,information_source,verification_status,recorded_by_account_id) VALUES('${fixture.soat}','${fixture.vehicle}','SOAT','${expiry(15)}','USER_ENTERED','USER_ENTERED','${fixture.account}');
    INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,information_source,verification_status,recorded_by_account_id) VALUES('${fixture.rtm}','${fixture.vehicle}','RTM','${expiry(30)}','USER_ENTERED','USER_ENTERED','${fixture.account}');
    INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id,reason) VALUES('${newId()}','qa.reminder.fixture.created','qa_fixture','${fixture.vehicle}','${newId()}','Development synthetic cron/Queue test; no application session or verified human action');
  `);
  process.stdout.write(
    "Synthetic fixture seeded; waiting for actual Development cron and Queue.\n",
  );
  const deadline = Date.now() + 12 * 60000;
  let lastState = "";
  while (Date.now() < deadline) {
    const rows = await sql(
      `SELECT r.days_before,r.status,r.reason_code,e.status AS outbox_status FROM notification_vehicle_reminders r JOIN integration_outbox_events e ON e.id=r.source_event_id WHERE r.account_id='${fixture.account}' ORDER BY r.days_before`,
    );
    if (rows.length > 1 || rows.some((row) => row.days_before !== 15))
      throw new Error("FREE_SCHEDULE_VIOLATION");
    const state = rows[0]
      ? `${rows[0].status}/${rows[0].outbox_status}`
      : "AWAITING_CRON";
    if (state !== lastState) {
      process.stdout.write(`Observed ${state}\n`);
      lastState = state;
    }
    if (
      rows[0]?.status === "UNAVAILABLE" &&
      rows[0].reason_code === "TRANSPORT_UNAVAILABLE" &&
      rows[0].outbox_status === "PROCESSED"
    ) {
      await writeFile(
        root + "/evidence.json",
        JSON.stringify({
          calendar,
          freeEmail15: true,
          freeEmail30Rejected: true,
          disposition: rows[0],
          authenticatedCustomerVerified: false,
          externalDeliveryVerified: false,
        }),
      );
      process.stdout.write(
        "PASS actual cron + canonical reminder + Queue processing; unavailable transport accurately recorded.\n",
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
  if (lastState !== "UNAVAILABLE/PROCESSED")
    throw new Error("CRON_QUEUE_VERIFICATION_TIMEOUT");
} catch (error) {
  await writeFile(
    root + "/diagnostic.txt",
    String(error.stdout || error.stderr || error.message || "UNKNOWN"),
  );
  process.stderr.write(
    `FAIL ${["WRONG_ENVIRONMENT", "FREE_SCHEDULE_VIOLATION", "CRON_QUEUE_VERIFICATION_TIMEOUT"].includes(error.message) ? error.message : "DEVELOPMENT_REMINDER_PROBE_FAILED"}\n`,
  );
  process.exitCode = 1;
} finally {
  if (seeded) {
    try {
      await sql(`UPDATE notification_preferences SET enabled=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${fixture.preference}' AND enabled=1;
        UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${fixture.grant}' AND revoked_at IS NULL;
        UPDATE vehicle_relationships SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${fixture.relationship}' AND ended_at IS NULL;
        UPDATE iam_accounts SET status='SUSPENDED' WHERE id='${fixture.account}';
        INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id,reason) VALUES('${newId()}','qa.reminder.fixture.disabled','qa_fixture','${fixture.vehicle}','${newId()}','Synthetic preferences disabled, grants revoked and account suspended; immutable history retained');`);
      process.stdout.write(
        "Fixture disabled; immutable audit/history retained.\n",
      );
    } catch {
      process.stderr.write(
        "FAIL FIXTURE_CLEANUP_REQUIRES_RECOVERY: manifest retained in .local/qa/vehicle-reminder-remote/fixture.json\n",
      );
      process.exitCode = 1;
    }
  }
}
