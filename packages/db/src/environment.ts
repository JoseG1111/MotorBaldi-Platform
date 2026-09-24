import type { PlatformEnvironment } from "@motorbaldi/config";
import { Problem } from "@motorbaldi/contracts";

const verified = new WeakMap<D1Database, PlatformEnvironment>();

export async function assertDatabaseEnvironment(
  db: D1Database,
  expected: PlatformEnvironment,
) {
  if (verified.get(db) === expected) return;
  const row = await db
    .prepare(
      "SELECT environment FROM governance_environment_metadata WHERE singleton = 1",
    )
    .first<{ environment: string }>();
  if (!row || row.environment !== expected)
    throw new Problem(
      503,
      "DATABASE_ENVIRONMENT_MISMATCH",
      "Database unavailable",
    );
  verified.set(db, expected);
}

export async function initializeDatabaseEnvironment(
  db: D1Database,
  environment: PlatformEnvironment,
) {
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton, environment) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING",
    )
    .bind(environment)
    .run();
  await assertDatabaseEnvironment(db, environment);
}

export function clearDatabaseEnvironmentVerificationForTest(db: D1Database) {
  verified.delete(db);
}
