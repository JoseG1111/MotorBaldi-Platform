// Existing Development only; pass an assured browser session through stdin, never CLI/config.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const host = "motorbaldi-admin-development.josegbarrios2.workers.dev";
const cookie = readFileSync(0, "utf8").trim();
if (!cookie || /[\r\n]/.test(cookie))
  throw new Error("Existing Development session required through stdin");
function assert(value, message) {
  if (!value) throw new Error(message);
}
async function call(path, body, key, expected = 200) {
  const response = await fetch(`https://${host}/api/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      origin: `https://${host}`,
      cookie,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  assert(
    response.status === expected,
    `Development command failed: ${response.status}; code=${data?.code ?? "UNKNOWN"}`,
  );
  return data;
}
const me = await call("/me");
assert(me.mfaEnabled === true, "Assured MFA session required");
const key = randomUUID();
const organization = {
  type: "OTHER",
  legalName: "MotorBaldi Development Idempotency Validation",
  displayName: "MotorBaldi Development Idempotency Validation",
  countryCode: "CO",
};
// Organization creation is intentionally disabled in remote Development. Preserve that flag.
await call("/organizations", organization, key, 404);
const existing = (await call("/admin/organizations")).items.find(
  (row) => row.display_name === "MotorBaldi Development Validation Workshop",
);
assert(existing?.id, "Existing synthetic validation organization required");
const inviteKey = randomUUID();
const invitation = {
  targetEmail: "idempotency-validation@example.test",
  roles: ["VIEWER"],
  scope: { type: "ALL_LOCATIONS", locationIds: [] },
};
const original = await call(
  `/organizations/${existing.id}/invitations`,
  invitation,
  inviteKey,
  201,
);
const repeated = await call(
  `/organizations/${existing.id}/invitations`,
  invitation,
  inviteKey,
  201,
);
await call(
  `/organizations/${existing.id}/invitations`,
  { ...invitation, targetEmail: "conflicting-idempotency@example.test" },
  inviteKey,
  409,
);
assert(
  typeof original.token === "string" &&
    !Object.hasOwn(repeated, "token") &&
    original.invitationId === repeated.invitationId &&
    repeated.replayed === true,
  "Invitation replay redaction failed",
);
console.log(
  "Development creation restriction and invitation atomic replay/one-time token redaction passed; synthetic private invitation retained.",
);
