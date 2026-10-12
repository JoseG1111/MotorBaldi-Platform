import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import {
  commitPreparedCommand,
  commitIdempotentCommand,
  buildIdempotencyScope,
  readReplay,
} from "@motorbaldi/db";
import {
  prepareCustomerWorkshopCommand,
  parseCustomerWorkshopCommand,
  discoverCustomerWorkshops,
  listCustomerWorkshopContacts,
  listOrganizationWorkshopContacts,
} from "../../packages/workshops/src/customer-contact.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import core from "../../migrations/0004_vehicle_core.sql?raw";
import access from "../../migrations/0005_vehicle_access.sql?raw";
import contacts from "../../migrations/0025_customer_workshop_contacts.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const actor = { accountId: newId(), personId: newId(), mfaEnabled: true };
const other = { accountId: newId(), personId: newId(), mfaEnabled: true };
const organizationId = newId(),
  vehicleId = newId(),
  membershipId = newId();
const body = {
  organizationId,
  vehicleId,
  message: "Please contact me about maintenance.",
  dataSharingConsent: true,
};
beforeAll(async () => {
  for (const sql of [foundation, phase1, closeout, core, access, contacts])
    await db.exec(sql.replace(/\n/g, " "));
  await db.exec(
    "INSERT INTO authz_permissions(code) VALUES ('org.workshop.read'),('org.workshop.manage'); INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('org-owner','org.workshop.read'),('org-owner','org.workshop.manage');",
  );
  for (const a of [actor, other]) {
    await db
      .prepare("INSERT INTO auth_users(id,name,email) VALUES(?,?,?)")
      .bind(a.accountId, "Synthetic", `${a.accountId}@example.test`)
      .run();
    await db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Synthetic','Customer')",
      )
      .bind(a.personId)
      .run();
    await db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(a.accountId, a.personId)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'WORKSHOP','Synthetic Workshop','Synthetic Workshop','CO','VERIFIED',?)",
    )
    .bind(organizationId, actor.personId)
    .run();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(vehicleId)
    .run();
  await db
    .prepare(
      "INSERT INTO vehicle_relationships(id,vehicle_id,relationship_type,person_id) VALUES(?,?,'OWNER',?)",
    )
    .bind(newId(), vehicleId, actor.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
    )
    .bind(newId(), vehicleId, actor.personId, actor.accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'ALL_LOCATIONS')",
    )
    .bind(membershipId, organizationId, actor.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-owner')",
    )
    .bind(membershipId)
    .run();
});
async function create() {
  return commitPreparedCommand(
    db,
    await prepareCustomerWorkshopCommand(
      db,
      actor,
      "workshop.contact.create",
      body,
      newId(),
    ),
  );
}
describe("Free self-service workshop contacts", () => {
  it("requires explicit consent, actual ownership and a canonical read grant", async () => {
    expect(() =>
      parseCustomerWorkshopCommand("workshop.contact.create", {
        ...body,
        dataSharingConsent: false,
      }),
    ).toThrow();
    expect(() =>
      parseCustomerWorkshopCommand("workshop.contact.create", {
        ...body,
        message: "x".repeat(1201),
      }),
    ).toThrow();
    await expect(
      prepareCustomerWorkshopCommand(
        db,
        other,
        "workshop.contact.create",
        body,
        newId(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
      )
      .bind(vehicleId)
      .run();
    await expect(
      prepareCustomerWorkshopCommand(
        db,
        actor,
        "workshop.contact.create",
        body,
        newId(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,'vehicle.read',?)",
      )
      .bind(newId(), vehicleId, actor.personId, actor.accountId)
      .run();
  });
  it("creates without a subscription, isolates customers and closes with immutable history", async () => {
    const response = await create();
    expect(response).toMatchObject({ status: "OPEN", version: 1 });
    expect((await listCustomerWorkshopContacts(db, actor)).items).toHaveLength(
      1,
    );
    expect((await listCustomerWorkshopContacts(db, other)).items).toHaveLength(
      0,
    );
    expect(
      (await listOrganizationWorkshopContacts(db, actor, organizationId)).items,
    ).toHaveLength(1);
    await db
      .prepare(
        "UPDATE org_memberships SET location_scope_type='SELECTED_LOCATIONS' WHERE id=?",
      )
      .bind(membershipId)
      .run();
    await expect(
      listOrganizationWorkshopContacts(db, actor, organizationId),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "UPDATE org_memberships SET location_scope_type='ALL_LOCATIONS' WHERE id=?",
      )
      .bind(membershipId)
      .run();
    await expect(
      prepareCustomerWorkshopCommand(
        db,
        { ...actor, mfaEnabled: false },
        "workshop.contact.close",
        {
          organizationId,
          requestId: response.id,
          version: 1,
          responseMessage:
            "We can help. Please describe your preferred appointment time.",
        },
        newId(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const closed = await commitPreparedCommand(
      db,
      await prepareCustomerWorkshopCommand(
        db,
        actor,
        "workshop.contact.close",
        {
          organizationId,
          requestId: response.id,
          version: 1,
          responseMessage:
            "We can help. Please describe your preferred appointment time.",
        },
        newId(),
      ),
    );
    expect(closed).toMatchObject({ status: "CLOSED", version: 2 });
    expect(
      (await listCustomerWorkshopContacts(db, actor)).items.find(
        (row) => row.id === response.id,
      ),
    ).toMatchObject({
      status: "CLOSED",
      message: body.message,
      responseMessage:
        "We can help. Please describe your preferred appointment time.",
    });
    expect(
      (
        await db
          .prepare(
            "SELECT version,status FROM workshop_contact_request_history WHERE request_id=? ORDER BY version",
          )
          .bind(response.id)
          .all()
      ).results,
    ).toEqual([
      { version: 1, status: "OPEN" },
      { version: 2, status: "CLOSED" },
    ]);
    await expect(
      db
        .prepare(
          "UPDATE workshop_contact_request_history SET status='CLOSED' WHERE request_id=?",
        )
        .bind(response.id)
        .run(),
    ).rejects.toThrow();
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM governance_audit_events WHERE resource_id=?",
          )
          .bind(response.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM integration_outbox_events WHERE aggregate_id=?",
          )
          .bind(response.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
  it("rolls back prepared creation after suspension and prepared close after role loss", async () => {
    const prepared = await prepareCustomerWorkshopCommand(
      db,
      actor,
      "workshop.contact.create",
      body,
      newId(),
    );
    await db
      .prepare("UPDATE org_organizations SET status='SUSPENDED' WHERE id=?")
      .bind(organizationId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await listCustomerWorkshopContacts(db, actor)).items.some(
        (row) => row.id === prepared.requestId,
      ),
    ).toBe(false);
    await db
      .prepare("UPDATE org_organizations SET status='ACTIVE' WHERE id=?")
      .bind(organizationId)
      .run();
    const response = await create();
    const close = await prepareCustomerWorkshopCommand(
      db,
      actor,
      "workshop.contact.close",
      {
        organizationId,
        requestId: response.id,
        version: 1,
        responseMessage:
          "We can help. Please describe your preferred appointment time.",
      },
      newId(),
    );
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='org-owner' AND permission_code='org.workshop.manage'",
      )
      .run();
    await expect(commitPreparedCommand(db, close)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await listCustomerWorkshopContacts(db, actor)).items.find(
        (row) => row.id === response.id,
      ),
    ).toMatchObject({ status: "OPEN", version: 1 });
  });
  it("stores one authoritative result for an idempotent Free contact and rejects changed payload", async () => {
    const scope = buildIdempotencyScope({
        accountId: actor.accountId,
        operation: "workshop.contact.create",
        organizationId,
      }),
      key = newId(),
      correlationId = newId();
    const prepared = await prepareCustomerWorkshopCommand(
      db,
      actor,
      "workshop.contact.create",
      body,
      correlationId,
    );
    const response = await commitIdempotentCommand(
      db,
      scope,
      key,
      body,
      correlationId,
      prepared,
    );
    expect(await readReplay(db, scope, key, body)).toEqual({
      response,
      replayed: true,
    });
    await expect(
      readReplay(db, scope, key, { ...body, message: "A different request" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM workshop_contact_requests WHERE id=?",
          )
          .bind(response.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("rechecks current account and ownership inside the committing batch", async () => {
    const prepared = await prepareCustomerWorkshopCommand(
      db,
      actor,
      "workshop.contact.create",
      body,
      newId(),
    );
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(actor.accountId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      status: 409,
    });
    await db
      .prepare("UPDATE iam_accounts SET status='ACTIVE' WHERE id=?")
      .bind(actor.accountId)
      .run();
    const next = await prepareCustomerWorkshopCommand(
      db,
      actor,
      "workshop.contact.create",
      body,
      newId(),
    );
    await db
      .prepare(
        "UPDATE vehicle_relationships SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND person_id=?",
      )
      .bind(vehicleId, actor.personId)
      .run();
    await expect(commitPreparedCommand(db, next)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM integration_outbox_events WHERE aggregate_id IN (?,?)",
          )
          .bind(prepared.requestId, next.requestId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("searches verified active workshops with bounded stable pagination", async () => {
    for (let i = 0; i < 32; i++)
      await db
        .prepare(
          "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'WORKSHOP','Synthetic','Search Synthetic','CO','VERIFIED',?)",
        )
        .bind(newId(), actor.personId)
        .run();
    const first = await discoverCustomerWorkshops(db, actor, "Search");
    expect(first.items).toHaveLength(30);
    const second = await discoverCustomerWorkshops(
      db,
      actor,
      "Search",
      String(first.nextCursor),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((row) => row.id)).size,
    ).toBe(32);
  });
});
