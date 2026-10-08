export const openapi = {
  openapi: "3.0.3",
  info: { title: "MotorBaldi Platform Foundation", version: "0.1.0" },
  paths: {
    "/health": {
      get: { responses: { "200": { description: "Worker responding" } } },
    },
    "/health/dependencies": {
      get: {
        responses: {
          "200": { description: "Dependency status" },
          "503": {
            description: "Database unavailable or environment mismatch",
          },
        },
      },
    },
    "/api/v1/principal": {
      get: {
        responses: {
          "200": { description: "Authenticated principal" },
          "401": { description: "Authentication required" },
        },
      },
    },
    "/api/v1/auth/sign-in/email": {
      post: {
        summary: "Sign in with an existing verified email account",
        responses: {
          "200": { description: "Sign-in result" },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/api/v1/auth/get-session": {
      get: { responses: { "200": { description: "Current session or null" } } },
    },
    "/api/v1/auth/sign-out": {
      post: {
        responses: {
          "200": { description: "Session revoked" },
          "401": { description: "Authentication required" },
        },
      },
    },
    "/api/v1/openapi.json": {
      get: { responses: { "200": { description: "OpenAPI document" } } },
    },
  },
};

const id = { type: "string", format: "uuid" };
const problem = {
  description: "Structured problem response",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/Problem" },
    },
  },
};
const key = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 8, maxLength: 128 },
};
const orgId = {
  name: "organizationId",
  in: "path",
  required: true,
  schema: id,
};
const personId = { name: "personId", in: "path", required: true, schema: id };
const leadId = { name: "leadId", in: "path", required: true, schema: id };
const membershipRequestId = {
  name: "membershipRequestId",
  in: "path",
  required: true,
  schema: id,
};
const caseId = { name: "caseId", in: "path", required: true, schema: id };
const credentialId = {
  name: "credentialId",
  in: "path",
  required: true,
  schema: id,
};
const response = (description: string) => ({ description });
const get = (summary: string, parameters: unknown[] = [], secured = true) => ({
  summary,
  parameters,
  ...(secured ? { security: [{ session: [] }] } : {}),
  responses: { "200": response("Success"), "401": problem, "403": problem },
});
const command = (
  summary: string,
  parameters: unknown[] = [],
  secured = true,
) => ({
  summary,
  parameters,
  ...(secured ? { security: [{ session: [] }] } : {}),
  responses: {
    "200": response("Command accepted"),
    "400": problem,
    "401": problem,
    "403": problem,
    "409": problem,
  },
});
const idempotent = (
  summary: string,
  parameters: unknown[] = [],
  secured = true,
) => command(summary, [...parameters, key], secured);
Object.assign(openapi, {
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "motorbaldi.session_token",
      },
    },
    schemas: {
      Problem: {
        type: "object",
        required: ["type", "status", "code", "message", "requestId"],
        properties: {
          type: { type: "string" },
          status: { type: "integer" },
          code: { type: "string" },
          message: { type: "string" },
          requestId: { type: "string" },
        },
      },
      Organization: {
        type: "object",
        required: [
          "id",
          "type",
          "display_name",
          "country_code",
          "status",
          "verification_status",
          "version",
        ],
        properties: {
          id,
          type: {
            type: "string",
            enum: [
              "WORKSHOP",
              "PARTS_SUPPLIER",
              "DEALERSHIP",
              "INSPECTION_CENTER",
              "ROADSIDE_PROVIDER",
              "FLEET",
              "OTHER",
            ],
          },
          display_name: { type: "string" },
          country_code: { type: "string", minLength: 2, maxLength: 2 },
          status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "CLOSED"] },
          verification_status: {
            type: "string",
            enum: [
              "DRAFT",
              "PENDING_VERIFICATION",
              "UNDER_REVIEW",
              "NEEDS_INFORMATION",
              "VERIFIED",
              "REJECTED",
              "SUSPENDED",
              "CLOSED",
            ],
          },
          version: { type: "integer" },
        },
      },
      LeadIntake: {
        type: "object",
        additionalProperties: false,
        properties: {
          givenName: { type: "string", maxLength: 120 },
          familyName: { type: "string", maxLength: 120 },
          email: { type: "string", format: "email" },
          phone: { type: "string", maxLength: 40 },
          organizationName: { type: "string", maxLength: 240 },
          message: { type: "string", maxLength: 2000 },
          countryCode: { type: "string", minLength: 2, maxLength: 2 },
          turnstileToken: { type: "string", maxLength: 2048 },
          utmSource: { type: "string" },
          utmMedium: { type: "string" },
          utmCampaign: { type: "string" },
          utmContent: { type: "string" },
          utmTerm: { type: "string" },
          referrer: { type: "string" },
        },
      },
    },
  },
});
Object.assign(openapi.paths, {
  "/api/v1/public/leads": {
    post: {
      ...idempotent("Receive an anonymous lead", [], false),
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LeadIntake" },
          },
        },
      },
      responses: {
        "202": response("Generic accepted receipt"),
        "400": problem,
        "403": problem,
        "429": problem,
        "503": problem,
      },
    },
  },
  "/api/v1/directory/organizations": {
    get: get("List verified organizations", [], false),
  },
  "/api/v1/auth/sign-up/email": {
    post: command(
      "Create a technical account with explicit terms and privacy acceptance",
      [],
      false,
    ),
  },
  "/api/v1/auth/verify-email": { get: get("Verify email", [], false) },
  "/api/v1/auth/two-factor/enable": { post: command("Begin TOTP enrollment") },
  "/api/v1/auth/two-factor/verify-totp": {
    post: command("Verify TOTP enrollment or sign-in challenge", [], false),
  },
  "/api/v1/auth/two-factor/verify-backup-code": {
    post: command("Verify backup code sign-in challenge", [], false),
  },
  "/api/v1/auth/send-verification-email": {
    post: command("Request verification email", [], false),
  },
  "/api/v1/auth/request-password-reset": {
    post: command(
      "Request password reset where delivery is configured",
      [],
      false,
    ),
  },
  "/api/v1/auth/reset-password": {
    post: command("Reset password using a valid token", [], false),
  },
  "/api/v1/me": { get: get("Current MotorBaldi principal") },
  "/api/v1/me/workspaces": {
    get: get("List current personal and organization contexts"),
  },
  "/api/v1/me/evidence-files": {
    get: get("List own private evidence statuses"),
    post: {
      ...command("Upload private evidence into quarantine"),
      parameters: [
        {
          name: "X-File-Size",
          in: "header",
          required: true,
          schema: { type: "integer", minimum: 1, maximum: 10485760 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "image/png": { schema: { type: "string", format: "binary" } },
          "image/jpeg": { schema: { type: "string", format: "binary" } },
          "application/pdf": { schema: { type: "string", format: "binary" } },
        },
      },
    },
  },
  "/api/v1/me/evidence-files/{fileId}": {
    get: get("Read own private evidence scan status", [
      { name: "fileId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/me/profile": {
    get: get("Current person profile"),
    patch: command("Update current person profile with version"),
  },
  "/api/v1/me/contact-methods": {
    get: get("List personal contact methods"),
    post: command("Add an unverified contact method"),
  },
  "/api/v1/me/consents": {
    get: get("List consent history"),
    post: command("Append a consent decision"),
  },
  "/api/v1/me/mechanic-profile": {
    get: get("Get independent mechanic profile"),
    put: command("Create or update mechanic profile with version"),
  },
  "/api/v1/me/specialties": {
    get: get("List professional specialties"),
    put: command("Replace professional specialties"),
  },
  "/api/v1/me/credentials": {
    get: get("List professional credentials"),
    post: command("Submit professional credential"),
  },
  "/api/v1/me/membership-requests": {
    get: get("List personal membership requests"),
  },
  "/api/v1/invitations/accept": {
    post: idempotent("Accept invitation using verified email"),
  },
  "/api/v1/organizations": {
    post: idempotent("Create organization and owner membership"),
  },
  "/api/v1/organizations/{organizationId}": {
    get: get("Read authorized organization", [orgId]),
    patch: command("Update organization with optimistic version", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/identifiers": {
    get: get("List protected legal identifier metadata", [orgId]),
    post: command("Add country-aware legal identifier", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/permissions": {
    get: get("List effective organization permissions", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/locations": {
    get: get("List authorized locations", [orgId]),
    post: command("Create location", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/locations/{locationId}": {
    patch: command("Update location with optimistic version", [
      orgId,
      { name: "locationId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/organizations/{organizationId}/capabilities": {
    get: get("List organization capabilities", [orgId]),
    put: command("Replace organization capabilities", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/members": {
    get: get("List organization members", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/members/{membershipId}/end": {
    post: command("End membership while preserving last owner", [
      orgId,
      { name: "membershipId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/organizations/{organizationId}/members/{membershipId}/roles": {
    put: command("Replace membership roles while preserving last owner", [
      orgId,
      { name: "membershipId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/organizations/{organizationId}/invitations": {
    get: get("List authorized invitations", [orgId]),
    post: idempotent("Create one-time invitation", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/invitations/{invitationId}/revoke": {
    post: command("Revoke pending invitation", [
      orgId,
      { name: "invitationId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/organizations/{organizationId}/membership-requests": {
    get: get("List authorized membership requests", [orgId]),
    post: idempotent("Request organization membership", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/membership-requests/{membershipRequestId}/approve":
    {
      post: idempotent("Approve same-organization membership request", [
        orgId,
        membershipRequestId,
      ]),
    },
  "/api/v1/organizations/{organizationId}/membership-requests/{membershipRequestId}/reject":
    {
      post: command("Reject same-organization membership request", [
        orgId,
        membershipRequestId,
      ]),
    },
  "/api/v1/organizations/{organizationId}/membership-requests/{membershipRequestId}/cancel":
    {
      post: command("Cancel own membership request", [
        orgId,
        membershipRequestId,
      ]),
    },
  "/api/v1/organizations/{organizationId}/verification/submit": {
    post: idempotent("Submit organization verification case", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/verification/cases": {
    get: get("List current organization verification cases", [orgId]),
  },
  "/api/v1/organizations/{organizationId}/verification/{caseId}/files": {
    post: command("Attach ACTIVE private evidence", [orgId, caseId]),
  },
  "/api/v1/organizations/{organizationId}/verification/{caseId}/files/{fileId}":
    {
      get: get("Read authorized private evidence", [
        orgId,
        caseId,
        { name: "fileId", in: "path", required: true, schema: id },
      ]),
    },
  "/api/v1/admin/organizations/{organizationId}/verification/{caseId}/files/{fileId}":
    {
      get: get("Read staff-authorized private evidence", [
        orgId,
        caseId,
        { name: "fileId", in: "path", required: true, schema: id },
      ]),
    },
  "/api/v1/admin/access": { get: get("List effective platform permissions") },
  "/api/v1/admin/accounts/{accountId}/suspend": {
    post: command("Suspend MotorBaldi account with MFA and reason", [
      { name: "accountId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/people": { get: get("Search people with bounded pagination") },
  "/api/v1/admin/people/{personId}": { get: get("Person 360", [personId]) },
  "/api/v1/admin/people/{personId}/platform-roles": {
    get: get("List explicit platform roles", [personId]),
    put: command("Assign platform roles with MFA and reason", [personId]),
  },
  "/api/v1/admin/people/{personId}/merge": {
    post: idempotent("Merge people with MFA and reason", [personId]),
  },
  "/api/v1/admin/duplicate-candidates/{candidateId}/resolve": {
    post: command("Resolve an open identity duplicate candidate with reason", [
      { name: "candidateId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/duplicate-candidates": {
    get: get("List open identity duplicate candidates"),
  },
  "/api/v1/admin/organizations": {
    get: get("List organizations with bounded pagination"),
  },
  "/api/v1/admin/organizations/{organizationId}": {
    get: get("Organization 360", [orgId]),
  },
  "/api/v1/admin/organizations/{organizationId}/verification/{caseId}/start-review":
    { post: command("Start staff verification review", [orgId, caseId]) },
  "/api/v1/admin/organizations/{organizationId}/verification/{caseId}/approve":
    {
      post: idempotent("Approve organization verification with MFA", [
        orgId,
        caseId,
      ]),
    },
  "/api/v1/admin/organizations/{organizationId}/verification/{caseId}/reject": {
    post: idempotent("Reject organization verification with MFA", [
      orgId,
      caseId,
    ]),
  },
  "/api/v1/admin/organizations/{organizationId}/verification/{caseId}/request-information":
    {
      post: command("Request additional verification evidence", [
        orgId,
        caseId,
      ]),
    },
  "/api/v1/admin/organizations/{organizationId}/suspend": {
    post: command("Suspend organization with MFA and reason", [orgId]),
  },
  "/api/v1/admin/crm/leads": {
    get: get("List lead inbox with bounded pagination"),
  },
  "/api/v1/admin/crm/leads/{leadId}": {
    get: get("Read lead intake", [leadId]),
  },
  "/api/v1/admin/crm/leads/{leadId}/assign": {
    post: command("Assign lead to CRM staff", [leadId]),
  },
  "/api/v1/admin/crm/opportunities": {
    get: get("List opportunities with bounded pagination"),
  },
  "/api/v1/admin/crm/opportunities/{opportunityId}": {
    get: get("Read opportunity", [
      { name: "opportunityId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/crm/opportunities/{opportunityId}/stage": {
    post: command("Move opportunity to configured stage with version", [
      { name: "opportunityId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/crm/opportunities/{opportunityId}/assign": {
    post: command("Assign opportunity to CRM staff", [
      { name: "opportunityId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/crm/activities": {
    get: get("List filtered CRM activities"),
    post: command("Record CRM interaction"),
  },
  "/api/v1/admin/crm/notes": {
    get: get("List filtered internal CRM notes"),
    post: command("Add append-only internal CRM note"),
  },
  "/api/v1/admin/crm/tasks": {
    get: get("List assigned CRM tasks"),
    post: command("Create CRM task"),
  },
  "/api/v1/admin/crm/tasks/{taskId}": {
    patch: command("Change CRM task state with version", [
      { name: "taskId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/crm/tasks/{taskId}/assign": {
    post: command("Assign CRM task to staff", [
      { name: "taskId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/crm/tags": {
    get: get("List CRM tags"),
    post: command("Create controlled CRM tag"),
  },
  "/api/v1/admin/crm/tags/{tagId}/assign": {
    post: command("Tag reviewed CRM entity", [
      { name: "tagId", in: "path", required: true, schema: id },
    ]),
  },
  "/api/v1/admin/crm/leads/{leadId}/triage": {
    post: command("Triage lead", [leadId]),
  },
  "/api/v1/admin/crm/leads/{leadId}/create-person": {
    post: command("Create provisional person after review", [leadId]),
  },
  "/api/v1/admin/crm/leads/{leadId}/link-person": {
    post: command("Link lead to reviewed existing person", [leadId]),
  },
  "/api/v1/admin/crm/leads/{leadId}/convert": {
    post: idempotent("Convert lead to opportunity", [leadId]),
  },
  "/api/v1/admin/crm/pipelines": {
    get: get("List active pipelines and stages"),
  },
  "/api/v1/admin/professionals/{personId}/credentials/{credentialId}/verify": {
    post: command("Verify credential with platform permission and MFA", [
      personId,
      credentialId,
    ]),
  },
  "/api/v1/admin/professionals/credentials": {
    get: get("List pending professional credentials"),
  },
  "/api/v1/admin/professionals/{personId}/credentials/{credentialId}/evidence":
    {
      get: get("Read staff-authorized ACTIVE credential evidence", [
        personId,
        credentialId,
      ]),
    },
  "/api/v1/admin/professionals/{personId}/credentials/{credentialId}/reject": {
    post: command("Reject credential with platform permission and MFA", [
      personId,
      credentialId,
    ]),
  },
});
