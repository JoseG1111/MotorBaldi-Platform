import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  requireOrganizationPermission,
  requirePlatformPermission,
} from "@motorbaldi/authz";
import {
  auditStatement,
  guardedBatch,
  outboxStatement,
  type EventRegistry,
} from "@motorbaldi/db";
import { newId, sha256Hex, utcNow } from "@motorbaldi/shared";

export type BusinessPrincipal = Principal & { personId: string };
const id = z.string().uuid();
export const locationInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    locationType: z.enum(["HEADQUARTERS", "BRANCH", "SERVICE_SITE", "OTHER"]),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    administrativeArea: z.string().trim().min(1).max(160),
    city: z.string().trim().min(1).max(160),
    postalCode: z.string().trim().max(40).optional(),
    addressLine1: z.string().trim().min(1).max(240),
    addressLine2: z.string().trim().max(240).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict();
export const organizationInput = z
  .object({
    type: z.enum([
      "WORKSHOP",
      "PARTS_SUPPLIER",
      "DEALERSHIP",
      "INSPECTION_CENTER",
      "ROADSIDE_PROVIDER",
      "FLEET",
      "OTHER",
    ]),
    legalName: z.string().trim().min(1).max(240),
    displayName: z.string().trim().min(1).max(240),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    initialLocation: locationInput.optional(),
  })
  .strict();
export const memberRoles = z
  .array(
    z.enum([
      "OWNER",
      "ADMIN",
      "SERVICE_ADVISOR",
      "MECHANIC",
      "INSPECTOR",
      "FINANCE",
      "VIEWER",
    ]),
  )
  .min(1)
  .max(7)
  .refine((v) => new Set(v).size === v.length);
export const locationScope = z
  .object({
    type: z.enum(["ALL_LOCATIONS", "SELECTED_LOCATIONS"]),
    locationIds: z.array(id).max(100).default([]),
  })
  .strict()
  .refine((v) =>
    v.type === "ALL_LOCATIONS"
      ? v.locationIds.length === 0
      : v.locationIds.length > 0,
  );
