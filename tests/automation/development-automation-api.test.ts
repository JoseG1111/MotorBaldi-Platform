import { beforeAll, describe, expect, it } from "vitest";
import { authenticateDevelopmentAutomation } from "@motorbaldi/auth";
import { env, exports as workerExports } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { automationCommitGuard } from "../../apps/api/src/development-automation-command.js";
import { automationResourceClaim } from "../../apps/api/src/development-automation-scope.js";
import { buildIdempotencyScope, prepareReplayStatement } from "@motorbaldi/db";
import { newId, sha256Hex } from "@motorbaldi/shared";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m9 from "../../migrations/0009_workshop_files.sql?raw";
import m10 from "../../migrations/0010_inspection_media.sql?raw";
import m11 from "../../migrations/0011_inspection_workflow.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";
import m14 from "../../migrations/0014_notifications.sql?raw";
import m15 from "../../migrations/0015_support.sql?raw";
import m16 from "../../migrations/0016_support_history_boundary.sql?raw";
import m17 from "../../migrations/0017_parts_catalog.sql?raw";
import m18 from "../../migrations/0018_development_automation.sql?raw";
const bindings = env as unknown as ApiBindings;
const db = bindings.DB;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const api = "https://motorbaldi-api-development.josegbarrios2.workers.dev";
const admin = "https://motorbaldi-admin-development.josegbarrios2.workers.dev";
const keyId = "33333333-3333-4333-8333-333333333333";
const testKey = "local_automation_test_key_material_12345678";
const personId = newId(),
  accountId = newId(),
  organizationId = newId(),
  locationId = newId(),
  membershipId = newId();
