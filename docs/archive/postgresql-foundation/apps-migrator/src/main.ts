import { migrationDatabase } from "@motorbaldi/db/migration-pool";
import {
  runCanonicalMigrations,
  type MigrationEnvironment,
} from "@motorbaldi/db/migrate";
const environment = process.env.APP_ENV;
const url = process.env.MIGRATION_DATABASE_URL;
if (
  !environment ||
  !["local", "test", "staging", "production"].includes(environment) ||
  !url
)
  throw new Error("Migration configuration missing or invalid");
const migrationEnvironment = environment as MigrationEnvironment;
const parsed = new URL(url);
if (!["postgres:", "postgresql:"].includes(parsed.protocol))
  throw new Error("Invalid migration connection protocol");
if (
  ["staging", "production"].includes(environment) &&
  parsed.searchParams.get("sslmode") !== "verify-full"
)
  throw new Error("Remote migrations require verified TLS");
const pool = migrationDatabase(url);
try {
  await runCanonicalMigrations(pool, {
    environment: migrationEnvironment,
    initializeEnvironment:
      process.env.INITIALIZE_DATABASE_ENVIRONMENT === "true",
    runtimeRole: process.env.RUNTIME_DATABASE_ROLE ?? "motorbaldi_runtime",
  });
} catch {
  console.error(
    "Migration failed; inspect database state and migration configuration securely",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
