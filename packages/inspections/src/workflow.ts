import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import {
  auditStatement,
  outboxStatement,
  type EventRegistry,
} from "@motorbaldi/db";
import type { Json } from "@motorbaldi/shared";
import type { VehicleOperation } from "@motorbaldi/vehicles";
import { inspectionSnapshot } from "./contract.js";
import {
  inspectionRecord,
  requireInspectionContext,
  requireInspectionWrite,
  inspectionRecordSnapshot,
  inspectionAttachment,
  type InspectionActor,
} from "./media.js";

export async function requireInspectionExecution(
  db: D1Database,
  actor: InspectionActor,
  context: { organizationId: string; locationId: string | null },
) {
  await requireInspectionContext(db, context);
  const allowed = await db
    .prepare(
      `SELECT 1 FROM org_memberships m JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_role_permissions rp ON rp.role_id=mr.role_id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION'
 WHERE m.person_id=? AND m.organization_id=? AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code='org.inspection.execute'
 AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=m.organization_id AND ml.location_id=?))`,
    )
    .bind(actor.personId, context.organizationId, context.locationId)
    .first();
  if (!allowed)
    throw new Problem(
      403,
      "FORBIDDEN",
      "Active location-scoped inspection executor required",
    );
}
/** Generic Vehicle record entry points must enforce exactly the same Inspection contract. */
export async function authorizeInspectionVehicleCommand(
  db: D1Database,
  actor: InspectionActor,
  operation: VehicleOperation,
  body: Record<string, Json>,
) {
  if (!operation.startsWith("vehicle.record.")) return;
  if (operation === "vehicle.record.create") {
    if (body.recordType !== "INSPECTION") return;
    await requireInspectionExecution(db, actor, {
      organizationId: String(body.organizationId),
      locationId: typeof body.locationId === "string" ? body.locationId : null,
    });
    inspectionSnapshot(body.content, new Set());
    return;
  }
  const type = await db
    .prepare(
      "SELECT record_type FROM vehicle_professional_records WHERE id=? AND vehicle_id=?",
    )
    .bind(String(body.recordId), String(body.vehicleId))
    .first<{ record_type: string }>();
  if (type?.record_type !== "INSPECTION") return;
  const record = await inspectionRecord(db, String(body.recordId));
  await requireInspectionExecution(db, actor, {
    organizationId: record.organization_id,
    locationId: record.location_id,
  });
  if (operation === "vehicle.record.finalize")
    await inspectionRecordSnapshot(db, record);
  else await inspectionRecordSnapshot(db, record, body.content);
}
export const inspectionAttachmentInput = z
  .object({
    recordId: z.string().uuid(),
    fileId: z.string().uuid(),
    version: z.number().int().positive(),
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export const inspectionEventContracts: EventRegistry = new Map([
  [
    "inspection.report.changed.v1:1",
    {
      aggregateType: "inspection_report",
      version: 1,
      payload: z
        .object({
          recordId: z.string().uuid(),
          vehicleId: z.string().uuid(),
          organizationId: z.string().uuid(),
          locationId: z.string().uuid(),
          operation: z.literal("inspection.file.attach"),
        })
        .strict(),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
export async function authorizeInspectionAttachment(
  db: D1Database,
  actor: InspectionActor,
  body: z.infer<typeof inspectionAttachmentInput>,
) {
  const record = await inspectionRecord(db, body.recordId);
  await requireInspectionWrite(db, actor, record);
  await requireInspectionExecution(db, actor, {
    organizationId: record.organization_id,
    locationId: record.location_id,
  });
}
export async function prepareInspectionAttachment(
  db: D1Database,
  actor: InspectionActor,
  body: z.infer<typeof inspectionAttachmentInput>,
  requestId: string,
) {
  const { record, statements } = await inspectionAttachment(
    db,
    actor,
    body.recordId,
    body.fileId,
    body.version,
  );
  return {
    vehicleId: record.vehicle_id,
    response: { recordId: record.id, version: body.version + 1 } as Record<
      string,
      Json
    >,
    statements: [
      ...statements,
      auditStatement(db, {
        actorId: actor.accountId,
        action: "inspection.file.attach",
        resourceType: "inspection_report",
        resourceId: record.id,
        organizationId: record.organization_id,
        requestId,
        reason: body.reason,
      }),
      outboxStatement(
        db,
        {
          aggregateType: "inspection_report",
          aggregateId: record.id,
          eventType: "inspection.report.changed.v1",
          eventVersion: 1,
          payload: {
            recordId: record.id,
            vehicleId: record.vehicle_id,
            organizationId: record.organization_id,
            locationId: record.location_id,
            operation: "inspection.file.attach",
          },
          requestId,
          externalEffectPolicy: "IDEMPOTENT",
        },
        inspectionEventContracts,
      ).statement,
    ],
  };
}

export async function listInspectionLocations(
  db: D1Database,
  actor: InspectionActor,
  organizationId: string,
) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT l.id,l.name FROM org_locations l JOIN org_organizations o ON o.id=l.organization_id JOIN org_memberships m ON m.organization_id=o.id JOIN iam_people p ON p.id=m.person_id JOIN iam_accounts a ON a.person_id=p.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION' JOIN authz_role_permissions rp ON rp.role_id=r.id
 WHERE o.id=? AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.status='ACTIVE' AND p.id=? AND a.id=? AND p.status='ACTIVE' AND a.status='ACTIVE' AND m.status='ACTIVE' AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code='org.inspection.execute'
 AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=l.id))
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='INSPECTION') OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code='INSPECTION')) ORDER BY l.id LIMIT 50`,
    )
    .bind(organizationId, actor.personId, actor.accountId)
    .all<{ id: string; name: string }>();
  return rows.results;
}
