import { Problem, type Principal } from "@motorbaldi/contracts";
import { requirePlatformPermission } from "@motorbaldi/authz";
import {
  hasVehiclePermission,
  parseVehicleCommand,
} from "@motorbaldi/vehicles";
import {
  inspectionRecord,
  requireInspectionRead,
  requireInspectionWrite,
  requireInspectionExecution,
  listInspectionLocations,
  listInspectionFiles,
  inspectionDownloadMetadata,
  inspectionAttachmentInput,
} from "@motorbaldi/inspections";
import type { Json } from "@motorbaldi/shared";
const uuid = "[0-9a-f-]{36}";
export async function inspectionRoutes(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (operation: string, body: Json) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  const reply = (value: unknown) =>
    Response.json(value, { headers: { ...cors, "cache-control": "no-store" } });
  const method = (expected: string) => {
    if (request.method !== expected)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  const command = async (operation: string, extra: Record<string, Json>) => {
    method("POST");
    await principal();
    const body = await readBody();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Problem(400, "INVALID_INSPECTION_INPUT", "Object required");
    for (const name of Object.keys(extra))
      if (name in body)
        throw new Problem(
          400,
          "INVALID_INSPECTION_INPUT",
          "Route identifiers cannot be overridden",
        );
    const input = { ...body, ...extra };
    const parsed =
      operation === "inspection.file.attach"
        ? inspectionAttachmentInput.parse(input)
        : parseVehicleCommand(operation, input);
    return reply(await execute(operation, parsed));
  };
  const org = path.match(
    new RegExp(
      "^/api/v1/organizations/(" + uuid + ")/inspections(?:/(locations))?$",
    ),
  );
  if (org) {
    const organizationId = org[1]!;
    if (!org[2] && request.method === "POST")
      return command("vehicle.record.create", {
        organizationId,
        recordType: "INSPECTION",
      });
    method("GET");
    const actor = await principal();
    if (org[2])
      return reply({
        items: await listInspectionLocations(db, actor, organizationId),
      });
    // Apply the canonical read predicates before LIMIT so denied rows cannot
    // consume the page. Keep per-row checks below for authority changes between
    // queries; continuation only uses an emitted, authorized ID (and may end if
    // all selected rows lose authority). SQL parity is covered by qa-pagination.
    const rows = await db
      .prepare(
        `SELECT row.id FROM vehicle_professional_records row WHERE row.organization_id=? AND row.record_type='INSPECTION' AND row.id>? AND (? IS NULL OR row.location_id=?) AND (row.status<>'DRAFT' OR row.author_person_id=?) AND EXISTS (SELECT 1 FROM org_organizations o JOIN org_locations l ON l.organization_id=o.id
 WHERE o.id=row.organization_id AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.id=row.location_id AND l.status='ACTIVE'
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code='INSPECTION') OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code='INSPECTION'))) AND EXISTS (SELECT 1 AS allowed
       FROM iam_accounts a
       JOIN iam_people p ON p.id=a.person_id
       WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE'
         AND EXISTS (
           SELECT 1 FROM vehicle_access_grants g
           WHERE g.vehicle_id=row.vehicle_id AND g.permission_code=?
             AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             AND g.revoked_at IS NULL
             AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             AND (g.person_id=p.id OR (g.organization_id=row.organization_id AND (g.location_id IS NULL OR g.location_id IS row.location_id)))
             AND (
               g.person_id=p.id
               OR (
                 g.organization_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM org_memberships m
                   JOIN org_organizations o ON o.id=m.organization_id
                   WHERE m.person_id=p.id AND m.organization_id=g.organization_id
                     AND m.status='ACTIVE' AND o.status='ACTIVE'
                     AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     AND (
                       g.location_id IS NULL
                       OR (
                         m.location_scope_type='ALL_LOCATIONS'
                         AND EXISTS (
                           SELECT 1 FROM org_locations l
                           WHERE l.id=g.location_id AND l.organization_id=g.organization_id
                             AND l.status='ACTIVE'
                         )
                       )
                       OR EXISTS (
                         SELECT 1 FROM org_membership_locations ml
                         JOIN org_locations l ON l.id=ml.location_id AND l.organization_id=ml.organization_id
                         WHERE ml.membership_id=m.id AND ml.organization_id=m.organization_id
                           AND ml.location_id=g.location_id AND l.status='ACTIVE'
                       )
                     )
                 )
               )
             )
         )
       LIMIT 1) ORDER BY row.id LIMIT 31`,
      )
      .bind(
        organizationId,
        url.searchParams.get("cursor") ?? "",
        url.searchParams.get("locationId"),
        url.searchParams.get("locationId"),
        actor.personId,
        actor.accountId,
        actor.personId,
        "vehicle.record.read",
      )
      .all<{ id: string }>();
    const items = [];
    for (const row of rows.results.slice(0, 30))
      try {
        const record = await inspectionRecord(db, row.id);
        await requireInspectionRead(db, actor, record);
        items.push(record);
      } catch (error) {
        if (!(error instanceof Problem) || error.status !== 404) throw error;
      }
    return reply({
      items,
      nextCursor: rows.results.length > 30 ? (items.at(-1)?.id ?? null) : null,
    });
  }
  const vehicles = path.match(
    new RegExp(
      "^/api/v1/organizations/(" +
        uuid +
        ")/inspections/locations/(" +
        uuid +
        ")/vehicles$",
    ),
  );
  if (vehicles) {
    method("GET");
    const actor = await principal(),
      organizationId = vehicles[1]!,
      locationId = vehicles[2]!;
    const locations = await listInspectionLocations(db, actor, organizationId);
    if (!locations.some((l) => l.id === locationId))
      throw new Problem(
        404,
        "INSPECTION_NOT_FOUND",
        "Inspection location not found",
      );
    const rows = await db
      .prepare(
        "SELECT DISTINCT v.id,v.kind_code FROM vehicle_vehicles v JOIN vehicle_access_grants g ON g.vehicle_id=v.id WHERE g.permission_code='vehicle.record.write' AND (g.person_id=? OR g.organization_id=?) AND g.revoked_at IS NULL AND v.id>? ORDER BY v.id LIMIT 30",
      )
      .bind(
        actor.personId,
        organizationId,
        url.searchParams.get("cursor") ?? "",
      )
      .all<{ id: string; kind_code: string }>();
    const items = [];
    for (const row of rows.results)
      if (
        await hasVehiclePermission(db, actor, row.id, "vehicle.record.write", {
          organizationId,
          locationId,
        })
      )
        items.push(row);
    return reply({ items });
  }
  const detail = path.match(
    new RegExp(
      "^/api/v1/inspections/(" +
        uuid +
        ")(?:/(update|finalize|amend|files)(?:/(" +
        uuid +
        "))?)?$",
    ),
  );
  if (detail) {
    const actor = await principal(),
      recordId = detail[1]!,
      action = detail[2],
      fileId = detail[3];
    if (fileId && action !== "files")
      throw new Problem(404, "NOT_FOUND", "Not found");
    const record = await inspectionRecord(db, recordId);
    if (action === "files" && request.method === "POST" && !fileId)
      return command("inspection.file.attach", { recordId });
    if (action && action !== "files")
      return command("vehicle.record." + action, {
        recordId,
        vehicleId: record.vehicle_id,
      });
    method("GET");
    await requireInspectionRead(db, actor, record);
    if (action === "files") {
      if (!fileId)
        return reply({ items: await listInspectionFiles(db, actor, recordId) });
      const file = await inspectionDownloadMetadata(
          db,
          actor,
          recordId,
          fileId,
        ),
        object = await bucket.get(file.active_key!);
      if (!object)
        throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
      return new Response(object.body, {
        headers: {
          ...cors,
          "content-type": file.declared_mime,
          "content-disposition": "attachment",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    let canWrite = false;
    try {
      await requireInspectionWrite(db, actor, record);
      await requireInspectionExecution(db, actor, {
        organizationId: record.organization_id,
        locationId: record.location_id,
      });
      canWrite = true;
    } catch (error) {
      if (!(error instanceof Problem) || ![403, 404].includes(error.status))
        throw error;
    }
    const amendments =
      record.status === "FINAL"
        ? (
            await db
              .prepare(
                "SELECT * FROM (SELECT id,reason,content_json,created_at FROM vehicle_professional_amendments WHERE record_id=? ORDER BY created_at DESC,id DESC LIMIT 100) ORDER BY created_at,id",
              )
              .bind(recordId)
              .all()
          ).results
        : [];
    const amendmentCount =
      record.status === "FINAL"
        ? Number(
            (
              await db
                .prepare(
                  "SELECT count(*) AS total FROM vehicle_professional_amendments WHERE record_id=?",
                )
                .bind(recordId)
                .first<{ total: number }>()
            )?.total ?? 0,
          )
        : 0;
    return reply({
      amendmentCount,
      amendmentsTruncated: amendmentCount > amendments.length,
      record,
      content: JSON.parse(record.content_json),
      files: await listInspectionFiles(db, actor, recordId),
      amendments,
      canWrite,
      mfaEnabled: actor.mfaEnabled,
    });
  }
  if (path === "/api/v1/admin/inspections") {
    method("GET");
    await requirePlatformPermission(
      db,
      await principal(),
      "platform.vehicle.read",
      { mfa: true },
    );
    const rows = await db
      .prepare(
        "SELECT r.id,r.vehicle_id,r.organization_id,r.location_id,r.record_type,r.status,r.version,r.content_json,(SELECT a.content_json FROM vehicle_professional_amendments a WHERE a.record_id=r.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS latest_amendment_json,r.finalized_at,o.display_name AS organization_name,l.name AS location_name FROM vehicle_professional_records r JOIN org_organizations o ON o.id=r.organization_id LEFT JOIN org_locations l ON l.organization_id=o.id AND l.id=r.location_id WHERE r.record_type='INSPECTION' AND r.id>? ORDER BY r.id LIMIT 30",
      )
      .bind(url.searchParams.get("cursor") ?? "")
      .all();
    return reply({
      items: rows.results,
      nextCursor: rows.results.at(-1)?.id ?? null,
    });
  }
  return null;
}
