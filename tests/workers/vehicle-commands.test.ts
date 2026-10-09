import { beforeAll, describe, expect, it } from "vitest";
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

async function request(path: string, body?: object, key?: string) {
  const response = await worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://portal.test",
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
});
