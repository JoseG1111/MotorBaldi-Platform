import {
  inspectionRecord,
  requireInspectionRead,
} from "@motorbaldi/inspections";
import type { Principal } from "@motorbaldi/contracts";
import { Problem } from "@motorbaldi/contracts";
import { requirePlatformPermission } from "@motorbaldi/authz";
import {
  hasVehiclePermission,
  parseVehicleCommand,
  customerVehicleState,
} from "@motorbaldi/vehicles";
import type { Json } from "@motorbaldi/shared";
import { z } from "zod";

type Actor = Principal & { personId: string };
const id = "[0-9a-f-]{36}";
export async function vehicleRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Actor>,
  execute: (operation: string, body: Json) => Promise<unknown>,
  body: () => Promise<unknown>,
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
  const command = async (
    operation: string,
    extra: Record<string, Json> = {},
  ) => {
    method("POST");
    await principal();
    const input = await body();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Problem(400, "INVALID_VEHICLE_INPUT", "Object required");
    for (const key of Object.keys(extra))
      if (key in input)
        throw new Problem(
          400,
          "INVALID_VEHICLE_INPUT",
          "Route identifiers cannot be overridden",
        );
    return reply(
      await execute(
        operation,
        parseVehicleCommand(operation, { ...input, ...extra }),
      ),
    );
  };
  const admin = async (permission = "platform.vehicle.read") => {
    const actor = await principal();
    await requirePlatformPermission(db, actor, permission, { mfa: true });
    return actor;
  };
  if (path === "/api/v1/me/vehicles") {
    if (request.method === "POST") return command("vehicle.customer.register");
    method("GET");
    const actor = await principal();
    const rows = await db
      .prepare(
        `SELECT DISTINCT v.id,v.kind_code,v.specification_json,v.version FROM vehicle_vehicles v JOIN vehicle_relationships r ON r.vehicle_id=v.id WHERE r.person_id=? AND r.relationship_type='OWNER' AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM vehicle_access_grants g WHERE g.vehicle_id=v.id AND g.person_id=? AND g.permission_code='vehicle.read' AND g.revoked_at IS NULL AND g.granted_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (g.expires_at IS NULL OR g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AND v.id>? ORDER BY v.id LIMIT 31`,
      )
      .bind(
        actor.personId,
        actor.personId,
        url.searchParams.get("cursor") ?? "",
      )
      .all<{
        id: string;
        kind_code: string;
        specification_json: string;
        version: number;
      }>();
    const items = [];
    for (const row of rows.results.slice(0, 30))
      if (await hasVehiclePermission(db, actor, row.id, "vehicle.read")) {
        const state = await customerVehicleState(db, actor, row.id);
        items.push({
          ...row,
          specification: JSON.parse(row.specification_json),
          writable: state.writable,
          active: state.owned,
        });
      }
    return reply({
      items,
      nextCursor: rows.results.length > 30 ? rows.results[29]!.id : null,
    });
  }
  const service = path.match(
    new RegExp(
      "^/api/v1/vehicles/(" +
        id +
        ")/(services|compliance|maintenance|registration|retire)$",
    ),
  );
  if (service) {
    const vehicleId = service[1]!,
      collection = service[2]!;
    if (request.method === "POST") {
      const operations: Record<string, string> = {
        compliance: "vehicle.compliance.update",
        maintenance: "vehicle.maintenance.append",
        registration: "vehicle.registration.update",
        retire: "vehicle.customer.retire",
      };
      if (!operations[collection])
        throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return command(operations[collection]!, { vehicleId });
    }
    if (collection !== "services")
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    method("GET");
    const actor = await principal();
    if (!(await hasVehiclePermission(db, actor, vehicleId, "vehicle.read")))
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
    const state = await customerVehicleState(db, actor, vehicleId);
    const compliance = await db
      .prepare(
        `SELECT e.* FROM vehicle_compliance_entries e WHERE vehicle_id=? AND NOT EXISTS(SELECT 1 FROM vehicle_compliance_entries newer WHERE newer.vehicle_id=e.vehicle_id AND newer.document_type=e.document_type AND (newer.created_at,newer.id)>(e.created_at,e.id)) ORDER BY document_type`,
      )
      .bind(vehicleId)
      .all();
    const cursorId = z
      .string()
      .uuid()
      .optional()
      .parse(url.searchParams.get("cursor") ?? undefined);
    const cursor = cursorId
      ? await db
          .prepare(
            "SELECT performed_on,id FROM vehicle_manual_maintenance WHERE id=? AND vehicle_id=?",
          )
          .bind(cursorId, vehicleId)
          .first<{ performed_on: string; id: string }>()
      : null;
    if (cursorId && !cursor)
      throw new Problem(
        404,
        "MAINTENANCE_CURSOR_UNAVAILABLE",
        "History cursor unavailable",
      );
    const maintenance = await db
      .prepare(
        `SELECT id,performed_on,title,notes,mileage,created_at FROM vehicle_manual_maintenance WHERE vehicle_id=? ${cursor ? "AND (performed_on<? OR (performed_on=? AND id<?))" : ""} ORDER BY performed_on DESC,id DESC LIMIT 31`,
      )
      .bind(
        vehicleId,
        ...(cursor
          ? [cursor.performed_on, cursor.performed_on, cursor.id]
          : []),
      )
      .all<{ id: string }>();
    const count = await db
      .prepare(
        "SELECT COUNT(*) n FROM vehicle_manual_maintenance WHERE recorded_by_person_id=?",
      )
      .bind(actor.personId)
      .first<{ n: number }>();
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
    const monthStart = month + "-01";
    const monthlyMaintenance = await db
      .prepare(
        "SELECT COUNT(*) AS entries FROM vehicle_manual_maintenance WHERE vehicle_id=? AND performed_on>=? AND performed_on<date(?,'+1 month')",
      )
      .bind(vehicleId, monthStart, monthStart)
      .first<{ entries: number }>();
    const latestMileage = await db
      .prepare(
        "SELECT reading_value,unit,observed_at FROM vehicle_odometer_readings WHERE vehicle_id=? ORDER BY observed_at DESC,id DESC LIMIT 1",
      )
      .bind(vehicleId)
      .first();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const monthlySummary =
      state.entitlements.premium && state.writable
        ? {
            month,
            manualMaintenanceEntries: monthlyMaintenance?.entries ?? 0,
            latestMileage,
            expirations: compliance.results.map((entry) => ({
              documentType: entry.document_type,
              expiresOn: entry.expires_on,
              status: String(entry.expires_on) < today ? "EXPIRED" : "CURRENT",
              verificationStatus: entry.verification_status,
            })),
            automaticDeliveryAvailable: false,
          }
        : null;
    return reply({
      monthlySummary,
      compliance: compliance.results.map((entry) => ({
        ...entry,
        expiration_status:
          String(entry.expires_on) < today
            ? "EXPIRED"
            : Math.round(
                  (Date.parse(String(entry.expires_on) + "T00:00:00Z") -
                    Date.parse(today + "T00:00:00Z")) /
                    86400000,
                ) <= 30
              ? "DUE_SOON"
              : "CURRENT",
      })),
      maintenance: maintenance.results.slice(0, 30),
      nextCursor:
        maintenance.results.length > 30 ? maintenance.results[29]!.id : null,
      writable: state.writable,
      owned: state.owned,
      entitlements: state.entitlements,
      manualEntriesUsed: count?.n ?? 0,
    });
  }
  if (path === "/api/v1/admin/vehicles") {
    if (request.method === "POST") return command("vehicle.create");
    method("GET");
    await admin();
    const rows = await db
      .prepare(
        "SELECT id,kind_code,version,created_at FROM vehicle_vehicles WHERE id>? ORDER BY id LIMIT 30",
      )
      .bind(url.searchParams.get("cursor") ?? "")
      .all();
    return reply({
      items: rows.results,
      nextCursor: rows.results.at(-1)?.id ?? null,
    });
  }
  const adminVehicle = path.match(
    new RegExp("^/api/v1/admin/vehicles/(" + id + ")$"),
  );
  if (adminVehicle) {
    if (request.method === "POST")
      return command("vehicle.update", { vehicleId: adminVehicle[1]! });
    method("GET");
    await admin();
    const vehicle = await db
      .prepare(
        "SELECT id,kind_code,specification_json,version FROM vehicle_vehicles WHERE id=?",
      )
      .bind(adminVehicle[1]!)
      .first();
    if (!vehicle)
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
    const tables = [
      "vehicle_identifiers",
      "vehicle_claims",
      "vehicle_relationships",
      "vehicle_access_grants",
    ] as const;
    const rows = [];
    for (const table of tables)
      rows.push(
        (
          await db
            .prepare(
              `SELECT * FROM ${table} WHERE vehicle_id=? ORDER BY id DESC LIMIT 50`,
            )
            .bind(adminVehicle[1]!)
            .all()
        ).results,
      );
    return reply({
      vehicle,
      identifiers: rows[0],
      claims: rows[1],
      relationships: rows[2],
      grants: rows[3],
    });
  }
  const simple = path.match(
    new RegExp(
      "^/api/v1/(admin/)?vehicles/(" +
        id +
        ")/(identifiers|grants|claims|odometer|records)$",
    ),
  );
  if (simple) {
    const [, staff, vehicleId, collection] = simple;
    if (staff) {
      if (collection === "identifiers")
        return command("vehicle.identifier.add", { vehicleId: vehicleId! });
      if (collection === "grants")
        return command("vehicle.grant.create", { vehicleId: vehicleId! });
      throw new Problem(404, "NOT_FOUND", "Not found");
    }
    if (request.method === "POST") {
      const operation = {
        claims: "vehicle.claim.submit",
        odometer: "vehicle.odometer.append",
        records: "vehicle.record.create",
      }[collection as "claims" | "odometer" | "records"];
      if (!operation)
        throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      return command(operation, { vehicleId: vehicleId! });
    }
    method("GET");
    const actor = await principal();
    const permission =
      collection === "records" ? "vehicle.record.read" : "vehicle.read";
    if (!(await hasVehiclePermission(db, actor, vehicleId!, permission)))
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
    if (collection === "claims")
      return reply({
        items: (
          await db
            .prepare(
              "SELECT id,relationship_type,status,created_at,reviewed_at FROM vehicle_claims WHERE vehicle_id=? AND submitted_by_person_id=? ORDER BY created_at DESC,id DESC LIMIT 50",
            )
            .bind(vehicleId!, actor.personId)
            .all()
        ).results,
      });
    if (collection === "identifiers" || collection === "grants")
      throw new Problem(404, "NOT_FOUND", "Not found");
    const rows =
      collection === "odometer"
        ? await db
            .prepare(
              "SELECT id,reading_value,unit,observed_at,corrects_reading_id,correction_reason FROM vehicle_odometer_readings WHERE vehicle_id=? ORDER BY observed_at DESC,id DESC LIMIT 50",
            )
            .bind(vehicleId!)
            .all()
        : await db
            .prepare(
              "SELECT id,organization_id,location_id,author_person_id,record_type,content_json,status,version,finalized_at FROM vehicle_professional_records WHERE vehicle_id=? AND (status='FINAL' OR author_person_id=?) ORDER BY created_at DESC,id DESC LIMIT 50",
            )
            .bind(vehicleId!, actor.personId)
            .all();
    if (collection === "records") {
      const allowed = [];
      for (const record of rows.results)
        if (
          await hasVehiclePermission(
            db,
            actor,
            vehicleId!,
            "vehicle.record.read",
            {
              organizationId: String(record.organization_id),
              locationId:
                record.location_id == null ? null : String(record.location_id),
            },
          )
        ) {
          if (record.record_type === "INSPECTION") {
            try {
              await requireInspectionRead(
                db,
                actor,
                await inspectionRecord(db, String(record.id)),
              );
            } catch (error) {
              if (error instanceof Problem && error.status === 404) continue;
              throw error;
            }
          }
          allowed.push(record);
        }
      rows.results = allowed;
    }
    const amendments =
      collection === "records"
        ? (
            await db
              .prepare(
                "SELECT a.id,a.record_id,a.reason,a.content_json,a.created_at FROM vehicle_professional_amendments a JOIN vehicle_professional_records r ON r.id=a.record_id WHERE r.vehicle_id=? AND r.status='FINAL' ORDER BY a.created_at DESC,a.id DESC LIMIT 50",
              )
              .bind(vehicleId!)
              .all()
          ).results
        : [];
    return reply({
      items: rows.results,
      amendments: amendments.filter((a) =>
        rows.results.some((r) => r.id === a.record_id),
      ),
    });
  }
  const staffAction = path.match(
    new RegExp(
      "^/api/v1/admin/vehicles/(" +
        id +
        ")/(identifiers|claims|relationships|grants)/(" +
        id +
        ")/(retire|review|end|revoke)$",
    ),
  );
  if (staffAction) {
    const [, vehicleId, collection, resourceId, action] = staffAction;
    const pair = collection + "/" + action;
    const operations: Record<string, [string, string]> = {
      "identifiers/retire": ["vehicle.identifier.retire", "identifierId"],
      "claims/review": ["vehicle.claim.review", "claimId"],
      "relationships/end": ["vehicle.relationship.end", "relationshipId"],
      "grants/revoke": ["vehicle.grant.revoke", "grantId"],
    };
    const operation = operations[pair];
    if (!operation) throw new Problem(404, "NOT_FOUND", "Not found");
    return command(operation[0], {
      vehicleId: vehicleId!,
      [operation[1]]: resourceId!,
    });
  }
  const recordAction = path.match(
    new RegExp(
      "^/api/v1/vehicles/(" +
        id +
        ")/records/(" +
        id +
        ")/(update|finalize|amend)$",
    ),
  );
  if (recordAction)
    return command("vehicle.record." + recordAction[3], {
      vehicleId: recordAction[1]!,
      recordId: recordAction[2]!,
    });
  const garage = path.match(
    new RegExp("^/api/v1/me/garage/(" + id + ")/(add|remove)$"),
  );
  if (garage)
    return command("vehicle.garage." + garage[2], { vehicleId: garage[1]! });
  const permissions = path.match(
    new RegExp("^/api/v1/vehicles/(" + id + ")/permissions$"),
  );
  if (permissions) {
    method("GET");
    const actor = await principal();
    const vehicleId = z.string().uuid().parse(permissions[1]);
    const codes = [];
    for (const code of [
      "vehicle.read",
      "vehicle.odometer.write",
      "vehicle.record.read",
      "vehicle.record.write",
    ])
      if (await hasVehiclePermission(db, actor, vehicleId, code))
        codes.push(code);
    if (!codes.length)
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
    return reply({ permissions: codes });
  }
  return null;
}
