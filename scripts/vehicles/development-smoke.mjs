// Development only. Supply an existing assured session through stdin, never a file/CLI argument.
// No password, TOTP secret, session cookie, or response containing identity is printed.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const adminHost = "motorbaldi-admin-development.josegbarrios2.workers.dev";
const portalHost = "motorbaldi-portal-development.josegbarrios2.workers.dev";
const anonymous = process.argv.includes("--anonymous");
const cookie = anonymous ? "" : readFileSync(0, "utf8").trim();
if (!anonymous && (!cookie || /[\r\n]/.test(cookie))) {
  process.stderr.write(
    "An existing Development session is required through stdin. Never save it in repository files.\n",
  );
  process.exit(1);
}
async function call(
  path,
  body,
  { key = randomUUID(), status = 200, authenticated = true } = {},
) {
  const response = await fetch(`https://${adminHost}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: `https://${adminHost}`,
      "content-type": "application/json",
      ...(authenticated && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "idempotency-key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => null);
  if (response.status !== status)
    throw new Error(
      `Development ${path}: expected ${status}, received ${response.status}; code=${data?.code ?? "UNKNOWN"}`,
    );
  return data;
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function main() {
  const missing = "018f0000-0000-7000-8000-000000000099";
  for (const path of [
    "/me/garage",
    "/admin/vehicles",
    `/vehicles/${missing}`,
    `/vehicles/${missing}/records`,
  ])
    await call(path, undefined, { status: 401, authenticated: false });
  for (const host of [adminHost, portalHost]) {
    const response = await fetch(`https://${host}`, {
      signal: AbortSignal.timeout(30000),
    });
    const page = await response.text();
    assert(
      response.status === 200 &&
        page.includes('lang="es"') &&
        page.includes("vehicle-detail"),
      "Development Vehicle UI unavailable",
    );
  }
  if (anonymous) {
    console.log(
      "Development anonymous vehicle protection and deployed UI assets passed.",
    );
    return;
  }
  const me = await call("/me");
  assert(
    me.mfaEnabled === true,
    "An assured post-MFA Development session is required",
  );
  await call("/admin/access");
  const body = {
    kindCode: "CAR",
    specification: {
      brand: "Development validation",
      model: "Phase 2 synthetic vehicle",
    },
    reason: "Synthetic Development Vehicle Core validation",
  };
  const key = randomUUID();
  const receipt = await call("/admin/vehicles", body, { key });
  const vehicle = receipt.vehicleId;
  assert(
    (await call("/admin/vehicles", body, { key })).vehicleId === vehicle,
    "Vehicle replay duplicated its effect",
  );
  await call(
    "/admin/vehicles",
    { ...body, kindCode: "MOTORCYCLE" },
    { key, status: 409 },
  );
  await call(`/vehicles/${vehicle}`, undefined, { status: 404 });
  const grants = {};
  for (const permissionCode of [
    "vehicle.read",
    "vehicle.odometer.write",
    "vehicle.record.read",
    "vehicle.record.write",
  ])
    grants[permissionCode] = (
      await call(`/admin/vehicles/${vehicle}/grants`, {
        personId: me.personId,
        permissionCode,
        reason: "Synthetic Development validation",
      })
    ).grantId;
  await call(`/vehicles/${vehicle}`);
  await call(`/me/garage/${vehicle}/add`, {});
  assert(
    (await call("/me/garage")).items.some((row) => row.id === vehicle),
    "Granted garage entry missing",
  );
  const identifier = await call(`/admin/vehicles/${vehicle}/identifiers`, {
    identifierType: "VIN",
    value: "SYNTHETIC-DEVELOPMENT-ONLY",
    reason: "Synthetic identifier validation",
  });
  await call(
    `/admin/vehicles/${vehicle}/identifiers/${identifier.identifierId}/retire`,
    { reason: "Retain synthetic identifier history" },
  );
  const claim = await call(`/vehicles/${vehicle}/claims`, {
    relationshipType: "OWNER",
    reason: "Synthetic reviewed relationship",
  });
  await call(`/admin/vehicles/${vehicle}/claims/${claim.claimId}/review`, {
    decision: "ACCEPTED",
    reason: "Synthetic Development relationship only; no legal title",
  });
  const update = {
    kindCode: "CAR",
    specification: body.specification,
    version: 1,
    reason: "Optimistic concurrency validation",
  };
  await call(`/admin/vehicles/${vehicle}`, update);
  await call(`/admin/vehicles/${vehicle}`, update, { status: 409 });
  const observation = {
    value: 1250,
    unit: "KILOMETERS",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  const reading = await call(`/vehicles/${vehicle}/odometer`, observation);
  await call(`/vehicles/${vehicle}/odometer`, {
    ...observation,
    value: 1200,
    correctsReadingId: reading.readingId,
    correctionReason: "Synthetic transcription correction",
  });
  assert(
    (await call(`/vehicles/${vehicle}/odometer`)).items.length === 2,
    "Odometer correction history missing",
  );
  const org = (await call("/admin/organizations")).items.find(
    (row) => row.display_name === "MotorBaldi Development Validation Workshop",
  );
  assert(
    org,
    "Existing synthetic Development validation organization is required",
  );
  // Exercise review through the real API on this explicitly synthetic fixture only.
  if (org.verification_status !== "VERIFIED") {
    const cases = await call(`/organizations/${org.id}/verification/cases`);
    const pending = cases.find((row) =>
      ["PENDING_VERIFICATION", "UNDER_REVIEW"].includes(row.status),
    );
    const caseId =
      pending?.id ??
      (await call(`/organizations/${org.id}/verification/submit`, {})).caseId;
    if (pending?.status !== "UNDER_REVIEW")
      await call(
        `/admin/organizations/${org.id}/verification/${caseId}/start-review`,
        {},
      );
    await call(
      `/admin/organizations/${org.id}/verification/${caseId}/approve`,
      {
        reason:
          "Synthetic Development-only fixture for authorization validation; no real business approval",
      },
    );
  }
  const record = await call(`/vehicles/${vehicle}/records`, {
    organizationId: org.id,
    recordType: "SERVICE",
    content: { summary: "Synthetic Development professional record" },
  });
  await call(`/vehicles/${vehicle}/records/${record.recordId}/update`, {
    version: 1,
    content: { summary: "Reviewed synthetic Development record" },
  });
  await call(`/vehicles/${vehicle}/records/${record.recordId}/finalize`, {
    version: 2,
  });
  await call(
    `/vehicles/${vehicle}/records/${record.recordId}/update`,
    { version: 3, content: {} },
    { status: 409 },
  );
  await call(`/vehicles/${vehicle}/records/${record.recordId}/amend`, {
    reason: "Synthetic Development amendment",
    content: { summary: "Appended correction preserved" },
  });
  const records = await call(`/vehicles/${vehicle}/records`);
  assert(
    records.items[0]?.status === "FINAL" && records.amendments.length === 1,
    "Final record and amendment history missing",
  );
  await call(
    `/admin/vehicles/${vehicle}/grants/${grants["vehicle.read"]}/revoke`,
    { reason: "Validate revoked vehicle access" },
  );
  await call(`/vehicles/${vehicle}`, undefined, { status: 404 });
  assert(
    (await call("/me/garage")).items.every((row) => row.id !== vehicle),
    "Revoked access remained visible",
  );
  await call(`/me/garage/${vehicle}/remove`, {});
  // Retain a labeled synthetic fixture for operator review; immutable histories are never deleted.
  await call(`/admin/vehicles/${vehicle}/grants`, {
    personId: me.personId,
    permissionCode: "vehicle.read",
    reason: "Review synthetic Development fixture",
  });
  await call(`/me/garage/${vehicle}/add`, {});
  console.log(
    "Development authenticated Vehicle Core smoke passed. Synthetic history retained for review.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
