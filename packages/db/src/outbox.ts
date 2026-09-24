import { z } from "zod";
import { newId, type Json } from "@motorbaldi/shared";

export interface EventContract {
  aggregateType: string;
  version: number;
  payload: z.ZodObject;
  externalEffect: "IDEMPOTENT" | "RECONCILE";
}

export type EventRegistry = ReadonlyMap<string, EventContract>;

export interface Event {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload_json: string;
  status: "PENDING" | "PROCESSING" | "PROCESSED" | "DEAD";
  attempts: number;
  available_at: string;
  processed_at: string | null;
  last_error_code: string | null;
  request_id: string;
  processing_token: string | null;
  lease_until: string | null;
  last_enqueued_at: string | null;
  external_effect_policy: "IDEMPOTENT" | "RECONCILE";
}

export function validateEvent(
  event: Pick<
    Event,
    | "event_type"
    | "event_version"
    | "aggregate_type"
    | "payload_json"
    | "external_effect_policy"
  >,
  registry: EventRegistry,
) {
  const contract = registry.get(event.event_type + ":" + event.event_version);
  if (
    !contract ||
    contract.version !== event.event_version ||
    contract.aggregateType !== event.aggregate_type ||
    contract.externalEffect !== event.external_effect_policy
  ) {
    throw new Error("UNKNOWN_EVENT_CONTRACT");
  }
  if (
    !contract.payload.strict().safeParse(JSON.parse(event.payload_json)).success
  )
    throw new Error("INVALID_EVENT_PAYLOAD");
}

export function outboxStatement(
  db: D1Database,
  event: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    eventVersion: number;
    payload: Record<string, Json>;
    requestId: string;
    externalEffectPolicy: "IDEMPOTENT" | "RECONCILE";
  },
  registry: EventRegistry,
) {
  const row = {
    id: newId(),
    aggregate_type: event.aggregateType,
    aggregate_id: event.aggregateId,
    event_type: event.eventType,
    event_version: event.eventVersion,
    payload_json: JSON.stringify(event.payload),
    external_effect_policy: event.externalEffectPolicy,
  };
  validateEvent(row, registry);
  return {
    id: row.id,
    statement: db
      .prepare(
        "INSERT INTO integration_outbox_events(id, aggregate_type, aggregate_id, event_type, event_version, payload_json, request_id, external_effect_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.aggregate_type,
        row.aggregate_id,
        row.event_type,
        row.event_version,
        row.payload_json,
        event.requestId,
        row.external_effect_policy,
      ),
  };
}

export async function receiveInbound(
  db: D1Database,
  provider: string,
  eventId: string,
  payload: Json,
  requestId: string,
) {
  const id = newId();
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO integration_inbound_events(id, provider, provider_event_id, payload_json, request_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, provider, eventId, JSON.stringify(payload), requestId)
    .run();
  if ((result.meta.changes ?? 0) === 1)
    return { id, disposition: "inserted" as const };
  const existing = await db
    .prepare(
      "SELECT id FROM integration_inbound_events WHERE provider = ? AND provider_event_id = ?",
    )
    .bind(provider, eventId)
    .first<{ id: string }>();
  if (!existing) throw new Error("Inbound deduplication invariant failed");
  return { id: existing.id, disposition: "duplicate" as const };
}
