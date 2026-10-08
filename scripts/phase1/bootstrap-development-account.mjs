import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { hashPassword } from "better-auth/crypto";
import { v7 } from "uuid";

class OperatorError extends Error {}

export function requireDevelopmentExecution(args) {
  if (args.length !== 2 || args[0] !== "development" || args[1] !== "--execute")
    throw new OperatorError(
      "Usage: node scripts/phase1/bootstrap-development-account.mjs development --execute",
    );
}

export function normalizeBootstrapEmail(value) {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new OperatorError("A valid email address is required.");
  return email;
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;

export function buildBootstrapSql({
  accountId,
  credentialId,
  auditId,
  securityId,
  requestId,
  name,
  email,
  passwordHash,
}) {
  const account = quote(accountId);
  const request = quote(requestId);
  const normalizedEmail = quote(email);
  const eligible = `(SELECT environment FROM governance_environment_metadata WHERE singleton=1)='development'
    AND NOT EXISTS(SELECT 1 FROM auth_users WHERE lower(trim(email))=${normalizedEmail})
    AND NOT EXISTS(SELECT 1 FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id WHERE r.scope='PLATFORM' AND r.code='PLATFORM_SUPERADMIN')`;
  // Wrangler's D1 --file ingestion executes the complete file as one transaction.
  return `INSERT INTO auth_users(id,name,email,email_verified)
VALUES(CASE WHEN ${eligible} THEN ${account} ELSE NULL END,${quote(name)},${normalizedEmail},1);
INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password)
VALUES(${quote(credentialId)},${account},${account},'credential',${quote(passwordHash)});
INSERT INTO iam_signup_consents(auth_user_id,terms_version,privacy_version,request_id)
VALUES(${account},'1','1',${request});
INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id)
VALUES(${quote(auditId)},${account},'identity.development_account.bootstrapped','auth_user',${account},${request});
INSERT INTO governance_security_events(id,code,actor_id,request_id)
VALUES(${quote(securityId)},'DEVELOPMENT_ACCOUNT_BOOTSTRAPPED',${account},${request});`;
}

function readPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    const bytes = [];
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new OperatorError("Cancelled."));
          return;
        }
        if (byte === 10 || byte === 13) {
          cleanup();
          resolve(Buffer.from(bytes).toString("utf8"));
          return;
        }
        if (byte === 8 || byte === 127) {
          bytes.pop();
        } else if (bytes.length < 1024) {
          bytes.push(byte);
        }
      }
    };
    process.stdout.write("Password: ");
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}

function runWrangler(args) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--remote",
      "--env",
      "development",
      "--config",
      "apps/api/wrangler.jsonc",
      "--yes",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new OperatorError(
      "Development D1 check or bootstrap failed; no account UUID was confirmed.",
    );
  return result.stdout;
}

function assertDevelopmentIsEmpty(email) {
  const sql = `SELECT (SELECT environment FROM governance_environment_metadata WHERE singleton=1) AS environment,
    EXISTS(SELECT 1 FROM auth_users WHERE lower(trim(email))=${quote(email)}) AS email_exists,
    EXISTS(SELECT 1 FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id WHERE r.scope='PLATFORM' AND r.code='PLATFORM_SUPERADMIN') AS superadmin_exists;`;
  let result;
  try {
    result = JSON.parse(runWrangler(["--json", "--command", sql]));
  } catch {
    throw new OperatorError("Could not verify the development D1 guards.");
  }
  const row = result?.[0]?.results?.[0];
  if (row?.environment !== "development")
    throw new OperatorError("D1 environment is not development.");
  if (row.email_exists !== 0) throw new OperatorError("Email already exists.");
  if (row.superadmin_exists !== 0)
    throw new OperatorError("A platform superadmin already exists.");
}

async function main() {
  requireDevelopmentExecution(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new OperatorError("An interactive terminal is required.");

  const prompts = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let name;
  let email;
  try {
    name = (await prompts.question("Full name: ")).trim();
    email = normalizeBootstrapEmail(await prompts.question("Email: "));
  } finally {
    prompts.close();
  }
  if (!name || name.length > 240)
    throw new OperatorError("Full name must be 1–240 characters.");
  assertDevelopmentIsEmpty(email);
  const password = await readPassword();
  if (password.length < 12 || password.length > 128)
    throw new OperatorError("Password must be 12–128 characters.");

  const accountId = v7();
  const sql = buildBootstrapSql({
    accountId,
    credentialId: v7(),
    auditId: v7(),
    securityId: v7(),
    requestId: v7(),
    name,
    email,
    passwordHash: await hashPassword(password),
  });
  const directory = mkdtempSync(
    join(tmpdir(), "motorbaldi-development-bootstrap-"),
  );
  const file = join(directory, "account.sql");
  try {
    writeFileSync(file, sql, { mode: 0o600, flag: "wx" });
    runWrangler(["--file", file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.stdout.write(`${accountId}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof OperatorError ? error.message : "Development account bootstrap failed."}\n`,
    );
    process.exitCode = 1;
  });
}
