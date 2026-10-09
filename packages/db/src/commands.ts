import type { Json } from "@motorbaldi/shared";
import { newId } from "@motorbaldi/shared";
import { Problem } from "@motorbaldi/contracts";
import {
  prepareReplayStatement,
  type IdempotencyScope,
} from "./idempotency.js";
import { guardedBatch } from "./guarded-batch.js";

/** Domain builders return statements without committing effects; the coordinator adds replay atomically. */
export type PreparedCommand<T extends Json> = {
  statements: D1PreparedStatement[];
  response: T;
  storedResponse?: Json;
  recover?: (error: unknown) => Promise<PreparedCommand<T> | null>;
  guard?: { table: string; column: string; code: string; message: string };
};
/** Compatibility wrappers outside idempotent coordination retain the domain's guarded batch behavior. */
export async function commitPreparedCommand<T extends Json>(
  db: D1Database,
  command: PreparedCommand<T>,
): Promise<T> {
  try {
    if (command.statements.length) {
      if (command.guard)
        await guardedBatch(db, command.statements, command.guard);
      else await db.batch(command.statements);
    }
    return command.response;
  } catch (error) {
    const recovered = await command.recover?.(error);
    if (recovered) return commitPreparedCommand(db, recovered);
    throw error;
  }
}

/** The replay claim and receipt guard precede all business effects in one D1 transaction. */
export async function commitIdempotentCommand<T extends Json>(
  db: D1Database,
  scope: IdempotencyScope,
  key: string,
  request: Json,
  requestId: string,
  command: PreparedCommand<T>,
): Promise<T> {
  const replay = await prepareReplayStatement(
    db,
    scope,
    key,
    request,
    command.storedResponse ?? command.response,
  );
  const receipt = db
    .prepare(
      `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,organization_id)
    SELECT ?, ?, 'command.accepted', 'idempotent_command', CASE WHEN changes()=1 THEN ? ELSE NULL END, ?, ?`,
    )
    .bind(
      newId(),
      scope.accountId,
      requestId,
      requestId,
      scope.organizationId ?? null,
    );
  try {
    await commitPreparedCommand(db, {
      statements: [replay, receipt, ...command.statements],
      response: command.response,
      ...(command.guard ? { guard: command.guard } : {}),
    });
    return command.response;
  } catch (error) {
    const recovered = await command.recover?.(error);
    if (recovered)
      return commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        requestId,
        recovered,
      );
    if (
      String(error).includes(
        "NOT NULL constraint failed: governance_audit_events.resource_id",
      )
    )
      throw new Problem(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Command claim or state changed; retry safely",
      );
    throw error;
  }
}
