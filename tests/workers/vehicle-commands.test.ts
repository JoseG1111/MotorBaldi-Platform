import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import inspectionMediaMigration from "../../migrations/0010_inspection_media.sql?raw";
import inspectionWorkflowMigration from "../../migrations/0011_inspection_workflow.sql?raw";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const accountId = "018f0000-0000-7000-8000-000000000071";
const password = "local-mfa-password-123";
const cookies = new Map<string, string>();
// Independent runtime cases model separate test clients; the real limiter remains enabled.
let clientCase = 1;
beforeEach(() => {
  clientCase++;
});

async function request(path: string, body?: object, key?: string) {
  const response = await worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://portal.test",
        "cf-connecting-ip": "192.0.2." + clientCase,
        ...(key ? { "idempotency-key": key } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookies.size
          ? {
              cookie: [...cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join("; "),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as never,
    env as unknown as ApiBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0]!;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(header))
      cookies.delete(name);
    else cookies.set(name, value);
  }
  return response;
}

async function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replaceAll("=", "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1]! & 15;
  const code =
    (((digest[offset]! & 127) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
    1_000_000;
  return String(code).padStart(6, "0");
}

import vehicleCore from "../../migrations/0004_vehicle_core.sql?raw";
import vehicleAccess from "../../migrations/0005_vehicle_access.sql?raw";
import vehicleHistory from "../../migrations/0006_vehicle_history.sql?raw";
import workshopFilesMigration from "../../migrations/0009_workshop_files.sql?raw";
import {
  files,
  deterministicTestScanner,
  unavailableScanner,
} from "@motorbaldi/storage";
import workshopMigration from "../../migrations/0008_workshop_operations.sql?raw";
import vehicleCommands from "../../migrations/0007_vehicle_commands.sql?raw";
import { newId } from "@motorbaldi/shared";
import { authorizeVehicleCommand } from "@motorbaldi/vehicles";
let personId: string;
const organizationId = newId();
beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  for (const sql of [
    vehicleCore,
    vehicleAccess,
    vehicleHistory,
    vehicleCommands,
    workshopMigration,
    workshopFilesMigration,
    inspectionMediaMigration,
    inspectionWorkflowMigration,
  ])
    await db.exec(sql.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
    )
    .bind(accountId, "MFA Test", "vehicle-commands@example.test")
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential',?)",
    )
    .bind("mfa-credential", accountId, accountId, await hashPassword(password))
    .run();

  await request("/auth/sign-in/email", {
    email: "vehicle-commands@example.test",
    password,
  });
  const enrollment = await request("/auth/two-factor/enable", {
    password,
    method: "totp",
  });
  const secret = new URL(
    ((await enrollment.json()) as { totpURI: string }).totpURI,
  ).searchParams.get("secret")!;
  expect(
    (
      await request("/auth/two-factor/verify-totp", {
        code: await totp(secret),
        trustDevice: false,
      })
    ).status,
  ).toBe(200);
  await request("/auth/sign-out", {});
  await request("/auth/sign-in/email", {
    email: "vehicle-commands@example.test",
    password,
  });
  expect(
    (
      await request("/auth/two-factor/verify-totp", {
        code: await totp(secret),
        trustDevice: false,
      })
    ).status,
  ).toBe(200);
  personId = ((await (await request("/me")).json()) as { personId: string })
    .personId;
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    )
    .bind(personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'WORKSHOP','Vehicle Tests','Vehicle Tests','CO','VERIFIED',?)",
    )
    .bind(organizationId, personId)
    .run();
  const membershipId = newId();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
    )
    .bind(membershipId, organizationId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-owner')",
    )
    .bind(membershipId)
    .run();
});

const command = (path: string, body: object, key = newId()) =>
  request(path, body, key);
