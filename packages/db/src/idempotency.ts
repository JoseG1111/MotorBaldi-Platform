import { canonical, sha256Hex, type Json } from "@motorbaldi/shared";
import { Problem } from "@motorbaldi/contracts";

export const maxIdempotencyResponseBytes = 8192;

const ttlByOperation: Readonly<Record<string, number>> = {
  "foundation.test": 3600,
  "auth.session": 900,
  "file.upload": 86400,
};

export interface IdempotencyScopeInput {
  accountId: string;
  operation: string;
  organizationId?: string;
}

export interface IdempotencyScope extends IdempotencyScopeInput {
  scope: string;
  ttlSeconds: number;
}

export interface IdempotencyRecord<T extends Json> {
  response: T;
  replayed: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildIdempotencyScope(
  input: IdempotencyScopeInput,
): IdempotencyScope {
  if (
    !uuid.test(input.accountId) ||
    (input.organizationId && !uuid.test(input.organizationId)) ||
    !/^[a-z][a-z0-9._:-]{1,127}$/.test(input.operation)
  ) {
    throw new Problem(400, "INVALID_IDEMPOTENCY_SCOPE", "Invalid scope");
  }
  const ttlSeconds = ttlByOperation[input.operation] ?? 3600;
  return {
    ...input,
    ttlSeconds,
    scope: canonical({
      accountId: input.accountId,
      operation: input.operation,
      organizationId: input.organizationId ?? null,
    }),
  };
}

async function fingerprint(request: Json) {
  return sha256Hex(canonical(request));
}

export async function readReplay<T extends Json>(
  db: D1Database,
  safeScope: IdempotencyScope,
  key: string,
  request: Json,
): Promise<IdempotencyRecord<T> | null> {
  if (!/^[\x21-\x7e]{8,128}$/.test(key))
    throw new Problem(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Invalid idempotency key",
    );
  const hash = await fingerprint(request);
  const row = await db
    .prepare(
      "SELECT request_hash, response_json FROM governance_idempotency_records WHERE scope = ? AND key = ? AND expires_at > ?",
    )
    .bind(safeScope.scope, key, new Date().toISOString())
    .first<{ request_hash: string; response_json: string }>();
  if (!row) return null;
  if (row.request_hash !== hash)
    throw new Problem(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Key already used for another request",
    );
  return { response: JSON.parse(row.response_json) as T, replayed: true };
}

export async function storeReplay<T extends Json>(
  db: D1Database,
  safeScope: IdempotencyScope,
  key: string,
  request: Json,
  response: T,
) {
  const encoded = JSON.stringify(response);
  if (
    new TextEncoder().encode(encoded).byteLength > maxIdempotencyResponseBytes
  ) {
    throw new Problem(
      500,
      "IDEMPOTENCY_RESPONSE_TOO_LARGE",
      "Idempotent response is too large to store",
    );
  }
  const expiresAt = new Date(
    Date.now() + safeScope.ttlSeconds * 1000,
  ).toISOString();
  await db
    .prepare(
      "INSERT INTO governance_idempotency_records(scope, key, operation, account_id, organization_id, request_hash, response_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      safeScope.scope,
      key,
      safeScope.operation,
      safeScope.accountId,
      safeScope.organizationId ?? null,
      await fingerprint(request),
      encoded,
      expiresAt,
    )
    .run();
}

export async function cleanupExpiredIdempotencyRecords(
  db: D1Database,
  limit = 1000,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
    throw new Error("Invalid cleanup limit");
  const result = await db
    .prepare(
      "DELETE FROM governance_idempotency_records WHERE rowid IN (SELECT rowid FROM governance_idempotency_records WHERE expires_at < ? ORDER BY expires_at LIMIT ?)",
    )
    .bind(new Date().toISOString(), limit)
    .run();
  return result.meta.changes ?? 0;
}
