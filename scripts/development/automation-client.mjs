import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEVELOPMENT_ADMIN_ORIGIN =
  "https://motorbaldi-admin-development.josegbarrios2.workers.dev";
export const DEVELOPMENT_API_ORIGIN =
  "https://motorbaldi-api-development.josegbarrios2.workers.dev";
const helper = fileURLToPath(
  new URL("./automation-secret.py", import.meta.url),
);
const forbidden = [
  "DEVELOPMENT_AUTOMATION_CREDENTIAL",
  "MOTORBALDI_AUTOMATION_SECRET",
  "MOTORBALDI_AUTOMATION_CREDENTIAL",
];

export function validateCredential(value) {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.keyId,
    ) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.secret) ||
    Buffer.from(value.secret, "base64url").length !== 32 ||
    Buffer.from(value.secret, "base64url").toString("base64url") !==
      value.secret
  )
    throw new Error("Development automation credential unavailable.");
  return { keyId: value.keyId, version: value.version, secret: value.secret };
}
export function secretService(operation, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [helper, operation],
      { encoding: "utf8", maxBuffer: 16384 },
      (error, stdout) => {
        if (error)
          reject(
            new Error("Development automation secret service unavailable."),
          );
        else resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function loadCredential() {
  if (forbidden.some((name) => process.env[name] !== undefined))
    throw new Error("Environment credentials are prohibited.");
  try {
    return validateCredential(JSON.parse(await secretService("lookup")));
  } catch {
    throw new Error("Development automation credential unavailable.");
  }
}
export function canonicalRequest(timestamp, nonce, method, url, body) {
  const target = new URL(url);
  return `${timestamp}\n${nonce}\n${method.toUpperCase()}\n${target.pathname}${target.search}\n${createHash("sha256").update(body).digest("hex")}`;
}
export function signRequest(credential, timestamp, nonce, method, url, body) {
  const key = validateCredential(credential);
  if (
    !/^\d{13}$/.test(String(timestamp)) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      nonce,
    )
  )
    throw new Error("Invalid automation request metadata.");
  const signature = createHmac("sha256", key.secret)
    .update(canonicalRequest(timestamp, nonce, method, url, body))
    .digest("hex");
  return `MotorBaldi-Development ${key.keyId}:${key.version}:${timestamp}:${nonce}:${signature}`;
}
export function getAutomationFetch(options = {}) {
  const transport = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    const marked = headers.get("x-motorbaldi-automation-intent") === "true";
    headers.delete("x-motorbaldi-automation-intent");
    if (!marked) return transport(new Request(request, { headers }));
    if (
      target.origin !== DEVELOPMENT_ADMIN_ORIGIN ||
      !(
        target.pathname === "/api/v1" || target.pathname.startsWith("/api/v1/")
      ) ||
      headers.has("cookie") ||
      headers.has("authorization")
    )
      throw new Error("Development automation request prohibited.");
    if (forbidden.some((name) => process.env[name] !== undefined))
      throw new Error("Environment credentials are prohibited.");
    const credential = options.credential
      ? validateCredential(options.credential)
      : await loadCredential();
    const bytes = Buffer.from(await request.arrayBuffer());
    target.host = new URL(DEVELOPMENT_API_ORIGIN).host;
    if (!headers.has("origin")) headers.set("origin", DEVELOPMENT_ADMIN_ORIGIN);
    headers.set(
      "authorization",
      signRequest(
        credential,
        (options.now ?? Date.now)(),
        (options.nonce ?? randomUUID)(),
        request.method,
        target,
        bytes,
      ),
    );
    try {
      return await transport(target.href, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : bytes,
        redirect: "error",
        credentials: "omit",
        signal: request.signal,
      });
    } catch {
      throw new Error("Development automation request failed.");
    }
  };
}