const registry: EventRegistry = new Map([
  [
    "organization.created.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "organization.invitation.created.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id, invitationId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "organization.membership.requested.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id, requestId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "organization.membership.approved.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id, requestId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "organization.verification.submitted.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id, caseId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "organization.verification.approved.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id, caseId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "organization.verification.rejected.v1:1",
    {
      aggregateType: "organization",
      version: 1,
      payload: z.object({ organizationId: id, caseId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
function event(
  db: D1Database,
  organizationId: string,
  eventType: string,
  payload: Record<string, string>,
  requestId: string,
) {
  return outboxStatement(
    db,
    {
      aggregateType: "organization",
      aggregateId: organizationId,
      eventType,
      eventVersion: 1,
      payload,
      requestId,
      externalEffectPolicy: "IDEMPOTENT",
    },
    registry,
  ).statement;
}
async function validateScope(
  db: D1Database,
  organizationId: string,
  scope: z.infer<typeof locationScope>,
) {
  const parsed = locationScope.parse(scope);
  for (const locationId of parsed.locationIds) {
    const row = await db
      .prepare(
        "SELECT 1 FROM org_locations WHERE id=? AND organization_id=? AND status='ACTIVE'",
      )
      .bind(locationId, organizationId)
      .first();
    if (!row)
      throw new Problem(
        400,
        "INVALID_LOCATION_SCOPE",
        "Invalid location scope",
      );
  }
  return parsed;
}
export async function createOrganization(
  db: D1Database,
  actor: BusinessPrincipal,
  input: z.infer<typeof organizationInput>,
  requestId: string,
) {
  const c = organizationInput.parse(input);
  const organizationId = newId();
  const locationId = c.initialLocation ? newId() : null;
  const statements = [
    db
      .prepare(
        "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        organizationId,
        c.type,
        c.legalName,
        c.displayName,
        c.countryCode,
        actor.personId,
      ),
  ];
  if (c.initialLocation) {
    const l = c.initialLocation;
    statements.push(
      db
        .prepare(
          "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,postal_code,address_line_1,address_line_2,latitude,longitude) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          locationId,
          organizationId,
          l.name,
          l.locationType,
          l.countryCode,
          l.administrativeArea,
          l.city,
          l.postalCode ?? null,
          l.addressLine1,
          l.addressLine2 ?? null,
          l.latitude ?? null,
          l.longitude ?? null,
        ),
    );
  }
  const membershipId = newId();
  statements.push(
    db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
      )
      .bind(membershipId, organizationId, actor.personId),
    db
      .prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-owner')",
      )
      .bind(membershipId),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.created",
      resourceType: "organization",
      resourceId: organizationId,
      organizationId,
      requestId,
    }),
    event(
      db,
      organizationId,
      "organization.created.v1",
      { organizationId },
      requestId,
    ),
  );
  await db.batch(statements);
  return { organizationId, locationId, membershipId };
}
export async function workspaces(db: D1Database, personId: string) {
  const rows = await db
    .prepare(
      "SELECT o.id,o.display_name,o.type,m.id AS membership_id,m.location_scope_type FROM org_memberships m JOIN org_organizations o ON o.id=m.organization_id WHERE m.person_id=? AND m.status='ACTIVE' AND o.status='ACTIVE' ORDER BY o.display_name,o.id LIMIT 100",
    )
    .bind(personId)
    .all<{
      id: string;
      display_name: string;
      type: string;
      membership_id: string;
      location_scope_type: string;
    }>();
  return [
    { type: "PERSONAL", id: "personal", name: "Mi cuenta" },
    ...rows.results.map((row) => ({
      type: "ORGANIZATION",
      id: row.id,
      name: row.display_name,
      organizationType: row.type,
      membershipId: row.membership_id,
      locationScopeType: row.location_scope_type,
    })),
  ];
}
export async function addLocation(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  input: z.infer<typeof locationInput>,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.location.manage",
  );
  const c = locationInput.parse(input);
  const locationId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,postal_code,address_line_1,address_line_2,latitude,longitude) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        locationId,
        organizationId,
        c.name,
        c.locationType,
        c.countryCode,
        c.administrativeArea,
        c.city,
        c.postalCode ?? null,
        c.addressLine1,
        c.addressLine2 ?? null,
        c.latitude ?? null,
        c.longitude ?? null,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.location.created",
      resourceType: "organization_location",
      resourceId: locationId,
      organizationId,
      requestId,
    }),
  ]);
  return locationId;
}
export async function setCapabilities(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  codes: string[],
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.capability.manage",
  );
  if (codes.length > 20 || new Set(codes).size !== codes.length)
    throw new Problem(400, "INVALID_CAPABILITIES", "Invalid capabilities");
  const statements = [
    db
      .prepare("DELETE FROM org_capabilities WHERE organization_id=?")
      .bind(organizationId),
  ];
  for (const code of codes)
    statements.push(
      db
        .prepare(
          "INSERT INTO org_capabilities(organization_id,code) VALUES(?,?)",
        )
        .bind(organizationId, code),
    );
  statements.push(
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.capabilities.updated",
      resourceType: "organization",
      resourceId: organizationId,
      organizationId,
      requestId,
    }),
  );
  await db.batch(statements);
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export async function createInvitation(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  targetEmail: string,
  roles: string[],
  scope: z.infer<typeof locationScope>,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.member.invite",
  );
  const parsedRoles = memberRoles.parse(roles);
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.member.role.manage",
  );
  if (parsedRoles.includes("OWNER"))
    await requireOrganizationPermission(
      db,
      actor,
      organizationId,
      "org.owner.manage",
    );
  const parsedScope = await validateScope(db, organizationId, scope);
  const email = targetEmail.trim().normalize("NFKC").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
    throw new Problem(400, "INVALID_EMAIL", "Invalid email");
  const token = randomToken(),
    hash = await sha256Hex(token),
    invitationId = newId();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_invitations(id,organization_id,target_email,proposed_roles_json,location_scope_type,proposed_locations_json,token_hash,created_by_person_id,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        invitationId,
        organizationId,
        email,
        JSON.stringify(parsedRoles),
        parsedScope.type,
        JSON.stringify(parsedScope.locationIds),
        hash,
        actor.personId,
        expiresAt,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.invitation.created",
      resourceType: "organization_invitation",
      resourceId: invitationId,
      organizationId,
      requestId,
    }),
    event(
      db,
      organizationId,
      "organization.invitation.created.v1",
      { organizationId, invitationId },
      requestId,
    ),
  ]);
  return { invitationId, token, expiresAt };
}
export async function acceptInvitation(
  db: D1Database,
  actor: BusinessPrincipal,
  token: string,
  requestId: string,
) {
  if (!/^[0-9a-f]{64}$/.test(token))
    throw new Problem(400, "INVITATION_INVALID", "Invitation unavailable");
  const hash = await sha256Hex(token);
  const invitation = await db
    .prepare("SELECT * FROM org_invitations WHERE token_hash=?")
    .bind(hash)
    .first<{
      id: string;
      organization_id: string;
      target_email: string;
      proposed_roles_json: string;
      location_scope_type: "ALL_LOCATIONS" | "SELECTED_LOCATIONS";
      proposed_locations_json: string;
      status: string;
      expires_at: string;
      accepted_by_person_id: string | null;
    }>();
  if (!invitation)
    throw new Problem(400, "INVITATION_INVALID", "Invitation unavailable");
  if (
    invitation.status === "ACCEPTED" &&
    invitation.accepted_by_person_id === actor.personId
  )
    return { invitationId: invitation.id, accepted: true };
  if (invitation.status !== "PENDING")
    throw new Problem(400, "INVITATION_INVALID", "Invitation unavailable");
  if (invitation.expires_at <= utcNow())
    throw new Problem(400, "INVITATION_EXPIRED", "Invitation unavailable");
  const user = await db
    .prepare("SELECT email,email_verified FROM auth_users WHERE id=?")
    .bind(actor.accountId)
    .first<{ email: string; email_verified: number }>();
  if (
    !user ||
    user.email_verified !== 1 ||
    user.email.trim().toLowerCase() !== invitation.target_email
  )
    throw new Problem(
      403,
      "INVITATION_EMAIL_MISMATCH",
      "Invitation unavailable",
    );
  const org = await db
    .prepare("SELECT status FROM org_organizations WHERE id=?")
    .bind(invitation.organization_id)
    .first<{ status: string }>();
  if (org?.status !== "ACTIVE")
    throw new Problem(
      409,
      "ORGANIZATION_UNAVAILABLE",
      "Organization unavailable",
    );
  const roles = memberRoles.parse(JSON.parse(invitation.proposed_roles_json));
  const scope = await validateScope(db, invitation.organization_id, {
    type: invitation.location_scope_type,
    locationIds: JSON.parse(invitation.proposed_locations_json),
  });
  const membershipId = newId();
  const statements = [
    db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,?)",
      )
      .bind(
        membershipId,
        invitation.organization_id,
        actor.personId,
        scope.type,
      ),
    ...roles.map((role) =>
      db
        .prepare(
          "INSERT INTO org_membership_roles(membership_id,role_id) SELECT ?,id FROM authz_roles WHERE scope='ORGANIZATION' AND code=?",
        )
        .bind(membershipId, role),
    ),
    ...scope.locationIds.map((locationId) =>
      db
        .prepare(
          "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
        )
        .bind(membershipId, invitation.organization_id, locationId),
    ),
    db
      .prepare(
        "UPDATE org_invitations SET status='ACCEPTED',accepted_by_person_id=?,accepted_at=? WHERE id=? AND status='PENDING' AND expires_at>?",
      )
      .bind(actor.personId, utcNow(), invitation.id, utcNow()),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.invitation.accepted",
      resourceType: "organization_invitation",
      resourceId: invitation.id,
      organizationId: invitation.organization_id,
      requestId,
    }),
  ];
  try {
    await db.batch(statements);
  } catch {
    throw new Problem(409, "INVITATION_INVALID", "Invitation unavailable");
  }
  return { invitationId: invitation.id, accepted: true };
}
export async function createMembershipRequest(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  roles: string[],
  scope: z.infer<typeof locationScope>,
  message: string | undefined,
  requestId: string,
) {
  const parsedRoles = memberRoles.parse(roles);
  if (parsedRoles.some((role) => role !== "MECHANIC" && role !== "INSPECTOR"))
    throw new Problem(
      403,
      "SELF_REQUEST_ROLE_FORBIDDEN",
      "Requested role unavailable",
    );
  const parsedScope = await validateScope(db, organizationId, scope);
  const org = await db
    .prepare("SELECT status FROM org_organizations WHERE id=?")
    .bind(organizationId)
    .first<{ status: string }>();
  if (org?.status !== "ACTIVE")
    throw new Problem(
      404,
      "ORGANIZATION_NOT_FOUND",
      "Organization unavailable",
    );
  const member = await db
    .prepare(
      "SELECT 1 FROM org_memberships WHERE organization_id=? AND person_id=? AND status='ACTIVE'",
    )
    .bind(organizationId, actor.personId)
    .first();
  if (member)
    throw new Problem(409, "MEMBERSHIP_ALREADY_EXISTS", "Membership exists");
  const requestIdValue = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_membership_requests(id,organization_id,person_id,requested_roles_json,location_scope_type,requested_locations_json,message,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        requestIdValue,
        organizationId,
        actor.personId,
        JSON.stringify(parsedRoles),
        parsedScope.type,
        JSON.stringify(parsedScope.locationIds),
        message?.slice(0, 2000) ?? null,
        new Date(Date.now() + 14 * 86400000).toISOString(),
      ),
    event(
      db,
      organizationId,
      "organization.membership.requested.v1",
      { organizationId, requestId: requestIdValue },
      requestId,
    ),
  ]);
  return requestIdValue;
}
export async function approveMembershipRequest(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  membershipRequestId: string,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.membership_request.review",
  );
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.member.role.manage",
  );
  const row = await db
    .prepare(
      "SELECT * FROM org_membership_requests WHERE id=? AND organization_id=?",
    )
    .bind(membershipRequestId, organizationId)
    .first<{
      id: string;
      person_id: string;
      requested_roles_json: string;
      location_scope_type: "ALL_LOCATIONS" | "SELECTED_LOCATIONS";
      requested_locations_json: string;
      status: string;
      expires_at: string;
    }>();
  if (!row)
    throw new Problem(
      404,
      "MEMBERSHIP_REQUEST_NOT_FOUND",
      "Request unavailable",
    );
  if (row.status === "APPROVED") return;
  if (row.status !== "PENDING" || row.expires_at <= utcNow())
    throw new Problem(
      409,
      "MEMBERSHIP_REQUEST_INVALID_STATE",
      "Request unavailable",
    );
  const roles = memberRoles.parse(JSON.parse(row.requested_roles_json));
  if (roles.includes("OWNER"))
    throw new Problem(403, "FORBIDDEN", "Access denied");
  const scope = await validateScope(db, organizationId, {
    type: row.location_scope_type,
    locationIds: JSON.parse(row.requested_locations_json),
  });
  const membershipId = newId();
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,?)",
        )
        .bind(membershipId, organizationId, row.person_id, scope.type),
      ...roles.map((role) =>
        db
          .prepare(
            "INSERT INTO org_membership_roles(membership_id,role_id) SELECT ?,id FROM authz_roles WHERE scope='ORGANIZATION' AND code=?",
          )
          .bind(membershipId, role),
      ),
      ...scope.locationIds.map((locationId) =>
        db
          .prepare(
            "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
          )
          .bind(membershipId, organizationId, locationId),
      ),
      db
        .prepare(
          "UPDATE org_membership_requests SET status='APPROVED',reviewed_by_person_id=?,reviewed_at=? WHERE id=? AND status='PENDING' AND expires_at>?",
        )
        .bind(actor.personId, utcNow(), row.id, utcNow()),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "organization.membership.request.approved",
        resourceType: "organization_membership_request",
        resourceId: row.id,
        organizationId,
        requestId,
      }),
      event(
        db,
        organizationId,
        "organization.membership.approved.v1",
        { organizationId, requestId: row.id },
        requestId,
      ),
    ]);
  } catch {
    throw new Problem(
      409,
      "MEMBERSHIP_REQUEST_INVALID_STATE",
      "Request unavailable",
    );
  }
}
export async function submitVerification(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.verification.submit",
  );
  const caseId = newId();
  const result = await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE org_organizations SET verification_status='PENDING_VERIFICATION',updated_at=?,version=version+1 WHERE id=? AND verification_status IN ('DRAFT','NEEDS_INFORMATION','REJECTED') AND status='ACTIVE'",
        )
        .bind(utcNow(), organizationId),
      db
        .prepare(
          "INSERT INTO org_verification_cases(id,organization_id,status) VALUES(?,?,CASE WHEN changes()=1 THEN 'PENDING_VERIFICATION' ELSE NULL END)",
        )
        .bind(caseId, organizationId),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "organization.verification.submitted",
        resourceType: "organization",
        resourceId: organizationId,
        organizationId,
        requestId,
      }),
      event(
        db,
        organizationId,
        "organization.verification.submitted.v1",
        { organizationId, caseId },
        requestId,
      ),
    ],
    {
      table: "org_verification_cases",
      column: "status",
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
      message: "Invalid verification transition",
    },
  );
  if ((result[0]?.meta.changes ?? 0) !== 1)
    throw new Problem(
      409,
      "ORGANIZATION_VERIFICATION_INVALID_STATE",
      "Invalid verification transition",
    );
  return caseId;
}
export async function decideVerification(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  caseId: string,
  decision: "VERIFIED" | "REJECTED",
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.organization.verify", {
    mfa: true,
  });
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  const row = await db
    .prepare(
      "SELECT status FROM org_verification_cases WHERE id=? AND organization_id=?",
    )
    .bind(caseId, organizationId)
    .first<{ status: string }>();
  if (row?.status !== "UNDER_REVIEW")
    throw new Problem(
      409,
      "ORGANIZATION_VERIFICATION_INVALID_STATE",
      "Invalid verification transition",
    );
  await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE org_verification_cases SET status=?,reviewed_by_person_id=?,decision_at=?,decision_reason=?,updated_at=? WHERE id=? AND organization_id=? AND status='UNDER_REVIEW'",
        )
        .bind(
          decision,
          actor.personId,
          utcNow(),
          reason,
          utcNow(),
          caseId,
          organizationId,
        ),
      db
        .prepare(
          "UPDATE org_organizations SET verification_status=?,updated_at=?,version=version+1 WHERE id=? AND verification_status='UNDER_REVIEW'",
        )
        .bind(decision, utcNow(), organizationId),
      db
        .prepare(
          "INSERT INTO org_verification_case_events(id,case_id,from_status,to_status,actor_person_id,reason) VALUES(?,?,'UNDER_REVIEW',CASE WHEN changes()=1 AND (SELECT status FROM org_verification_cases WHERE id=?)=? AND (SELECT verification_status FROM org_organizations WHERE id=?)=? THEN ? ELSE NULL END,?,?)",
        )
        .bind(
          newId(),
          caseId,
          caseId,
          decision,
          organizationId,
          decision,
          decision,
          actor.personId,
          reason,
        ),
      auditStatement(db, {
        actorId: actor.accountId,
        action: `organization.verification.${decision.toLowerCase()}`,
        resourceType: "organization",
        resourceId: organizationId,
        organizationId,
        reason,
        requestId,
      }),
      event(
        db,
        organizationId,
        decision === "VERIFIED"
          ? "organization.verification.approved.v1"
          : "organization.verification.rejected.v1",
        { organizationId, caseId },
        requestId,
      ),
    ],
    {
      table: "org_verification_case_events",
      column: "to_status",
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
      message: "Invalid verification transition",
    },
  );
}
export async function startVerificationReview(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  caseId: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.organization.verify");
  const result = await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE org_verification_cases SET status='UNDER_REVIEW',review_started_at=?,updated_at=? WHERE id=? AND organization_id=? AND status='PENDING_VERIFICATION'",
        )
        .bind(utcNow(), utcNow(), caseId, organizationId),
      db
        .prepare(
          "UPDATE org_organizations SET verification_status='UNDER_REVIEW',version=version+1,updated_at=? WHERE id=? AND verification_status='PENDING_VERIFICATION'",
        )
        .bind(utcNow(), organizationId),
      db
        .prepare(
          "INSERT INTO org_verification_case_events(id,case_id,from_status,to_status,actor_person_id) VALUES(?,?,'PENDING_VERIFICATION',CASE WHEN changes()=1 AND (SELECT status FROM org_verification_cases WHERE id=?)='UNDER_REVIEW' AND (SELECT verification_status FROM org_organizations WHERE id=?)='UNDER_REVIEW' THEN 'UNDER_REVIEW' ELSE NULL END,?)",
        )
        .bind(newId(), caseId, caseId, organizationId, actor.personId),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "organization.verification.review.started",
        resourceType: "organization",
        resourceId: organizationId,
        organizationId,
        requestId,
      }),
    ],
    {
      table: "org_verification_case_events",
      column: "to_status",
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
      message: "Invalid verification transition",
    },
  );
  if ((result[0]?.meta.changes ?? 0) !== 1)
    throw new Problem(
      409,
      "ORGANIZATION_VERIFICATION_INVALID_STATE",
      "Invalid verification transition",
    );
}

