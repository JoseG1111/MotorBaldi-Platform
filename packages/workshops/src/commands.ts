import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import {
  auditStatement,
  outboxStatement,
  type EventRegistry,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";
import {
  requireWorkshopPermission,
  requireWorkshopAssignee,
  type WorkshopActor,
  type WorkshopContext,
} from "./access.js";
import {
  assertWorkshopTransition,
  workshopStates,
  type WorkshopState,
} from "./contract.js";
const id = z.string().uuid(),
  reason = z.string().trim().min(5).max(1000),
  description = z.string().trim().min(5).max(4000),
  version = z.number().int().positive();
export const workshopCommandInputs = {
  "workshop.order.file.attach": z
    .object({ organizationId: id, orderId: id, fileId: id, version, reason })
    .strict(),
  "workshop.order.create": z
    .object({
      organizationId: id,
      locationId: id,
      vehicleId: id,
      description,
      assignedPersonId: id.optional(),
      reason,
    })
    .strict(),
  "workshop.order.update": z
    .object({
      organizationId: id,
      orderId: id,
      version,
      description,
      assignedPersonId: id.nullable(),
      reason,
    })
    .strict(),
  "workshop.order.transition": z
    .object({
      organizationId: id,
      orderId: id,
      version,
      toStatus: z.enum(workshopStates),
      finalRecordId: id.optional(),
      reason,
    })
    .strict()
    .refine((v) => (v.toStatus === "COMPLETED") === Boolean(v.finalRecordId)),
} as const;
export type WorkshopOperation = keyof typeof workshopCommandInputs;
export type WorkshopOrder = {
  id: string;
  vehicle_id: string;
  organization_id: string;
  location_id: string;
  description: string;
  status: WorkshopState;
  assigned_person_id: string | null;
  final_record_id: string | null;
  version: number;
};
export function parseWorkshopCommand(
  operation: string,
  input: unknown,
): Record<string, Json> {
  const schema = workshopCommandInputs[operation as WorkshopOperation];
  if (!schema)
    throw new Problem(
      400,
      "UNKNOWN_WORKSHOP_OPERATION",
      "Unknown Workshop operation",
    );
  return schema.parse(input) as Record<string, Json>;
}
export async function workshopOrder(
  db: D1Database,
  organizationId: string,
  orderId: string,
) {
  const order = await db
    .prepare(
      "SELECT id,vehicle_id,organization_id,location_id,description,status,assigned_person_id,final_record_id,version FROM workshop_orders WHERE id=? AND organization_id=?",
    )
    .bind(orderId, organizationId)
    .first<WorkshopOrder>();
  if (!order)
    throw new Problem(404, "WORKSHOP_NOT_FOUND", "Workshop order not found");
  return order;
}
export function orderContext(order: WorkshopOrder): WorkshopContext {
  return {
    vehicleId: order.vehicle_id,
    organizationId: order.organization_id,
    locationId: order.location_id,
  };
}
export async function authorizeWorkshopCommand(
  db: D1Database,
  actor: WorkshopActor,
  operation: WorkshopOperation,
  body: Record<string, Json>,
) {
  const order =
    operation === "workshop.order.create"
      ? null
      : await workshopOrder(
          db,
          String(body.organizationId),
          String(body.orderId),
        );
  const context = order
    ? orderContext(order)
    : {
        organizationId: String(body.organizationId),
        locationId: String(body.locationId),
        vehicleId: String(body.vehicleId),
      };
  const execute =
    operation === "workshop.order.transition" &&
    (body.toStatus === "IN_PROGRESS" || body.toStatus === "COMPLETED");
  try {
    await requireWorkshopPermission(
      db,
      actor,
      context,
      execute ? "org.workshop.execute" : "org.workshop.manage",
      true,
    );
  } catch (error) {
    if (
      operation !== "workshop.order.file.attach" ||
      !(error instanceof Problem) ||
      error.status !== 404 ||
      order?.assigned_person_id !== actor.personId
    )
      throw error;
    await requireWorkshopPermission(
      db,
      actor,
      context,
      "org.workshop.execute",
      true,
    );
    await requireWorkshopAssignee(db, actor.personId, context);
  }

  if (execute) {
    if (order!.assigned_person_id !== actor.personId)
      throw new Problem(403, "FORBIDDEN", "Assigned executor required");
    await requireWorkshopAssignee(db, actor.personId, context);
  }
  if (
    operation === "workshop.order.transition" &&
    body.toStatus === "CLOSED" &&
    !actor.mfaEnabled
  )
    throw new Problem(
      403,
      "MFA_REQUIRED",
      "Multi-factor authentication required",
    );
  return { order, context };
}
export const workshopEventContracts: EventRegistry = new Map([
  [
    "workshop.order.changed.v1:1",
    {
      aggregateType: "workshop_order",
      version: 1,
      payload: z
        .object({
          orderId: id,
          vehicleId: id,
          organizationId: id,
          locationId: id,
          operation: z.enum([
            "workshop.order.create",
            "workshop.order.update",
            "workshop.order.transition",
            "workshop.order.file.attach",
          ]),
        })
        .strict(),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
export function workshopReplayAudit(
  db: D1Database,
  actor: WorkshopActor,
  orderId: string,
  requestId: string,
) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) VALUES(?,?,'workshop.command.accepted','workshop_order',CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
    )
    .bind(newId(), actor.accountId, orderId, requestId);
}
export async function prepareWorkshopCommand(
  db: D1Database,
  actor: WorkshopActor,
  operation: WorkshopOperation,
  body: Record<string, Json>,
  requestId: string,
) {
  const { order, context } = await authorizeWorkshopCommand(
    db,
    actor,
    operation,
    body,
  );
  const orderId = order?.id ?? newId();
  const nextVersion = order ? Number(body.version) + 1 : 1;
  let toStatus = order?.status ?? "DRAFT";
  let mutation: D1PreparedStatement;
  if (operation === "workshop.order.create") {
    if (typeof body.assignedPersonId === "string")
      await requireWorkshopAssignee(db, body.assignedPersonId, context);
    mutation = db
      .prepare(
        "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,assigned_person_id,created_by_account_id) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        orderId,
        context.vehicleId,
        context.organizationId,
        context.locationId,
        String(body.description),
        body.assignedPersonId ?? null,
        actor.accountId,
      );
  } else if (operation === "workshop.order.update") {
    if (
      order!.status === "COMPLETED" ||
      order!.status === "CLOSED" ||
      order!.status === "CANCELLED"
    )
      throw new Problem(
        409,
        "WORKSHOP_INVALID_TRANSITION",
        "Order cannot be edited",
      );
    if (typeof body.assignedPersonId === "string")
      await requireWorkshopAssignee(db, body.assignedPersonId, context);
    if (order!.status === "IN_PROGRESS" && body.assignedPersonId === null)
      throw new Problem(
        400,
        "INVALID_WORKSHOP_ASSIGNEE",
        "Active executor required",
      );
    mutation = db
      .prepare(
        "UPDATE workshop_orders SET description=?,assigned_person_id=?,updated_at=?,version=version+1 WHERE id=? AND organization_id=? AND version=? AND status=?",
      )
      .bind(
        String(body.description),
        body.assignedPersonId ?? null,
        utcNow(),
        orderId,
        context.organizationId,
        Number(body.version),
        order!.status,
      );
  } else if (operation === "workshop.order.file.attach") {
    if (!["DRAFT", "OPEN", "IN_PROGRESS"].includes(order!.status))
      throw new Problem(
        409,
        "WORKSHOP_INVALID_TRANSITION",
        "Completion evidence is frozen",
      );
    const file = await db
      .prepare(
        "SELECT 1 FROM storage_files WHERE id=? AND uploaded_by_account_id=? AND status='ACTIVE'",
      )
      .bind(String(body.fileId), actor.accountId)
      .first();
    if (!file)
      throw new Problem(
        409,
        "FILE_NOT_ACTIVE",
        "An ACTIVE file owned by the uploader is required",
      );
    mutation = db
      .prepare(
        "UPDATE workshop_orders SET updated_at=?,version=version+1 WHERE id=? AND organization_id=? AND version=? AND status=? AND EXISTS(SELECT 1 FROM storage_files f WHERE f.id=? AND f.status='ACTIVE' AND f.uploaded_by_account_id=?)",
      )
      .bind(
        utcNow(),
        orderId,
        context.organizationId,
        Number(body.version),
        order!.status,
        String(body.fileId),
        actor.accountId,
      );
  } else {
    toStatus = body.toStatus as WorkshopState;
    let finalRecord = false;
    if (toStatus === "COMPLETED")
      finalRecord = Boolean(
        await db
          .prepare(
            "SELECT 1 FROM vehicle_professional_records WHERE id=? AND vehicle_id=? AND organization_id=? AND location_id=? AND author_person_id=? AND status='FINAL'",
          )
          .bind(
            String(body.finalRecordId),
            context.vehicleId,
            context.organizationId,
            context.locationId,
            actor.personId,
          )
          .first(),
      );
    assertWorkshopTransition(order!.status, toStatus, {
      manage: !["IN_PROGRESS", "COMPLETED"].includes(toStatus),
      execute: ["IN_PROGRESS", "COMPLETED"].includes(toStatus),
      assigned: order!.assigned_person_id === actor.personId,
      finalRecord,
      mfa: actor.mfaEnabled,
    });
    mutation = db
      .prepare(
        "UPDATE workshop_orders SET status=?,final_record_id=?,updated_at=?,version=version+1 WHERE id=? AND organization_id=? AND version=? AND status=?",
      )
      .bind(
        toStatus,
        toStatus === "COMPLETED"
          ? String(body.finalRecordId)
          : order!.final_record_id,
        utcNow(),
        orderId,
        context.organizationId,
        Number(body.version),
        order!.status,
      );
  }
  const history = db
    .prepare(
      "INSERT INTO workshop_order_events(id,order_id,from_status,to_status,version,actor_account_id,reason) VALUES(?,?,?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?,?)",
    )
    .bind(
      newId(),
      orderId,
      order?.status ?? null,
      toStatus,
      nextVersion,
      actor.accountId,
      String(body.reason),
    );
  const event = outboxStatement(
    db,
    {
      aggregateType: "workshop_order",
      aggregateId: orderId,
      eventType: "workshop.order.changed.v1",
      eventVersion: 1,
      payload: { orderId, ...context, operation },
      requestId,
      externalEffectPolicy: "IDEMPOTENT",
    },
    workshopEventContracts,
  ).statement;
  const statements = [mutation, history];
  if (operation === "workshop.order.file.attach")
    statements.push(
      db
        .prepare(
          "INSERT INTO workshop_order_files(order_id,file_id,attached_by_account_id) VALUES(?,?,?)",
        )
        .bind(orderId, String(body.fileId), actor.accountId),
    );
  return {
    orderId,
    response: { orderId, version: nextVersion, status: toStatus } as Record<
      string,
      Json
    >,
    statements: [
      ...statements,
      auditStatement(db, {
        actorId: actor.accountId,
        action: operation,
        resourceType: "workshop_order",
        resourceId: orderId,
        organizationId: context.organizationId,
        reason: String(body.reason),
        requestId,
      }),
      event,
    ],
  };
}
