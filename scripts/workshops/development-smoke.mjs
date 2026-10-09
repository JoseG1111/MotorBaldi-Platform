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
    "/admin/workshop/orders",
    `/organizations/${missing}/workshop/locations`,
    `/organizations/${missing}/workshop/orders`,
  ])
    await call(path, undefined, { status: 401, authenticated: false });
  for (const host of [adminHost, portalHost]) {
    const response = await fetch(`https://${host}`, {
      signal: AbortSignal.timeout(30000),
    });
    assert(
      response.status === 200 &&
        (await response.text()).includes("workshop-panel"),
      "Development Workshop UI missing",
    );
  }
  if (anonymous) {
    console.log(
      "Development anonymous Workshop protection and UI assets passed.",
    );
    return;
  }
  const me = await call("/me");
  assert(me.mfaEnabled === true, "Fresh MFA-assured session required");
  const org = (await call("/admin/organizations")).items.find(
    (row) => row.display_name === "MotorBaldi Development Validation Workshop",
  );
  assert(
    org?.verification_status === "VERIFIED",
    "Verified synthetic Development organization required",
  );
  const locations = (await call(`/organizations/${org.id}/locations`)).items;
  let location = locations.find(
    (row) => row.name === "MotorBaldi Development Workshop Site",
  );
  if (!location) {
    const receipt = await call(
      `/organizations/${org.id}/locations`,
      {
        name: "MotorBaldi Development Workshop Site",
        locationType: "SERVICE_SITE",
        countryCode: "CO",
        administrativeArea: "Development fixture",
        city: "Development fixture",
        addressLine1: "Synthetic Development validation only",
      },
      { status: 201 },
    );
    location = { id: receipt.locationId };
  }
  let otherLocation = locations.find(
    (row) => row.name === "MotorBaldi Development Alternate Site",
  );
  if (!otherLocation) {
    const receipt = await call(
      `/organizations/${org.id}/locations`,
      {
        name: "MotorBaldi Development Alternate Site",
        locationType: "SERVICE_SITE",
        countryCode: "CO",
        administrativeArea: "Development fixture",
        city: "Development fixture",
        addressLine1: "Synthetic Development validation only",
      },
      { status: 201 },
    );
    otherLocation = { id: receipt.locationId };
  }
  const capabilities = (
    await call(`/organizations/${org.id}/capabilities`)
  ).map((row) => row.code);
  if (!capabilities.includes("GENERAL_MAINTENANCE"))
    await call(
      `/organizations/${org.id}/capabilities`,
      { codes: [...capabilities, "GENERAL_MAINTENANCE"] },
      { method: "PUT" },
    );
  const vehicle = (
    await call("/admin/vehicles", {
      kindCode: "CAR",
      specification: {
        brand: "Development validation",
        model: "Synthetic Workshop lifecycle",
      },
      reason: "Synthetic Workshop validation",
    })
  ).vehicleId;
  const grants = {};
  for (const permissionCode of [
    "vehicle.workshop.read",
    "vehicle.workshop.write",
    "vehicle.record.read",
    "vehicle.record.write",
  ])
    grants[permissionCode] = (
      await call(`/admin/vehicles/${vehicle}/grants`, {
        organizationId: org.id,
        locationId: location.id,
        permissionCode,
        reason: "Synthetic location-scoped Workshop validation",
      })
    ).grantId;
  const available = await call(
    `/organizations/${org.id}/workshop/locations/${location.id}/vehicles`,
  );
  assert(
    available.items.some((row) => row.id === vehicle),
    "Granted Workshop vehicle missing",
  );
  const unavailable = await call(
    `/organizations/${org.id}/workshop/locations/${otherLocation.id}/vehicles`,
  );
  assert(
    unavailable.items.every((row) => row.id !== vehicle),
    "Location-scoped grant leaked to another site",
  );
  const path = `/organizations/${org.id}/workshop/orders`;
  const input = {
    vehicleId: vehicle,
    locationId: location.id,
    description: "Synthetic Development Workshop operational validation",
    assignedPersonId: me.personId,
    reason: "Synthetic operational validation",
  };
  await call(path, input, { origin: "https://untrusted.example", status: 403 });
  const key = randomUUID();
  const receipt = await call(path, input, { key });
  const orderId = receipt.orderId;
  assert(
    (await call(path, input, { key })).orderId === orderId,
    "Workshop replay duplicated its effect",
  );
  await call(
    path,
    { ...input, description: "Different idempotent body" },
    { key, status: 409 },
  );
  await call(path, { ...input, locationId: otherLocation.id }, { status: 404 });
  await call(
    `/organizations/${missing}/workshop/orders/${orderId}`,
    undefined,
    { status: 404 },
  );
  const detail = await call(`${path}/${orderId}`);
  assert(
    detail.canManage && detail.canExecute && detail.order.status === "DRAFT",
    "Scoped Workshop actions missing",
  );
  await call(
    `${path}/${orderId}/transition`,
    {
      version: 1,
      toStatus: "IN_PROGRESS",
      reason: "Reject skipped transition",
    },
    { status: 409 },
  );
  const update = {
    version: 1,
    description: "Reviewed synthetic Development Workshop work",
    assignedPersonId: me.personId,
    reason: "Synthetic description review",
  };
  await call(`${path}/${orderId}/update`, update);
  await call(`${path}/${orderId}/update`, update, { status: 409 });
  await call(`${path}/${orderId}/transition`, {
    version: 2,
    toStatus: "OPEN",
    reason: "Synthetic operational admission",
  });
  await call(`${path}/${orderId}/transition`, {
    version: 3,
    toStatus: "IN_PROGRESS",
    reason: "Synthetic assigned execution",
  });
  await call(
    `${path}/${orderId}/transition`,
    {
      version: 4,
      toStatus: "COMPLETED",
      finalRecordId: missing,
      reason: "Reject missing completion evidence",
    },
    { status: 409 },
  );
  const record = await call(`/vehicles/${vehicle}/records`, {
    organizationId: org.id,
    locationId: location.id,
    recordType: "SERVICE",
    content: { summary: "Synthetic immutable Workshop completion evidence" },
  });
  await call(`/vehicles/${vehicle}/records/${record.recordId}/finalize`, {
    version: 1,
  });
  await call(`${path}/${orderId}/transition`, {
    version: 4,
    toStatus: "COMPLETED",
    finalRecordId: record.recordId,
    reason: "Synthetic final completion evidence",
  });
  await call(`${path}/${orderId}/transition`, {
    version: 5,
    toStatus: "CLOSED",
    reason: "Synthetic MFA-assured Workshop closure",
  });
  await call(
    `${path}/${orderId}/update`,
    { ...update, version: 6 },
    { status: 409 },
  );
  const closed = await call(`${path}/${orderId}`);
  assert(
    closed.order.status === "CLOSED" && closed.history.length === 6,
    "Immutable Workshop closure/history missing",
  );
  const evidenceOrder = await call(path, {
    ...input,
    description: "Synthetic quarantine validation order",
  });
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
  assert(upload.status === 202, "Private quarantine upload failed");
  const uploaded = await upload.json();
  const pending = await call(`/me/evidence-files/${uploaded.fileId}`);
  assert(
    pending.status === "QUARANTINED",
    "Unconfigured scanner must retain quarantine",
  );
  await call(
    `${path}/${evidenceOrder.orderId}/files`,
    {
      version: 1,
      fileId: uploaded.fileId,
      reason: "Validate unavailable scan protection",
    },
    { status: 409 },
  );
  assert(
    (await call(`${path}/${evidenceOrder.orderId}/files`)).items.length === 0,
    "Quarantined file must not attach",
  );
  await call(
    `${path}/${evidenceOrder.orderId}/files/${uploaded.fileId}`,
    undefined,
    { status: 404 },
  );
  assert(
    (await call(`${path}/${evidenceOrder.orderId}`)).order.version === 1,
    "Rejected attachment must not mutate order",
  );
  await call("/admin/workshop/orders");
  await call(
    `/admin/vehicles/${vehicle}/grants/${grants["vehicle.workshop.write"]}/revoke`,
    { reason: "Validate revoked Workshop command authority" },
  );
  await call(path, input, { key, status: 404 });
  console.log(
    "Development authenticated Workshop core and private quarantine smoke passed. Synthetic closed order and immutable history retained.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
