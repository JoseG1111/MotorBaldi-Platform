import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { hasVehiclePermission } from "../../packages/vehicles/src/index.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import vehicleCore from "../../migrations/0004_vehicle_core.sql?raw";
import vehicleAccess from "../../migrations/0005_vehicle_access.sql?raw";

const db = (env as unknown as ApiBindings).DB;

beforeAll(async () => {
  for (const sql of [foundation, phase1, closeout, vehicleCore, vehicleAccess])
    await db.exec(sql.replace(/\n/g, " "));
});

describe("Vehicle identifiers and explicit access", () => {
  const actor = { accountId: newId(), personId: newId() };
  const orgId = newId();
  const membershipId = newId();
  const allowedLocation = newId();
  const otherLocation = newId();
  const vehicleId = newId();

  beforeAll(async () => {
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
      )
      .bind(actor.accountId, "Vehicle Test", "vehicle-test@example.test")
      .run();
    await db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Vehicle','Test')",
      )
      .bind(actor.personId)
      .run();
    await db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(actor.accountId, actor.personId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id) VALUES(?,'WORKSHOP','Vehicle Test Workshop','Vehicle Test Workshop','US',?)",
      )
      .bind(orgId, actor.personId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'SELECTED_LOCATIONS')",
      )
      .bind(membershipId, orgId, actor.personId)
      .run();
    for (const [id, name] of [
      [allowedLocation, "Allowed"],
      [otherLocation, "Other"],
    ])
      await db
        .prepare(
          "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?, ?, ?, 'SERVICE_SITE', 'US', 'Test', 'Test', 'Synthetic')",
        )
        .bind(id, orgId, name)
        .run();
    await db
      .prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      )
      .bind(membershipId, orgId, allowedLocation)
      .run();
    await db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
      .bind(vehicleId)
      .run();
  });

  it("keeps historical identifiers separate from identity and access", async () => {
    const prior = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_identifiers(id,vehicle_id,identifier_type,country_code,raw_value,normalized_value,recorded_at,retired_at) VALUES(?,?,'PLATE','US','OLD 123','OLD123','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')",
      )
      .bind(prior, vehicleId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_identifiers(id,vehicle_id,identifier_type,country_code,raw_value,normalized_value,recorded_at) VALUES(?,?,'PLATE','US','NEW 456','NEW456','2026-02-01T00:00:00.000Z')",
      )
      .bind(newId(), vehicleId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_garage_entries(person_id,vehicle_id) VALUES(?,?)",
      )
      .bind(actor.personId, vehicleId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_claims(id,vehicle_id,relationship_type,claimant_person_id,submitted_by_person_id) VALUES(?,?,'OWNER',?,?)",
      )
      .bind(newId(), vehicleId, actor.personId, actor.personId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_relationships(id,vehicle_id,relationship_type,person_id) VALUES(?,?,'OWNER',?)",
      )
      .bind(newId(), vehicleId, actor.personId)
      .run();
    const rows = await db
      .prepare(
        "SELECT raw_value,retired_at FROM vehicle_identifiers WHERE vehicle_id=? ORDER BY recorded_at",
      )
      .bind(vehicleId)
      .all<{ raw_value: string; retired_at: string | null }>();
    expect(rows.results.map((row) => row.raw_value)).toEqual([
      "OLD 123",
      "NEW 456",
    ]);
    expect(rows.results[0]?.retired_at).toBeTruthy();
    await expect(
      db
        .prepare(
          "UPDATE vehicle_identifiers SET raw_value='ALTERED' WHERE id=?",
        )
        .bind(prior)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM vehicle_identifiers WHERE id=?")
        .bind(prior)
        .run(),
    ).rejects.toThrow();
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(false);
  });

  it("requires an active, exact person grant", async () => {
    const grantId = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
      )
      .bind(grantId, vehicleId, actor.personId, actor.accountId)
      .run();
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(true);
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.manage"),
    ).toBe(false);
    expect(
      await hasVehiclePermission(
        db,
        { ...actor, accountId: newId() },
        vehicleId,
        "vehicle.read",
      ),
    ).toBe(false);
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      )
      .bind(grantId)
      .run();
    await expect(
      db
        .prepare("UPDATE vehicle_access_grants SET revoked_at=NULL WHERE id=?")
        .bind(grantId)
        .run(),
    ).rejects.toThrow();
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(false);
  });

  it("applies organization membership and location scope to grants", async () => {
    const grantId = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,'vehicle.read',?)",
      )
      .bind(grantId, vehicleId, orgId, otherLocation, actor.accountId)
      .run();
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(false);
    await db
      .prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      )
      .bind(membershipId, orgId, otherLocation)
      .run();
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(true);
    await db
      .prepare("UPDATE org_memberships SET status='SUSPENDED' WHERE id=?")
      .bind(membershipId)
      .run();
    expect(
      await hasVehiclePermission(db, actor, vehicleId, "vehicle.read"),
    ).toBe(false);
  });

  it("rejects a cross-organization location on a grant", async () => {
    const foreignOrg = newId();
    await db
      .prepare(
        "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id) VALUES(?,'OTHER','Other Org','Other Org','US',?)",
      )
      .bind(foreignOrg, actor.personId)
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,'vehicle.read',?)",
        )
        .bind(newId(), vehicleId, foreignOrg, allowedLocation, actor.accountId)
        .run(),
    ).rejects.toThrow();
  });
});

