import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type pg from "pg";
import { applyRuntimeGrants } from "./grants.js";
const environments = ["local", "test", "staging", "production"] as const;
export type MigrationEnvironment = (typeof environments)[number];
export interface MigrationOptions {
  environment: MigrationEnvironment;
  initializeEnvironment?: boolean;
  runtimeRole: string;
}
export async function runCanonicalMigrations(
  pool: pg.Pool,
  options: MigrationOptions,
  until?: string,
) {
  return migrate(pool, until, options);
}
export async function migrate(
  pool: pg.Pool,
  until?: string,
  options?: MigrationOptions,
) {
  if (!options) throw new Error("Canonical migration options required");
  if (!environments.includes(options.environment))
    throw new Error("Invalid migration environment");
  const tx = await pool.connect();
  try {
    await tx.query("SELECT pg_advisory_lock(89234107)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS public.motorbaldi_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const folder = new URL("../migrations/", import.meta.url);
    const migrationFiles = (await readdir(folder))
      .filter((n) => /^\d{4}_.*\.sql$/.test(n))
      .sort();
    const checksumByName = new Map<string, string>();
    for (const name of migrationFiles) {
      const sql = await readFile(new URL(name, folder), "utf8");
      checksumByName.set(name, createHash("sha256").update(sql).digest("hex"));
    }
    await verifyEnvironment(tx, options, checksumByName);
    for (const name of migrationFiles) {
      if (until && name > until) break;
      const sql = await readFile(new URL(name, folder), "utf8");
      const checksum = checksumByName.get(name)!;
      const existing = await tx.query<{ checksum: string }>(
        "SELECT checksum FROM public.motorbaldi_migrations WHERE name=$1",
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error("Migration checksum mismatch: " + name);
        continue;
      }
      await tx.query("BEGIN");
      try {
        await tx.query(sql);
        if (name === "0003_environment.sql")
          await tx.query(
            "INSERT INTO governance.environment_metadata(singleton,environment) VALUES (true,$1)",
            [options.environment],
          );
        await tx.query(
          "INSERT INTO public.motorbaldi_migrations(name,checksum) VALUES ($1,$2)",
          [name, checksum],
        );
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      }
    }
    await verifyEnvironment(tx, options, checksumByName);
    if (!until) {
      await tx.query("BEGIN");
      try {
        await applyRuntimeGrants(tx, options.runtimeRole);
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await tx.query("SELECT pg_advisory_unlock(89234107)");
    tx.release();
  }
}
async function verifyEnvironment(
  tx: pg.PoolClient,
  options: MigrationOptions,
  checksumByName: ReadonlyMap<string, string>,
) {
  const metadata = await tx.query<{ name: string | null }>(
    "SELECT to_regclass('governance.environment_metadata')::text AS name",
  );
  if (!metadata.rows[0]?.name) {
    if (!options.initializeEnvironment)
      throw new Error("Explicit database environment initialization required");
    return;
  }
  const stored = await tx.query<{ environment: string }>(
    "SELECT environment FROM governance.environment_metadata",
  );
  if (stored.rows.length === 1) {
    if (stored.rows[0]?.environment !== options.environment)
      throw new Error("Database environment mismatch");
    return;
  }
  if (stored.rows.length > 1) throw new Error("Database environment mismatch");
  if (!options.initializeEnvironment)
    throw new Error("Explicit database environment initialization required");
  const history = await tx.query<{ checksum: string }>(
    "SELECT checksum FROM public.motorbaldi_migrations WHERE name='0003_environment.sql'",
  );
  if (
    history.rows.length !== 1 ||
    history.rows[0]?.checksum !== checksumByName.get("0003_environment.sql")
  )
    throw new Error("Database environment repair refused");
  await tx.query("BEGIN");
  try {
    await tx.query(
      "INSERT INTO governance.environment_metadata(singleton,environment) VALUES (true,$1)",
      [options.environment],
    );
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  }
}
