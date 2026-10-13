import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import { exportOwnAccountData } from "../../packages/identity/src/privacy-export.js";
import m0 from "../../migrations/0001_foundation.sql?raw";
import m1 from "../../migrations/0002_phase1.sql?raw";
import m2 from "../../migrations/0003_phase1_closeout.sql?raw";
import m13 from "../../migrations/0014_notifications.sql?raw";
const db = (env as unknown as ApiBindings).DB;
beforeAll(async () => {
  for (const sql of [m0, m1, m2, m13])
    await db.exec(sql.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function fixture() {
  const accountId = newId(),
    personId = newId(),
    contactId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Private owner',?,1)",
      )
      .bind(accountId, `${accountId}@example.test`),
    db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,middle_name,family_name,display_name) VALUES(?,'ACTIVE','Own','Middle','Person','Own Person')",
      )
      .bind(personId),
    db
      .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
      .bind(accountId, personId),
    db
      .prepare(
        "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,verified_at,source) VALUES(?,?,'EMAIL',?,?,'VERIFIED','2026-01-01T00:00:00Z','LOCAL_FIXTURE')",
      )
      .bind(
        contactId,
        personId,
        `${accountId}@example.test`,
        `${accountId}@example.test`,
      ),
    db
      .prepare(
        "INSERT INTO iam_signup_consents(auth_user_id,terms_version,privacy_version,request_id) VALUES(?,'terms-test','privacy-test',?)",
      )
      .bind(accountId, newId()),
    db
      .prepare(
        "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id) VALUES(?,?,'TERMS','terms-test','GRANTED','SIGNUP',?)",
      )
      .bind(newId(), personId, newId()),
    db
      .prepare(
        "INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id) VALUES(?,?,'TRANSACTIONAL','EMAIL',1,?)",
      )
      .bind(newId(), accountId, contactId),
    db
      .prepare(
        "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(?,?,'must-never-export-session-secret-'||?,'2030-01-01T00:00:00Z')",
      )
      .bind(newId(), accountId, newId()),
    db
      .prepare(
        "INSERT INTO auth_credentials(id,user_id,provider_id,account_id,password) VALUES(?,?,'credential',?,'must-never-export-password')",
      )
      .bind(newId(), accountId, accountId),
  ]);
  return { accountId, personId, contactId };
}
async function auditCount(accountId: string) {
  return await db
    .prepare(
      "SELECT count(*) AS count FROM governance_audit_events WHERE actor_id=? AND action='identity.privacy.account.exported'",
    )
    .bind(accountId)
    .first<number>("count");
}