async function createVehicle() {
  const response = await command("/admin/vehicles", {
    kindCode: "CAR",
    specification: { brand: "MotorBaldi Test" },
    reason: "Worker validation",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { vehicleId: string }).vehicleId;
}
async function grant(vehicleId: string, permissionCode: string) {
  const response = await command("/admin/vehicles/" + vehicleId + "/grants", {
    personId,
    permissionCode,
    reason: "Worker validation",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { grantId: string }).grantId;
}
describe("Vehicle command runtime", () => {
  it("commits one business effect, audit, event and replay; conflicting bodies and revoked authority fail", async () => {
    const key = newId();
    const body = {
      kindCode: "CAR",
      specification: { brand: "Atomic Test" },
      reason: "Atomic validation",
    };
    const first = await command("/admin/vehicles", body, key);
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as { vehicleId: string };
    const replay = await command("/admin/vehicles", body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ...receipt, replayed: true });
    expect(
      (
        await command(
          "/admin/vehicles",
          { ...body, kindCode: "MOTORCYCLE" },
          key,
        )
      ).status,
    ).toBe(409);
    const events = await db
      .prepare(
        "SELECT count(*) AS n FROM integration_outbox_events WHERE aggregate_id=? AND event_type='vehicle.changed.v1'",
      )
      .bind(receipt.vehicleId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    // Last-superadmin protection stays in force; test current replay authority using a non-assured actor instead.
    await expect(
      authorizeVehicleCommand(
        db,
        { accountId, personId, mfaEnabled: false },
        "vehicle.create",
        body,
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
  });
  it("rolls back stale updates together with their audit, outbox and replay", async () => {
    const vehicleId = await createVehicle();
    const body = {
      kindCode: "CAR",
      specification: { brand: "Updated" },
      version: 1,
      reason: "Version validation",
    };
    expect((await command("/admin/vehicles/" + vehicleId, body)).status).toBe(
      200,
    );
    const key = newId();
    expect(
      (await command("/admin/vehicles/" + vehicleId, body, key)).status,
    ).toBe(409);
    expect(
      await db
        .prepare("SELECT 1 FROM governance_idempotency_records WHERE key=?")
        .bind(key)
        .first(),
    ).toBeNull();
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM integration_outbox_events WHERE aggregate_id=?",
          )
          .bind(vehicleId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("separates read grants, garage, claims and relationships and enforces revocation on replay", async () => {
    const vehicleId = await createVehicle();
    expect((await request("/vehicles/" + vehicleId)).status).toBe(404);
    const grantId = await grant(vehicleId, "vehicle.read");
    const key = newId();
    expect(
      (await command("/me/garage/" + vehicleId + "/add", {}, key)).status,
    ).toBe(200);
    const claim = await command("/vehicles/" + vehicleId + "/claims", {
      relationshipType: "OWNER",
      reason: "Reviewed ownership",
    });
    expect(claim.status).toBe(200);
    const { claimId } = (await claim.json()) as { claimId: string };
    const review = await command(
      "/admin/vehicles/" + vehicleId + "/claims/" + claimId + "/review",
      { decision: "ACCEPTED", reason: "Reviewed ownership" },
    );
    expect(review.status).toBe(200);
    expect(
      (
        await command(
          "/admin/vehicles/" + vehicleId + "/claims/" + claimId + "/review",
          { decision: "REJECTED", reason: "Attempted second review" },
        )
      ).status,
    ).toBe(409);
    const revoked = await command(
      "/admin/vehicles/" + vehicleId + "/grants/" + grantId + "/revoke",
      { reason: "End test access" },
    );
    expect(revoked.status).toBe(200);
    expect((await request("/vehicles/" + vehicleId)).status).toBe(404);
    expect(
      (await command("/me/garage/" + vehicleId + "/add", {}, key)).status,
    ).toBe(404);
    expect((await request("/me/garage")).status).toBe(200);
    expect(
      (await command("/me/garage/" + vehicleId + "/remove", {})).status,
    ).toBe(200);
    expect(
      (await command("/me/garage/" + newId() + "/remove", {})).status,
    ).toBe(200);
  });
  it("keeps odometer correction events immutable and rejects wrong-vehicle correction atomically", async () => {
    const vehicleId = await createVehicle();
    await grant(vehicleId, "vehicle.odometer.write");
    const reading = await command("/vehicles/" + vehicleId + "/odometer", {
      value: 1000,
      unit: "KILOMETERS",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(reading.status).toBe(200);
    const { readingId } = (await reading.json()) as { readingId: string };
    expect(
      (
        await command("/vehicles/" + vehicleId + "/odometer", {
          value: 100,
          unit: "KILOMETERS",
          observedAt: "2026-01-01T00:00:00.000Z",
          correctsReadingId: readingId,
          correctionReason: "Typographical correction",
        })
      ).status,
    ).toBe(200);
    const other = await createVehicle();
    await grant(other, "vehicle.odometer.write");
    const key = newId();
    expect(
      (
        await command(
          "/vehicles/" + other + "/odometer",
          {
            value: 100,
            unit: "KILOMETERS",
            observedAt: "2026-01-01T00:00:00.000Z",
            correctsReadingId: readingId,
            correctionReason: "Wrong vehicle correction",
          },
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      await db
        .prepare("SELECT 1 FROM governance_idempotency_records WHERE key=?")
        .bind(key)
        .first(),
    ).toBeNull();
  });
  it("requires verified professional membership; freezes final records and allows audited amendments", async () => {
    const vehicleId = await createVehicle();
    await grant(vehicleId, "vehicle.record.write");
    await grant(vehicleId, "vehicle.record.read");
    const created = await command("/vehicles/" + vehicleId + "/records", {
      organizationId,
      recordType: "SERVICE",
      content: { summary: "Initial draft" },
    });
    expect(created.status).toBe(200);
    const { recordId } = (await created.json()) as { recordId: string };
    expect(
      (
        await command(
          "/vehicles/" + vehicleId + "/records/" + recordId + "/update",
          { version: 1, content: { summary: "Reviewed draft" } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          "/vehicles/" + vehicleId + "/records/" + recordId + "/finalize",
          { version: 2 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          "/vehicles/" + vehicleId + "/records/" + recordId + "/update",
          { version: 3, content: { summary: "Rewrite final" } },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await command(
          "/vehicles/" + vehicleId + "/records/" + recordId + "/amend",
          {
            reason: "Clarification after finalization",
            content: { summary: "Correction preserved" },
          },
        )
      ).status,
    ).toBe(200);
    const records = await request("/vehicles/" + vehicleId + "/records");
    expect(records.status).toBe(200);
    expect(await records.json()).toMatchObject({
      items: [
        {
          status: "FINAL",
          version: 3,
          content_json: '{"summary":"Reviewed draft"}',
        },
      ],
      amendments: [{ reason: "Clarification after finalization" }],
    });
    await db
      .prepare(
        "UPDATE org_organizations SET verification_status='PENDING_VERIFICATION',version=version+1 WHERE id=?",
      )
      .bind(organizationId)
      .run();
    expect(
      (
        await command("/vehicles/" + vehicleId + "/records", {
          organizationId,
          recordType: "SERVICE",
          content: {},
        })
      ).status,
    ).toBe(403);
  });
  it("keeps professional record reads, amendments and writes inside a location-scoped vehicle grant", async () => {
    await db
      .prepare(
        "UPDATE org_organizations SET verification_status='VERIFIED',version=version+1 WHERE id=?",
      )
      .bind(organizationId)
      .run();
    const vehicleId = await createVehicle();
    const writeGrant = await grant(vehicleId, "vehicle.record.write");
    const locations = [newId(), newId()];
    for (const locationId of locations)
      await db
        .prepare(
          "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Test Site','BRANCH','CO','Test','Test','Synthetic')",
        )
        .bind(locationId, organizationId)
        .run();
    const recordIds = [];
    for (const locationId of locations) {
      const created = await command("/vehicles/" + vehicleId + "/records", {
        organizationId,
        locationId,
        recordType: "SERVICE",
        content: { summary: "Location-scoped record" },
      });
      expect(created.status).toBe(200);
      const recordId = ((await created.json()) as { recordId: string })
        .recordId;
      recordIds.push(recordId);
      expect(
        (
          await command(
            "/vehicles/" + vehicleId + "/records/" + recordId + "/finalize",
            { version: 1 },
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await command(
          "/vehicles/" + vehicleId + "/records/" + recordIds[1] + "/amend",
          {
            reason: "Second-location correction",
            content: { summary: "Private second-location amendment" },
          },
        )
      ).status,
    ).toBe(200);
    for (const permissionCode of [
      "vehicle.record.read",
      "vehicle.record.write",
    ])
      expect(
        (
          await command("/admin/vehicles/" + vehicleId + "/grants", {
            organizationId,
            locationId: locations[0],
            permissionCode,
            reason: "First-location permission only",
          })
        ).status,
      ).toBe(200);
    const response = await request("/vehicles/" + vehicleId + "/records");
    expect(response.status).toBe(200);
    const visible = (await response.json()) as {
      items: { id: string }[];
      amendments: unknown[];
    };
    expect(visible.items.map((r) => r.id)).toEqual([recordIds[0]]);
    expect(visible.amendments).toEqual([]);
    expect(
      (
        await command(
          "/admin/vehicles/" + vehicleId + "/grants/" + writeGrant + "/revoke",
          { reason: "End unrestricted test write" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command("/vehicles/" + vehicleId + "/records", {
          organizationId,
          locationId: locations[1],
          recordType: "SERVICE",
          content: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await command("/vehicles/" + vehicleId + "/records", {
          organizationId,
          locationId: locations[0],
          recordType: "SERVICE",
          content: {},
        })
      ).status,
    ).toBe(200);
  });
});

async function workshopFixture() {
  await db
    .prepare(
      "UPDATE org_organizations SET verification_status='VERIFIED',version=version+1 WHERE id=?",
    )
    .bind(organizationId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'GENERAL_MAINTENANCE') ON CONFLICT DO NOTHING",
    )
    .bind(organizationId)
    .run();
  const locationId = newId();
  await db
    .prepare(
      "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Test Site','BRANCH','CO','Test','Test','Synthetic')",
    )
    .bind(locationId, organizationId)
    .run();
  const vehicleId = await createVehicle();
  await grant(vehicleId, "vehicle.workshop.read");
  const writeGrantId = await grant(vehicleId, "vehicle.workshop.write");
  return {
    locationId,
    vehicleId,
    writeGrantId,
    path: "/organizations/" + organizationId + "/workshop/orders",
  };
}
describe("Workshop command runtime", () => {
  it("performs versioned operational progression with atomic replay/history and immutable completion", async () => {
    const fixture = await workshopFixture();
    const { locationId, vehicleId, path } = fixture;
    const locations = await request(
      "/organizations/" + organizationId + "/workshop/locations",
    );
    expect(locations.status).toBe(200);
    expect(await locations.json()).toMatchObject({ canManage: true });
    const input = {
      locationId,
      vehicleId,
      description: "Synthetic operational validation",
      assignedPersonId: personId,
      reason: "Worker validation creation",
    };
    const key = newId();
    const created = await command(path, input, key);
    expect(created.status).toBe(200);
    const receipt = (await created.json()) as { orderId: string };
    const orderId = receipt.orderId;
    expect(await (await command(path, input, key)).json()).toMatchObject({
      ...receipt,
      replayed: true,
    });
    const detail = await request(path + "/" + orderId);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      order: { status: "DRAFT", version: 1 },
      history: [{ to_status: "DRAFT", version: 1 }],
      canManage: true,
      canExecute: true,
    });
    expect(
      (
        await command(path + "/" + orderId + "/transition", {
          version: 1,
          toStatus: "IN_PROGRESS",
          reason: "Invalid skipped transition",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await command(path + "/" + orderId + "/update", {
          version: 1,
          description: "Reviewed operational request",
          assignedPersonId: personId,
          reason: "Reviewed description",
        })
      ).status,
    ).toBe(200);
    const staleKey = newId();
    expect(
      (
        await command(
          path + "/" + orderId + "/update",
          {
            version: 1,
            description: "Stale operational request",
            assignedPersonId: personId,
            reason: "Stale update rejection",
          },
          staleKey,
        )
      ).status,
    ).toBe(409);
    expect(
      await db
        .prepare("SELECT 1 FROM governance_idempotency_records WHERE key=?")
        .bind(staleKey)
        .first(),
    ).toBeNull();
    expect(
      (
        await command(path + "/" + orderId + "/transition", {
          version: 2,
          toStatus: "OPEN",
          reason: "Admit operational request",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await command(path + "/" + orderId + "/transition", {
          version: 3,
          toStatus: "IN_PROGRESS",
          reason: "Assigned executor started work",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await command(path + "/" + orderId + "/transition", {
          version: 4,
          toStatus: "COMPLETED",
          finalRecordId: newId(),
          reason: "Unmatched completion record",
        })
      ).status,
    ).toBe(409);
    await grant(vehicleId, "vehicle.record.write");
    const record = await command("/vehicles/" + vehicleId + "/records", {
      organizationId,
      locationId,
      recordType: "SERVICE",
      content: { summary: "Operational completion" },
    });
    expect(record.status).toBe(200);
    const recordId = ((await record.json()) as { recordId: string }).recordId;
    expect(
      (
        await command(
          "/vehicles/" + vehicleId + "/records/" + recordId + "/finalize",
          { version: 1 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(path + "/" + orderId + "/transition", {
          version: 4,
          toStatus: "COMPLETED",
          finalRecordId: recordId,
          reason: "Immutable completion evidence",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await command(path + "/" + orderId + "/transition", {
          version: 5,
          toStatus: "CLOSED",
          reason: "MFA assured operational closure",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await command(path + "/" + orderId + "/update", {
          version: 6,
          description: "Rewrite closed order",
          assignedPersonId: personId,
          reason: "Attempt terminal mutation",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM workshop_order_events WHERE order_id=?",
          )
          .bind(orderId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(6);
    expect((await request("/admin/workshop/orders")).status).toBe(200);
  });
  it("denies wrong organization/location and revoked command replay without granting access through assignment", async () => {
    const { locationId, vehicleId, path, writeGrantId } =
      await workshopFixture();
    const key = newId();
    const input = {
      locationId,
      vehicleId,
      description: "Access denial validation",
      assignedPersonId: personId,
      reason: "Worker access validation",
    };
    const created = await command(path, input, key);
    expect(created.status).toBe(200);
    const { orderId } = (await created.json()) as { orderId: string };
    expect(
      (
        await request(
          "/organizations/" + newId() + "/workshop/orders/" + orderId,
        )
      ).status,
    ).toBe(404);
    expect(
      (await command(path, { ...input, locationId: newId() })).status,
    ).toBe(404);
    expect(
      (await command(path, { ...input, assignedPersonId: newId() })).status,
    ).toBe(400);
    expect(
      (
        await command(
          "/admin/vehicles/" +
            vehicleId +
            "/grants/" +
            writeGrantId +
            "/revoke",
          { reason: "End operational test write" },
        )
      ).status,
    ).toBe(200);
    expect((await command(path, input, key)).status).toBe(404);
    expect((await request(path + "/" + orderId)).status).toBe(200);
  });
  it("keeps unavailable scans quarantined and attaches only owned ACTIVE evidence atomically", async () => {
    const { locationId, vehicleId, path } = await workshopFixture();
    const created = await command(path, {
      locationId,
      vehicleId,
      description: "Private evidence validation",
      assignedPersonId: personId,
      reason: "Synthetic private evidence",
    });
    expect(created.status).toBe(200);
    const orderId = ((await created.json()) as { orderId: string }).orderId;
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const quarantine = files(
      db,
      (env as unknown as ApiBindings).PRIVATE_BUCKET,
      { scanner: unavailableScanner },
    );
    const upload = await quarantine.requestUpload(
      accountId,
      "image/png",
      bytes.length,
      "file-upload-test",
    );
    await quarantine.putQuarantineObject(upload.id, bytes, "image/png");
    expect(await quarantine.scan(upload.id, "unavailable-scan-test")).toBe(
      "QUARANTINED",
    );
    const body = {
      fileId: upload.id,
      version: 1,
      reason: "Synthetic evidence attachment",
    };
    const rejectedKey = newId();
    expect(
      (await command(path + "/" + orderId + "/files", body, rejectedKey))
        .status,
    ).toBe(409);
    expect(
      await db
        .prepare("SELECT 1 FROM governance_idempotency_records WHERE key=?")
        .bind(rejectedKey)
        .first(),
    ).toBeNull();
    const scanner = files(db, (env as unknown as ApiBindings).PRIVATE_BUCKET, {
      scanner: deterministicTestScanner,
    });
    expect(await scanner.scan(upload.id, "local-only-clean-scan")).toBe(
      "ACTIVE",
    );
    const key = newId();
    const attached = await command(path + "/" + orderId + "/files", body, key);
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({ version: 2 });
    expect(
      await (await command(path + "/" + orderId + "/files", body, key)).json(),
    ).toMatchObject({ version: 2, replayed: true });
    expect(
      (await command(path + "/" + orderId + "/files", { ...body, version: 2 }))
        .status,
    ).toBe(409);
    expect(
      (
        await db
          .prepare("SELECT version FROM workshop_orders WHERE id=?")
          .bind(orderId)
          .first<{ version: number }>()
      )?.version,
    ).toBe(2);
    const download = await request(
      path + "/" + orderId + "/files/" + upload.id,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe("attachment");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    expect(
      (
        await request(
          "/organizations/" +
            newId() +
            "/workshop/orders/" +
            orderId +
            "/files/" +
            upload.id,
        )
      ).status,
    ).toBe(404);
    await expect(
      db
        .prepare("DELETE FROM workshop_order_files WHERE order_id=?")
        .bind(orderId)
        .run(),
    ).rejects.toThrow();
    const grantIds = (
      await db
        .prepare(
          "SELECT id FROM vehicle_access_grants WHERE vehicle_id=? AND permission_code='vehicle.workshop.read' AND revoked_at IS NULL",
        )
        .bind(vehicleId)
        .all<{ id: string }>()
    ).results;
    for (const g of grantIds)
      await command(
        "/admin/vehicles/" + vehicleId + "/grants/" + g.id + "/revoke",
        { reason: "Revoke evidence read validation" },
      );
    expect(
      (await request(path + "/" + orderId + "/files/" + upload.id)).status,
    ).toBe(404);
  });
});

describe("Inspection workflow enforcement on generic Vehicle commands", () => {
  it("requires capability, valid schema, current executor authority and preserves immutable final/amendment history", async () => {
    const locationId = newId();
    await db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Inspection Site','SERVICE_SITE','CO','Test','Test','Synthetic')",
      )
      .bind(locationId, organizationId)
      .run();
    const vehicle = await createVehicle();
    await grant(vehicle, "vehicle.record.write");
    await grant(vehicle, "vehicle.record.read");
    const content = {
      schemaVersion: 1,
      summary: "Synthetic initial inspection observations",
      findings: [],
    };
    const input = {
      organizationId,
      locationId,
      recordType: "INSPECTION",
      content,
    };
    expect(
      (await command("/vehicles/" + vehicle + "/records", input)).status,
    ).toBe(404);
    await db
      .prepare(
        "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'INSPECTION')",
      )
      .bind(organizationId)
      .run();
    expect(
      (
        await command("/vehicles/" + vehicle + "/records", {
          ...input,
          content: { summary: "Invalid missing schema" },
        })
      ).status,
    ).toBe(400);
    const key = newId(),
      created = await command("/vehicles/" + vehicle + "/records", input, key);
    expect(created.status).toBe(200);
    const recordId = ((await created.json()) as { recordId: string }).recordId;
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='org-owner' AND permission_code='org.inspection.execute'",
      )
      .run();
    expect(
      (await command("/vehicles/" + vehicle + "/records", input, key)).status,
    ).toBe(403);
    await db
      .prepare(
        "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('org-owner','org.inspection.execute')",
      )
      .run();
    expect(
      (await command("/vehicles/" + vehicle + "/records", input, key)).status,
    ).toBe(200);
    expect(
      (
        await command(
          "/vehicles/" + vehicle + "/records/" + recordId + "/update",
          {
            version: 1,
            content: {
              ...content,
              findings: [
                {
                  id: newId(),
                  label: "Synthetic",
                  observation: "Synthetic observation",
                  evidenceFileIds: [newId()],
                },
              ],
            },
          },
        )
      ).status,
    ).toBe(409);
    const updated = {
      ...content,
      summary: "Synthetic corrected draft observations",
    };
    expect(
      (
        await command(
          "/vehicles/" + vehicle + "/records/" + recordId + "/update",
          { version: 1, content: updated },
        )
      ).status,
    ).toBe(200);
    await expect(
      authorizeVehicleCommand(
        db,
        { accountId, personId, mfaEnabled: false },
        "vehicle.record.finalize",
        {
          vehicleId: vehicle,
          recordId,
          version: 2,
          reason: "Validate MFA requirement",
        },
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect(
      (
        await command(
          "/vehicles/" + vehicle + "/records/" + recordId + "/finalize",
          { version: 2 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await command(
          "/vehicles/" + vehicle + "/records/" + recordId + "/update",
          { version: 3, content },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await command(
          "/vehicles/" + vehicle + "/records/" + recordId + "/amend",
          { content, reason: "Correct through separate amendment" },
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT content_json,status,version FROM vehicle_professional_records WHERE id=?",
        )
        .bind(recordId)
        .first(),
    ).toEqual({
      content_json: JSON.stringify(updated),
      status: "FINAL",
      version: 3,
    });
  });
});

describe("Atomic Inspection attachment coordinator", () => {
  it("commits replay/audit/event/association together and rechecks authority before replay", async () => {
    const locationId = newId();
    await db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Inspection Media Site','SERVICE_SITE','CO','Test','Test','Synthetic')",
      )
      .bind(locationId, organizationId)
      .run();
    const vehicle = await createVehicle();
    await grant(vehicle, "vehicle.record.write");
    const created = await command("/vehicles/" + vehicle + "/records", {
      organizationId,
      locationId,
      recordType: "INSPECTION",
      content: {
        schemaVersion: 1,
        summary: "Synthetic attachment coordinator report",
        findings: [],
      },
    });
    expect(created.status).toBe(200);
    const recordId = ((await created.json()) as { recordId: string }).recordId;
    // Isolated local metadata fixture; no file scan or deployed safety assertion.
    const fileId = newId();
    await db
      .prepare(
        "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,active_key,declared_mime,size_bytes,sha256,status,request_id) VALUES(?,?,?,?,'image/png',64,?,'ACTIVE','synthetic-inspection-test')",
      )
      .bind(
        fileId,
        accountId,
        "test-quarantine/" + fileId,
        "test-active/" + fileId,
        "0".repeat(64),
      )
      .run();
    const session = await db
      .prepare(
        "SELECT id FROM auth_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(accountId)
      .first<{ id: string }>();
    const scope = buildIdempotencyScope({
        accountId,
        operation: "inspection.file.attach",
      }),
      key = newId();
    const input = {
      recordId,
      fileId,
      version: 1,
      reason: "Synthetic trusted lifecycle metadata",
    };
    const run = (body: object, k = key) =>
      (env as unknown as ApiBindings).IDEMPOTENCY_COORDINATOR.getByName(
        scope.scope + ":" + k,
      ).fetch("https://idempotency/run", {
        method: "POST",
        body: JSON.stringify({
          key: k,
          scope,
          request: body,
          sessionId: session!.id,
          requestId: newId(),
        }),
      });
    const result = await run(input);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      recordId,
      version: 2,
      replayed: false,
    });
    expect(await (await run(input)).json()).toMatchObject({
      version: 2,
      replayed: true,
    });
    expect(
      (await run({ ...input, reason: "Conflicting replay body" })).status,
    ).toBe(409);
    expect((await run({ ...input, version: 2 }, newId())).status).toBe(409);
    expect(
      await db
        .prepare("SELECT version FROM vehicle_professional_records WHERE id=?")
        .bind(recordId)
        .first(),
    ).toEqual({ version: 2 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS total FROM governance_audit_events WHERE action='inspection.file.attach' AND resource_id=?",
        )
        .bind(recordId)
        .first(),
    ).toEqual({ total: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS total FROM integration_outbox_events WHERE aggregate_id=? AND event_type='inspection.report.changed.v1'",
        )
        .bind(recordId)
        .first(),
    ).toEqual({ total: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS total FROM governance_idempotency_records WHERE operation='inspection.file.attach'",
        )
        .first(),
    ).toEqual({ total: 1 });
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='org-owner' AND permission_code='org.inspection.execute'",
      )
      .run();
    expect((await run(input)).status).toBe(403);
    await db
      .prepare(
        "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('org-owner','org.inspection.execute')",
      )
      .run();
  });
});

describe("Dedicated Inspection API and private media", () => {
  it("uses canonical reports and atomic media with private scoped bytes and quarantine rejection", async () => {
    const locationId = newId();
    await db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Inspection API Site','SERVICE_SITE','CO','Test','Test','Synthetic')",
      )
      .bind(locationId, organizationId)
      .run();
    const vehicle = await createVehicle();
    await grant(vehicle, "vehicle.record.write");
    await grant(vehicle, "vehicle.record.read");
    const path = "/organizations/" + organizationId + "/inspections",
      content = {
        schemaVersion: 1,
        summary: "Synthetic API observations",
        findings: [],
      };
    expect(
      (
        await command(path, {
          vehicleId: vehicle,
          locationId,
          organizationId,
          content,
        })
      ).status,
    ).toBe(400);
    expect((await request(path + "/locations")).status).toBe(200);
    expect(
      (await request(path + "/locations/" + locationId + "/vehicles")).status,
    ).toBe(200);
    const create = await command(path, {
      vehicleId: vehicle,
      locationId,
      content,
    });
    expect(create.status).toBe(200);
    const recordId = ((await create.json()) as { recordId: string }).recordId;
    const report = "/inspections/" + recordId;
    expect((await request(report)).status).toBe(200);
    expect((await request("/admin/inspections")).status).toBe(200);
    const pending = newId(),
      active = newId();
    for (const [id, state] of [
      [pending, "QUARANTINED"],
      [active, "ACTIVE"],
    ])
      await db
        .prepare(
          "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,active_key,declared_mime,size_bytes,sha256,status,request_id) VALUES(?,?,?,?,'image/png',4,?,?,'synthetic-inspection-api-test')",
        )
        .bind(
          id,
          accountId,
          "test-quarantine/" + id,
          state === "ACTIVE" ? "test-active/" + id : null,
          state === "ACTIVE" ? "0".repeat(64) : null,
          state,
        )
        .run();
    expect(
      (
        await command(report + "/files", {
          version: 1,
          fileId: pending,
          reason: "Validate unavailable fixture",
        })
      ).status,
    ).toBe(409);
    expect((await request(report + "/files/" + pending)).status).toBe(404);
    await (env as unknown as ApiBindings).PRIVATE_BUCKET.put(
      "test-active/" + active,
      new Uint8Array([1, 2, 3, 4]),
    );
    const input = {
        version: 1,
        fileId: active,
        reason: "Synthetic local lifecycle fixture",
      },
      key = newId();
    expect((await command(report + "/files", input, key)).status).toBe(200);
    expect((await command(report + "/files", input, key)).status).toBe(200);
    const download = await request(report + "/files/" + active);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe("attachment");
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([
      1, 2, 3, 4,
    ]);
    const detail = (await (await request(report)).json()) as {
      files: Record<string, unknown>[];
    };
    expect(detail.files).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain("test-active/");
    expect(
      (
        await command(report + "/update", {
          version: 2,
          content: {
            ...content,
            findings: [
              {
                id: newId(),
                label: "Observation",
                observation: "Synthetic observed state",
                evidenceFileIds: [active],
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    expect((await command(report + "/finalize", { version: 3 })).status).toBe(
      200,
    );
    expect(
      (
        await command(report + "/files", {
          version: 4,
          fileId: active,
          reason: "Reject final attachment",
        })
      ).status,
    ).toBe(409);
    const correctionRows = Array.from({ length: 101 }, (_, n) =>
      db
        .prepare(
          "INSERT INTO vehicle_professional_amendments(id,record_id,author_person_id,reason,content_json,created_at) VALUES(?,?,?,'Synthetic history pagination fixture',?,?)",
        )
        .bind(
          newId(),
          recordId,
          personId,
          JSON.stringify({ ...content, summary: "Synthetic correction " + n }),
          "2026-01-01T00:00:00." + String(n).padStart(3, "0") + "Z",
        ),
    );
    await db.batch(correctionRows);
    const corrected = (await (await request(report)).json()) as {
      amendmentCount: number;
      amendmentsTruncated: boolean;
      amendments: { content_json: string }[];
      content: { summary: string };
    };
    expect(corrected.amendmentCount).toBe(101);
    expect(corrected.amendmentsTruncated).toBe(true);
    expect(corrected.amendments).toHaveLength(100);
    expect(JSON.parse(corrected.amendments.at(-1)!.content_json).summary).toBe(
      "Synthetic correction 100",
    );
    expect(corrected.content.summary).toBe(content.summary);
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND permission_code='vehicle.record.read'",
      )
      .bind(vehicle)
      .run();
    expect((await request(report + "/files/" + active)).status).toBe(404);
    const saved = new Map(cookies);
    cookies.clear();
    expect((await request("/admin/inspections")).status).toBe(401);
    for (const [name, value] of saved) cookies.set(name, value);
  });
});