export async function endMembership(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  membershipId: string,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.member.manage",
  );
  const member = await db
    .prepare(
      "SELECT m.status,EXISTS(SELECT 1 FROM org_membership_roles mr JOIN authz_roles r ON r.id=mr.role_id WHERE mr.membership_id=m.id AND r.code='OWNER') AS owner FROM org_memberships m WHERE m.id=? AND m.organization_id=?",
    )
    .bind(membershipId, organizationId)
    .first<{ status: string; owner: number }>();
  if (!member || member.status !== "ACTIVE")
    throw new Problem(409, "MEMBERSHIP_NOT_ACTIVE", "Membership unavailable");
  if (member.owner)
    await requireOrganizationPermission(
      db,
      actor,
      organizationId,
      "org.owner.manage",
    );
  try {
    await db.batch([
      db
        .prepare(
          "UPDATE org_memberships SET status='ENDED',valid_to=?,updated_at=?,version=version+1 WHERE id=? AND organization_id=? AND status='ACTIVE'",
        )
        .bind(utcNow(), utcNow(), membershipId, organizationId),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "organization.membership.ended",
        resourceType: "organization_membership",
        resourceId: membershipId,
        organizationId,
        requestId,
      }),
      db
        .prepare(
          "INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES(?,'ORGANIZATION_MEMBERSHIP_ENDED',?,?)",
        )
        .bind(newId(), actor.accountId, requestId),
    ]);
  } catch (error) {
    if (String(error).includes("LAST_OWNER_REQUIRED"))
      throw new Problem(409, "LAST_OWNER_REQUIRED", "Last owner required");
    throw error;
  }
}
export async function changeMembershipRoles(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  membershipId: string,
  roles: string[],
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.member.role.manage",
  );
  const parsed = memberRoles.parse(roles);
  const membership = await db
    .prepare(
      "SELECT status FROM org_memberships WHERE id=? AND organization_id=?",
    )
    .bind(membershipId, organizationId)
    .first<{ status: string }>();
  if (membership?.status !== "ACTIVE")
    throw new Problem(409, "MEMBERSHIP_NOT_ACTIVE", "Membership unavailable");
  const owner = await db
    .prepare(
      "SELECT 1 FROM org_membership_roles mr JOIN authz_roles r ON r.id=mr.role_id WHERE mr.membership_id=? AND r.code='OWNER'",
    )
    .bind(membershipId)
    .first();
  if (owner || parsed.includes("OWNER"))
    await requireOrganizationPermission(
      db,
      actor,
      organizationId,
      "org.owner.manage",
    );
  try {
    await db.batch([
      ...parsed.map((role) =>
        db
          .prepare(
            "INSERT INTO org_membership_roles(membership_id,role_id) SELECT ?,id FROM authz_roles WHERE scope='ORGANIZATION' AND code=? ON CONFLICT(membership_id,role_id) DO NOTHING",
          )
          .bind(membershipId, role),
      ),
      db
        .prepare(
          `DELETE FROM org_membership_roles WHERE membership_id=? AND role_id NOT IN (SELECT id FROM authz_roles WHERE scope='ORGANIZATION' AND code IN (${parsed.map(() => "?").join(",")}))`,
        )
        .bind(membershipId, ...parsed),
      db
        .prepare(
          "UPDATE org_memberships SET version=version+1,updated_at=? WHERE id=?",
        )
        .bind(utcNow(), membershipId),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "organization.membership.roles.changed",
        resourceType: "organization_membership",
        resourceId: membershipId,
        organizationId,
        requestId,
      }),
      db
        .prepare(
          "INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES(?,'ORGANIZATION_ROLE_CHANGED',?,?)",
        )
        .bind(newId(), actor.accountId, requestId),
    ]);
  } catch (error) {
    if (String(error).includes("LAST_OWNER_REQUIRED"))
      throw new Problem(409, "LAST_OWNER_REQUIRED", "Last owner required");
    throw error;
  }
}
export async function revokeInvitation(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  invitationId: string,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.member.invite",
  );
  const result = await db.batch([
    db
      .prepare(
        "UPDATE org_invitations SET status='REVOKED',revoked_at=? WHERE id=? AND organization_id=? AND status='PENDING'",
      )
      .bind(utcNow(), invitationId, organizationId),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.invitation.revoked",
      resourceType: "organization_invitation",
      resourceId: invitationId,
      organizationId,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "INVITATION_INVALID", "Invitation unavailable");
}
export async function rejectMembershipRequest(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  membershipRequestId: string,
  reason: string,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.membership_request.review",
  );
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  const result = await db.batch([
    db
      .prepare(
        "UPDATE org_membership_requests SET status='REJECTED',reviewed_by_person_id=?,reviewed_at=?,decision_reason=? WHERE id=? AND organization_id=? AND status='PENDING'",
      )
      .bind(
        actor.personId,
        utcNow(),
        reason,
        membershipRequestId,
        organizationId,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.membership.request.rejected",
      resourceType: "organization_membership_request",
      resourceId: membershipRequestId,
      organizationId,
      reason,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(
      409,
      "MEMBERSHIP_REQUEST_INVALID_STATE",
      "Request unavailable",
    );
}
export async function cancelMembershipRequest(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  membershipRequestId: string,
) {
  const result = await db
    .prepare(
      "UPDATE org_membership_requests SET status='CANCELLED' WHERE id=? AND organization_id=? AND person_id=? AND status='PENDING'",
    )
    .bind(membershipRequestId, organizationId, actor.personId)
    .run();
  if (result.meta.changes !== 1)
    throw new Problem(
      409,
      "MEMBERSHIP_REQUEST_INVALID_STATE",
      "Request unavailable",
    );
}
export async function attachVerificationFile(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  caseId: string,
  fileId: string,
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.verification.submit",
  );
  const row = await db
    .prepare(
      "SELECT c.status,f.status AS file_status FROM org_verification_cases c JOIN storage_files f ON f.id=? AND f.uploaded_by_account_id=? WHERE c.id=? AND c.organization_id=?",
    )
    .bind(fileId, actor.accountId, caseId, organizationId)
    .first<{ status: string; file_status: string }>();
  if (
    !row ||
    row.file_status !== "ACTIVE" ||
    !["PENDING_VERIFICATION", "NEEDS_INFORMATION"].includes(row.status)
  )
    throw new Problem(400, "FILE_NOT_ACTIVE", "Evidence unavailable");
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_verification_files(case_id,file_id,attached_by_person_id) VALUES(?,?,?)",
      )
      .bind(caseId, fileId, actor.personId),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.verification.file.attached",
      resourceType: "organization_verification_case",
      resourceId: caseId,
      organizationId,
      requestId,
    }),
  ]);
}
export async function requestVerificationInformation(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  caseId: string,
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.organization.verify");
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE org_verification_cases SET status='NEEDS_INFORMATION',updated_at=?,decision_reason=? WHERE id=? AND organization_id=? AND status='UNDER_REVIEW'",
        )
        .bind(utcNow(), reason, caseId, organizationId),
      db
        .prepare(
          "UPDATE org_organizations SET verification_status='NEEDS_INFORMATION',version=version+1,updated_at=? WHERE id=? AND verification_status='UNDER_REVIEW'",
        )
        .bind(utcNow(), organizationId),
      db
        .prepare(
          "INSERT INTO org_verification_case_events(id,case_id,from_status,to_status,actor_person_id,reason) VALUES(?,?,'UNDER_REVIEW',CASE WHEN changes()=1 AND (SELECT status FROM org_verification_cases WHERE id=?)='NEEDS_INFORMATION' AND (SELECT verification_status FROM org_organizations WHERE id=?)='NEEDS_INFORMATION' THEN 'NEEDS_INFORMATION' ELSE NULL END,?,?)",
        )
        .bind(newId(), caseId, caseId, organizationId, actor.personId, reason),
      auditStatement(db, {
        actorId: actor.accountId,
        action: "organization.verification.information.requested",
        resourceType: "organization",
        resourceId: organizationId,
        organizationId,
        reason,
        requestId,
      }),
    ],
    {
      table: "org_verification_case_events",
      column: "to_status",
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
      message: "Invalid verification transition",
    },
  );
}
export async function suspendOrganization(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.organization.suspend", {
    mfa: true,
  });
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  const result = await db.batch([
    db
      .prepare(
        "UPDATE org_organizations SET status='SUSPENDED',verification_status='SUSPENDED',updated_at=?,version=version+1 WHERE id=? AND status='ACTIVE'",
      )
      .bind(utcNow(), organizationId),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.suspended",
      requirePreviousChange: true,
      resourceType: "organization",
      resourceId: organizationId,
      organizationId,
      reason,
      requestId,
    }),
    db
      .prepare(
        "INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES(?,'ORGANIZATION_SUSPENDED',?,?)",
      )
      .bind(newId(), actor.accountId, requestId),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(
      409,
      "ORGANIZATION_INVALID_STATE",
      "Organization unavailable",
    );
}

