import { z } from "zod";
import type { Event } from "@motorbaldi/db";
import { HandlerFailure, type Handler } from "./handler.js";
import { supportCommandEventRegistry } from "./support.js";

const payload = z.object({ caseId: z.uuid(), accountId: z.uuid() }).strict();
/** Process durable internal state/audit references only. This is never transport delivery. */
export async function validateSupportEvent(
  db: D1Database,
  event: Event,
): Promise<void> {
  const contract = supportCommandEventRegistry.get(
    `${event.event_type}:${event.event_version}`,
  );
  let parsed: ReturnType<typeof payload.safeParse>;
  try {
    parsed = payload.safeParse(JSON.parse(event.payload_json));
  } catch {
    throw new HandlerFailure("PERMANENT", "INVALID_SUPPORT_EVENT");
  }
  if (
    !contract ||
    !parsed.success ||
    event.aggregate_type !== "support" ||
    event.aggregate_id !== parsed.data.caseId ||
    event.external_effect_policy !== "IDEMPOTENT"
  )
    throw new HandlerFailure("PERMANENT", "INVALID_SUPPORT_EVENT");
  const evidence = await db
    .prepare(
      `SELECT 1 FROM support_cases c JOIN governance_audit_events a ON a.resource_id=c.id AND a.resource_type='support' WHERE c.id=? AND c.account_id=? AND a.action=? AND a.request_id=? LIMIT 1`,
    )
    .bind(
      parsed.data.caseId,
      parsed.data.accountId,
      event.event_type.replace(/\.v1$/, ""),
      event.request_id,
    )
    .first();
  if (!evidence) throw new HandlerFailure("PERMANENT", "INVALID_SUPPORT_EVENT");
}
export function supportEventHandlers(
  db: D1Database,
): ReadonlyMap<string, Handler> {
  return new Map(
    [...supportCommandEventRegistry.keys()].map((key) => [
      key.split(":")[0]!,
      async (event: Event) => validateSupportEvent(db, event),
    ]),
  );
}
