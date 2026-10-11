import type { Event } from "@motorbaldi/db";
import { HandlerFailure, type Handler } from "@motorbaldi/messaging/handler";
import { marketplaceCommandEventRegistry } from "./marketplace.js";
/** Validate persisted historical effects; later withdrawal never invalidates earlier evidence. */
export async function validateMarketplaceEvent(
  db: D1Database,
  event: Event,
): Promise<void> {
  const contract = marketplaceCommandEventRegistry.get(
    `${event.event_type}:${event.event_version}`,
  );
  let body: { resourceId: string; organizationId: string; version: number };
  try {
    if (
      !contract ||
      event.aggregate_type !== "marketplace" ||
      event.external_effect_policy !== "IDEMPOTENT"
    )
      throw new Error();
    body = contract.payload
      .strict()
      .parse(JSON.parse(event.payload_json)) as typeof body;
    if (event.aggregate_id !== body.resourceId) throw new Error();
  } catch {
    throw new HandlerFailure("PERMANENT", "INVALID_MARKETPLACE_EVENT");
  }
  const operation = event.event_type.replace(/\.v1$/, "");
  const evidence = await db
    .prepare(
      "SELECT 1 FROM marketplace_listing_history h JOIN governance_audit_events a ON a.resource_id=h.listing_id AND a.actor_id=h.actor_account_id AND a.request_id=h.request_id AND a.action=h.operation AND a.organization_id=h.organization_id JOIN marketplace_listings l ON l.id=h.listing_id AND l.organization_id=h.organization_id WHERE h.listing_id=? AND h.organization_id=? AND h.version=? AND h.operation=? AND h.request_id=? AND a.resource_type='marketplace'",
    )
    .bind(
      body.resourceId,
      body.organizationId,
      body.version,
      operation,
      event.request_id,
    )
    .first();
  if (!evidence)
    throw new HandlerFailure("PERMANENT", "INVALID_MARKETPLACE_EVENT");
}
export function marketplaceEventHandlers(
  db: D1Database,
): ReadonlyMap<string, Handler> {
  return new Map(
    [...marketplaceCommandEventRegistry.keys()].map((key) => [
      key.split(":")[0]!,
      async (event: Event) => validateMarketplaceEvent(db, event),
    ]),
  );
}