export async function updateOrganization(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  input: { legalName: string; displayName: string; version: number },
  requestId: string,
) {
  await requireOrganizationPermission(db, actor, organizationId, "org.update");
  const c = z
    .object({
      legalName: z.string().trim().min(1).max(240),
      displayName: z.string().trim().min(1).max(240),
      version: z.number().int().positive(),
    })
    .strict()
    .parse(input);
  const result = await db.batch([
    db
      .prepare(
        "UPDATE org_organizations SET legal_name=?,display_name=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='ACTIVE'",
      )
      .bind(c.legalName, c.displayName, utcNow(), organizationId, c.version),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.updated",
      requirePreviousChange: true,
      resourceType: "organization",
      resourceId: organizationId,
      organizationId,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "VERSION_CONFLICT", "Stale organization version");
  return c.version + 1;
}
export async function updateLocation(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  locationId: string,
  input: { name: string; addressLine1: string; city: string; version: number },
  requestId: string,
) {
  await requireOrganizationPermission(
    db,
    actor,
    organizationId,
    "org.location.manage",
    locationId,
  );
  const c = z
    .object({
      name: z.string().trim().min(1).max(160),
      addressLine1: z.string().trim().min(1).max(240),
      city: z.string().trim().min(1).max(160),
      version: z.number().int().positive(),
    })
    .strict()
    .parse(input);
  const result = await db.batch([
    db
      .prepare(
        "UPDATE org_locations SET name=?,address_line_1=?,city=?,version=version+1,updated_at=? WHERE id=? AND organization_id=? AND version=? AND status='ACTIVE'",
      )
      .bind(
        c.name,
        c.addressLine1,
        c.city,
        utcNow(),
        locationId,
        organizationId,
        c.version,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.location.updated",
      requirePreviousChange: true,
      resourceType: "organization_location",
      resourceId: locationId,
      organizationId,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "VERSION_CONFLICT", "Stale location version");
  return c.version + 1;
}
export async function addIdentifier(
  db: D1Database,
  actor: BusinessPrincipal,
  organizationId: string,
  input: { countryCode: string; identifierType: string; value: string },
  requestId: string,
) {
  await requireOrganizationPermission(db, actor, organizationId, "org.update");
  const c = z
    .object({
      countryCode: z.string().regex(/^[A-Z]{2}$/),
      identifierType: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      value: z.string().trim().min(1).max(256),
    })
    .strict()
    .parse(input);
  const normalized = c.value.normalize("NFKC").trim().toUpperCase();
  const id = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_identifiers(id,organization_id,country_code,identifier_type,raw_value,normalized_value) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        id,
        organizationId,
        c.countryCode,
        c.identifierType,
        c.value,
        normalized,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "organization.identifier.added",
      resourceType: "organization_identifier",
      resourceId: id,
      organizationId,
      requestId,
    }),
  ]);
  return id;
}

export async function expireInvitations(
  db: D1Database,
  now = utcNow(),
  limit = 100,
) {
  const result = await db
    .prepare(
      "UPDATE org_invitations SET status='EXPIRED' WHERE id IN (SELECT id FROM org_invitations WHERE status='PENDING' AND expires_at<=? ORDER BY expires_at,id LIMIT ?) AND status='PENDING' AND expires_at<=?",
    )
    .bind(now, Math.min(1000, Math.max(1, limit)), now)
    .run();
  return result.meta.changes ?? 0;
}

export async function expireMembershipRequests(
  db: D1Database,
  now = utcNow(),
  limit = 100,
) {
  const result = await db
    .prepare(
      "UPDATE org_membership_requests SET status='EXPIRED' WHERE id IN (SELECT id FROM org_membership_requests WHERE status='PENDING' AND expires_at<=? ORDER BY expires_at,id LIMIT ?) AND status='PENDING' AND expires_at<=?",
    )
    .bind(now, Math.min(1000, Math.max(1, limit)), now)
    .run();
  return result.meta.changes ?? 0;
}
