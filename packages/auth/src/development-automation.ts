import type { ApiBindings } from "@motorbaldi/config";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  securityEvent,
  requireDevelopmentAutomationAssurance,
} from "@motorbaldi/db";
import { canonical, newId, sha256Hex, type Json } from "@motorbaldi/shared";
const origin = "https://motorbaldi-api-development.josegbarrios2.workers.dev";
const unavailable = () =>
  new Problem(
    403,
    "DEVELOPMENT_AUTOMATION_DENIED",
    "Development automation unavailable",
  );
type Machine = Principal & {
  personId: string;
  automationAuthorizationId: string;
};
async function identity(db: D1Database, accountId: string) {
  return db
    .prepare(
      "SELECT i.*,a.person_id FROM development_automation_identities i JOIN iam_accounts a ON a.id=i.account_id JOIN iam_people p ON p.id=a.person_id WHERE i.account_id=? AND i.status='ACTIVE' AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.status='ACTIVE' AND p.status='ACTIVE' AND EXISTS(SELECT 1 FROM governance_environment_metadata WHERE singleton=1 AND environment='development')",
    )
    .bind(accountId)
    .first<{ key_id: string; credential_version: number; person_id: string }>();
}
export async function issueDevelopmentAutomationAuthorization(
  db: D1Database,
  actor: Principal,
  operation: string,
  body: Json,
): Promise<string> {
  await requireDevelopmentAutomationAssurance(db, actor);
  const current = await identity(db, actor.accountId);
  if (!current) throw unavailable();
  const id = newId();
  await db
    .prepare(
      "INSERT INTO development_automation_authorizations(id,account_id,credential_version,operation,request_hash,expires_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      id,
      actor.accountId,
      current.credential_version,
      operation,
      await sha256Hex(canonical(body)),
      new Date(Date.now() + 60000).toISOString(),
    )
    .run();
  return id;
}
export async function assessDevelopmentAutomationCommand(
  env: ApiBindings,
  id: string,
  accountId: string,
  operation: string,
  body: Json,
): Promise<Machine> {
  if (
    env.ENVIRONMENT !== "development" ||
    env.AUTH_BASE_URL !== origin ||
    env.DEVELOPMENT_AUTOMATION_ENABLED !== "true" ||
    !env.DEVELOPMENT_AUTOMATION_CREDENTIAL
  )
    throw unavailable();
  const current = await identity(env.DB, accountId);
  if (!current) throw unavailable();
  let credential: { keyId: string; version: number };
  try {
    credential = JSON.parse(env.DEVELOPMENT_AUTOMATION_CREDENTIAL);
  } catch {
    throw unavailable();
  }
  if (
    current.key_id !== credential.keyId ||
    current.credential_version !== credential.version
  )
    throw unavailable();
  const context = await env.DB.prepare(
    "SELECT request_hash FROM development_automation_authorizations WHERE id=? AND account_id=? AND credential_version=? AND operation=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  )
    .bind(id, accountId, current.credential_version, operation)
    .first<{ request_hash: string }>();
  if (!context || context.request_hash !== (await sha256Hex(canonical(body))))
    throw unavailable();
  return {
    accountId,
    personId: current.person_id,
    mfaEnabled: false,
    automationAuthorizationId: id,
  };
}
export async function authenticateDevelopmentAutomation(
  request: Request,
  env: ApiBindings,
  requestId: string,
): Promise<Machine | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("MotorBaldi-Development")) return null;
  let accountId: string | undefined;
  try {
    if (
      env.ENVIRONMENT !== "development" ||
      env.DEVELOPMENT_AUTOMATION_ENABLED !== "true" ||
      !env.DEVELOPMENT_AUTOMATION_CREDENTIAL ||
      env.AUTH_BASE_URL !== origin ||
      new URL(request.url).origin !== origin ||
      request.headers.has("cookie")
    )
      throw unavailable();
    const matched =
      /^MotorBaldi-Development ([0-9a-f-]{36}):([1-9][0-9]*):([0-9]{13}):([0-9a-f-]{36}):([0-9a-f]{64})$/.exec(
        header,
      );
    if (!matched) throw unavailable();
    const [, keyId, version, time, nonce, signature] = matched;
    if (Math.abs(Date.now() - Number(time)) > 60000) throw unavailable();
    let credential: { keyId: string; version: number; secret: string };
    try {
      credential = JSON.parse(env.DEVELOPMENT_AUTOMATION_CREDENTIAL);
    } catch {
      throw unavailable();
    }
    if (
      credential.keyId !== keyId ||
      credential.version !== Number(version) ||
      !/^[A-Za-z0-9_-]{43}$/.test(credential.secret)
    )
      throw unavailable();
    const row = await env.DB.prepare(
      "SELECT account_id FROM development_automation_identities WHERE key_id=?",
    )
      .bind(keyId)
      .first<{ account_id: string }>();
    if (!row) throw unavailable();
    accountId = row.account_id;
    const current = await identity(env.DB, accountId);
    if (!current || current.credential_version !== Number(version))
      throw unavailable();
    const reader = request.clone().body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 16384) {
          void reader.cancel().catch(() => {});
          throw unavailable();
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const url = new URL(request.url);
    const value = `${time}\n${nonce}\n${request.method}\n${url.pathname}${url.search}\n${await sha256Hex(bytes)}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(credential.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Uint8Array.from(signature!.match(/../g)!, (v) =>
      parseInt(v, 16),
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        sig,
        new TextEncoder().encode(value),
      ))
    )
      throw unavailable();
    const contextId = newId();
    const expires = new Date(Date.now() + 60000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO development_automation_nonces(key_id,nonce,expires_at) VALUES(?,?,?)",
      ).bind(
        keyId,
        nonce,
        new Date(Math.max(Date.now(), Number(time)) + 60001).toISOString(),
      ),
      env.DB.prepare(
        "INSERT INTO development_automation_authorizations(id,account_id,credential_version,operation,request_hash,expires_at) VALUES(?,?,?,'http.read',?,?)",
      ).bind(
        contextId,
        accountId,
        current.credential_version,
        await sha256Hex(value),
        expires,
      ),
    ]);
    await securityEvent(
      env.DB,
      "DEVELOPMENT_AUTOMATION_AUTHENTICATED",
      requestId,
      accountId,
    );
    return {
      accountId,
      personId: current.person_id,
      mfaEnabled: false,
      automationAuthorizationId: contextId,
    };
  } catch {
    if (env.ENVIRONMENT === "development")
      await securityEvent(
        env.DB,
        "DEVELOPMENT_AUTOMATION_DENIED",
        requestId,
        accountId,
      );
    throw unavailable();
  }
}
