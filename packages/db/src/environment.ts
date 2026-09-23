import type { PlatformEnvironment } from "@motorbaldi/config";

export async function assertDatabaseEnvironment(
  db: D1Database,
  expected: PlatformEnvironment,
) {
  const row = await db
    .prepare(
      "SELECT environment FROM governance_environment_metadata WHERE singleton = 1",
    )
    .first<{ environment: string }>();
  if (!row || row.environment !== expected)
    throw new Error("Database environment mismatch or uninitialized database");
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