describe("bounded own-account privacy export", () => {
  it("exports explicit own-account data and commits a metadata-only audit", async () => {
    const own = await fixture(),
      other = await fixture(),
      requestId = newId();
    const result = await exportOwnAccountData(db, own, requestId);
    expect(result.schemaVersion).toBe(1);
    expect(result.scope).toBe("ACCOUNT_DATA");
    expect(result.account.id).toBe(own.accountId);
    expect(result.person.id).toBe(own.personId);
    expect(result.person.middleName).toBe("Middle");
    expect(result.contactMethods.map((row) => row.id)).toEqual([own.contactId]);
    expect(result.signupConsent?.termsVersion).toBe("terms-test");
    expect(result.legalConsentEvents).toHaveLength(1);
    expect(result.notificationPreferences).toHaveLength(1);
    const json = JSON.stringify(result);
    expect(json).not.toContain(other.personId);
    expect(json).not.toContain(other.accountId);
    expect(json).not.toMatch(
      /password|credential|session|token|must-never-export|provider/i,
    );
    expect(Object.keys(result)).toEqual([
      "schemaVersion",
      "scope",
      "account",
      "person",
      "contactMethods",
      "signupConsent",
      "legalConsentEvents",
      "notificationPreferences",
    ]);
    const audit = await db
      .prepare(
        "SELECT actor_id,resource_id,request_id,reason FROM governance_audit_events WHERE actor_id=? AND action='identity.privacy.account.exported'",
      )
      .bind(own.accountId)
      .first();
    expect(audit).toEqual({
      actor_id: own.accountId,
      resource_id: own.accountId,
      request_id: requestId,
      reason: null,
    });
  });
  it("rejects cross-person access without recording a successful export", async () => {
    const own = await fixture(),
      other = await fixture();
    await expect(
      exportOwnAccountData(
        db,
        { accountId: own.accountId, personId: other.personId },
        newId(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await auditCount(own.accountId)).toBe(0);
  });
  it.each(["account", "person", "verification"])(
    "denies inactive or unverified %s",
    async (target) => {
      const own = await fixture();
      if (target === "account")
        await db
          .prepare(
            "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
          )
          .bind(own.accountId)
          .run();
      if (target === "person")
        await db
          .prepare(
            "UPDATE iam_people SET status='PROVISIONAL',version=version+1 WHERE id=?",
          )
          .bind(own.personId)
          .run();
      if (target === "verification")
        await db
          .prepare("UPDATE auth_users SET email_verified=0 WHERE id=?")
          .bind(own.accountId)
          .run();
      await expect(
        exportOwnAccountData(db, own, newId()),
      ).rejects.toMatchObject({ status: 403 });
      expect(await auditCount(own.accountId)).toBe(0);
    },
  );
  it("rechecks revoked authority inside the atomic read and audit batch", async () => {
    const own = await fixture();
    const racedDb = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await db
          .prepare(
            "UPDATE iam_accounts SET status='SUSPENDED',version=version+1 WHERE id=?",
          )
          .bind(own.accountId)
          .run();
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      exportOwnAccountData(racedDb, own, newId()),
    ).rejects.toMatchObject({
      status: 409,
      code: "PRIVACY_EXPORT_AUTHORITY_CHANGED",
    });
    expect(await auditCount(own.accountId)).toBe(0);
  });
  it("allows exactly 500 contacts and rejects 501 instead of truncating or auditing success", async () => {
    const own = await fixture();
    await db.batch(
      Array.from({ length: 499 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,'EMAIL',?,?,'LOCAL_FIXTURE')",
          )
          .bind(
            newId(),
            own.personId,
            `contact${i}@example.test`,
            `contact${i}@example.test`,
          ),
      ),
    );
    expect(
      (await exportOwnAccountData(db, own, newId())).contactMethods,
    ).toHaveLength(500);
    await db
      .prepare(
        "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,'EMAIL','overflow@example.test','overflow@example.test','LOCAL_FIXTURE')",
      )
      .bind(newId(), own.personId)
      .run();
    await expect(exportOwnAccountData(db, own, newId())).rejects.toMatchObject({
      status: 413,
      code: "PRIVACY_EXPORT_COLLECTION_LIMIT",
    });
    expect(await auditCount(own.accountId)).toBe(1);
  });
});

it("bounds signup legal consent history independently without exporting marketing consent", async () => {
  const own = await fixture();
  await db
    .prepare(
      "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id) VALUES(?,?,'MARKETING_EMAIL','marketing-test','GRANTED','LOCAL_FIXTURE',?)",
    )
    .bind(newId(), own.personId, newId())
    .run();
  expect(
    (await exportOwnAccountData(db, own, newId())).legalConsentEvents,
  ).toHaveLength(1);
  await db.batch(
    Array.from({ length: 500 }, () =>
      db
        .prepare(
          "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id) VALUES(?,?,'PRIVACY','privacy-test','GRANTED','SIGNUP',?)",
        )
        .bind(newId(), own.personId, newId()),
    ),
  );
  await expect(exportOwnAccountData(db, own, newId())).rejects.toMatchObject({
    status: 413,
    code: "PRIVACY_EXPORT_COLLECTION_LIMIT",
  });
  expect(await auditCount(own.accountId)).toBe(1);
});

it("returns an explicit empty signup consent when the account has none", async () => {
  const own = await fixture();
  await db
    .prepare("DELETE FROM iam_signup_consents WHERE auth_user_id=?")
    .bind(own.accountId)
    .run();
  expect(
    (await exportOwnAccountData(db, own, newId())).signupConsent,
  ).toBeNull();
});
