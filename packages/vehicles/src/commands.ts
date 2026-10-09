import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  requirePlatformPermission,
  requireOrganizationPermission,
} from "@motorbaldi/authz";
import { outboxStatement, type EventRegistry } from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";
import { hasVehiclePermission } from "./index.js";

type Actor = Principal & { personId: string };
const id = z.string().uuid();
const reason = z.string().trim().min(5).max(1000);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const content = z
  .record(z.string().max(128), z.json())
  .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= 65536);
const version = z.number().int().positive();
const target = {
  personId: id.optional(),
  organizationId: id.optional(),
  locationId: id.optional(),
};
const validTarget = (v: {
  personId?: string;
  organizationId?: string;
  locationId?: string;
}) =>
  Boolean(v.personId) !== Boolean(v.organizationId) &&
  (!v.locationId || Boolean(v.organizationId));
export const vehiclePermissions = [
  "vehicle.read",
  "vehicle.odometer.write",
  "vehicle.record.read",
  "vehicle.record.write",
] as const;
export const vehicleCommandInputs = {
  "vehicle.create": z
    .object({
      kindCode: code,
      specification: content
        .refine((v) => JSON.stringify(v).length <= 16384)
        .default({}),
      reason,
    })
    .strict(),
  "vehicle.update": z
    .object({
      vehicleId: id,
      kindCode: code,
      specification: content.refine((v) => JSON.stringify(v).length <= 16384),
      version,
      reason,
    })
    .strict(),
  "vehicle.identifier.add": z
    .object({
      vehicleId: id,
      identifierType: code,
      value: z.string().trim().min(1).max(256),
      countryCode: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional(),
      reason,
    })
    .strict(),
  "vehicle.identifier.retire": z
    .object({ vehicleId: id, identifierId: id, reason })
    .strict(),
  "vehicle.claim.submit": z
    .object({
      vehicleId: id,
      relationshipType: z.enum(["OWNER", "DRIVER"]),
      reason,
    })
    .strict(),
  "vehicle.claim.review": z
    .object({
      vehicleId: id,
      claimId: id,
      decision: z.enum(["ACCEPTED", "REJECTED"]),
      reason,
    })
    .strict(),
  "vehicle.relationship.end": z
    .object({ vehicleId: id, relationshipId: id, reason })
    .strict(),
  "vehicle.grant.create": z
    .object({
      vehicleId: id,
      ...target,
      permissionCode: z.enum(vehiclePermissions),
      expiresAt: z.iso.datetime({ precision: 3 }).optional(),
      reason,
    })
    .strict()
    .refine(validTarget),
  "vehicle.grant.revoke": z
    .object({ vehicleId: id, grantId: id, reason })
    .strict(),
  "vehicle.garage.add": z.object({ vehicleId: id }).strict(),
  "vehicle.garage.remove": z.object({ vehicleId: id }).strict(),
  "vehicle.odometer.append": z
    .object({
      vehicleId: id,
      value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      unit: z.enum(["KILOMETERS", "MILES"]),
      observedAt: z.iso.datetime({ precision: 3 }),
      correctsReadingId: id.optional(),
      correctionReason: reason.optional(),
    })
    .strict()
    .refine(
      (v) => Boolean(v.correctsReadingId) === Boolean(v.correctionReason),
    ),
  "vehicle.record.create": z
    .object({
      vehicleId: id,
      organizationId: id,
      locationId: id.optional(),
      recordType: code,
      content,
    })
    .strict(),
  "vehicle.record.update": z
    .object({ vehicleId: id, recordId: id, version, content })
    .strict(),
  "vehicle.record.finalize": z
    .object({ vehicleId: id, recordId: id, version })
    .strict(),
  "vehicle.record.amend": z
    .object({ vehicleId: id, recordId: id, content, reason })
    .strict(),
} as const;
export type VehicleOperation = keyof typeof vehicleCommandInputs;
export function parseVehicleCommand(
  operation: string,
  input: unknown,
): Record<string, Json> {
  const schema = vehicleCommandInputs[operation as VehicleOperation];
  if (!schema)
    throw new Problem(
      400,
      "UNKNOWN_VEHICLE_OPERATION",
      "Unknown vehicle command",
    );
  return schema.parse(input) as Record<string, Json>;
}
export const vehicleEventContracts: EventRegistry = new Map([
  [
    "vehicle.changed.v1:1",
    {
      aggregateType: "vehicle",
      version: 1,
      payload: z.object({
        vehicleId: id,
        operation: z.enum(
          Object.keys(vehicleCommandInputs) as [string, ...string[]],
        ),
      }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
const staffOperations = new Set([
  "vehicle.create",
  "vehicle.update",
  "vehicle.identifier.add",
  "vehicle.identifier.retire",
  "vehicle.claim.review",
  "vehicle.relationship.end",
  "vehicle.grant.create",
  "vehicle.grant.revoke",
]);

/** Rechecked inside the serialized coordinator, including before returning a replay. */
export async function authorizeVehicleCommand(
  db: D1Database,
  actor: Actor,
  operation: VehicleOperation,
  body: Record<string, Json>,
) {
  if (staffOperations.has(operation)) {
    await requirePlatformPermission(db, actor, "platform.vehicle.manage", {
      mfa: true,
    });
    return;
  }
  const vehicleId = String(body.vehicleId);
  if (operation === "vehicle.garage.remove") return;
  const permission =
    operation === "vehicle.odometer.append"
      ? "vehicle.odometer.write"
      : operation.startsWith("vehicle.record.")
        ? "vehicle.record.write"
        : "vehicle.read";
  if (!(await hasVehiclePermission(db, actor, vehicleId, permission)))
    throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
  if (operation.startsWith("vehicle.record.")) {
    const record =
      operation === "vehicle.record.create"
        ? null
        : await db
            .prepare(
              "SELECT organization_id,location_id,author_person_id FROM vehicle_professional_records WHERE id=? AND vehicle_id=?",
            )
            .bind(String(body.recordId), vehicleId)
            .first<{
              organization_id: string;
              location_id: string | null;
              author_person_id: string;
            }>();
    if (operation !== "vehicle.record.create" && !record)
      throw new Problem(404, "RECORD_NOT_FOUND", "Record not found");
    if (record && record.author_person_id !== actor.personId)
      throw new Problem(
        403,
        "FORBIDDEN",
        "Only the author may change this record",
      );
    const orgId = record?.organization_id ?? String(body.organizationId);
    const locationId =
      record?.location_id ??
      (typeof body.locationId === "string" ? body.locationId : undefined);
    await requireOrganizationPermission(
      db,
      actor,
      orgId,
      "org.vehicle.record.manage",
      locationId ?? undefined,
    );
    // Vehicle grants separately enforce membership validity and location scope.
    const membership = await db
      .prepare(
        `SELECT 1 FROM org_memberships m JOIN org_organizations o ON o.id=m.organization_id WHERE m.person_id=? AND m.organization_id=? AND m.status='ACTIVE' AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND m.valid_from<=? AND (m.valid_to IS NULL OR m.valid_to>?) AND (? IS NULL OR EXISTS(SELECT 1 FROM org_locations l WHERE l.id=? AND l.organization_id=o.id AND l.status='ACTIVE' AND (m.location_scope_type='ALL_LOCATIONS' OR EXISTS(SELECT 1 FROM org_membership_locations ml WHERE ml.membership_id=m.id AND ml.organization_id=o.id AND ml.location_id=l.id))))`,
      )
      .bind(
        actor.personId,
        orgId,
        utcNow(),
        utcNow(),
        locationId ?? null,
        locationId ?? null,
      )
      .first();
    if (!membership)
      throw new Problem(
        403,
        "FORBIDDEN",
        "Verified organization and active membership required",
      );
    if (
      (operation === "vehicle.record.finalize" ||
        operation === "vehicle.record.amend") &&
      !actor.mfaEnabled
    )
      throw new Problem(
        403,
        "MFA_REQUIRED",
        "Multi-factor authentication required",
      );
  }
}

/** A dependent NOT NULL audit insert aborts the entire D1 batch on a lost CAS. */
export function vehicleChangeAudit(
  db: D1Database,
  actor: Actor,
  action: string,
  vehicleId: string,
  requestId: string,
  why?: string,
) {
  return db
    .prepare(
      `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason) VALUES(?,?,?,'vehicle',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)`,
    )
    .bind(newId(), actor.accountId, action, vehicleId, requestId, why ?? null);
}
export async function prepareVehicleCommand(
  db: D1Database,
  actor: Actor,
  operation: VehicleOperation,
  body: Record<string, Json>,
  requestId: string,
) {
  const vehicleId =
    operation === "vehicle.create" ? newId() : String(body.vehicleId);
  const statements: D1PreparedStatement[] = [];
  const response: Record<string, Json> = { vehicleId };
  const add = (
    sql: string,
    values: (string | number | null)[],
    action = operation,
  ) => {
    statements.push(
      db.prepare(sql).bind(...values),
      vehicleChangeAudit(
        db,
        actor,
        action,
        vehicleId,
        requestId,
        typeof body.reason === "string" ? body.reason : undefined,
      ),
    );
  };
  if (operation !== "vehicle.create" && operation !== "vehicle.garage.remove") {
    const exists = await db
      .prepare("SELECT 1 FROM vehicle_vehicles WHERE id=?")
      .bind(vehicleId)
      .first();
    if (!exists)
      throw new Problem(404, "VEHICLE_NOT_FOUND", "Vehicle not found");
  }
  switch (operation) {
    case "vehicle.create":
      add(
        "INSERT INTO vehicle_vehicles(id,kind_code,specification_json) VALUES(?,?,?)",
        [vehicleId, String(body.kindCode), JSON.stringify(body.specification)],
      );
      response.version = 1;
      break;
    case "vehicle.update":
      add(
        "UPDATE vehicle_vehicles SET kind_code=?,specification_json=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        [
          String(body.kindCode),
          JSON.stringify(body.specification),
          utcNow(),
          vehicleId,
          Number(body.version),
        ],
      );
      response.version = Number(body.version) + 1;
      break;
    case "vehicle.identifier.add": {
      const identifierId = newId();
      response.identifierId = identifierId;
      add(
        "INSERT INTO vehicle_identifiers(id,vehicle_id,identifier_type,country_code,raw_value,normalized_value) VALUES(?,?,?,?,?,?)",
        [
          identifierId,
          vehicleId,
          String(body.identifierType),
          typeof body.countryCode === "string" ? body.countryCode : null,
          String(body.value),
          String(body.value).normalize("NFKC").trim().toUpperCase(),
        ],
      );
      break;
    }
    case "vehicle.identifier.retire":
      add(
        "UPDATE vehicle_identifiers SET retired_at=? WHERE id=? AND vehicle_id=? AND retired_at IS NULL",
        [utcNow(), String(body.identifierId), vehicleId],
      );
      break;
    case "vehicle.claim.submit": {
      const claimId = newId();
      response.claimId = claimId;
      add(
        "INSERT INTO vehicle_claims(id,vehicle_id,relationship_type,claimant_person_id,submitted_by_person_id) VALUES(?,?,?,?,?)",
        [
          claimId,
          vehicleId,
          String(body.relationshipType),
          actor.personId,
          actor.personId,
        ],
      );
      break;
    }
    case "vehicle.claim.review": {
      add(
        "UPDATE vehicle_claims SET status=?,reviewed_by_person_id=?,reviewed_at=? WHERE id=? AND vehicle_id=? AND status='PENDING'",
        [
          String(body.decision),
          actor.personId,
          utcNow(),
          String(body.claimId),
          vehicleId,
        ],
      );
      if (body.decision === "ACCEPTED") {
        const relationshipId = newId();
        response.relationshipId = relationshipId;
        add(
          "INSERT INTO vehicle_relationships(id,vehicle_id,relationship_type,person_id,organization_id,source_claim_id) SELECT ?,vehicle_id,relationship_type,claimant_person_id,claimant_organization_id,id FROM vehicle_claims WHERE id=? AND vehicle_id=? AND status='ACCEPTED'",
          [relationshipId, String(body.claimId), vehicleId],
        );
      }
      break;
    }
    case "vehicle.relationship.end":
      add(
        "UPDATE vehicle_relationships SET ended_at=? WHERE id=? AND vehicle_id=? AND ended_at IS NULL",
        [utcNow(), String(body.relationshipId), vehicleId],
      );
      break;
    case "vehicle.grant.create": {
      const grantId = newId();
      response.grantId = grantId;
      if (body.expiresAt && String(body.expiresAt) <= utcNow())
        throw new Problem(400, "INVALID_EXPIRY", "Future expiry required");
      const personId = typeof body.personId === "string" ? body.personId : null;
      const orgId =
        typeof body.organizationId === "string" ? body.organizationId : null;
      const locationId =
        typeof body.locationId === "string" ? body.locationId : null;
      const active = personId
        ? await db
            .prepare("SELECT 1 FROM iam_people WHERE id=? AND status='ACTIVE'")
            .bind(personId)
            .first()
        : await db
            .prepare(
              "SELECT 1 FROM org_organizations o WHERE o.id=? AND o.status='ACTIVE' AND o.verification_status='VERIFIED' AND (? IS NULL OR EXISTS(SELECT 1 FROM org_locations l WHERE l.id=? AND l.organization_id=o.id AND l.status='ACTIVE'))",
            )
            .bind(orgId, locationId, locationId)
            .first();
      if (!active)
        throw new Problem(
          400,
          "INVALID_GRANT_TARGET",
          "Active target required",
        );
      add(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,person_id,organization_id,location_id,permission_code,granted_by_account_id,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          grantId,
          vehicleId,
          personId,
          orgId,
          locationId,
          String(body.permissionCode),
          actor.accountId,
          typeof body.expiresAt === "string" ? body.expiresAt : null,
        ],
      );
      break;
    }
    case "vehicle.grant.revoke":
      add(
        "UPDATE vehicle_access_grants SET revoked_at=? WHERE id=? AND vehicle_id=? AND revoked_at IS NULL",
        [utcNow(), String(body.grantId), vehicleId],
      );
      break;
    case "vehicle.garage.add":
      add(
        "INSERT INTO vehicle_garage_entries(person_id,vehicle_id) VALUES(?,?) ON CONFLICT(person_id,vehicle_id) DO UPDATE SET added_at=excluded.added_at",
        [actor.personId, vehicleId],
      );
      break;
    case "vehicle.garage.remove":
      // Removing an absent bookmark is a safe no-op; no access to vehicle details is needed.
      statements.push(
        db
          .prepare(
            "DELETE FROM vehicle_garage_entries WHERE person_id=? AND vehicle_id=?",
          )
          .bind(actor.personId, vehicleId),
      );
      break;
    case "vehicle.odometer.append": {
      if (String(body.observedAt) > utcNow())
        throw new Problem(
          400,
          "INVALID_OBSERVATION",
          "Observation cannot be in the future",
        );
      const readingId = newId();
      response.readingId = readingId;
      add(
        "INSERT INTO vehicle_odometer_readings(id,vehicle_id,reading_value,unit,observed_at,recorded_by_account_id,corrects_reading_id,correction_reason) VALUES(?,?,?,?,?,?,?,?)",
        [
          readingId,
          vehicleId,
          Number(body.value),
          String(body.unit),
          String(body.observedAt),
          actor.accountId,
          typeof body.correctsReadingId === "string"
            ? body.correctsReadingId
            : null,
          typeof body.correctionReason === "string"
            ? body.correctionReason
            : null,
        ],
      );
      break;
    }
    case "vehicle.record.create": {
      const recordId = newId();
      response.recordId = recordId;
      response.version = 1;
      add(
        "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,location_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,?,?,?)",
        [
          recordId,
          vehicleId,
          String(body.organizationId),
          typeof body.locationId === "string" ? body.locationId : null,
          actor.personId,
          String(body.recordType),
          JSON.stringify(body.content),
        ],
      );
      break;
    }
    case "vehicle.record.update":
      add(
        "UPDATE vehicle_professional_records SET content_json=?,version=version+1,updated_at=? WHERE id=? AND vehicle_id=? AND author_person_id=? AND version=? AND status='DRAFT'",
        [
          JSON.stringify(body.content),
          utcNow(),
          String(body.recordId),
          vehicleId,
          actor.personId,
          Number(body.version),
        ],
      );
      response.version = Number(body.version) + 1;
      break;
    case "vehicle.record.finalize":
      add(
        "UPDATE vehicle_professional_records SET status='FINAL',finalized_at=?,updated_at=?,version=version+1 WHERE id=? AND vehicle_id=? AND author_person_id=? AND version=? AND status='DRAFT'",
        [
          utcNow(),
          utcNow(),
          String(body.recordId),
          vehicleId,
          actor.personId,
          Number(body.version),
        ],
      );
      response.version = Number(body.version) + 1;
      break;
    case "vehicle.record.amend": {
      const amendmentId = newId();
      response.amendmentId = amendmentId;
      add(
        "INSERT INTO vehicle_professional_amendments(id,record_id,author_person_id,reason,content_json) SELECT ?,id,?,?,? FROM vehicle_professional_records WHERE id=? AND vehicle_id=? AND status='FINAL' AND author_person_id=?",
        [
          amendmentId,
          actor.personId,
          String(body.reason),
          JSON.stringify(body.content),
          String(body.recordId),
          vehicleId,
          actor.personId,
        ],
      );
      break;
    }
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
