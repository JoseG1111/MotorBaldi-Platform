import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { v7 } from "uuid";
import {
  syntheticCustomerSql,
  closeSyntheticCustomerSql,
  requireSyntheticSandboxExecution,
  resumeSyntheticCustomerSql,
} from "../../scripts/billing/sandbox-customer-fixture.mjs";
const fixture = () => ({
  accountId: v7(),
  credentialId: v7(),
  auditId: v7(),
  requestId: v7(),
  passwordHash: "a".repeat(32) + ":" + "b".repeat(128),
});
function database(environment: string) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001_foundation.sql", "utf8"));
  db.exec(readFileSync("migrations/0002_phase1.sql", "utf8"));
  db.prepare(
    "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,?)",
  ).run(environment);
  return db;
}
function atomic(db: DatabaseSync, sql: string) {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
describe("owner-authorized synthetic billing customer isolation", () => {
  it("requires explicit Development execution and approved cadence before resource access", () => {
    for (const args of [
      [],
      ["production", "--execute"],
      ["staging", "--execute"],
      ["development"],
      ["development", "--execute", "UNKNOWN"],
      ["development", "--execute", "MONTHLY", "extra"],
    ])
      expect(() => requireSyntheticSandboxExecution(args)).toThrow();
    expect(() =>
      requireSyntheticSandboxExecution(["development", "--execute", "ANNUAL"]),
    ).not.toThrow();
  });
  for (const env of ["local", "staging", "production"])
    it(`rolls back every fixture write against ${env} metadata`, () => {
      const db = database(env);
      expect(() => atomic(db, syntheticCustomerSql(fixture()))).toThrow();
      expect(db.prepare("SELECT count(*) n FROM auth_users").get()).toEqual({
        n: 0,
      });
      expect(
        db.prepare("SELECT count(*) n FROM auth_credentials").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT count(*) n FROM governance_audit_events").get(),
      ).toEqual({ n: 0 });
      db.close();
    });
  it("creates only an audited synthetic credential without staff, organization or signup consent grants", () => {
    const db = database("development"),
      f = fixture();
    atomic(db, syntheticCustomerSql(f));
    expect(
      db.prepare("SELECT name,email,two_factor_enabled FROM auth_users").get(),
    ).toEqual({
      name: "Synthetic Sandbox Customer",
      email: `sandbox-customer-${f.accountId}@development.invalid`,
      two_factor_enabled: 0,
    });
    for (const table of [
      "platform_person_roles",
      "org_memberships",
      "iam_signup_consents",
    ])
      expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({
        n: 0,
      });
    expect(
      db.prepare("SELECT action FROM governance_audit_events").get(),
    ).toEqual({ action: "identity.development_customer_fixture.provisioned" });
    expect(() =>
      atomic(
        db,
        syntheticCustomerSql({ ...f, credentialId: v7(), auditId: v7() }),
      ),
    ).toThrow();
    expect(db.prepare("SELECT count(*) n FROM auth_credentials").get()).toEqual(
      { n: 1 },
    );
    db.close();
  });
  it("rejects arbitrary identities and raw passwords", () => {
    expect(() =>
      syntheticCustomerSql({ ...fixture(), accountId: "x' OR 1=1" }),
    ).toThrow();
    expect(() =>
      syntheticCustomerSql({ ...fixture(), passwordHash: "plain-password" }),
    ).toThrow();
  });
  it("revokes only its fixture session and credential, retaining audit history", () => {
    const db = database("development"),
      first = fixture(),
      second = fixture();
    atomic(db, syntheticCustomerSql(first));
    atomic(db, syntheticCustomerSql(second));
    for (const f of [first, second])
      db.prepare(
        "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(?,?,?, '2099-01-01')",
      ).run(v7(), f.accountId, v7());
    atomic(
      db,
      closeSyntheticCustomerSql({
        accountId: first.accountId,
        auditId: v7(),
        requestId: v7(),
      }),
    );
    expect(db.prepare("SELECT user_id FROM auth_sessions").get()).toEqual({
      user_id: second.accountId,
    });
    expect(
      db
        .prepare("SELECT password FROM auth_credentials WHERE user_id=?")
        .get(first.accountId),
    ).toEqual({ password: null });
    expect(
      db
        .prepare("SELECT password FROM auth_credentials WHERE user_id=?")
        .get(second.accountId),
    ).toEqual({ password: second.passwordHash });
    expect(
      db.prepare("SELECT count(*) n FROM governance_audit_events").get(),
    ).toEqual({ n: 3 });
    db.close();
  });
  it("cannot disable an ordinary account without exact synthetic provenance", () => {
    const db = database("development"),
      f = fixture();
    db.prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Real Operator','operator@example.test',1)",
    ).run(f.accountId);
    db.prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential','preserved')",
    ).run(v7(), f.accountId, f.accountId);
    atomic(
      db,
      closeSyntheticCustomerSql({
        accountId: f.accountId,
        auditId: v7(),
        requestId: v7(),
      }),
    );
    expect(db.prepare("SELECT password FROM auth_credentials").get()).toEqual({
      password: "preserved",
    });
    expect(
      db.prepare("SELECT count(*) n FROM governance_audit_events").get(),
    ).toEqual({ n: 0 });
    db.close();
  });
  it("resumes only its audited nonprivileged customer with a fresh credential and normal session creation still required", () => {
    const db = database("development"),
      f = fixture(),
      person = v7();
    atomic(db, syntheticCustomerSql(f));
    db.prepare(
      "INSERT INTO iam_people(id,given_name,family_name,status) VALUES(?,'Synthetic','Customer','ACTIVE')",
    ).run(person);
    db.prepare(
      "INSERT INTO iam_accounts(id,person_id,status) VALUES(?,?,'SUSPENDED')",
    ).run(f.accountId, person);
    atomic(
      db,
      closeSyntheticCustomerSql({
        accountId: f.accountId,
        auditId: v7(),
        requestId: v7(),
      }),
    );
    const newHash = "c".repeat(32) + ":" + "d".repeat(128);
    atomic(
      db,
      resumeSyntheticCustomerSql({
        accountId: f.accountId,
        auditId: v7(),
        requestId: v7(),
        passwordHash: newHash,
      }),
    );
    expect(db.prepare("SELECT status FROM iam_accounts").get()).toEqual({
      status: "ACTIVE",
    });
    expect(db.prepare("SELECT password FROM auth_credentials").get()).toEqual({
      password: newHash,
    });
    expect(db.prepare("SELECT count(*) n FROM auth_sessions").get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare("SELECT count(*) n FROM iam_signup_consents").get(),
    ).toEqual({ n: 0 });
    db.close();
  });
  it("cannot reset or reenable an ordinary account through synthetic resume", () => {
    const db = database("development"),
      f = fixture();
    db.prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Operator','real@example.test',1)",
    ).run(f.accountId);
    db.prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential','original')",
    ).run(v7(), f.accountId, f.accountId);
    expect(() =>
      atomic(
        db,
        resumeSyntheticCustomerSql({
          accountId: f.accountId,
          auditId: v7(),
          requestId: v7(),
          passwordHash: f.passwordHash,
        }),
      ),
    ).toThrow();
    expect(db.prepare("SELECT password FROM auth_credentials").get()).toEqual({
      password: "original",
    });
    expect(
      db.prepare("SELECT count(*) n FROM governance_audit_events").get(),
    ).toEqual({ n: 0 });
    db.close();
  });
  it("refuses fixture resume after privileged role assignment without removing or bypassing MFA protections", () => {
    const db = database("development"),
      f = fixture(),
      person = v7();
    atomic(db, syntheticCustomerSql(f));
    db.prepare(
      "INSERT INTO iam_people(id,given_name,family_name) VALUES(?,'Synthetic','Customer')",
    ).run(person);
    db.prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)").run(
      f.accountId,
      person,
    );
    db.prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    ).run(person);
    expect(() =>
      atomic(
        db,
        resumeSyntheticCustomerSql({
          accountId: f.accountId,
          auditId: v7(),
          requestId: v7(),
          passwordHash: "e".repeat(32) + ":" + "f".repeat(128),
        }),
      ),
    ).toThrow();
    expect(db.prepare("SELECT password FROM auth_credentials").get()).toEqual({
      password: f.passwordHash,
    });
    db.close();
  });
});
