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

const registry = new Map();
const handlers = new Map();

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
