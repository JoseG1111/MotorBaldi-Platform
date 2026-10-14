import { beforeAll, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import {
  authorizeVehicleCommand,
  parseVehicleCommand,
  prepareVehicleCommand,
  customerVehicleState,
  hasVehiclePermission,
  type VehicleOperation,
} from "@motorbaldi/vehicles";
import m0 from "../../migrations/0001_foundation.sql?raw";
import m1 from "../../migrations/0002_phase1.sql?raw";
import m2 from "../../migrations/0003_phase1_closeout.sql?raw";
import m3 from "../../migrations/0004_vehicle_core.sql?raw";
import m4 from "../../migrations/0005_vehicle_access.sql?raw";
import m5 from "../../migrations/0006_vehicle_history.sql?raw";
import m6 from "../../migrations/0007_vehicle_commands.sql?raw";
import m7 from "../../migrations/0008_workshop_operations.sql?raw";
import m8 from "../../migrations/0009_workshop_files.sql?raw";
import m9 from "../../migrations/0010_inspection_media.sql?raw";
import m10 from "../../migrations/0011_inspection_workflow.sql?raw";
import m11 from "../../migrations/0012_billing_membership.sql?raw";
import m12 from "../../migrations/0013_payment_provider_evidence.sql?raw";
import m13 from "../../migrations/0014_notifications.sql?raw";
import m14 from "../../migrations/0015_support.sql?raw";
import m15 from "../../migrations/0016_support_history_boundary.sql?raw";
import m16 from "../../migrations/0017_parts_catalog.sql?raw";
import m17 from "../../migrations/0018_development_automation.sql?raw";
import m18 from "../../migrations/0019_marketplace_discovery.sql?raw";
import m19 from "../../migrations/0020_customer_plans.sql?raw";
import m20 from "../../migrations/0021_vehicle_services.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const actor = { accountId: newId(), personId: newId(), mfaEnabled: false };
beforeAll(async () => {
  for (const sql of [
    m0,
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
    m19,
    m20,
  ])
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email) VALUES(?,'Synthetic owner','owner-services@example.test')",
    )
    .bind(actor.accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Owner','Synthetic')",
    )
    .bind(actor.personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(actor.accountId, actor.personId)
    .run();
});
async function run(operation: VehicleOperation, input: unknown) {
  const body = parseVehicleCommand(operation, input);
  await authorizeVehicleCommand(db, actor, operation, body);
  const command = await prepareVehicleCommand(
    db,
    actor,
    operation,
    body,
    newId(),
  );
  await db.batch(command.statements);
  return command.response;
}
let vehicleId: string;
describe("Customer vehicle canonical services", () => {
  it("Free registration creates declared OWNER and explicit grants, rejects second and staff escalation", async () => {
    const result = await run("vehicle.customer.register", {
      kindCode: "CAR",
      specification: { make: "Synthetic", model: "Test" },
    });
    vehicleId = String(result.vehicleId);
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(true);
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.record.write"),
    ).toBe(false);
    const relationship = await db
      .prepare(
        "SELECT source_claim_id FROM vehicle_relationships WHERE vehicle_id=?",
      )
      .bind(vehicleId)
      .first();
    expect(relationship?.source_claim_id).toBe(null);
    await expect(
      run("vehicle.customer.register", {
        kindCode: "CAR",
        specification: { make: "Other", model: "Test" },
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_PLAN_LIMIT" });
    await expect(
      run("vehicle.create", { kindCode: "CAR", reason: "Not authorized" }),
    ).rejects.toBeDefined();
  });
  it("expiry updates retain immutable history and never accept client verified claims or invalid calendar dates", async () => {
    await run("vehicle.compliance.update", {
      vehicleId,
      documentType: "SOAT",
      expiresOn: "2030-01-10",
      provider: "User supplied",
    });
    await run("vehicle.compliance.update", {
      vehicleId,
      documentType: "SOAT",
      expiresOn: "2031-01-10",
    });
    const rows = await db
      .prepare(
        "SELECT information_source,verification_status FROM vehicle_compliance_entries WHERE vehicle_id=?",
      )
      .bind(vehicleId)
      .all();
    expect(rows.results).toHaveLength(2);
    expect(
      rows.results.every((r) => r.verification_status === "USER_ENTERED"),
    ).toBe(true);
    expect(() =>
      parseVehicleCommand("vehicle.compliance.update", {
        vehicleId,
        documentType: "RTM",
        expiresOn: "2030-02-30",
      }),
    ).toThrow();
    expect(() =>
      parseVehicleCommand("vehicle.compliance.update", {
        vehicleId,
        documentType: "RTM",
        expiresOn: "2030-02-28",
        verificationStatus: "VERIFIED",
      }),
    ).toThrow();
    await expect(
      db
        .prepare("DELETE FROM vehicle_compliance_entries WHERE vehicle_id=?")
        .bind(vehicleId)
        .run(),
    ).rejects.toThrow();
  });
  it("Free five manual entries enforce canonical cap and atomic duplicate prepared commands", async () => {
    for (let n = 0; n < 4; n++)
      await run("vehicle.maintenance.append", {
        vehicleId,
        performedOn: "2026-01-01",
        title: "Synthetic maintenance",
      });
    const body = parseVehicleCommand("vehicle.maintenance.append", {
      vehicleId,
      performedOn: "2026-01-02",
      title: "Race",
    });
    const first = await prepareVehicleCommand(
        db,
        actor,
        "vehicle.maintenance.append",
        body,
        newId(),
      ),
      second = await prepareVehicleCommand(
        db,
        actor,
        "vehicle.maintenance.append",
        body,
        newId(),
      );
    await db.batch(first.statements);
    await expect(db.batch(second.statements)).rejects.toThrow();
    await expect(run("vehicle.maintenance.append", body)).rejects.toMatchObject(
      { code: "MAINTENANCE_PLAN_LIMIT" },
    );
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) n FROM vehicle_manual_maintenance")
          .first()
      )?.n,
    ).toBe(5);
  });
  it("real granted Premium permits three and unlimited maintenance; suspended downgrade preserves extra history read-only", async () => {
    const subscription = newId();
    await db
      .prepare(
        "INSERT INTO billing_subscriptions(id,account_id,plan_code,status) VALUES(?,?,'ACOMPANAMIENTO_MONTHLY','PENDING_ACTIVATION')",
      )
      .bind(subscription, actor.accountId)
      .run();
    await db
      .prepare(
        "INSERT INTO billing_admin_grants(id,subscription_id,starts_at,ends_at,authorized_by_account_id,reason) VALUES(?,?,'2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',?,'Synthetic authorized fixture')",
      )
      .bind(newId(), subscription, actor.accountId)
      .run();
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='ACTIVE',current_period_start='2020-01-01T00:00:00.000Z',current_period_end='2099-01-01T00:00:00.000Z',version=version+1 WHERE id=?",
      )
      .bind(subscription)
      .run();
    const second = await run("vehicle.customer.register", {
      kindCode: "CAR",
      specification: { make: "Second", model: "Test" },
    });
    await run("vehicle.customer.register", {
      kindCode: "MOTORCYCLE",
      specification: { make: "Third", model: "Test" },
    });
    await expect(
      run("vehicle.customer.register", {
        kindCode: "CAR",
        specification: { make: "Fourth", model: "Test" },
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_PLAN_LIMIT" });
    for (let n = 0; n < 8; n++)
      await run("vehicle.maintenance.append", {
        vehicleId,
        performedOn: "2026-02-01",
        title: "Premium maintenance",
      });
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(subscription)
      .run();
    expect(
      (await customerVehicleState(db, actor, String(second.vehicleId)))
        .writable,
    ).toBe(false);
    expect(
      await hasVehiclePermission(
        db,
        actor,
        String(second.vehicleId),
        "vehicle.read",
      ),
    ).toBe(true);
    await expect(
      run("vehicle.compliance.update", {
        vehicleId: second.vehicleId,
        documentType: "RTM",
        expiresOn: "2030-01-01",
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_PLAN_READ_ONLY" });
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) n FROM vehicle_manual_maintenance")
          .first()
      )?.n,
    ).toBe(13);
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='ACTIVE',version=version+1 WHERE id=?",
      )
      .bind(subscription)
      .run();
    expect(
      (await customerVehicleState(db, actor, String(second.vehicleId)))
        .writable,
    ).toBe(true);
  });
  it("retiring owned declarations frees the Free slot without deleting history or read grants", async () => {
    const subscription = await db
      .prepare("SELECT id FROM billing_subscriptions WHERE account_id=?")
      .bind(actor.accountId)
      .first<{ id: string }>();
    await db
      .prepare(
        "UPDATE billing_subscriptions SET status='SUSPENDED',version=version+1 WHERE id=?",
      )
      .bind(subscription!.id)
      .run();
    const rows = await db
      .prepare(
        "SELECT DISTINCT vehicle_id FROM vehicle_relationships WHERE person_id=? AND ended_at IS NULL",
      )
      .bind(actor.personId)
      .all<{ vehicle_id: string }>();
    for (const row of rows.results)
      await run("vehicle.customer.retire", {
        vehicleId: row.vehicle_id,
        reason: "Synthetic owner retirement",
      });
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(true);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM vehicle_manual_maintenance WHERE vehicle_id=?",
          )
          .bind(vehicleId)
          .first()
      )?.n,
    ).toBe(13);
    const replacement = await run("vehicle.customer.register", {
      kindCode: "CAR",
      specification: { make: "Replacement", model: "Synthetic" },
    });
    expect(
      (await customerVehicleState(db, actor, String(replacement.vehicleId)))
        .writable,
    ).toBe(true);
  });
  async function syntheticActor() {
    const owner = { accountId: newId(), personId: newId(), mfaEnabled: false };
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email) VALUES(?,'Race fixture',?)",
      )
      .bind(owner.accountId, owner.accountId + "@example.test")
      .run();
    await db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Race','Fixture')",
      )
      .bind(owner.personId)
      .run();
    await db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(owner.accountId, owner.personId)
      .run();
    return owner;
  }
  async function prepareFor(
    owner: typeof actor,
    operation: VehicleOperation,
    input: unknown,
  ) {
    const body = parseVehicleCommand(operation, input);
    await authorizeVehicleCommand(db, owner, operation, body);
    return prepareVehicleCommand(db, owner, operation, body, newId());
  }
  it("a prepared registration rejects an account suspended before commit", async () => {
    const owner = await syntheticActor();
    const command = await prepareFor(owner, "vehicle.customer.register", {
      kindCode: "CAR",
      specification: { make: "Race", model: "Fixture" },
    });
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(owner.accountId)
      .run();
    await expect(db.batch(command.statements)).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT 1 FROM vehicle_vehicles WHERE id=?")
        .bind(command.vehicleId)
        .first(),
    ).toBe(null);
  });
  it("prepared compliance and retirement reject read grants revoked before commit", async () => {
    const owner = await syntheticActor();
    const registration = await prepareFor(owner, "vehicle.customer.register", {
      kindCode: "CAR",
      specification: { make: "Race", model: "Fixture" },
    });
    await db.batch(registration.statements);
    const vehicleId = registration.vehicleId;
    const compliance = await prepareFor(owner, "vehicle.compliance.update", {
      vehicleId,
      documentType: "SOAT",
      expiresOn: "2030-01-01",
    });
    const retirement = await prepareFor(owner, "vehicle.customer.retire", {
      vehicleId,
      reason: "Prepared before revoked grant",
    });
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND person_id=? AND permission_code='vehicle.read'",
      )
      .bind(vehicleId, owner.personId)
      .run();
    await expect(db.batch(compliance.statements)).rejects.toThrow();
    await expect(db.batch(retirement.statements)).rejects.toThrow();
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM vehicle_compliance_entries WHERE vehicle_id=?",
          )
          .bind(vehicleId)
          .first()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(
            "SELECT ended_at FROM vehicle_relationships WHERE vehicle_id=?",
          )
          .bind(vehicleId)
          .first()
      )?.ended_at,
    ).toBe(null);
  });
  it("prepared mileage rejects a revoked write grant even when read permission remains", async () => {
    const owner = await syntheticActor();
    const registration = await prepareFor(owner, "vehicle.customer.register", {
      kindCode: "CAR",
      specification: { make: "Race", model: "Fixture" },
    });
    await db.batch(registration.statements);
    const vehicleId = registration.vehicleId;
    const command = await prepareFor(owner, "vehicle.odometer.append", {
      vehicleId,
      value: 100,
      unit: "KILOMETERS",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND person_id=? AND permission_code='vehicle.odometer.write'",
      )
      .bind(vehicleId, owner.personId)
      .run();
    await expect(db.batch(command.statements)).rejects.toThrow();
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM vehicle_odometer_readings WHERE vehicle_id=?",
          )
          .bind(vehicleId)
          .first()
      )?.n,
    ).toBe(0);
  });
});
