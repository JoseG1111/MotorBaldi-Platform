import { newId } from "@motorbaldi/shared";
import {
  type Event,
  type EventRegistry,
  validateEvent,
} from "@motorbaldi/db/outbox";
import { HandlerFailure, boundedHandler, type Handler } from "./handler.js";

export interface ProcessingOptions {
  timeoutMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
}

const safeCode = (value: string) =>
  /^[A-Z_]{1,64}$/.test(value) ? value : "HANDLER_FAILED";

export async function claimEvent(db: D1Database, id: string, leaseMs = 30000) {
  const token = newId();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  return db
    .prepare(
      "UPDATE integration_outbox_events SET status = 'PROCESSING', processing_token = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ? AND status = 'PENDING' AND available_at <= ? RETURNING *",
    )
    .bind(token, leaseUntil, id, new Date().toISOString())
    .first<Event>();
}

export async function acknowledgeEvent(db: D1Database, event: Event) {
  const result = await db
    .prepare(
      "UPDATE integration_outbox_events SET status = 'PROCESSED', processed_at = ?, processing_token = NULL, lease_until = NULL, last_error_code = NULL WHERE id = ? AND status = 'PROCESSING' AND processing_token = ? AND lease_until > ?",
    )
    .bind(
      new Date().toISOString(),
      event.id,
      event.processing_token,
      new Date().toISOString(),
    )
    .run();
  return result.meta.changes === 1;
}

export async function recoverExpiredLeases(db: D1Database, maxAttempts = 5) {
  const rows =
    (
      await db
        .prepare(
          "SELECT * FROM integration_outbox_events WHERE status = 'PROCESSING' AND lease_until <= ? ORDER BY lease_until LIMIT 100",
        )
        .bind(new Date().toISOString())
        .all<Event>()
    ).results ?? [];
  for (const event of rows) {
    const unknown = event.external_effect_policy === "RECONCILE";
    const dead = unknown || event.attempts >= maxAttempts;
    const code = unknown ? "UNKNOWN_EXTERNAL_OUTCOME" : "LEASE_EXPIRED";
    const now = new Date().toISOString();
    if (dead) {
      await db.batch([
        db
          .prepare(
            "INSERT INTO integration_dead_letters(id, outbox_id, error_code, attempts, request_id) SELECT ?, id, ?, attempts, request_id FROM integration_outbox_events WHERE id = ? AND status = 'PROCESSING' AND processing_token = ? AND lease_until <= ? ON CONFLICT(outbox_id) DO UPDATE SET attempts = excluded.attempts, error_code = excluded.error_code, resolved_at = NULL, resolution = NULL",
          )
          .bind(newId(), code, event.id, event.processing_token, now),
        db
          .prepare(
            "UPDATE integration_outbox_events SET status = 'DEAD', processing_token = NULL, lease_until = NULL, available_at = ?, last_enqueued_at = NULL, last_error_code = ? WHERE id = ? AND status = 'PROCESSING' AND processing_token = ? AND lease_until <= ?",
          )
          .bind(now, code, event.id, event.processing_token, now),
      ]);
    } else {
      await db
        .prepare(
          "UPDATE integration_outbox_events SET status = 'PENDING', processing_token = NULL, lease_until = NULL, available_at = ?, last_enqueued_at = NULL, last_error_code = ? WHERE id = ? AND status = 'PROCESSING' AND processing_token = ? AND lease_until <= ?",
        )
        .bind(now, code, event.id, event.processing_token, now)
        .run();
    }
  }
  return rows.length;
}

