import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  getCustomerEntitlements,
  customerPremiumPredicate,
  outboxStatement,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import { hasVehiclePermission, vehiclePermissionPredicate } from "./index.js";
import { vehicleChangeAudit, vehicleEventContracts } from "./commands.js";
type Actor = Principal & { personId: string };
const id = z.string().uuid();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
const registration = {
  kindCode: z.enum(["CAR", "MOTORCYCLE", "TRUCK", "BUS", "OTHER"]),
  specification: z
    .object({
      make: z.string().trim().min(1).max(100),
      model: z.string().trim().min(1).max(100),
      modelYear: z.number().int().min(1900).max(2200).optional(),
      plate: z.string().trim().max(20).optional(),
    })
    .strict(),
};
export const customerServiceInputs = {
  "vehicle.customer.retire": z
    .object({ vehicleId: id, reason: z.string().trim().min(5).max(1000) })
    .strict(),
  "vehicle.customer.register": z.object(registration).strict(),
  "vehicle.registration.update": z
    .object({
      vehicleId: id,
      ...registration,
      version: z.number().int().positive(),
    })
    .strict(),
  "vehicle.compliance.update": z
    .object({
      vehicleId: id,
      documentType: z.enum(["SOAT", "RTM"]),
      expiresOn: date,
      provider: z.string().trim().max(200).optional(),
    })
    .strict(),
  "vehicle.maintenance.append": z
    .object({
      vehicleId: id,
      performedOn: date,
      title: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(2000).default(""),
      mileage: z.number().int().nonnegative().max(10000000).optional(),
    })
    .strict(),
};
export async function customerVehicleState(
  db: D1Database,
  actor: Actor,
  vehicleId: string,
) {
  const entitlements = await getCustomerEntitlements(db, actor);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS rank FROM vehicle_vehicles v WHERE EXISTS(SELECT 1 FROM vehicle_relationships r WHERE r.vehicle_id=v.id AND r.person_id=? AND r.relationship_type='OWNER' AND r.ended_at IS NULL AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (v.created_at,v.id)<=(SELECT created_at,id FROM vehicle_vehicles WHERE id=?)`,
    )
    .bind(actor.personId, vehicleId)
    .first<{ rank: number }>();
  const owner = await db
    .prepare(
      "SELECT 1 FROM vehicle_relationships WHERE person_id=? AND vehicle_id=? AND relationship_type='OWNER' AND ended_at IS NULL AND effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(actor.personId, vehicleId)
    .first();
  return {
    entitlements,
    owned: !!owner,
    writable: !!owner && (row?.rank ?? 0) <= entitlements.vehicleLimit,
  };
}
export async function authorizeCustomerService(
  db: D1Database,
  actor: Actor,
  operation: string,
  body: Record<string, Json>,
) {
  const active = await db
    .prepare(
      "SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE'",
    )
    .bind(actor.accountId, actor.personId)
    .first();
  if (!active)
    throw new Problem(403, "FORBIDDEN", "Active customer account required");
  if (operation === "vehicle.customer.register") {
    const { entitlements } = await customerVehicleState(db, actor, "");
    const count = await db
      .prepare(
        "SELECT COUNT(DISTINCT vehicle_id) n FROM vehicle_relationships WHERE person_id=? AND relationship_type='OWNER' AND ended_at IS NULL",
      )
      .bind(actor.personId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= entitlements.vehicleLimit)
      throw new Problem(
        403,
        "VEHICLE_PLAN_LIMIT",
        "Tu plan alcanzó el límite de vehículos activos.",
      );
    return;
  }
  const vehicleId = String(body.vehicleId);
  if (!(await hasVehiclePermission(db, actor, vehicleId, "vehicle.read")))
    throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
  const state = await customerVehicleState(db, actor, vehicleId);
  if (!state.owned)
    throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
  if (operation === "vehicle.customer.retire") return;
  if (!state.writable)
    throw new Problem(
      403,
      "VEHICLE_PLAN_READ_ONLY",
      "Este vehículo conserva su historial y requiere Premium para editarlo.",
    );
  if (
    operation === "vehicle.maintenance.append" &&
    state.entitlements.manualMaintenanceLimit !== null
  ) {
    const count = await db
      .prepare(
        "SELECT COUNT(*) n FROM vehicle_manual_maintenance WHERE recorded_by_person_id=?",
      )
      .bind(actor.personId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= state.entitlements.manualMaintenanceLimit)
      throw new Problem(
        403,
        "MAINTENANCE_PLAN_LIMIT",
        "Gratis incluye hasta cinco registros manuales de mantenimiento.",
      );
  }
}
export async function prepareCustomerService(
  db: D1Database,
  actor: Actor,
  operation: string,
  body: Record<string, Json>,
  requestId: string,
) {
  const vehicleId =
    operation === "vehicle.customer.register"
      ? newId()
      : String(body.vehicleId);
  const statements: D1PreparedStatement[] = [];
  const response: Record<string, Json> = { vehicleId };
  const add = (sql: string, values: (string | number | null)[]) =>
    statements.push(
      db.prepare(sql).bind(...values),
      vehicleChangeAudit(db, actor, operation, vehicleId, requestId),
    );
  if (operation !== "vehicle.customer.register")
    statements.push(
      customerVehicleWriteGuard(
        db,
        actor,
        vehicleId,
        requestId,
        "vehicle.read",
        operation !== "vehicle.customer.retire",
      ),
    );
  else
    statements.push(
      db
        .prepare(
          `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) SELECT ?,?,'vehicle.customer.account.checked','vehicle',CASE WHEN EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE') THEN ? ELSE NULL END,?`,
        )
        .bind(
          newId(),
          actor.accountId,
          actor.accountId,
          actor.personId,
          vehicleId,
          requestId,
        ),
    );

  if (operation === "vehicle.customer.register") {
    add(
      `INSERT INTO vehicle_vehicles(id,kind_code,specification_json) SELECT ?,?,? WHERE (SELECT COUNT(DISTINCT vehicle_id) FROM vehicle_relationships WHERE person_id=? AND relationship_type='OWNER' AND ended_at IS NULL)<CASE WHEN ${customerPremiumPredicate} THEN 3 ELSE 1 END`,
      [
        vehicleId,
        String(body.kindCode),
        JSON.stringify(body.specification),
        actor.personId,
        actor.accountId,
        actor.personId,
      ],
    );
    add(
      "INSERT INTO vehicle_relationships(id,vehicle_id,relationship_type,person_id) VALUES(?,?,'OWNER',?)",
      [newId(), vehicleId, actor.personId],
    );
    for (const permission of [
      "vehicle.read",
      "vehicle.odometer.write",
      "vehicle.record.read",
    ])
      add(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,?)",
        [newId(), vehicleId, actor.personId, permission, actor.accountId],
      );
    add(
      "INSERT INTO vehicle_garage_entries(person_id,vehicle_id) VALUES(?,?)",
      [actor.personId, vehicleId],
    );
    response.version = 1;
  } else if (operation === "vehicle.customer.retire") {
    // End only this person's declaration; retain grants and all historical data.
    add(
      "UPDATE vehicle_relationships SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=(SELECT id FROM vehicle_relationships WHERE vehicle_id=? AND person_id=? AND relationship_type='OWNER' AND ended_at IS NULL ORDER BY id LIMIT 1)",
      [vehicleId, actor.personId],
    );
  } else if (operation === "vehicle.compliance.update") {
    const entryId = newId();
    response.entryId = entryId;
    add(
      "INSERT INTO vehicle_compliance_entries(id,vehicle_id,document_type,expires_on,provider,information_source,verification_status,recorded_by_account_id) VALUES(?,?,?,?,?,'USER_ENTERED','USER_ENTERED',?)",
      [
        entryId,
        vehicleId,
        String(body.documentType),
        String(body.expiresOn),
        typeof body.provider === "string" ? body.provider : null,
        actor.accountId,
      ],
    );
  } else if (operation === "vehicle.maintenance.append") {
    const entryId = newId();
    response.entryId = entryId;
    add(
      `INSERT INTO vehicle_manual_maintenance(id,vehicle_id,recorded_by_person_id,performed_on,title,notes,mileage) SELECT ?,?,?,?,?,?,? WHERE ${customerPremiumPredicate} OR (SELECT COUNT(*) FROM vehicle_manual_maintenance WHERE recorded_by_person_id=?)<5`,
      [
        entryId,
        vehicleId,
        actor.personId,
        String(body.performedOn),
        String(body.title),
        String(body.notes),
        typeof body.mileage === "number" ? body.mileage : null,
        actor.accountId,
        actor.personId,
        actor.personId,
      ],
    );
  } else if (operation === "vehicle.registration.update") {
    add(
      "UPDATE vehicle_vehicles SET kind_code=?,specification_json=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?",
      [
        String(body.kindCode),
        JSON.stringify(body.specification),
        vehicleId,
        Number(body.version),
      ],
    );
    response.version = Number(body.version) + 1;
  }
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "vehicle",
        aggregateId: vehicleId,
        eventType: "vehicle.changed.v1",
        eventVersion: 1,
        payload: { vehicleId, operation },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      vehicleEventContracts,
    ).statement,
  );
  return { vehicleId, statements, response };
}