const base = `/organizations/${organizationId}`;
const reason = "Synthetic Development Parts validation";
let requestNumber = 0;
async function signed(
  path: string,
  body?: object,
  idempotencyKey = newId(),
  options: { origin?: string; signed?: boolean; bindings?: ApiBindings } = {},
) {
  const raw = body ? JSON.stringify(body) : "",
    method = body ? "POST" : "GET",
    time = String(Date.now()),
    nonce = newId();
  const value = `${time}\n${nonce}\n${method}\n/api/v1${path}\n${await sha256Hex(raw)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(testKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  const signature = Array.from(digest, (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const headers: Record<string, string> = {
    origin: options.origin ?? admin,
    "cf-connecting-ip": `192.0.2.${++requestNumber}`,
    "idempotency-key": idempotencyKey,
  };
  if (options.signed !== false)
    headers.authorization = `MotorBaldi-Development ${keyId}:1:${time}:${nonce}:${signature}`;
  if (body) headers["content-type"] = "application/json";
  return worker.fetch!(
    new Request(api + "/api/v1" + path, {
      method,
      headers,
      ...(body ? { body: raw } : {}),
    }) as never,
    options.bindings ?? bindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}
async function call(path: string, body?: object, key?: string) {
  const response = await signed(path, body, key);
  const json = (await response.json()) as Record<string, unknown>;
  expect(response.status, `${path}: ${JSON.stringify(json)}`).toBe(200);
  return json;
}
async function count(table: string, where = "1=1") {
  return Number(
    (await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .first<{ n: number }>())!.n,
  );
}
beforeAll(async () => {
  for (const migration of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m9,
    m10,
    m11,
    m12,
    m13,
    m14,
    m15,
    m16,
    m17,
    m18,
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'development')",
    )
    .run();
  await db.batch([
    db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Synthetic','Development')",
      )
      .bind(personId),
    db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Synthetic Development',?,1,0)",
      )
      .bind(accountId, `${accountId}@example.test`),
    db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(accountId, personId),
    db
      .prepare(
        "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'WORKSHOP','Synthetic Development','MotorBaldi Development Validation Workshop','CO','VERIFIED',?)",
      )
      .bind(organizationId, personId),
    db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'MotorBaldi Development Workshop Site','SERVICE_SITE','CO','Synthetic','Synthetic','Synthetic')",
      )
      .bind(locationId, organizationId),
    db
      .prepare(
        "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'GENERAL_MAINTENANCE')",
      )
      .bind(organizationId),
    db
      .prepare(
        "INSERT INTO development_automation_identities(key_id,name,account_id,credential_version,status,organization_id,location_id,expires_at) VALUES(?,'development-validation',?,1,'ACTIVE',?,?,'2099-01-01T00:00:00.000Z')",
      )
      .bind(keyId, accountId, organizationId, locationId),
    db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-development-automation')",
      )
      .bind(personId),
    db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'SELECTED_LOCATIONS')",
      )
      .bind(membershipId, organizationId, personId),
    db
      .prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      )
      .bind(membershipId, organizationId, locationId),
    db
      .prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-development-automation')",
      )
      .bind(membershipId),
  ]);
});
describe("signed Development automation through actual API and coordinator", () => {
  it("fails closed for unsigned, other environments, unrelated routes and foreign resources", async () => {
    expect(
      (await signed("/me", undefined, undefined, { signed: false })).status,
    ).toBe(401);
    for (const environment of ["staging", "production"] as const)
      await expect(
        authenticateDevelopmentAutomation(
          new Request(api + "/api/v1/me", {
            headers: { authorization: "MotorBaldi-Development invalid" },
          }) as never,
          { ...bindings, ENVIRONMENT: environment },
          newId(),
        ),
      ).rejects.toMatchObject({ status: 403 });
    expect((await signed("/admin/accounts")).status).toBe(403);
    expect(
      (await signed(`/organizations/${newId()}/parts-offerings`)).status,
    ).toBe(404);
    expect((await signed(`/admin/parts/${newId()}`)).status).toBe(404);
    const me = await call("/me");
    expect(me).toMatchObject({
      accountId,
      personId,
      mfaEnabled: false,
      authenticationMethod: "DEVELOPMENT_AUTOMATION",
    });
    expect(await count("auth_two_factors")).toBe(0);
    expect(await count("auth_credentials")).toBe(0);
    expect(
      await count(
        "platform_person_roles",
        "role_id IN (SELECT id FROM authz_roles WHERE code='PLATFORM_SUPERADMIN')",
      ),
    ).toBe(0);
  });
  it("executes isolated Parts lifecycle atomically with replay and frozen Workshop prices", async () => {
    const enableBody = {
        organizationId,
        locationId,
        reason: "Synthetic Development PARTS fixture enable",
      },
      enableKey = newId();
    const enabled = await call(
      "/development/automation/fixtures/parts/enable",
      enableBody,
      enableKey,
    );
    const eventsAfterEnable = await count("integration_outbox_events");
    const enabledReplay = await call(
      "/development/automation/fixtures/parts/enable",
      enableBody,
      enableKey,
    );
    expect(enabledReplay).toMatchObject({ ...enabled, replayed: true });
    expect(await count("integration_outbox_events")).toBe(eventsAfterEnable);
    expect(
      (
        await db
          .prepare(
            "SELECT code FROM org_capabilities WHERE organization_id=? ORDER BY code",
          )
          .bind(organizationId)
          .all()
      ).results,
    ).toEqual([{ code: "GENERAL_MAINTENANCE" }, { code: "PARTS" }]);
    const data = {
      name: "Synthetic Development Parts fixture",
      category: "VALIDATION",
      brand: "Synthetic Development",
      manufacturerReference: newId(),
      description: reason,
      unit: "UNIT",
      compatibility: [],
    };
    const createKey = newId();
    const beforeCreate = await count("integration_outbox_events");
    expect(
      (
        await signed("/admin/parts", { ...data, reason }, undefined, {
          origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
    const canonical = await call(
      "/admin/parts",
      { ...data, reason },
      createKey,
    );
    expect(canonical).toMatchObject({ version: 1 });
    const partId = String(canonical.partId),
      partPath = "/admin/parts/" + partId;
    const replay = await call("/admin/parts", { ...data, reason }, createKey);
    expect(replay).toMatchObject({ partId, replayed: true });
    expect(await count("integration_outbox_events")).toBe(beforeCreate + 1);
    expect(
      (
        await signed(
          "/admin/parts",
          { ...data, name: "Synthetic mismatch", reason },
          createKey,
        )
      ).status,
    ).toBe(409);
    await call(partPath + "/transition", {
      version: 1,
      toStatus: "ACTIVE",
      reason,
    });
    expect(
      (
        await signed(partPath + "/transition", {
          version: 1,
          toStatus: "ACTIVE",
          reason,
        })
      ).status,
    ).toBe(409);
    await call(partPath + "/update", { ...data, version: 2, reason });
    const vehicle = await call("/admin/vehicles", {
      kindCode: "CAR",
      specification: {
        brand: "Synthetic Development",
        model: "Parts validation " + newId(),
      },
      reason,
    });
    const vehicleId = String(vehicle.vehicleId);
    for (const permissionCode of [
      "vehicle.workshop.read",
      "vehicle.workshop.write",
    ])
      await call(`/admin/vehicles/${vehicleId}/grants`, {
        organizationId,
        locationId,
        permissionCode,
        reason,
      });
    const order = await call(base + "/workshop/orders", {
      vehicleId,
      locationId,
      description: reason + " " + newId(),
      reason,
    });
    const orderId = String(order.orderId),
      orderPath = base + "/workshop/orders/" + orderId;
    expect(
      await db
        .prepare("SELECT assigned_person_id FROM workshop_orders WHERE id=?")
        .bind(orderId)
        .first(),
    ).toMatchObject({ assigned_person_id: null });
    const offerData = {
      ...data,
      locationId,
      canonicalPartId: partId,
      priceMinor: 12345,
      currency: "COP",
      availability: "AVAILABLE",
    };
    const offering = await call(base + "/parts-offerings", {
      ...offerData,
      reason,
    });
    const offeringId = String(offering.offeringId),
      offeringPath = base + "/parts-offerings/" + offeringId;
    await call(offeringPath + "/transition", {
      version: 1,
      toStatus: "ACTIVE",
      reason,
    });
    const snapshotKey = newId(),
      snapshotBody = { offeringId, version: 1, reason };
    const snapshot = await call(
      orderPath + "/parts",
      snapshotBody,
      snapshotKey,
    );
    expect(snapshot).toMatchObject({ version: 2 });
    const snapshotReplay = await call(
      orderPath + "/parts",
      snapshotBody,
      snapshotKey,
    );
    expect(snapshotReplay).toMatchObject({
      snapshotId: snapshot.snapshotId,
      replayed: true,
    });
    await call(offeringPath + "/update", {
      ...offerData,
      priceMinor: 54321,
      version: 2,
      reason,
    });
    const snapshotRows = await db
      .prepare("SELECT snapshot_json FROM parts_workshop_snapshots WHERE id=?")
      .bind(snapshot.snapshotId)
      .first<{ snapshot_json: string }>();
    expect(JSON.parse(snapshotRows!.snapshot_json)).toMatchObject({
      priceMinor: 12345,
    });
    await call(offeringPath + "/transition", {
      version: 3,
      toStatus: "INACTIVE",
      reason,
    });
    await call(orderPath + "/transition", {
      version: 2,
      toStatus: "CANCELLED",
      reason,
    });
    await call(partPath + "/transition", {
      version: 3,
      toStatus: "ARCHIVED",
      reason,
    });
    expect(await count("parts_canonical")).toBe(1);
    expect(await count("parts_offerings")).toBe(1);
    expect(await count("parts_workshop_snapshots")).toBe(1);
    expect(await count("development_automation_resources")).toBe(7);
    expect(await count("governance_audit_events")).toBeGreaterThanOrEqual(12);
    expect(
      await count("governance_idempotency_records"),
    ).toBeGreaterThanOrEqual(12);
    expect(await count("integration_outbox_events")).toBeGreaterThanOrEqual(12);
    expect(
      (
        await db
          .prepare(
            "SELECT account_id FROM development_automation_resources GROUP BY account_id",
          )
          .all()
      ).results,
    ).toEqual([{ account_id: accountId }]);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(
      await count(
        "governance_security_events",
        "code='DEVELOPMENT_AUTOMATION_AUTHENTICATED'",
      ),
    ).toBeGreaterThan(10);
    expect(await count("auth_two_factors")).toBe(0);
  });
  it("rolls back replay, ownership and effects when assurance is revoked before commit", async () => {
    const contextId = newId(),
      resourceId = newId(),
      requestId = newId(),
      key = newId();
    await db
      .prepare(
        "INSERT INTO development_automation_authorizations(id,account_id,credential_version,operation,request_hash,expires_at) VALUES(?,?,1,'vehicle.create',?,'2099-01-01T00:00:00.000Z')",
      )
      .bind(contextId, accountId, "0".repeat(64))
      .run();
    const actor = {
      accountId,
      personId,
      mfaEnabled: false,
      automationAuthorizationId: contextId,
    };
    const currentScope = buildIdempotencyScope({
      accountId,
      operation: "vehicle.create",
    });
    const replay = await prepareReplayStatement(
      db,
      currentScope,
      key,
      { reason },
      { vehicleId: resourceId },
    );
    const ownership = automationResourceClaim(db, actor, "vehicle.create", {
      vehicleId: resourceId,
    });
    const guard = automationCommitGuard(db, actor, "vehicle.create", requestId);
    const auditBefore = await count("governance_audit_events"),
      replayBefore = await count("governance_idempotency_records"),
      ownershipBefore = await count("development_automation_resources");
    await db
      .prepare(
        "UPDATE development_automation_identities SET status='REVOKED' WHERE account_id=?",
      )
      .bind(accountId)
      .run();
    await expect(
      db.batch([
        replay,
        ...ownership,
        guard,
        db
          .prepare(
            "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'DIAGNOSTICS')",
          )
          .bind(organizationId),
      ]),
    ).rejects.toThrow();
    expect(await count("governance_idempotency_records")).toBe(replayBefore);
    expect(await count("development_automation_resources")).toBe(
      ownershipBefore,
    );
    expect(await count("governance_audit_events")).toBe(auditBefore);
    expect(await count("org_capabilities", "code='DIAGNOSTICS'")).toBe(0);
    expect((await signed("/me")).status).toBe(403);
    await db
      .prepare(
        "UPDATE development_automation_identities SET status='ACTIVE' WHERE account_id=?",
      )
      .bind(accountId)
      .run();
  });
});
