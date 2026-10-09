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
  {
    key = randomUUID(),
    status = 200,
    authenticated = true,
    method,
    origin,
  } = {},
) {
  const response = await fetch(`https://${adminHost}/api/v1${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      origin: origin ?? `https://${adminHost}`,
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
    "/admin/inspections",
    `/inspections/${missing}`,
    `/organizations/${missing}/inspections/locations`,
  ])
    await call(path, undefined, { status: 401, authenticated: false });
  for (const host of [adminHost, portalHost]) {
    const response = await fetch(`https://${host}`, {
      signal: AbortSignal.timeout(30000),
    });
    assert(
      response.status === 200 &&
        (await response.text()).includes("inspections-panel"),
      "Development Inspection UI missing",
    );
  }
  if (anonymous) {
    console.log(
      "Development anonymous Inspection protection and UI assets passed.",
    );
    return;
  }
  const me = await call("/me");
  assert(me.mfaEnabled === true, "Existing assured MFA session required");
  const org = (await call("/admin/organizations")).items.find(
    (row) => row.display_name === "MotorBaldi Development Validation Workshop",
  );
  assert(
    org?.verification_status === "VERIFIED",
    "Verified synthetic organization required",
  );
  const locations = (await call(`/organizations/${org.id}/locations`)).items,
    location = locations.find(
      (row) => row.name === "MotorBaldi Development Workshop Site",
    ),
    other = locations.find(
      (row) => row.name === "MotorBaldi Development Alternate Site",
    );
  assert(location && other, "Existing synthetic sites required");
  const capabilities = (
    await call(`/organizations/${org.id}/capabilities`)
  ).map((row) => row.code);
  if (!capabilities.includes("INSPECTION"))
    await call(
      `/organizations/${org.id}/capabilities`,
      { codes: [...capabilities, "INSPECTION"] },
      { method: "PUT" },
    );
  const vehicle = (
    await call("/admin/vehicles", {
      kindCode: "CAR",
      specification: {
        brand: "Development validation",
        model: "Synthetic Inspection lifecycle",
      },
      reason: "Synthetic Inspection remote validation",
    })
  ).vehicleId;
  const grants = {};
  for (const permissionCode of ["vehicle.record.read", "vehicle.record.write"])
    grants[permissionCode] = (
      await call(`/admin/vehicles/${vehicle}/grants`, {
        organizationId: org.id,
        locationId: location.id,
        permissionCode,
        reason: "Synthetic scoped Inspection validation",
      })
    ).grantId;
  const path = `/organizations/${org.id}/inspections`,
    input = {
      vehicleId: vehicle,
      locationId: location.id,
      content: {
        schemaVersion: 1,
        summary: "Synthetic remote inspection observations",
        findings: [],
      },
    },
    key = randomUUID();
  await call(path, input, { status: 403, origin: "https://untrusted.example" });
  await call(path, { ...input, locationId: other.id }, { status: 404 });
  await call(
    path,
    { ...input, content: { summary: "Missing required schema" } },
    { status: 400 },
  );
  const receipt = await call(path, input, { key }),
    recordId = receipt.recordId,
    report = `/inspections/${recordId}`;
  assert(
    (await call(path, input, { key })).recordId === recordId,
    "Inspection create replay duplicated report",
  );
  await call(
    path,
    {
      ...input,
      content: { ...input.content, summary: "Conflicting replay body" },
    },
    { key, status: 409 },
  );
  const choices = await call(path + "/locations/" + location.id + "/vehicles");
  assert(
    choices.items.some((row) => row.id === vehicle),
    "Scoped Inspection vehicle missing",
  );
  assert(
    (await call(path + "/locations/" + other.id + "/vehicles")).items.every(
      (row) => row.id !== vehicle,
    ),
    "Vehicle grant leaked across location",
  );
  const content = {
    schemaVersion: 1,
    summary: "Synthetic reviewed remote observations",
    findings: [
      {
        id: randomUUID(),
        label: "Synthetic finding",
        observation: "Trusted fixture observation without file evidence",
        evidenceFileIds: [],
      },
    ],
  };
  await call(report + "/update", { version: 1, content });
  await call(report + "/update", { version: 1, content }, { status: 409 });
  await call(report + "/finalize", { version: 2 });
  await call(report + "/update", { version: 3, content }, { status: 409 });
  await call(report + "/amend", {
    content: { ...content, summary: "Synthetic separate correction" },
    reason: "Synthetic immutable-report amendment",
  });
  const final = await call(report);
  assert(
    final.record.status === "FINAL" &&
      final.record.version === 3 &&
      final.content.summary === content.summary &&
      final.amendments.length === 1,
    "Immutable Inspection final/amendment history missing",
  );
  assert(
    (await call("/admin/inspections")).items.some((row) => row.id === recordId),
    "Staff Inspection view missing",
  );
  const pending = (
    await call(path, {
      ...input,
      content: {
        ...input.content,
        summary: "Synthetic private quarantine Inspection",
      },
    })
  ).recordId;
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = await fetch(`https://${adminHost}/api/v1/me/evidence-files`, {
    method: "POST",
    headers: {
      cookie,
      origin: `https://${adminHost}`,
      "content-type": "image/png",
      "x-file-size": String(bytes.length),
    },
    body: bytes,
    signal: AbortSignal.timeout(30000),
  });
  assert(upload.status === 202, "Private synthetic upload rejected");
  const uploaded = await upload.json();
  assert(
    (await call("/me/evidence-files/" + uploaded.fileId)).status ===
      "QUARANTINED",
    "Deferred scanner must preserve private quarantine",
  );
  await call(
    `/inspections/${pending}/files`,
    {
      version: 1,
      fileId: uploaded.fileId,
      reason: "Validate deferred scanner quarantine",
    },
    { status: 409 },
  );
  await call(`/inspections/${pending}/files/${uploaded.fileId}`, undefined, {
    status: 404,
  });
  const untouched = await call(`/inspections/${pending}`);
  assert(
    untouched.record.version === 1 && untouched.files.length === 0,
    "Rejected attachment mutated report",
  );
  await call(
    `/admin/vehicles/${vehicle}/grants/${grants["vehicle.record.write"]}/revoke`,
    { reason: "Synthetic revoked Inspection execution validation" },
  );
  await call(path, input, { key, status: 404 });
  console.log(
    "Development authenticated Inspection report/no-file workflow and private quarantine smoke passed. Real scanning remains DEFERRED — OWNER APPROVED; no remote CLEAN/ACTIVE evidence delivery is claimed.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
