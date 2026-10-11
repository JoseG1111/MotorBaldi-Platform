import {
  automationCommitGuard,
  prepareDevelopmentPartsFixture,
} from "./development-automation-command.js";
import {
  automationResourceClaim,
  validateAutomationCommand,
} from "./development-automation-scope.js";
import { assessDevelopmentAutomationCommand } from "@motorbaldi/auth";
import {
  parsePartsCommand,
  authorizePartsCommand,
  preparePartsCommand,
  type PartsOperation,
} from "@motorbaldi/parts";
import {
  parseSupportCommand,
  authorizeSupportCommand,
  prepareSupportCommand,
  type SupportOperation,
} from "@motorbaldi/messaging";
import {
  parseNotificationCommand,
  authorizeNotificationCommand,
  prepareNotificationCommand,
  type NotificationOperation,
} from "@motorbaldi/messaging";
import {
  checkoutInput,
  authorizeCheckout,
  prepareCheckout,
  parseBillingCommand,
  authorizeBillingCommand,
  prepareBillingCommand,
  parseCommissionCommand,
  authorizeCommissionCommand,
  prepareCommissionCommand,
  type BillingOperation,
  type CommissionOperation,
} from "@motorbaldi/payments";
import {
  authorizeInspectionVehicleCommand,
  authorizeInspectionAttachment,
  prepareInspectionAttachment,
  inspectionAttachmentInput,
} from "@motorbaldi/inspections";
import {
  authorizeWorkshopCommand,
  parseWorkshopCommand,
  prepareWorkshopCommand,
  workshopReplayAudit,
  type WorkshopOperation,
} from "@motorbaldi/workshops";
import { DurableObject } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  readReplay,
  prepareReplayStatement,
  type IdempotencyScope,
} from "@motorbaldi/db/idempotency";
import { relayOutbox } from "@motorbaldi/messaging/queue";
import { Problem } from "@motorbaldi/contracts";
import { assertDatabaseEnvironment } from "@motorbaldi/db/environment";
import type { Json } from "@motorbaldi/shared";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  prepareCreateOrganization,
  organizationInput,
  memberRoles,
  prepareCreateInvitation,
  prepareAcceptInvitation,
  prepareCreateMembershipRequest,
  prepareApproveMembershipRequest,
  prepareSubmitVerification,
  prepareDecideVerification,
  type BusinessPrincipal,
} from "@motorbaldi/organizations";
import {
  leadInput,
  prepareLeadReceipt,
  prepareConvertLead,
} from "@motorbaldi/crm";
import { prepareMergePeople } from "@motorbaldi/identity";
import { commitIdempotentCommand, type PreparedCommand } from "@motorbaldi/db";
import { sha256Hex } from "@motorbaldi/shared";
import {
  requireOrganizationPermission,
  requirePlatformPermission,
} from "@motorbaldi/authz";
import {
  authorizeVehicleCommand,
  parseVehicleCommand,
  prepareVehicleCommand,
  vehicleChangeAudit,
  type VehicleOperation,
} from "@motorbaldi/vehicles";
import { assessAuthenticatedSession } from "@motorbaldi/auth";

