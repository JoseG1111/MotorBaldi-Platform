import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import {
  inspectionAttachment,
  inspectionDownloadMetadata,
  inspectionRecord,
  inspectionRecordSnapshot,
  requireInspectionRead,
} from "@motorbaldi/inspections";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import core from "../../migrations/0004_vehicle_core.sql?raw";
import access from "../../migrations/0005_vehicle_access.sql?raw";
import history from "../../migrations/0006_vehicle_history.sql?raw";
import commands from "../../migrations/0007_vehicle_commands.sql?raw";
import workshop from "../../migrations/0008_workshop_operations.sql?raw";
import workshopFiles from "../../migrations/0009_workshop_files.sql?raw";
import inspectionMedia from "../../migrations/0010_inspection_media.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const personId = newId(),
  accountId = newId(),
  organizationId = newId(),
  locationId = newId(),
  otherLocationId = newId(),
  vehicleId = newId(),
  membershipId = newId();
const actor = { accountId, personId, mfaEnabled: true };
const content = JSON.stringify({
  schemaVersion: 1,
  summary: "Synthetic observation report",
  findings: [],
});
beforeAll(async () => {
  for (const sql of [
    foundation,
    phase1,
    closeout,
    core,
    access,
    history,
    commands,
    workshop,
    workshopFiles,
    inspectionMedia,
  ])
    await db.exec(sql.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email) VALUES(?,'Inspection Test','inspection@example.test')",
    )
    .bind(accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Inspection','Test')",
    )
    .bind(personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(accountId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'OTHER','Inspection Fixture','Inspection Fixture','CO','VERIFIED',?)",
    )
    .bind(organizationId, personId)
    .run();
  for (const id of [locationId, otherLocationId])
    await db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Synthetic','SERVICE_SITE','CO','Test','Test','Synthetic')",
      )
      .bind(id, organizationId)
      .run();
  await db
    .prepare(
      "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'INSPECTION')",
    )
    .bind(organizationId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'ALL_LOCATIONS')",
    )
    .bind(membershipId, organizationId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-inspector')",
    )
    .bind(membershipId)
    .run();
  await db
    .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
    .bind(vehicleId)
    .run();
  for (const p of ["vehicle.record.read", "vehicle.record.write"])
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,?,?)",
      )
      .bind(newId(), vehicleId, organizationId, locationId, p, accountId)
      .run();
});
async function report(location = locationId, type = "INSPECTION") {
  const id = newId();
  await db
    .prepare(
      "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(id, vehicleId, organizationId, location, personId, type, content)
    .run();
  return id;
}
// Isolated D1 lifecycle metadata fixtures, not scanner results and never remote promotion.
async function file(status = "ACTIVE") {
  const id = newId();
  await db
    .prepare(
      "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,request_id,declared_mime,size_bytes,status,sha256,active_key) VALUES(?,?,?,'synthetic-file-test','image/png',64,?,?,?)",
    )
    .bind(
      id,
      accountId,
      "test-quarantine/" + id,
      status,
      status === "ACTIVE" ? "0".repeat(64) : null,
      status === "ACTIVE" ? "test-private/" + id : null,
    )
    .run();
  return id;
}
describe("Inspection media persistence and privacy", () => {
  it("rejects quarantined/unassociated evidence without mutating the report", async () => {
    const id = await report(),
      pending = await file("QUARANTINED");
    await expect(
      inspectionAttachment(db, actor, id, pending, 1),
    ).rejects.toMatchObject({ code: "INSPECTION_EVIDENCE_UNAVAILABLE" });
    await expect(
      inspectionDownloadMetadata(db, actor, id, pending),
    ).rejects.toMatchObject({ status: 404 });
    expect((await inspectionRecord(db, id)).version).toBe(1);
    await expect(
      inspectionRecordSnapshot(db, await inspectionRecord(db, id), {
        schemaVersion: 1,
        summary: "Synthetic observation report",
        findings: [
          {
            id: newId(),
            label: "Observation",
            observation: "Synthetic",
            evidenceFileIds: [pending],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INSPECTION_EVIDENCE_UNAVAILABLE" });
  });
  it("keeps ACTIVE associations immutable, guards stale CAS and freezes final media", async () => {
    const id = await report(),
      active = await file();
    const attachment = await inspectionAttachment(db, actor, id, active, 1);
    await db.batch(attachment.statements);
    expect((await inspectionRecord(db, id)).version).toBe(2);
    expect(
      (await inspectionDownloadMetadata(db, actor, id, active)).active_key,
    ).toBe("test-private/" + active);
    await expect(
      db
        .prepare("DELETE FROM inspection_record_files WHERE record_id=?")
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE inspection_record_files SET attached_at=? WHERE record_id=?",
        )
        .bind("2026-01-01T00:00:00.000Z", id)
        .run(),
    ).rejects.toThrow();
    const next = await file(),
      stale = await inspectionAttachment(db, actor, id, next, 2);
    await db
      .prepare(
        "UPDATE vehicle_professional_records SET version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(db.batch(stale.statements)).rejects.toThrow();
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS total FROM inspection_record_files WHERE record_id=?",
        )
        .bind(id)
        .first<{ total: number }>())!.total,
    ).toBe(1);
    await db
      .prepare(
        "UPDATE vehicle_professional_records SET status='FINAL',finalized_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=?",
      )
      .bind(id)
      .run();
    await expect(
      inspectionAttachment(db, actor, id, next, 4),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db
        .prepare(
          "INSERT INTO inspection_record_files(record_id,file_id,attached_by_account_id) VALUES(?,?,?)",
        )
        .bind(id, next, accountId)
        .run(),
    ).rejects.toThrow();
  });
  it("rejects another uploader and rolls back when file state changes after preparation", async () => {
    const id = await report(),
      active = await file(),
      other = newId();
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email) VALUES(?,'Other Fixture','other-inspection@example.test')",
      )
      .bind(other)
      .run();
    await db
      .prepare("UPDATE storage_files SET uploaded_by_account_id=? WHERE id=?")
      .bind(other, active)
      .run();
    await expect(
      inspectionAttachment(db, actor, id, active, 1),
    ).rejects.toMatchObject({ code: "INSPECTION_EVIDENCE_UNAVAILABLE" });
    const owned = await file(),
      prepared = await inspectionAttachment(db, actor, id, owned, 1);
    await db
      .prepare("UPDATE storage_files SET status='QUARANTINED' WHERE id=?")
      .bind(owned)
      .run();
    await expect(db.batch(prepared.statements)).rejects.toThrow();
    expect((await inspectionRecord(db, id)).version).toBe(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS total FROM inspection_record_files WHERE record_id=?",
        )
        .bind(id)
        .first<{ total: number }>())!.total,
    ).toBe(0);
  });
  it("enforces exact location grants, active capability and current authority on download", async () => {
    const id = await report(),
      active = await file();
    await db.batch(
      (await inspectionAttachment(db, actor, id, active, 1)).statements,
    );
    await expect(
      requireInspectionRead(
        db,
        actor,
        await inspectionRecord(db, await report(otherLocationId)),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      inspectionRecord(db, await report(locationId, "SERVICE")),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "DELETE FROM org_capabilities WHERE organization_id=? AND code='INSPECTION'",
      )
      .bind(organizationId)
      .run();
    await expect(
      inspectionDownloadMetadata(db, actor, id, active),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'INSPECTION')",
      )
      .bind(organizationId)
      .run();
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=? AND permission_code='vehicle.record.read'",
      )
      .bind(vehicleId)
      .run();
    await expect(
      inspectionDownloadMetadata(db, actor, id, active),
    ).rejects.toMatchObject({ status: 404 });
  });
});