describe("Vehicle Core schema", () => {
  it("stores a central vehicle without an owner, garage, or identifier", async () => {
    const id = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_vehicles(id,kind_code,specification_json) VALUES(?,?,?)",
      )
      .bind(id, "MOTORCYCLE", JSON.stringify({ propulsion: "electric" }))
      .run();
    const row = await db
      .prepare(
        "SELECT id,kind_code,specification_json,version,created_at FROM vehicle_vehicles WHERE id=?",
      )
      .bind(id)
      .first<{
        id: string;
        kind_code: string;
        specification_json: string;
        version: number;
        created_at: string;
      }>();
    expect(row).toMatchObject({ id, kind_code: "MOTORCYCLE", version: 1 });
    expect(JSON.parse(row!.specification_json)).toEqual({
      propulsion: "electric",
    });
    expect(row!.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    const columns = await db
      .prepare("PRAGMA table_info(vehicle_vehicles)")
      .all<{
        name: string;
      }>();
    expect(columns.results.map((column) => column.name)).not.toEqual(
      expect.arrayContaining([
        "person_id",
        "account_id",
        "organization_id",
        "vin",
        "plate",
      ]),
    );
  });

  it("rejects non-v7 IDs, malformed kind codes, and non-object specifications", async () => {
    const insert = (id: string, kind: string, spec: string) =>
      db
        .prepare(
          "INSERT INTO vehicle_vehicles(id,kind_code,specification_json) VALUES(?,?,?)",
        )
        .bind(id, kind, spec)
        .run();
    await expect(
      insert("550e8400-e29b-41d4-a716-446655440000", "CAR", "{}"),
    ).rejects.toThrow();
    await expect(insert(newId(), "bad kind", "{}")).rejects.toThrow();
    await expect(insert(newId(), "CAR", "[]")).rejects.toThrow();
    await expect(insert(newId(), "CAR", "not-json")).rejects.toThrow();
  });

  it("requires a one-step version advance on update", async () => {
    const id = newId();
    await db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,?)")
      .bind(id, "OTHER")
      .run();
    await expect(
      db
        .prepare("UPDATE vehicle_vehicles SET kind_code='CAR' WHERE id=?")
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE vehicle_vehicles SET kind_code='CAR',version=version+1 WHERE id=? AND version=1",
      )
      .bind(id)
      .run();
    expect(
      (
        await db
          .prepare("SELECT kind_code,version FROM vehicle_vehicles WHERE id=?")
          .bind(id)
          .first<{ kind_code: string; version: number }>()
      )?.version,
    ).toBe(2);
  });
});