export async function processEvent(
  db: D1Database,
  id: string,
  handlers: ReadonlyMap<string, Handler>,
  registry: EventRegistry,
  options: ProcessingOptions = {},
) {
  const timeout = options.timeoutMs ?? 10000;
  const lease = options.leaseMs ?? 30000;
  const event = await claimEvent(db, id, lease);
  if (!event) return "ignored";
  try {
    try {
      validateEvent(event, registry);
    } catch {
      throw new HandlerFailure("PERMANENT", "INVALID_EVENT_CONTRACT");
    }
    const handler = handlers.get(event.event_type);
    if (!handler) throw new HandlerFailure("PERMANENT", "UNKNOWN_EVENT_TYPE");
    await boundedHandler(handler, event, timeout);
    return (await acknowledgeEvent(db, event)) ? "processed" : "lease_lost";
  } catch (error) {
    const failure =
      error instanceof HandlerFailure
        ? error
        : new HandlerFailure("UNKNOWN_EXTERNAL_OUTCOME");
    const uncertain = failure.kind === "UNKNOWN_EXTERNAL_OUTCOME";
    const maxAttempts = options.maxAttempts ?? 5;
    const dead =
      failure.kind === "PERMANENT" ||
      (uncertain && event.external_effect_policy !== "IDEMPOTENT") ||
      event.attempts >= maxAttempts;
    const code =
      uncertain && event.external_effect_policy !== "IDEMPOTENT"
        ? "UNKNOWN_EXTERNAL_OUTCOME"
        : safeCode(failure.code);
    const delay = Math.min(
      3600000,
      (options.backoffMs ?? 1000) * 2 ** Math.min(event.attempts - 1, 12),
    );
    const availableAt = new Date(Date.now() + delay).toISOString();
    if (dead) {
      await db.batch([
        db
          .prepare(
            "INSERT INTO integration_dead_letters(id, outbox_id, error_code, attempts, request_id) SELECT ?, id, ?, attempts, request_id FROM integration_outbox_events WHERE id = ? AND status = 'PROCESSING' AND processing_token = ? ON CONFLICT(outbox_id) DO UPDATE SET attempts = excluded.attempts, error_code = excluded.error_code, resolved_at = NULL, resolution = NULL",
          )
          .bind(newId(), code, id, event.processing_token),
        db
          .prepare(
            "UPDATE integration_outbox_events SET status = 'DEAD', processing_token = NULL, lease_until = NULL, last_enqueued_at = NULL, last_error_code = ?, available_at = ? WHERE id = ? AND status = 'PROCESSING' AND processing_token = ?",
          )
          .bind(code, availableAt, id, event.processing_token),
      ]);
    } else {
      await db
        .prepare(
          "UPDATE integration_outbox_events SET status = 'PENDING', processing_token = NULL, lease_until = NULL, last_enqueued_at = NULL, last_error_code = ?, available_at = ? WHERE id = ? AND status = 'PROCESSING' AND processing_token = ?",
        )
        .bind(code, availableAt, id, event.processing_token)
        .run();
    }
    return dead ? "dead" : "retry";
  }
}

export async function relayOutbox(
  db: D1Database,
  queue: Queue<{ eventId: string; requestId: string }>,
  resendMs = 30000,
) {
  await recoverExpiredLeases(db);
  const cutoff = new Date(Date.now() - resendMs).toISOString();
  const rows =
    (
      await db
        .prepare(
          "SELECT * FROM integration_outbox_events WHERE status = 'PENDING' AND available_at <= ? AND (last_enqueued_at IS NULL OR last_enqueued_at <= ?) ORDER BY created_at LIMIT 20",
        )
        .bind(new Date().toISOString(), cutoff)
        .all<Event>()
    ).results ?? [];
  for (const event of rows) {
    await db
      .prepare(
        "UPDATE integration_outbox_events SET last_enqueued_at = ? WHERE id = ? AND status = 'PENDING'",
      )
      .bind(new Date().toISOString(), event.id)
      .run();
    try {
      await queue.send(
        { eventId: event.id, requestId: event.request_id },
        { contentType: "json" },
      );
    } catch {
      await db
        .prepare(
          "UPDATE integration_outbox_events SET last_enqueued_at = NULL WHERE id = ? AND status = 'PENDING'",
        )
        .bind(event.id)
        .run();
    }
  }
  return rows.length;
}
