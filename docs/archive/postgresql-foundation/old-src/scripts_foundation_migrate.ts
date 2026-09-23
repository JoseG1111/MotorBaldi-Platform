import { migrationDatabase } from "@motorbaldi/db/migration-pool";
import {
  runCanonicalMigrations,
  type MigrationEnvironment,
} from "@motorbaldi/db/migrate";
const environment = process.env.APP_ENV;
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error(
    "MIGRATION_DATABASE_URL required (separate owner credential)",
  );
if (
  !environment ||
  !["local", "test", "staging", "production"].includes(environment)
)
  throw new Error("APP_ENV required for migrations");
const migrationEnvironment = environment as MigrationEnvironment;
const pool = migrationDatabase(process.env.MIGRATION_DATABASE_URL);
try {
  await runCanonicalMigrations(pool, {
    environment: migrationEnvironment,
    initializeEnvironment:
      process.env.INITIALIZE_DATABASE_ENVIRONMENT === "true",
    runtimeRole: process.env.RUNTIME_DATABASE_ROLE ?? "motorbaldi_runtime",
  });
  console.log("Migrations validated and applied");
} finally {
  await pool.end();
}
