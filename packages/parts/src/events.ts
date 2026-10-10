import type { Event } from "@motorbaldi/db";
import { HandlerFailure, type Handler } from "@motorbaldi/messaging/handler";
import { partsCommandEventRegistry } from "./domain.js";

/** Historical persisted references authenticate internal events without reauthorizing a former editor. */
export async function validatePartsEvent(
  db: D1Database,
  event: Event,
): Promise<void> {
  const contract = partsCommandEventRegistry.get(
    `${event.event_type}:${event.event_version}`,
  );
  let body: {
    resourceId: string;
    organizationId: string | null;
    version: number;
  };
  try {
    if (
      !contract ||
      event.aggregate_type !== "parts" ||
      event.external_effect_policy !== "IDEMPOTENT"
    )
      throw new Error();
    body = contract.payload
      .strict()
      .parse(JSON.parse(event.payload_json)) as typeof body;
    if (event.aggregate_id !== body.resourceId) throw new Error();
  } catch {
    throw new HandlerFailure("PERMANENT", "INVALID_PARTS_EVENT");
  }
  const operation = event.event_type.replace(/\.v1$/, "");
  const workshop = operation === "parts.workshop.snapshot.add";
  const evidence = workshop
    ? await db
        .prepare(
          "SELECT 1 FROM parts_workshop_snapshots s JOIN governance_audit_events a ON a.resource_id=s.id AND a.resource_type='parts' AND a.actor_id=s.actor_account_id WHERE s.id=? AND s.organization_id=? AND s.order_version=? AND a.organization_id=s.organization_id AND a.action=? AND a.request_id=?",
        )
        .bind(
          body.resourceId,
          body.organizationId,
          body.version,
          operation,
          event.request_id,
        )
        .first()
    : await db
        .prepare(
          "SELECT 1 FROM parts_change_history h JOIN governance_audit_events a ON a.resource_id=h.resource_id AND a.resource_type='parts' AND a.actor_id=h.actor_account_id AND a.request_id=h.request_id WHERE h.resource_id=? AND h.resource_type=? AND h.version=? AND a.organization_id IS ? AND a.action=? AND h.request_id=? AND (?='canonical' OR json_extract(h.snapshot_json,'$.organizationId') IS ?)",
        )
        .bind(
          body.resourceId,
          operation.startsWith("parts.canonical.") ? "canonical" : "offering",
          body.version,
          body.organizationId,
          operation,
          event.request_id,
          operation.startsWith("parts.canonical.") ? "canonical" : "offering",
          body.organizationId,
        )
        .first();
  if (!evidence) throw new HandlerFailure("PERMANENT", "INVALID_PARTS_EVENT");
}
export function partsEventHandlers(
  db: D1Database,
): ReadonlyMap<string, Handler> {
  return new Map(
    [...partsCommandEventRegistry.keys()].map((key) => [
      key.split(":")[0]!,
      async (event: Event) => validatePartsEvent(db, event),
    ]),
  );
}
