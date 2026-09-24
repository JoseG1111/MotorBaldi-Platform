import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("D1 foundation migration", () => {
  it("uses SQLite/D1 semantics and not PostgreSQL runtime features", () => {
    const sql = readFileSync("migrations/0001_foundation.sql", "utf8");
    expect(sql).toContain("CREATE TABLE governance_environment_metadata");
    expect(sql).toContain("CREATE TABLE integration_outbox_events");
    expect(sql).toContain("CREATE TABLE storage_files");
    expect(sql).toContain(") STRICT;");
    expect(sql).toContain("governance_environment_metadata_no_update");
    expect(sql).toContain("governance_audit_events_no_delete");
    expect(sql).not.toMatch(
      /CREATE SCHEMA|GRANT|REVOKE|CREATE ROLE|TIMESTAMPTZ|jsonb|pg_advisory|FOR UPDATE/i,
    );
  });

  it("documents a single UTC text representation", () => {
    const sql = readFileSync("migrations/0001_foundation.sql", "utf8");
    expect(sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    expect(sql).not.toMatch(/\bREAL\b|\bFLOAT\b/);
  });
});