export class IdempotencyCoordinator extends DurableObject<ApiBindings> {
  private tail: Promise<void> = Promise.resolve();
  private async prepareGeneric(
    operation: string,
    request: Json,
    requestId: string,
    actor: BusinessPrincipal | null,
  ): Promise<PreparedCommand<Json>> {
    const body = request as Record<string, Json>;
    const db = this.env.DB;
    if (operation === "development.fixture.parts.enable")
      return prepareDevelopmentPartsFixture(db, actor!, request, requestId);
    if (operation.startsWith("parts."))
      return preparePartsCommand(
        db,
        actor!,
        operation as PartsOperation,
        parsePartsCommand(operation, request),
        requestId,
      );
    if (operation.startsWith("support."))
      return prepareSupportCommand(
        db,
        actor!,
        operation as SupportOperation,
        parseSupportCommand(operation, request),
        requestId,
      );
    if (operation.startsWith("notification."))
      return prepareNotificationCommand(
        db,
        actor!,
        operation as NotificationOperation,
        parseNotificationCommand(operation, request),
        requestId,
      );
    if (operation === "billing.checkout.create")
      return prepareCheckout(
        db,
        actor!,
        checkoutInput.parse(request),
        requestId,
      );
    if (operation.startsWith("billing."))
      return prepareBillingCommand(
        db,
        actor!,
        operation as BillingOperation,
        parseBillingCommand(operation, request),
        requestId,
      );
    if (operation.startsWith("commission."))
      return prepareCommissionCommand(
        db,
        actor!,
        operation as CommissionOperation,
        parseCommissionCommand(operation, request),
        requestId,
      );

    switch (operation) {
      case "organization.create":
        return prepareCreateOrganization(
          db,
          actor!,
          organizationInput.parse(request),
          requestId,
        );
      case "organization.invitation.create":
        return prepareCreateInvitation(
          db,
          actor!,
          String(body.organizationId),
          String(body.targetEmail),
          body.roles as string[],
          body.scope as never,
          requestId,
        );
      case "organization.invitation.accept":
        return prepareAcceptInvitation(
          db,
          actor!,
          String(body.token),
          requestId,
        );
      case "organization.membership-request.create":
        return prepareCreateMembershipRequest(
          db,
          actor!,
          String(body.organizationId),
          body.roles as string[],
          body.scope as never,
          typeof body.message === "string" ? body.message : undefined,
          requestId,
        );
      case "organization.membership-request.approve":
        return prepareApproveMembershipRequest(
          db,
          actor!,
          String(body.organizationId),
          String(body.membershipRequestId),
          requestId,
        );
      case "organization.verification.submit":
        return prepareSubmitVerification(
          db,
          actor!,
          String(body.organizationId),
          requestId,
        );
      case "organization.verification.approve":
      case "organization.verification.reject":
        return prepareDecideVerification(
          db,
          actor!,
          String(body.organizationId),
          String(body.caseId),
          operation.endsWith("approve") ? "VERIFIED" : "REJECTED",
          String(body.reason),
          requestId,
        );
      case "crm.lead.convert":
        return prepareConvertLead(
          db,
          String(body.leadId),
          actor!,
          String(body.pipelineId),
          String(body.stageId),
          String(body.title),
          requestId,
        );
      case "identity.person.merge":
        return prepareMergePeople(
          db,
          String(body.sourceId),
          String(body.destinationId),
          actor!,
          String(body.reason),
          requestId,
        );
      case "foundation.test": {
        if (typeof body.responseBytes === "number" && body.responseBytes > 8000)
          throw new Problem(
            413,
            "IDEMPOTENCY_RESPONSE_TOO_LARGE",
            "Idempotent response is too large to store",
          );
        // This local fixture models a D1 receipt, not a cross-store business effect.
        return {
          statements: [],
          response: { ok: true, requestId, effectNumber: 1 },
        };
      }
      default:
        throw new Problem(
          400,
          "UNKNOWN_IDEMPOTENCY_OPERATION",
          "Unknown idempotent operation",
        );
    }
  }

  private async authorizeGeneric(
    operation: string,
    actor: BusinessPrincipal,
    request: Json,
  ) {
    const body = request as Record<string, Json>;
    const db = this.env.DB;
    if (operation.startsWith("parts."))
      await authorizePartsCommand(
        db,
        actor,
        operation as PartsOperation,
        parsePartsCommand(operation, request),
      );
    if (operation.startsWith("support."))
      await authorizeSupportCommand(
        db,
        actor,
        operation as SupportOperation,
        parseSupportCommand(operation, request),
      );
    if (operation.startsWith("notification."))
      await authorizeNotificationCommand(
        db,
        actor,
        operation as NotificationOperation,
        parseNotificationCommand(operation, request),
      );
    if (operation === "billing.checkout.create")
      await authorizeCheckout(db, actor, checkoutInput.parse(request));
    else if (operation.startsWith("billing."))
      await authorizeBillingCommand(
        db,
        actor,
        operation as BillingOperation,
        parseBillingCommand(operation, request),
      );
    if (operation.startsWith("commission."))
      await authorizeCommissionCommand(
        db,
        actor,
        operation as CommissionOperation,
        parseCommissionCommand(operation, request),
      );

    if (operation === "crm.lead.convert")
      await requirePlatformPermission(db, actor, "platform.crm.manage");
    if (operation === "identity.person.merge")
      await requirePlatformPermission(db, actor, "platform.people.merge", {
        mfa: true,
      });
    if (
      operation.startsWith("organization.verification.") &&
      operation !== "organization.verification.submit"
    )
      await requirePlatformPermission(
        db,
        actor,
        "platform.organization.verify",
        { mfa: true },
      );
    const permissions: Record<string, string[]> = {
      "organization.invitation.create": [
        "org.member.invite",
        "org.member.role.manage",
        ...(Array.isArray(body.roles) && body.roles.includes("OWNER")
          ? ["org.owner.manage"]
          : []),
      ],
      "organization.membership-request.approve": [
        "org.membership_request.review",
        "org.member.role.manage",
      ],
      "organization.verification.submit": ["org.verification.submit"],
    };
    for (const permission of permissions[operation] ?? [])
      await requireOrganizationPermission(
        db,
        actor,
        String(body.organizationId),
        permission,
      );
    if (operation === "organization.membership-request.create") {
      const roles = memberRoles.parse(body.roles);
      if (roles.some((role) => role !== "MECHANIC" && role !== "INSPECTOR"))
        throw new Problem(
          403,
          "SELF_REQUEST_ROLE_FORBIDDEN",
          "Requested role unavailable",
        );
      const org = await db
        .prepare(
          "SELECT 1 FROM org_organizations WHERE id=? AND status='ACTIVE'",
        )
        .bind(String(body.organizationId))
        .first();
      if (!org)
        throw new Problem(
          404,
          "ORGANIZATION_NOT_FOUND",
          "Organization unavailable",
        );
    }
    if (operation === "organization.invitation.accept") {
      const invitation = await db
        .prepare(
          `SELECT 1 FROM org_invitations i JOIN org_organizations o ON o.id=i.organization_id
        JOIN auth_users u ON u.id=? WHERE i.token_hash=? AND o.status='ACTIVE' AND u.email_verified=1
        AND lower(trim(u.email))=i.target_email AND (i.status='PENDING' OR (i.status='ACCEPTED' AND i.accepted_by_person_id=?))`,
        )
        .bind(
          actor.accountId,
          await sha256Hex(String(body.token)),
          actor.personId,
        )
        .first();
      if (!invitation)
        throw new Problem(403, "INVITATION_INVALID", "Invitation unavailable");
    }
  }

