import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { requireWorkshopPermission } from "@motorbaldi/workshops";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import core from "../../migrations/0004_vehicle_core.sql?raw";
import access from "../../migrations/0005_vehicle_access.sql?raw";
import history from "../../migrations/0006_vehicle_history.sql?raw";
import commands from "../../migrations/0007_vehicle_commands.sql?raw";
import workshops from "../../migrations/0008_workshop_operations.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const personId = newId(),
  accountId = newId(),
  organizationId = newId(),
  locationId = newId(),
  otherLocationId = newId(),
  vehicleId = newId(),
  membershipId = newId();
const actor = { personId, accountId, mfaEnabled: true };
const context = { organizationId, locationId, vehicleId };
beforeAll(async () => {
  for (const sql of [
    foundation,
    phase1,
    closeout,
    core,
    access,
    history,
    commands,
    workshops,
  ])
    await db.exec(sql.replace(/\n/g, " "));
  await db
    .prepare("INSERT INTO auth_users(id,name,email) VALUES(?,?,?)")
    .bind(accountId, "Workshop Test", "workshop-test@example.test")
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Workshop','Test')",
    )
    .bind(personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(accountId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'OTHER','Workshop Test','Workshop Test','CO','VERIFIED',?)",
    )
    .bind(organizationId, personId)
    .run();
  for (const id of [locationId, otherLocationId])
    await db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Test Site','BRANCH','CO','Test','Test','Synthetic')",
      )
      .bind(id, organizationId)
      .run();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'SELECTED_LOCATIONS')",
    )
    .bind(membershipId, organizationId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-owner')",
    )
    .bind(membershipId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
    )
    .bind(membershipId, organizationId, locationId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'GENERAL_MAINTENANCE')",
    )
    .bind(organizationId)
    .run();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(vehicleId)
    .run();
});
async function order() {
  const id = newId();
  await db
    .prepare(
      "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,assigned_person_id,created_by_account_id) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      vehicleId,
      organizationId,
      locationId,
      "Synthetic Workshop work",
      personId,
      accountId,
    )
    .run();
  return id;
}
describe("Workshop persistence and authorization", () => {
  it("requires both location-scoped organization authorization and an exact vehicle grant", async () => {
    await expect(
      requireWorkshopPermission(db, actor, context, "org.workshop.read"),
    ).rejects.toMatchObject({ status: 404 });
    const grantId = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,'vehicle.workshop.read',?)",
      )
      .bind(grantId, vehicleId, organizationId, locationId, accountId)
      .run();
    await expect(
      requireWorkshopPermission(db, actor, context, "org.workshop.read"),
    ).resolves.toBeUndefined();
    await expect(
      requireWorkshopPermission(
        db,
        actor,
        { ...context, locationId: otherLocationId },
        "org.workshop.read",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requireWorkshopPermission(
        db,
        actor,
        context,
        "org.workshop.manage",
        true,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      )
      .bind(grantId)
      .run();
    await expect(
      requireWorkshopPermission(db, actor, context, "org.workshop.read"),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("keeps organization vehicle grants tied to the resource location even for all-location members", async () => {
    await db
      .prepare(
        "UPDATE org_memberships SET location_scope_type='ALL_LOCATIONS',version=version+1 WHERE id=?",
      )
      .bind(membershipId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,'vehicle.workshop.read',?)",
      )
      .bind(newId(), vehicleId, organizationId, locationId, accountId)
      .run();
    await expect(
      requireWorkshopPermission(db, actor, context, "org.workshop.read"),
    ).resolves.toBeUndefined();
    await expect(
      requireWorkshopPermission(
        db,
        actor,
        { ...context, locationId: otherLocationId },
        "org.workshop.read",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects skipped transitions, scope changes and terminal edits", async () => {
    const id = await order();
    await expect(
      db
        .prepare(
          "UPDATE workshop_orders SET status='COMPLETED',version=version+1 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE workshop_orders SET location_id=?,version=version+1 WHERE id=?",
        )
        .bind(otherLocationId, id)
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='OPEN',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='CANCELLED',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE workshop_orders SET description='Changed terminal description',version=version+1 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      db.prepare("DELETE FROM workshop_orders WHERE id=?").bind(id).run(),
    ).rejects.toThrow();
  });
  it("requires a matching immutable final professional completion record", async () => {
    const id = await order(),
      recordId = newId();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='OPEN',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='IN_PROGRESS',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,'SERVICE','{}')",
      )
      .bind(recordId, vehicleId, organizationId, locationId, personId)
      .run();
    const complete = () =>
      db
        .prepare(
          "UPDATE workshop_orders SET status='COMPLETED',final_record_id=?,version=version+1 WHERE id=?",
        )
        .bind(recordId, id)
        .run();
    await expect(complete()).rejects.toThrow();
    await db
      .prepare(
        "UPDATE vehicle_professional_records SET status='FINAL',finalized_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=?",
      )
      .bind(recordId)
      .run();
    await complete();
    await db
      .prepare(
        "UPDATE workshop_orders SET status='CLOSED',version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE workshop_orders SET status='OPEN',version=version+1 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow();
  });
  it("retains append-only operational transition evidence", async () => {
    const orderId = await order(),
      eventId = newId();
    await db
      .prepare(
        "INSERT INTO workshop_order_events(id,order_id,to_status,version,actor_account_id,reason) VALUES(?,?,'DRAFT',1,?,'Synthetic creation')",
      )
      .bind(eventId, orderId, accountId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE workshop_order_events SET reason='Rewritten history' WHERE id=?",
        )
        .bind(eventId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM workshop_order_events WHERE id=?")
        .bind(eventId)
        .run(),
    ).rejects.toThrow();
  });
});
