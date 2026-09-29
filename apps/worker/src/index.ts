import {
  backgroundWorkerConfig,
  type BackgroundWorkerBindings,
  type QueueMessage,
} from "@motorbaldi/config";
import { assertDatabaseEnvironment } from "@motorbaldi/db/environment";
import {
  processEvent,
  recoverExpiredLeases,
} from "@motorbaldi/messaging/queue";
import { cleanupExpiredIdempotencyRecords } from "@motorbaldi/db/idempotency";
import {
  queryOperationalMetrics,
  recordOperationalMetrics,
} from "@motorbaldi/observability/metrics";
import { logger } from "@motorbaldi/observability";
import {
  deterministicTestScanner,
  files,
  unavailableScanner,
} from "@motorbaldi/storage";
import { reconcileVerifiedAccounts } from "@motorbaldi/identity";
import {
  expireInvitations,
  expireMembershipRequests,
} from "@motorbaldi/organizations";
import { expireCredentials } from "@motorbaldi/professional";
import { newId } from "@motorbaldi/shared";
import { z } from "zod";

const uuid = z.string().uuid();
const eventContracts = [
  [
    "identity.account.created.v1",
    "identity",
    z.object({ accountId: uuid, personId: uuid }).strict(),
  ],
  [
    "identity.person.merged.v1",
    "identity",
    z.object({ sourceId: uuid, destinationId: uuid }).strict(),
  ],
  [
    "organization.created.v1",
    "organization",
    z.object({ organizationId: uuid }).strict(),
  ],
  [
    "organization.invitation.created.v1",
    "organization",
    z.object({ organizationId: uuid, invitationId: uuid }).strict(),
  ],
  [
    "organization.membership.requested.v1",
    "organization",
    z.object({ organizationId: uuid, requestId: uuid }).strict(),
  ],
  [
    "organization.membership.approved.v1",
    "organization",
    z.object({ organizationId: uuid, requestId: uuid }).strict(),
  ],
  [
    "organization.verification.submitted.v1",
    "organization",
    z.object({ organizationId: uuid, caseId: uuid }).strict(),
  ],
  [
    "organization.verification.approved.v1",
    "organization",
    z.object({ organizationId: uuid, caseId: uuid }).strict(),
  ],
  [
    "organization.verification.rejected.v1",
    "organization",
    z.object({ organizationId: uuid, caseId: uuid }).strict(),
  ],
  ["crm.lead.received.v1", "crm_lead", z.object({ leadId: uuid }).strict()],
  [
    "crm.lead.converted.v1",
    "crm_lead",
    z.object({ leadId: uuid, opportunityId: uuid }).strict(),
  ],
] as const;
const registry = new Map(
  eventContracts.map(([name, aggregateType, payload]) => [
    `${name}:1`,
    {
      aggregateType,
      version: 1,
      payload,
      externalEffect: "IDEMPOTENT" as const,
    },
  ]),
);
const handlers = new Map(
  eventContracts.map(([name]) => [name, async () => {}]),
);

export default {
  async fetch() {
    return new Response(null, { status: 404 });
  },

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: BackgroundWorkerBindings,
  ) {
    const c = backgroundWorkerConfig(env);
    await assertDatabaseEnvironment(env.DB, c.environment);
    for (const message of batch.messages) {
      const result = await processEvent(
        env.DB,
        message.body.eventId,
        handlers,
        registry,
      );
      if (result === "retry") message.retry();
      else message.ack();
      logger.info({
        event: "queue_message",
        service: "motorbaldi-worker",
        operation: "outbox.consume",
        status: result === "processed" ? 200 : 202,
        requestId: message.body.requestId,
      });
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: BackgroundWorkerBindings,
    ctx: ExecutionContext,
  ) {
    const c = backgroundWorkerConfig(env);
    await assertDatabaseEnvironment(env.DB, c.environment);
    const storage = files(env.DB, env.PRIVATE_BUCKET, {
      scanner:
        c.malwareScannerProvider === "DETERMINISTIC_TEST"
          ? deterministicTestScanner
          : unavailableScanner,
    });
    ctx.waitUntil(storage.recoverExpiredFileScans());
    ctx.waitUntil(storage.cleanupStaleUploads());
    ctx.waitUntil(storage.cleanupOrphanPromotions());
    ctx.waitUntil(recoverExpiredLeases(env.DB));
    ctx.waitUntil(cleanupExpiredIdempotencyRecords(env.DB));
    ctx.waitUntil(reconcileVerifiedAccounts(env.DB, newId()));
    ctx.waitUntil(expireInvitations(env.DB));
    ctx.waitUntil(expireMembershipRequests(env.DB));
    ctx.waitUntil(expireCredentials(env.DB));
    if (env.OUTBOX_COORDINATOR) {
      ctx.waitUntil(
        env.OUTBOX_COORDINATOR.getByName(c.environment).fetch(
          "https://outbox/relay",
        ),
      );
    } else if (env.EVENTS_QUEUE) {
      const { relayOutbox } = await import("@motorbaldi/messaging/queue");
      ctx.waitUntil(relayOutbox(env.DB, env.EVENTS_QUEUE));
    }
    ctx.waitUntil(
      queryOperationalMetrics(env.DB).then((values) =>
        recordOperationalMetrics(values, "worker"),
      ),
    );
  },
};