export function customerVehicleWriteGuard(
  db: D1Database,
  actor: Actor,
  vehicleId: string,
  requestId: string,
  permission = "vehicle.read",
  restrictOwnerLimit = true,
) {
  const rank = restrictOwnerLimit
    ? ` AND EXISTS(SELECT 1 FROM vehicle_relationships r WHERE r.vehicle_id=? AND r.person_id=? AND r.relationship_type='OWNER' AND r.ended_at IS NULL AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (SELECT COUNT(*) FROM vehicle_vehicles v WHERE EXISTS(SELECT 1 FROM vehicle_relationships r WHERE r.vehicle_id=v.id AND r.person_id=? AND r.relationship_type='OWNER' AND r.ended_at IS NULL AND r.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (v.created_at,v.id)<=(SELECT created_at,id FROM vehicle_vehicles WHERE id=?))<=CASE WHEN ${customerPremiumPredicate} THEN 3 ELSE 1 END`
    : "";
  const bindings: (string | number | null)[] = [
    newId(),
    actor.accountId,
    actor.accountId,
    actor.personId,
    vehicleId,
    permission,
    null,
    null,
    null,
  ];
  if (restrictOwnerLimit)
    bindings.push(
      vehicleId,
      actor.personId,
      actor.personId,
      vehicleId,
      actor.accountId,
      actor.personId,
    );
  bindings.push(vehicleId, requestId);
  return db
    .prepare(
      `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) SELECT ?,?,'vehicle.customer.entitlement.checked','vehicle',CASE WHEN ${vehiclePermissionPredicate}${rank} THEN ? ELSE NULL END,?`,
    )
    .bind(...bindings);
}
