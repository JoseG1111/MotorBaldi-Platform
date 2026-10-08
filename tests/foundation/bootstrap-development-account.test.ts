import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { v7 } from "uuid";
import {
  buildBootstrapSql,
  normalizeBootstrapEmail,
  requireDevelopmentExecution,
} from "../../scripts/phase1/bootstrap-development-account.mjs";

const script = "scripts/phase1/bootstrap-development-account.mjs";
const identity = () => ({
  accountId: v7(),
  credentialId: v7(),
  auditId: v7(),
  securityId: v7(),
  requestId: v7(),
  name: "Development Operator",
  email: "operator@example.test",
  passwordHash: "fixture-hash",
});

function database(
  environment: "local" | "development" | "staging" | "production",
) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001_foundation.sql", "utf8"));
  db.exec(readFileSync("migrations/0002_phase1.sql", "utf8"));
  db.prepare(
    "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,?)",
  ).run(environment);
  return db;
}

function importAtomically(db: DatabaseSync, sql: string) {
  db.exec("BEGIN TRANSACTION");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("development account bootstrap", () => {
  it("refuses every environment except explicit development execution before prompting", () => {
    for (const args of [
      [],
      ["local", "--execute"],
      ["staging", "--execute"],
      ["production", "--execute"],
      ["development"],
      ["development", "--execute", "extra"],
    ]) {
      expect(() => requireDevelopmentExecution(args)).toThrow();
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(() =>
      requireDevelopmentExecution(["development", "--execute"]),
    ).not.toThrow();
    expect(normalizeBootstrapEmail("  OPERATOR@EXAMPLE.TEST  ")).toBe(
      "operator@example.test",
    );
  });

  it("creates the five intended rows atomically without manually creating a person", () => {
    const db = database("development");
    try {
      const ids = identity();
      importAtomically(db, buildBootstrapSql(ids));
      expect(
        db
          .prepare(
            "SELECT name,email,email_verified FROM auth_users WHERE id=?",
          )
          .get(ids.accountId),
      ).toMatchObject({ name: ids.name, email: ids.email, email_verified: 1 });
      expect(
        db
          .prepare(
            "SELECT provider_id,account_id,password FROM auth_credentials WHERE user_id=?",
          )
          .get(ids.accountId),
      ).toMatchObject({
        provider_id: "credential",
        account_id: ids.accountId,
        password: "fixture-hash",
      });
      expect(
        db
          .prepare(
            "SELECT terms_version,privacy_version FROM iam_signup_consents WHERE auth_user_id=?",
          )
          .get(ids.accountId),
      ).toMatchObject({ terms_version: "1", privacy_version: "1" });
      expect(
        db
          .prepare(
            "SELECT action FROM governance_audit_events WHERE actor_id=?",
          )
          .get(ids.accountId),
      ).toMatchObject({ action: "identity.development_account.bootstrapped" });
      expect(
        db
          .prepare(
            "SELECT code FROM governance_security_events WHERE actor_id=?",
          )
          .get(ids.accountId),
      ).toMatchObject({ code: "DEVELOPMENT_ACCOUNT_BOOTSTRAPPED" });
      expect(
        db.prepare("SELECT count(*) AS n FROM iam_people").get(),
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare("SELECT count(*) AS n FROM iam_accounts").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls back on environment mismatch, duplicate email, or existing superadmin", () => {
    for (const environment of ["local", "staging", "production"] as const) {
      const db = database(environment);
      try {
        expect(() =>
          importAtomically(db, buildBootstrapSql(identity())),
        ).toThrow();
        expect(
          db.prepare("SELECT count(*) AS n FROM auth_users").get(),
        ).toMatchObject({ n: 0 });
      } finally {
        db.close();
      }
    }
    const duplicate = database("development");
    try {
      duplicate
        .prepare(
          "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Existing','Operator@Example.Test',1)",
        )
        .run(v7());
      expect(() =>
        importAtomically(duplicate, buildBootstrapSql(identity())),
      ).toThrow();
      expect(
        duplicate.prepare("SELECT count(*) AS n FROM auth_credentials").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      duplicate.close();
    }
    const superadmin = database("development");
    try {
      const personId = v7();
      superadmin
        .prepare(
          "INSERT INTO iam_people(id,given_name,family_name) VALUES(?,'Existing','Admin')",
        )
        .run(personId);
      superadmin
        .prepare(
          "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
        )
        .run(personId);
      expect(() =>
        importAtomically(superadmin, buildBootstrapSql(identity())),
      ).toThrow();
      expect(
        superadmin.prepare("SELECT count(*) AS n FROM auth_users").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      superadmin.close();
    }
  });

  it("rolls back earlier rows when the final security event insert fails", () => {
    const db = database("development");
    try {
      const ids = identity();
      db.prepare(
        "INSERT INTO governance_security_events(id,code,request_id) VALUES(?,'EXISTING','fixture')",
      ).run(ids.securityId);
      expect(() => importAtomically(db, buildBootstrapSql(ids))).toThrow();
      for (const table of [
        "auth_users",
        "auth_credentials",
        "iam_signup_consents",
        "governance_audit_events",
      ])
        expect(
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
        ).toMatchObject({ n: 0 });
      expect(
        db
          .prepare("SELECT count(*) AS n FROM governance_security_events")
          .get(),
      ).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });
});