  async fetch(request: Request) {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.run(request);
    } catch (error) {
      if (error instanceof Problem)
        return Response.json(
          { code: error.code, message: error.message },
          { status: error.status },
        );
      throw error;
    } finally {
      release();
    }
  }

  private async run(request: Request) {
    if (new URL(request.url).pathname !== "/run" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const input = (await request.json()) as {
      key: string;
      scope: IdempotencyScope;
      request: Json;
      requestId: string;
      sessionId?: string | null;
      automationAuthorizationId?: string | null;
    };
    await assertDatabaseEnvironment(this.env.DB, this.env.ENVIRONMENT);
    const machine = input.automationAuthorizationId
      ? await assessDevelopmentAutomationCommand(
          this.env,
          input.automationAuthorizationId,
          input.scope.accountId,
          input.scope.operation,
          input.request,
        )
      : null;
    if (machine)
      await validateAutomationCommand(
        this.env.DB,
        machine,
        input.scope.operation,
        input.request,
      );
    let vehicleActor: BusinessPrincipal | null = null;
    let vehicleBody: Record<string, Json> | null = null;
    if (input.scope.operation.startsWith("vehicle.")) {
      const assurance =
        machine ??
        (input.sessionId
          ? await assessAuthenticatedSession(
              this.env.DB,
              input.scope.accountId,
              input.sessionId,
            )
          : null);
      if (!assurance)
        throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
      const account = await ensureMotorBaldiAccount(
        this.env.DB,
        input.scope.accountId,
        input.requestId,
      );
      vehicleActor = {
        accountId: input.scope.accountId,
        personId: account.personId,
        mfaEnabled: assurance.mfaEnabled,
        ...(machine
          ? { automationAuthorizationId: machine.automationAuthorizationId }
          : {}),
      };
      vehicleBody = parseVehicleCommand(input.scope.operation, input.request);
      await authorizeVehicleCommand(
        this.env.DB,
        vehicleActor,
        input.scope.operation as VehicleOperation,
        vehicleBody,
      );
    }
    if (vehicleActor && vehicleBody)
      await authorizeInspectionVehicleCommand(
        this.env.DB,
        vehicleActor,
        input.scope.operation as VehicleOperation,
        vehicleBody,
      );
    let inspectionActor: BusinessPrincipal | null = null;
    let inspectionBody: ReturnType<
      typeof inspectionAttachmentInput.parse
    > | null = null;
    if (input.scope.operation === "inspection.file.attach") {
      const assurance =
        machine ??
        (input.sessionId
          ? await assessAuthenticatedSession(
              this.env.DB,
              input.scope.accountId,
              input.sessionId,
            )
          : null);
      if (!assurance)
        throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
      const account = await ensureMotorBaldiAccount(
        this.env.DB,
        input.scope.accountId,
        input.requestId,
      );
      inspectionActor = {
        accountId: input.scope.accountId,
        personId: account.personId,
        mfaEnabled: assurance.mfaEnabled,
        ...(machine
          ? { automationAuthorizationId: machine.automationAuthorizationId }
          : {}),
      };
      inspectionBody = inspectionAttachmentInput.parse(input.request);
      await authorizeInspectionAttachment(
        this.env.DB,
        inspectionActor,
        inspectionBody,
      );
    }
    let workshopActor: BusinessPrincipal | null = null;
    let workshopBody: Record<string, Json> | null = null;
    if (input.scope.operation.startsWith("workshop.")) {
      const assurance =
        machine ??
        (input.sessionId
          ? await assessAuthenticatedSession(
              this.env.DB,
              input.scope.accountId,
              input.sessionId,
            )
          : null);
      if (!assurance)
        throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
      const account = await ensureMotorBaldiAccount(
        this.env.DB,
        input.scope.accountId,
        input.requestId,
      );
      workshopActor = {
        accountId: input.scope.accountId,
        personId: account.personId,
        mfaEnabled: assurance.mfaEnabled,
        ...(machine
          ? { automationAuthorizationId: machine.automationAuthorizationId }
          : {}),
      };
      workshopBody = parseWorkshopCommand(input.scope.operation, input.request);
      await authorizeWorkshopCommand(
        this.env.DB,
        workshopActor,
        input.scope.operation as WorkshopOperation,
        workshopBody,
      );
    }
    let genericActor: BusinessPrincipal | null = null;
    const generic =
      !vehicleActor &&
      !workshopActor &&
      !inspectionActor &&
      input.scope.operation !== "crm.lead.create";
    if (generic && input.scope.operation !== "foundation.test") {
      const assurance =
        machine ??
        (input.sessionId
          ? await assessAuthenticatedSession(
              this.env.DB,
              input.scope.accountId,
              input.sessionId,
            )
          : null);
      if (!assurance)
        throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
      const account = await ensureMotorBaldiAccount(
        this.env.DB,
        input.scope.accountId,
        input.requestId,
      );
      genericActor = {
        accountId: input.scope.accountId,
        personId: account.personId,
        mfaEnabled: assurance.mfaEnabled,
        ...(machine
          ? { automationAuthorizationId: machine.automationAuthorizationId }
          : {}),
      };
      await this.authorizeGeneric(
        input.scope.operation,
        genericActor,
        input.request,
      );
    }
    const replay = await readReplay<Json>(
      this.env.DB,
      input.scope,
      input.key,
      input.request,
    );
    if (replay)
      return Response.json({
        ...(replay.response as Record<string, Json>),
        replayed: true,
      });
    if (inspectionActor && inspectionBody) {
      const command = await prepareInspectionAttachment(
        this.env.DB,
        inspectionActor,
        inspectionBody,
        input.requestId,
      );
      const replayStatement = await prepareReplayStatement(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        command.response,
      );
      try {
        await this.env.DB.batch([
          replayStatement,
          vehicleChangeAudit(
            this.env.DB,
            inspectionActor,
            "inspection.command.accepted",
            command.vehicleId,
            input.requestId,
          ),
          ...command.statements,
        ]);
      } catch (error) {
        if (
          String(error).includes("constraint failed") ||
          String(error).includes("INSPECTION_")
        )
          throw new Problem(
            409,
            "INSPECTION_COMMAND_CONFLICT",
            "Inspection or file state changed; refresh and retry",
          );
        throw error;
      }
      return Response.json({ ...command.response, replayed: false });
    }
    if (workshopActor && workshopBody) {
      const command = await prepareWorkshopCommand(
        this.env.DB,
        workshopActor,
        input.scope.operation as WorkshopOperation,
        workshopBody,
        input.requestId,
      );
      const replayStatement = await prepareReplayStatement(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        command.response,
      );
      try {
        await this.env.DB.batch([
          ...(machine
            ? [
                automationCommitGuard(
                  this.env.DB,
                  machine,
                  input.scope.operation,
                  input.requestId,
                ),
              ]
            : []),
          replayStatement,
          workshopReplayAudit(
            this.env.DB,
            workshopActor,
            command.orderId,
            input.requestId,
          ),
          ...(machine
            ? automationResourceClaim(
                this.env.DB,
                machine,
                input.scope.operation,
                command.response,
              )
            : []),
          ...command.statements,
        ]);
      } catch (error) {
        if (
          String(error).includes(
            "NOT NULL constraint failed: workshop_order_events.to_status",
          ) ||
          String(error).includes(
            "NOT NULL constraint failed: governance_audit_events.resource_id",
          )
        )
          throw new Problem(
            409,
            "VERSION_CONFLICT",
            "Workshop state changed; refresh and retry",
          );
        if (
          String(error).includes("WORKSHOP_") ||
          String(error).includes("constraint failed")
        )
          throw new Problem(
            409,
            "WORKSHOP_COMMAND_CONFLICT",
            "Workshop command conflicts with current state",
          );
        throw error;
      }
      return Response.json({ ...command.response, replayed: false });
    }
    if (vehicleActor && vehicleBody) {
      const command = await prepareVehicleCommand(
        this.env.DB,
        vehicleActor,
        input.scope.operation as VehicleOperation,
        vehicleBody,
        input.requestId,
      );
      const replayStatement = await prepareReplayStatement(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        command.response,
      );
      try {
        await this.env.DB.batch([
          ...(machine
            ? [
                automationCommitGuard(
                  this.env.DB,
                  machine,
                  input.scope.operation,
                  input.requestId,
                ),
              ]
            : []),
          replayStatement,
          vehicleChangeAudit(
            this.env.DB,
            vehicleActor,
            "vehicle.command.accepted",
            command.vehicleId,
            input.requestId,
          ),
          ...(machine
            ? automationResourceClaim(
                this.env.DB,
                machine,
                input.scope.operation,
                command.response,
              )
            : []),
          ...command.statements,
        ]);
      } catch (error) {
        if (
          String(error).includes(
            "NOT NULL constraint failed: governance_audit_events.resource_id",
          )
        )
          throw new Problem(
            409,
            "VERSION_CONFLICT",
            "Command state changed; refresh and retry",
          );
        if (
          String(error).includes("constraint failed") ||
          String(error).includes("odometer reading")
        )
          throw new Problem(
            409,
            "VEHICLE_COMMAND_CONFLICT",
            "Vehicle command conflicts with current state",
          );
        throw error;
      }
      return Response.json({ ...command.response, replayed: false });
    }
    if (input.scope.operation === "crm.lead.create") {
      const receipt = prepareLeadReceipt(
        this.env.DB,
        leadInput.parse(input.request),
        input.requestId,
      );
      const response = { leadId: receipt.leadId };
      try {
        await commitIdempotentCommand(
          this.env.DB,
          input.scope,
          input.key,
          input.request,
          input.requestId,
          { statements: receipt.statements, response },
        );
      } catch {
        const winner = await readReplay<Json>(
          this.env.DB,
          input.scope,
          input.key,
          input.request,
        );
        if (winner)
          return Response.json({
            ...(winner.response as Record<string, Json>),
            replayed: true,
          });
        return Response.json(
          { code: "INTERNAL_ERROR", message: "Internal server error" },
          { status: 500 },
        );
      }
      return Response.json({ ...response, replayed: false });
    }
    const command = await this.prepareGeneric(
      input.scope.operation,
      input.request,
      input.requestId,
      genericActor,
    );
    if (machine)
      command.statements.unshift(
        automationCommitGuard(
          this.env.DB,
          machine,
          input.scope.operation,
          input.requestId,
        ),
        ...automationResourceClaim(
          this.env.DB,
          machine,
          input.scope.operation,
          command.response,
        ),
      );
    try {
      const response = await commitIdempotentCommand(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        input.requestId,
        command,
      );
      return Response.json({
        ...(response as Record<string, Json>),
        replayed: false,
      });
    } catch (error) {
      const replayAfterRace = await readReplay<Json>(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
      );
      if (replayAfterRace)
        return Response.json({
          ...(replayAfterRace.response as Record<string, Json>),
          replayed: true,
        });
      throw error;
    }
  }
}

export class OutboxCoordinator extends DurableObject<ApiBindings> {
  async relay() {
    await assertDatabaseEnvironment(this.env.DB, this.env.ENVIRONMENT);
    if (!this.env.EVENTS_QUEUE)
      throw new Problem(503, "QUEUE_UNAVAILABLE", "Events queue unavailable");
    return relayOutbox(this.env.DB, this.env.EVENTS_QUEUE);
  }

  async fetch() {
    try {
      return Response.json({ relayed: await this.relay() });
    } catch (error) {
      if (error instanceof Problem)
        return Response.json(
          { code: error.code, message: error.message },
          { status: error.status },
        );
      throw error;
    }
  }
}
