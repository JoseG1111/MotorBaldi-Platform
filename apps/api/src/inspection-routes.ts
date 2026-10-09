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
    const rows = await db
      .prepare(
        "SELECT id FROM vehicle_professional_records WHERE organization_id=? AND record_type='INSPECTION' AND id>? AND (? IS NULL OR location_id=?) ORDER BY id LIMIT 30",
      )
      .bind(
        organizationId,
        url.searchParams.get("cursor") ?? "",
        url.searchParams.get("locationId"),
        url.searchParams.get("locationId"),
      )
      .all<{ id: string }>();
    const items = [];
    for (const row of rows.results)
      try {
        const record = await inspectionRecord(db, row.id);
        await requireInspectionRead(db, actor, record);
        items.push(record);
      } catch (error) {
        if (!(error instanceof Problem) || error.status !== 404) throw error;
      }
    return reply({ items, nextCursor: items.at(-1)?.id ?? null });
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
