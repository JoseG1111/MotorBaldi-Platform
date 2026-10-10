import {
  partsCommandEventRegistry,
  partsEventHandlers,
} from "@motorbaldi/parts";
import {
  supportCommandEventRegistry,
  supportEventHandlers,
  createMembershipNotification,
  membershipNotificationEventRegistry,
  notificationCommandEventRegistry,
  type Handler,
} from "@motorbaldi/messaging";
import type { EventContract } from "@motorbaldi/db";
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
import { expireMemberships } from "@motorbaldi/payments";

const uuid = z.string().uuid();
const eventContracts = [
  [
    "billing.checkout.created.v1",
    "billing",
    z
      .object({ subscriptionId: uuid, paymentId: uuid, periodId: uuid })
      .strict(),
  ],
  [
    "billing.payment.changed.v1",
    "billing",
    z.object({ paymentId: uuid, subscriptionId: uuid }).strict(),
  ],
  [
    "billing.subscription.expired.v1",
    "billing",
    z.object({ subscriptionId: uuid }).strict(),
  ],
  [
    "billing.subscription.changed.v1",
    "billing",
    z.object({ subscriptionId: uuid }).strict(),
  ],
  [
    "commission.changed.v1",
    "commission",
    z
      .object({
        id: uuid,
        operation: z.string().regex(/^commission\.[a-z.]+$/),
      })
      .strict(),
  ],
  [
    "inspection.report.changed.v1",
    "inspection_report",
    z
      .object({
        recordId: uuid,
        vehicleId: uuid,
        organizationId: uuid,
        locationId: uuid,
        operation: z.literal("inspection.file.attach"),
      })
      .strict(),
  ],
  [
    "workshop.order.changed.v1",
    "workshop_order",
    z
      .object({
        orderId: uuid,
        vehicleId: uuid,
        organizationId: uuid,
        locationId: uuid,
        operation: z.enum([
          "workshop.order.create",
          "workshop.order.update",
          "workshop.order.transition",
          "workshop.order.file.attach",
        ]),
      })
      .strict(),
  ],
  [
    "vehicle.changed.v1",
    "vehicle",
    z
      .object({
        vehicleId: uuid,
        operation: z.string().regex(/^vehicle\.[a-z.]+$/),
      })
      .strict(),
  ],
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
const registry = new Map<string, EventContract>(
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
for (const [key, contract] of [
  ...partsCommandEventRegistry,
  ...supportCommandEventRegistry,
  ...membershipNotificationEventRegistry,
  ...notificationCommandEventRegistry,
])
  registry.set(key, contract);
const handlers = new Map<string, Handler>(
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
    const scopedHandlers = new Map(handlers);
    for (const [key, handler] of partsEventHandlers(env.DB))
      scopedHandlers.set(key, handler);
    for (const [key, handler] of supportEventHandlers(env.DB))
      scopedHandlers.set(key, handler);
    for (const key of [
      ...membershipNotificationEventRegistry.keys(),
      ...notificationCommandEventRegistry.keys(),
    ])
      scopedHandlers.set(key.split(":")[0]!, async () => {});
    scopedHandlers.set("billing.subscription.changed.v1", async (event) => {
      await createMembershipNotification(env.DB, event);
    });
    for (const message of batch.messages) {
      const result = await processEvent(
        env.DB,
        message.body.eventId,
        scopedHandlers,
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
    if (c.malwareScannerProvider !== "UNCONFIGURED")
      ctx.waitUntil(storage.scanQuarantinedUploads());
    ctx.waitUntil(storage.cleanupStaleUploads());
    ctx.waitUntil(storage.cleanupOrphanPromotions());
    ctx.waitUntil(recoverExpiredLeases(env.DB));
    ctx.waitUntil(cleanupExpiredIdempotencyRecords(env.DB));
    ctx.waitUntil(reconcileVerifiedAccounts(env.DB, newId()));
    ctx.waitUntil(expireInvitations(env.DB));
    ctx.waitUntil(expireMembershipRequests(env.DB));
    ctx.waitUntil(expireCredentials(env.DB));
    ctx.waitUntil(expireMemberships(env.DB, newId()));
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
