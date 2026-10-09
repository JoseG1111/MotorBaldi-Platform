import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  hasVehiclePermission,
  authorizeVehicleCommand,
} from "@motorbaldi/vehicles";
import { inspectionSnapshot } from "./contract.js";

export type InspectionActor = Principal & { personId: string };
export type InspectionRecord = {
  id: string;
  vehicle_id: string;
  organization_id: string;
  location_id: string | null;
  author_person_id: string;
  content_json: string;
  status: "DRAFT" | "FINAL";
  version: number;
};
export async function inspectionRecord(
  db: D1Database,
  recordId: string,
): Promise<InspectionRecord> {
  const record = await db
    .prepare(
      "SELECT id,vehicle_id,organization_id,location_id,author_person_id,content_json,status,version FROM vehicle_professional_records WHERE id=? AND record_type='INSPECTION'",
    )
    .bind(recordId)
    .first<InspectionRecord>();
  if (!record)
    throw new Problem(
      404,
      "INSPECTION_NOT_FOUND",
      "Inspection report not found",
    );
  return record;
}
export async function requireInspectionContext(
  db: D1Database,
  context: { organizationId: string; locationId: string | null },
) {
  const row = await db
    .prepare(
      `SELECT 1 FROM org_organizations o JOIN org_locations l ON l.organization_id=o.id
 WHERE o.id=? AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.id=? AND l.status='ACTIVE'
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='INSPECTION') OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code='INSPECTION'))`,
    )
    .bind(context.organizationId, context.locationId)
    .first();
  if (!row)
    throw new Problem(
      404,
      "INSPECTION_NOT_FOUND",
      "Verified inspection location required",
    );
}
export async function requireInspectionRead(
  db: D1Database,
  actor: InspectionActor,
  record: InspectionRecord,
) {
  await requireInspectionContext(db, {
    organizationId: record.organization_id,
    locationId: record.location_id,
  });
  if (
    (record.status === "DRAFT" && record.author_person_id !== actor.personId) ||
    !(await hasVehiclePermission(
      db,
      actor,
      record.vehicle_id,
      "vehicle.record.read",
      {
        organizationId: record.organization_id,
        locationId: record.location_id,
      },
    ))
  )
    throw new Problem(
      404,
      "INSPECTION_NOT_FOUND",
      "Inspection report not found",
    );
}
export async function requireInspectionWrite(
  db: D1Database,
  actor: InspectionActor,
  record: InspectionRecord,
) {
  await requireInspectionContext(db, {
    organizationId: record.organization_id,
    locationId: record.location_id,
  });
  await authorizeVehicleCommand(db, actor, "vehicle.record.update", {
    vehicleId: record.vehicle_id,
    recordId: record.id,
    version: record.version,
    content: {},
  });
}
export async function activeInspectionFileIds(
  db: D1Database,
  recordId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db
    .prepare(
      "SELECT f.id FROM inspection_record_files i JOIN storage_files f ON f.id=i.file_id WHERE i.record_id=? AND f.status='ACTIVE'",
    )
    .bind(recordId)
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}
export async function inspectionRecordSnapshot(
  db: D1Database,
  record: InspectionRecord,
  content: unknown = JSON.parse(record.content_json),
) {
  return inspectionSnapshot(
    content,
    await activeInspectionFileIds(db, record.id),
  );
}
export async function listInspectionFiles(
  db: D1Database,
  actor: InspectionActor,
  recordId: string,
) {
  const record = await inspectionRecord(db, recordId);
  await requireInspectionRead(db, actor, record);
  return (
    await db
      .prepare(
        "SELECT f.id,f.declared_mime,f.size_bytes,f.status,i.attached_at FROM inspection_record_files i JOIN storage_files f ON f.id=i.file_id WHERE i.record_id=? ORDER BY i.attached_at,f.id LIMIT 200",
      )
      .bind(recordId)
      .all()
  ).results;
}
/** Internal R2 key only; API must never serialize it or issue public object URLs. */
export async function inspectionDownloadMetadata(
  db: D1Database,
  actor: InspectionActor,
  recordId: string,
  fileId: string,
) {
  const record = await inspectionRecord(db, recordId);
  await requireInspectionRead(db, actor, record);
  const file = await db
    .prepare(
      "SELECT f.active_key,f.declared_mime FROM inspection_record_files i JOIN storage_files f ON f.id=i.file_id WHERE i.record_id=? AND f.id=? AND f.status='ACTIVE'",
    )
    .bind(recordId, fileId)
    .first<{ active_key: string | null; declared_mime: string }>();
  if (!file?.active_key)
    throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
  return file;
}
export async function inspectionAttachment(
  db: D1Database,
  actor: InspectionActor,
  recordId: string,
  fileId: string,
  version: number,
) {
  const record = await inspectionRecord(db, recordId);
  await requireInspectionWrite(db, actor, record);
  if (record.status !== "DRAFT" || record.version !== version)
    throw new Problem(
      409,
      "VERSION_CONFLICT",
      "Draft inspection with current version required",
    );
  const file = await db
    .prepare(
      "SELECT 1 FROM storage_files WHERE id=? AND status='ACTIVE' AND uploaded_by_account_id=?",
    )
    .bind(fileId, actor.accountId)
    .first();
  if (!file)
    throw new Problem(
      409,
      "INSPECTION_EVIDENCE_UNAVAILABLE",
      "Owned active evidence required",
    );
  return {
    record,
    statements: [
      db
        .prepare(
          "UPDATE vehicle_professional_records SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? AND status='DRAFT' AND author_person_id=? AND EXISTS(SELECT 1 FROM storage_files WHERE id=? AND status='ACTIVE' AND uploaded_by_account_id=?)",
        )
        .bind(recordId, version, actor.personId, fileId, actor.accountId),
      // Dependent NOT NULL guard aborts the batch if CAS fails; association insert remains atomic.
      db
        .prepare(
          "INSERT INTO inspection_record_files(record_id,file_id,attached_by_account_id) VALUES(CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)",
        )
        .bind(recordId, fileId, actor.accountId),
    ],
  };
}
