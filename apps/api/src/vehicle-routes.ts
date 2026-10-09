import type { Principal } from "@motorbaldi/contracts";
import { Problem } from "@motorbaldi/contracts";
import { requirePlatformPermission } from "@motorbaldi/authz";
import {
  hasVehiclePermission,
  parseVehicleCommand,
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
        )
          allowed.push(record);
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
