import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { workshopRoutes } from "../../apps/api/src/workshop-routes.js";
import { inspectionRoutes } from "../../apps/api/src/inspection-routes.js";
import { requireWorkshopPermission } from "@motorbaldi/workshops";
import {
  inspectionRecord,
  requireInspectionRead,
} from "@motorbaldi/inspections";
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
    .prepare(
      "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'INSPECTION')",
    )
    .bind(organizationId)
    .run();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(vehicleId)
    .run();
});

const bindings = env as unknown as ApiBindings;
async function list(
  kind: "workshop" | "inspection",
  cursor?: string,
  location?: string,
) {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (location) params.set("locationId", location);
  const request = new Request(
    `https://api.test/api/v1/organizations/${organizationId}/${kind === "workshop" ? "workshop/orders" : "inspections"}?${params}`,
  );
  const unused = async () => {
    throw new Error("Read routes must not execute commands");
  };
  const route = kind === "workshop" ? workshopRoutes : inspectionRoutes;
  const response = await route(
    request,
    db,
    bindings.PRIVATE_BUCKET,
    async () => actor,
    unused,
    unused,
    {},
  );
  return (await response!.json()) as {
    items: { id: string }[];
    nextCursor: string | null;
  };
}
function id(index: number) {
  return `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}
async function fixtures() {
  const deniedVehicle = newId();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(deniedVehicle)
    .run();
  for (const permission of ["vehicle.workshop.read", "vehicle.record.read"])
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        newId(),
        vehicleId,
        organizationId,
        locationId,
        permission,
        accountId,
      )
      .run();
  for (const permission of ["vehicle.workshop.read", "vehicle.record.read"])
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id,granted_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        newId(),
        deniedVehicle,
        organizationId,
        locationId,
        permission,
        accountId,
        "1999-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
      )
      .run();
  const otherAuthor = newId();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Other','Author')",
    )
    .bind(otherAuthor)
    .run();
  await db
    .prepare(
      "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,'INSPECTION',?)",
    )
    .bind(
      id(0),
      vehicleId,
      organizationId,
      locationId,
      otherAuthor,
      JSON.stringify({
        schemaVersion: 1,
        summary: "Private draft",
        findings: [],
      }),
    )
    .run();
  const expected: string[] = [];
  // An invisible prefix longer than the page size plus interspersed denied rows.
  for (let index = 1; index <= 120; index++) {
    const allowed = index > 35 && index % 4 !== 0;
    const vehicle = allowed ? vehicleId : deniedVehicle;
    if (allowed) expected.push(id(index));
    await db
      .prepare(
        "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,created_by_account_id) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        id(index),
        vehicle,
        organizationId,
        locationId,
        "Synthetic pagination work",
        accountId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,'INSPECTION',?)",
      )
      .bind(
        id(index),
        vehicle,
        organizationId,
        locationId,
        personId,
        JSON.stringify({
          schemaVersion: 1,
          summary: "Synthetic pagination report",
          findings: [],
        }),
      )
      .run();
  }
  return expected;
}
let expected: string[];
beforeAll(async () => {
  expected = await fixtures();
});
describe("Authorization-aware organization pagination", () => {
  for (const kind of ["workshop", "inspection"] as const) {
    it(`${kind} reaches every authorized row beyond an invisible prefix with bounded unique pages`, async () => {
      let cursor: string | undefined;
      const seen: string[] = [];
      for (let page = 0; page < 5; page++) {
        const result = await list(kind, cursor);
        expect(result.items.length).toBeLessThanOrEqual(30);
        for (const item of result.items) {
          expect(expected).toContain(item.id);
          if (kind === "workshop")
            await requireWorkshopPermission(
              db,
              actor,
              { organizationId, locationId, vehicleId },
              "org.workshop.read",
            );
          else
            await requireInspectionRead(
              db,
              actor,
              await inspectionRecord(db, item.id),
            );
        }
        seen.push(...result.items.map((item) => item.id));
        if (!result.nextCursor) break;
        expect(result.items.map((item) => item.id)).toContain(
          result.nextCursor,
        );
        expect(result.nextCursor).not.toBe(cursor);
        cursor = result.nextCursor;
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      expect(await list(kind, undefined, otherLocationId)).toEqual({
        items: [],
        nextCursor: null,
      });
      await db
        .prepare("DELETE FROM org_membership_locations WHERE membership_id=?")
        .bind(membershipId)
        .run();
      expect(await list(kind)).toEqual({ items: [], nextCursor: null });
      await db
        .prepare(
          "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
        )
        .bind(membershipId, organizationId, locationId)
        .run();
      // SQL preselection must preserve canonical account/person and temporal scope.
      for (const [disable, restore] of [
        [
          "UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?",
          "UPDATE iam_accounts SET status='ACTIVE' WHERE id=?",
        ],
      ]) {
        await db.prepare(disable!).bind(accountId).run();
        expect(await list(kind)).toEqual({ items: [], nextCursor: null });
        await db.prepare(restore!).bind(accountId).run();
      }
      await db
        .prepare("UPDATE iam_people SET status='PROVISIONAL' WHERE id=?")
        .bind(personId)
        .run();
      expect(await list(kind)).toEqual({ items: [], nextCursor: null });
      await db
        .prepare("UPDATE iam_people SET status='ACTIVE' WHERE id=?")
        .bind(personId)
        .run();
      await db
        .prepare(
          "UPDATE org_memberships SET valid_from='2999-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(membershipId)
        .run();
      expect(await list(kind)).toEqual({ items: [], nextCursor: null });
      await db
        .prepare(
          "UPDATE org_memberships SET valid_from='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(membershipId)
        .run();
      await db
        .prepare(
          "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND permission_code=?",
        )
        .bind(
          vehicleId,
          kind === "workshop" ? "vehicle.workshop.read" : "vehicle.record.read",
        )
        .run();
      expect(await list(kind)).toEqual({ items: [], nextCursor: null });
    });
  }
});
