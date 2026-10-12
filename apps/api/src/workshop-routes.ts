import { Problem, type Principal } from "@motorbaldi/contracts";
import { requirePlatformPermission } from "@motorbaldi/authz";
import { hasVehiclePermission } from "@motorbaldi/vehicles";
import {
  workshopOrder,
  orderContext,
  requireWorkshopPermission,
  parseWorkshopCommand,
  listWorkshopLocations,
} from "@motorbaldi/workshops";
import type { Json } from "@motorbaldi/shared";
const uuid = "[0-9a-f-]{36}";
export async function workshopRoutes(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (
    operation: string,
    body: Json,
    organizationId: string,
  ) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  const reply = (body: unknown) =>
    Response.json(body, { headers: { ...cors, "cache-control": "no-store" } });
  const method = (expected: string) => {
    if (request.method !== expected)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  const command = async (operation: string, extra: Record<string, Json>) => {
    method("POST");
    await principal();
    const body = await readBody();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Problem(400, "INVALID_WORKSHOP_INPUT", "Object required");
    for (const name of Object.keys(extra))
      if (name in body)
        throw new Problem(
          400,
          "INVALID_WORKSHOP_INPUT",
          "Route identifiers cannot be overridden",
        );
    const parsed = parseWorkshopCommand(operation, { ...body, ...extra });
    return reply(
      await execute(operation, parsed, String(parsed.organizationId)),
    );
  };
  const scope = path.match(
    new RegExp(
      "^/api/v1/organizations/(" + uuid + ")/workshop/(locations|orders)$",
    ),
  );
  if (scope) {
    const organizationId = scope[1]!;
    if (scope[2] === "locations") {
      method("GET");
      const actor = await principal();
      return reply({
        items: await listWorkshopLocations(db, actor, organizationId),
        canManage:
          (
            await listWorkshopLocations(
              db,
              actor,
              organizationId,
              "org.workshop.manage",
            )
          ).length > 0,
      });
    }
    if (request.method === "POST")
      return command("workshop.order.create", { organizationId });
    method("GET");
    const actor = await principal();
    // Apply the canonical read predicates before LIMIT so denied rows cannot
    // consume the page. Keep per-row checks below for authority changes between
    // queries; continuation only uses an emitted, authorized ID (and may end if
    // all selected rows lose authority). SQL parity is covered by qa-pagination.
    const rows = await db
      .prepare(
        `SELECT row.id,row.vehicle_id,row.location_id,row.description,row.status,row.assigned_person_id,row.final_record_id,row.version FROM workshop_orders row WHERE row.organization_id=? AND row.id>? AND (? IS NULL OR row.location_id=?) AND EXISTS (SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN org_memberships m ON m.person_id=p.id JOIN org_organizations o ON o.id=m.organization_id JOIN org_locations l ON l.organization_id=o.id JOIN org_membership_roles mr ON mr.membership_id=m.id JOIN authz_role_permissions rp ON rp.role_id=mr.role_id JOIN authz_roles r ON r.id=mr.role_id AND r.scope='ORGANIZATION'
 WHERE a.id=? AND p.id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND o.id=row.organization_id AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND l.id=row.location_id AND l.status='ACTIVE' AND m.status='ACTIVE'
 AND m.valid_from<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (m.valid_to IS NULL OR m.valid_to>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND rp.permission_code=?
 AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=l.id))
 AND (EXISTS(SELECT 1 FROM org_capabilities c WHERE c.organization_id=o.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK')) OR EXISTS(SELECT 1 FROM org_location_capabilities c WHERE c.organization_id=o.id AND c.location_id=l.id AND c.code IN ('CAR_SERVICE','MOTORCYCLE_SERVICE','GENERAL_MAINTENANCE','ELECTRICAL','DIAGNOSTICS','TIRES','BODYWORK'))) LIMIT 1) AND EXISTS (SELECT 1 AS allowed
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
        actor.accountId,
        actor.personId,
        "org.workshop.read",
        actor.accountId,
        actor.personId,
        "vehicle.workshop.read",
      )
      .all();
    const items = [];
    for (const row of rows.results.slice(0, 30))
      try {
        await requireWorkshopPermission(
          db,
          actor,
          {
            organizationId,
            locationId: String(row.location_id),
            vehicleId: String(row.vehicle_id),
          },
          "org.workshop.read",
        );
        items.push(row);
      } catch (error) {
        if (!(error instanceof Problem) || error.status !== 404) throw error;
      }
    return reply({
      items,
      nextCursor: rows.results.length > 30 ? (items.at(-1)?.id ?? null) : null,
    });
  }
  const available = path.match(
    new RegExp(
      "^/api/v1/organizations/(" +
        uuid +
        ")/workshop/locations/(" +
        uuid +
        ")/vehicles$",
    ),
  );
  if (available) {
    method("GET");
    const actor = await principal(),
      organizationId = available[1]!,
      locationId = available[2]!;
    const locations = await listWorkshopLocations(
      db,
      actor,
      organizationId,
      "org.workshop.manage",
    );
    if (!locations.some((row) => row.id === locationId))
      throw new Problem(
        404,
        "WORKSHOP_NOT_FOUND",
        "Workshop location not found",
      );
    const rows = await db
      .prepare(
        "SELECT DISTINCT v.id,v.kind_code FROM vehicle_vehicles v JOIN vehicle_access_grants g ON g.vehicle_id=v.id WHERE g.permission_code='vehicle.workshop.write' AND (g.person_id=? OR g.organization_id=?) AND g.revoked_at IS NULL AND v.id>? ORDER BY v.id LIMIT 30",
      )
      .bind(
        actor.personId,
        organizationId,
        url.searchParams.get("cursor") ?? "",
      )
      .all();
    const items = [];
    for (const row of rows.results)
      if (
        await hasVehiclePermission(
          db,
          actor,
          String(row.id),
          "vehicle.workshop.write",
          { organizationId, locationId },
        )
      )
        items.push(row);
    return reply({ items });
  }
  const orderFiles = path.match(
    new RegExp(
      "^/api/v1/organizations/(" +
        uuid +
        ")/workshop/orders/(" +
        uuid +
        ")/files(?:/(" +
        uuid +
        "))?$",
    ),
  );
  if (orderFiles) {
    const organizationId = orderFiles[1]!,
      orderId = orderFiles[2]!,
      fileId = orderFiles[3];
    if (!fileId && request.method === "POST")
      return command("workshop.order.file.attach", { organizationId, orderId });
    method("GET");
    const actor = await principal(),
      order = await workshopOrder(db, organizationId, orderId);
    await requireWorkshopPermission(
      db,
      actor,
      orderContext(order),
      "org.workshop.read",
    );
    if (!fileId)
      return reply({
        items: (
          await db
            .prepare(
              "SELECT f.id,f.declared_mime,f.size_bytes,f.status,w.attached_at FROM workshop_order_files w JOIN storage_files f ON f.id=w.file_id WHERE w.order_id=? ORDER BY w.attached_at,f.id LIMIT 50",
            )
            .bind(orderId)
            .all()
        ).results,
      });
    const file = await db
      .prepare(
        "SELECT f.active_key,f.declared_mime FROM workshop_order_files w JOIN storage_files f ON f.id=w.file_id WHERE w.order_id=? AND f.id=? AND f.status='ACTIVE'",
      )
      .bind(orderId, fileId)
      .first<{ active_key: string | null; declared_mime: string }>();
    if (!file?.active_key)
      throw new Problem(404, "FILE_NOT_FOUND", "Evidence unavailable");
    const object = await bucket.get(file.active_key);
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
  const orderMatch = path.match(
    new RegExp(
      "^/api/v1/organizations/(" +
        uuid +
        ")/workshop/orders/(" +
        uuid +
        ")(?:/(update|transition))?$",
    ),
  );
  if (orderMatch) {
    const organizationId = orderMatch[1]!,
      orderId = orderMatch[2]!;
    if (orderMatch[3])
      return command("workshop.order." + orderMatch[3], {
        organizationId,
        orderId,
      });
    method("GET");
    const actor = await principal(),
      order = await workshopOrder(db, organizationId, orderId);
    await requireWorkshopPermission(
      db,
      actor,
      orderContext(order),
      "org.workshop.read",
    );
    const history = (
      await db
        .prepare(
          "SELECT from_status,to_status,version,reason,created_at FROM workshop_order_events WHERE order_id=? ORDER BY version LIMIT 100",
        )
        .bind(orderId)
        .all()
    ).results;
    let canManage = false,
      canExecute = false;
    try {
      await requireWorkshopPermission(
        db,
        actor,
        orderContext(order),
        "org.workshop.manage",
        true,
      );
      canManage = true;
    } catch (error) {
      if (!(error instanceof Problem) || error.status !== 404) throw error;
    }
    try {
      await requireWorkshopPermission(
        db,
        actor,
        orderContext(order),
        "org.workshop.execute",
        true,
      );
      canExecute = order.assigned_person_id === actor.personId;
    } catch (error) {
      if (!(error instanceof Problem) || error.status !== 404) throw error;
    }
    return reply({
      order,
      history,
      canManage,
      canExecute,
      mfaEnabled: actor.mfaEnabled,
    });
  }
  if (path === "/api/v1/admin/workshop/orders") {
    method("GET");
    const actor = await principal();
    await requirePlatformPermission(db, actor, "platform.workshop.read", {
      mfa: true,
    });
    const rows = await db
      .prepare(
        "SELECT w.id,w.organization_id,o.display_name AS organization_name,w.location_id,l.name AS location_name,w.vehicle_id,w.description,w.status,w.version FROM workshop_orders w JOIN org_organizations o ON o.id=w.organization_id JOIN org_locations l ON l.id=w.location_id WHERE w.id>? ORDER BY w.id LIMIT 30",
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
