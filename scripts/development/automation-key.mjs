import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { v7 as newId } from "uuid";
import { pathToFileURL } from "node:url";
import { secretService, validateCredential } from "./automation-client.mjs";

function capturedCommand(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pnpm",
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error)
          reject(new Error("Development automation provisioning failed."));
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function provisionCredential(metadata, dependencies = {}) {
  const bridge = dependencies.secretService ?? secretService;
  const command = dependencies.command ?? capturedCommand;
  try {
    const existing = JSON.parse(await bridge("lookup-optional"));
    const credential =
      existing === null
        ? validateCredential({
            keyId: metadata.keyId,
            version: metadata.version,
            secret: randomBytes(32).toString("base64url"),
          })
        : validateCredential(existing);
    if (
      credential.keyId !== metadata.keyId ||
      credential.version !== metadata.version
    )
      throw new Error();
    const serialized = JSON.stringify(credential);
    await bridge("store", serialized);
    await command(
      [
        "exec",
        "wrangler",
        "secret",
        "put",
        "DEVELOPMENT_AUTOMATION_CREDENTIAL",
        "--config",
        "apps/api/wrangler.jsonc",
        "--env",
        "development",
      ],
      serialized,
    );
  } catch {
    throw new Error("Development automation provisioning failed.");
  }
}
const environmentGuard =
  "EXISTS (SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development')";
function validateMetadata(metadata) {
  validateCredential({
    keyId: metadata.keyId,
    version: metadata.version,
    secret: Buffer.alloc(32).toString("base64url"),
  });
  validateCredential({
    keyId: metadata.accountId,
    version: metadata.version,
    secret: Buffer.alloc(32).toString("base64url"),
  });
  if (
    !Number.isSafeInteger(metadata.version + 1) ||
    !["ACTIVE", "REVOKED"].includes(metadata.status) ||
    !Number.isFinite(Date.parse(metadata.expiresAt))
  )
    throw new Error();
  return metadata;
}
export function buildLifecycleSql(metadata, operation, requestId = newId()) {
  validateMetadata(metadata);
  if (
    !["rotate", "revoke"].includes(operation) ||
    !/^[0-9a-f-]{36}$/i.test(requestId)
  )
    throw new Error("Development automation provisioning failed.");
  const event =
    operation === "rotate"
      ? "DEVELOPMENT_AUTOMATION_ROTATED"
      : "DEVELOPMENT_AUTOMATION_REVOKED";
  const auditId = newId(),
    securityId = newId();
  const mutation =
    operation === "rotate"
      ? `credential_version=${metadata.version + 1},status='ACTIVE',expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 days')`
      : "status='REVOKED'";
  const active = operation === "revoke" ? " AND status='ACTIVE'" : "";
  return `UPDATE development_automation_identities SET ${mutation} WHERE name='development-validation' AND key_id='${metadata.keyId}' AND account_id='${metadata.accountId}' AND credential_version=${metadata.version} AND status='${metadata.status}' AND expires_at='${metadata.expiresAt.replaceAll("'", "''")}'${active} AND ${environmentGuard}; INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason) SELECT '${auditId}','${metadata.accountId}','${event}','development_automation_identity','${metadata.keyId}','${requestId}','Owner-directed Development automation lifecycle' WHERE changes()=1; INSERT INTO governance_security_events(id,actor_id,code,request_id) SELECT '${securityId}','${metadata.accountId}','${event}','${requestId}' WHERE EXISTS(SELECT 1 FROM governance_audit_events WHERE id='${auditId}'); SELECT COUNT(*) AS changed FROM governance_security_events WHERE id='${securityId}';`;
}
function d1Arguments(sql) {
  return [
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
  ];
}
async function executeD1(sql, command = capturedCommand) {
  const parsed = JSON.parse(await command(d1Arguments(sql)));
  if (
    !Array.isArray(parsed) ||
    parsed.some((result) => result.success !== true)
  )
    throw new Error();
  return parsed.flatMap((result) => result.results ?? []);
}
export async function rotateCredential(metadata, dependencies = {}) {
  const bridge = dependencies.secretService ?? secretService;
  const command = dependencies.command ?? capturedCommand;
  try {
    validateMetadata(metadata);
    const existing = validateCredential(JSON.parse(await bridge("lookup")));
    if (
      existing.keyId !== metadata.keyId ||
      ![metadata.version, metadata.version + 1].includes(existing.version) ||
      !Number.isSafeInteger(metadata.version + 1)
    )
      throw new Error();
    const credential =
      existing.version === metadata.version + 1
        ? existing
        : validateCredential({
            keyId: metadata.keyId,
            version: metadata.version + 1,
            secret: randomBytes(32).toString("base64url"),
          });
    await bridge("store", JSON.stringify(credential));
    const rows = await executeD1(
      buildLifecycleSql(metadata, "rotate"),
      command,
    );
    if (rows.length !== 1 || rows[0].changed !== 1) throw new Error();
    await provisionCredential(
      { keyId: credential.keyId, version: credential.version },
      { secretService: bridge, command },
    );
  } catch {
    throw new Error("Development automation provisioning failed.");
  }
}
export async function revokeCredential(metadata, dependencies = {}) {
  try {
    validateMetadata(metadata);
    if (metadata.status !== "ACTIVE") throw new Error();
    const rows = await executeD1(
      buildLifecycleSql(metadata, "revoke"),
      dependencies.command ?? capturedCommand,
    );
    if (rows.length !== 1 || rows[0].changed !== 1) throw new Error();
  } catch {
    throw new Error("Development automation provisioning failed.");
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && !["--rotate", "--revoke"].includes(args[0])) ||
    [
      "DEVELOPMENT_AUTOMATION_CREDENTIAL",
      "MOTORBALDI_AUTOMATION_SECRET",
      "MOTORBALDI_AUTOMATION_CREDENTIAL",
    ].some((name) => process.env[name] !== undefined)
  )
    throw new Error();
  const activeOnly =
    args.length === 0
      ? " AND status='ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      : "";
  const rows = await executeD1(
    `SELECT key_id AS keyId,credential_version AS version,account_id AS accountId,status,expires_at AS expiresAt FROM development_automation_identities WHERE name='development-validation'${activeOnly} AND ${environmentGuard};`,
  );
  if (rows.length !== 1) throw new Error();
  validateMetadata(rows[0]);
  if (args[0] === "--rotate") await rotateCredential(rows[0]);
  else if (args[0] === "--revoke") await revokeCredential(rows[0]);
  else await provisionCredential(rows[0]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then(() =>
      process.stdout.write("Development automation lifecycle completed.\n"),
    )
    .catch(() => {
      process.stderr.write("Development automation provisioning failed.\n");
      process.exitCode = 1;
    });
}
