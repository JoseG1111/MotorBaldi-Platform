import { DurableObject } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  readReplay,
  storeReplay,
  type IdempotencyScope,
} from "@motorbaldi/db/idempotency";
import { relayOutbox } from "@motorbaldi/messaging/queue";
import { Problem } from "@motorbaldi/contracts";
import { assertDatabaseEnvironment } from "@motorbaldi/db/environment";
import type { Json } from "@motorbaldi/shared";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  createOrganization,
  organizationInput,
  createInvitation,
  acceptInvitation,
  createMembershipRequest,
  approveMembershipRequest,
  submitVerification,
  decideVerification,
  type BusinessPrincipal,
} from "@motorbaldi/organizations";
import { leadInput, receiveLead, convertLead } from "@motorbaldi/crm";
import { mergePeople } from "@motorbaldi/identity";
import { requirePlatformPermission } from "@motorbaldi/authz";
import { assessAuthenticatedSession } from "@motorbaldi/auth";

export class IdempotencyCoordinator extends DurableObject<ApiBindings> {
  private tail: Promise<void> = Promise.resolve();
  private async execute(
    operation: string,
    request: Json,
    requestId: string,
    accountId: string,
    sessionId: string | null,
  ): Promise<{ response: Json; storedResponse?: Json }> {
    if (operation === "crm.lead.create") {
      const body = leadInput.parse(request);
      return {
        response: { leadId: await receiveLead(this.env.DB, body, requestId) },
      };
    }
    const requiresAccount = operation !== "foundation.test";
    const assurance =
      requiresAccount && sessionId
        ? await assessAuthenticatedSession(this.env.DB, accountId, sessionId)
        : null;
    if (requiresAccount && !assurance)
      throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
    const account = requiresAccount
      ? await ensureMotorBaldiAccount(this.env.DB, accountId, requestId)
      : null;
    const actor = account
      ? ({
          accountId,
          personId: account.personId,
          mfaEnabled: assurance!.mfaEnabled,
        } as BusinessPrincipal)
      : null;
    const body = request as Record<string, Json>;
    if (operation === "organization.create") {
      return {
        response: await createOrganization(
          this.env.DB,
          actor!,
          organizationInput.parse(request),
          requestId,
        ),
      };
    }
    if (operation === "organization.invitation.create") {
      const invitation = await createInvitation(
        this.env.DB,
        actor!,
        String(body.organizationId),
        String(body.targetEmail),
        body.roles as string[],
        body.scope as never,
        requestId,
      );
      return {
        response: invitation,
        storedResponse: {
          invitationId: invitation.invitationId,
          expiresAt: invitation.expiresAt,
        },
      };
    }
    if (operation === "organization.invitation.accept")
      return {
        response: await acceptInvitation(
          this.env.DB,
          actor!,
          String(body.token),
          requestId,
        ),
      };
    if (operation === "organization.membership-request.create")
      return {
        response: {
          membershipRequestId: await createMembershipRequest(
            this.env.DB,
            actor!,
            String(body.organizationId),
            body.roles as string[],
            body.scope as never,
            typeof body.message === "string" ? body.message : undefined,
            requestId,
          ),
        },
      };
    if (operation === "organization.membership-request.approve") {
      await approveMembershipRequest(
        this.env.DB,
        actor!,
        String(body.organizationId),
        String(body.membershipRequestId),
        requestId,
      );
      return { response: { approved: true } };
    }
    if (operation === "organization.verification.submit")
      return {
        response: {
          caseId: await submitVerification(
            this.env.DB,
            actor!,
            String(body.organizationId),
            requestId,
          ),
        },
      };
    if (
      operation === "organization.verification.approve" ||
      operation === "organization.verification.reject"
    ) {
      await decideVerification(
        this.env.DB,
        actor!,
        String(body.organizationId),
        String(body.caseId),
        operation.endsWith("approve") ? "VERIFIED" : "REJECTED",
        String(body.reason),
        requestId,
      );
      return { response: { reviewed: true } };
    }
    if (operation === "crm.lead.convert") {
      await requirePlatformPermission(
        this.env.DB,
        actor!,
        "platform.crm.manage",
      );
      return {
        response: {
          opportunityId: await convertLead(
            this.env.DB,
            String(body.leadId),
            actor!,
            String(body.pipelineId),
            String(body.stageId),
            String(body.title),
            requestId,
          ),
        },
      };
    }
    if (operation === "identity.person.merge") {
      await requirePlatformPermission(
        this.env.DB,
        actor!,
        "platform.people.merge",
        { mfa: true },
      );
      await mergePeople(
        this.env.DB,
        String(body.sourceId),
        String(body.destinationId),
        actor!,
        String(body.reason),
        requestId,
      );
      return { response: { merged: true } };
    }
    if (operation !== "foundation.test")
      throw new Problem(
        400,
        "UNKNOWN_IDEMPOTENCY_OPERATION",
        "Unknown idempotent operation",
      );
    const input = request as Record<string, Json>;
    if (typeof input.responseBytes === "number" && input.responseBytes > 8000)
      throw new Problem(
        413,
        "IDEMPOTENCY_RESPONSE_TOO_LARGE",
        "Idempotent response is too large to store",
      );
    const effects =
      ((await this.ctx.storage.get<number>("foundation-effects")) ?? 0) + 1;
    await this.ctx.storage.put("foundation-effects", effects);
    return { response: { ok: true, requestId, effectNumber: effects } };
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
    };
    await assertDatabaseEnvironment(this.env.DB, this.env.ENVIRONMENT);
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
    const result = await this.execute(
      input.scope.operation,
      input.request,
      input.requestId,
      input.scope.accountId,
      input.sessionId ?? null,
    );
    try {
      await storeReplay(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        result.storedResponse ?? result.response,
      );
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
    return Response.json({
      ...(result.response as Record<string, Json>),
      replayed: false,
    });
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
