import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId, sha256Hex } from "@motorbaldi/shared";
import {
  issuePhoneOwnershipChallenge,
  consumePhoneOwnershipChallenge,
} from "../../packages/identity/src/phone-ownership.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import ownership from "../../migrations/0028_phone_ownership_challenges.sql?raw";
const db = (env as unknown as ApiBindings).DB;
beforeAll(async () => {
  for (const sql of [foundation, phase1, closeout, ownership])
    await db.exec(sql.replace(/^--.*$/gm, "").replace(/\n/g, " "));
});
async function fixture() {
  const actor = {
    accountId: newId(),
    personId: newId(),
    sessionId: newId(),
    mfaEnabled: false,
  };
  const contactId = newId(),
    phone = "+573001234567";
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Synthetic',?,1)",
    )
    .bind(actor.accountId, `${actor.accountId}@example.test`)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Synthetic','Customer')",
    )
    .bind(actor.personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(actor.accountId, actor.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(?,?,?,?)",
    )
    .bind(
      actor.sessionId,
      actor.accountId,
      newId(),
      new Date(Date.now() + 3600000).toISOString(),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,'PHONE',?,?,'TEST')",
    )
    .bind(contactId, actor.personId, phone, phone)
    .run();
  return { actor, contactId, phone };
}
async function issued() {
  const f = await fixture();
  const response = await issuePhoneOwnershipChallenge(
    db,
    f.actor,
    f.contactId,
    newId(),
  );
  return {
    ...f,
    response,
    evidence: {
      token: response.message.slice("MotorBaldi ".length),
      sender: f.phone,
      providerReference: `wamid.${newId()}`,
      occurredAt: new Date().toISOString(),
    },
  };
}
const consume = (
  evidence: Parameters<typeof consumePhoneOwnershipChallenge>[1],
) => consumePhoneOwnershipChallenge(db, evidence, newId());
async function auditCount(contactId: string, action: string) {
  return (await db
    .prepare(
      "SELECT count(*) AS count FROM governance_audit_events WHERE resource_id=? AND action=?",
    )
    .bind(contactId, action)
    .first<{ count: number }>())!.count;
}
describe("D1 phone ownership challenges", () => {
  it("stores random token hashes only and verifies once without granting consent", async () => {
    const f = await issued(),
      other = await issued();
    expect(f.evidence.token).toMatch(/^[a-f0-9]{64}$/);
    expect(other.evidence.token).not.toBe(f.evidence.token);
    const row = await db
      .prepare(
        "SELECT * FROM iam_phone_ownership_challenges WHERE account_id=?",
      )
      .bind(f.actor.accountId)
      .first();
    expect(row?.token_sha256).toBe(await sha256Hex(f.evidence.token));
    expect(row?.phone_sha256).toBe(await sha256Hex(f.phone));
    expect(JSON.stringify(row)).not.toContain(f.evidence.token);
    expect(JSON.stringify(row)).not.toContain(f.phone);
    expect(await consume(f.evidence)).toBe(true);
    expect(await consume(f.evidence)).toBe(false);
    expect(
      await db
        .prepare(
          "SELECT verification_status FROM iam_contact_methods WHERE id=?",
        )
        .bind(f.contactId)
        .first("verification_status"),
    ).toBe("VERIFIED");
    expect(
      await auditCount(f.contactId, "identity.phone.ownership.verified"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT count(*) FROM iam_consent_events WHERE person_id=?")
        .bind(f.actor.personId)
        .first("count(*)"),
    ).toBe(0);
  });
  it("enforces cooldown including concurrent issuance", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        issuePhoneOwnershipChallenge(db, f.actor, f.contactId, newId()),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(
      issuePhoneOwnershipChallenge(db, f.actor, f.contactId, newId()),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      await auditCount(f.contactId, "identity.phone.challenge.issued"),
    ).toBe(1);
    await db
      .prepare(
        "UPDATE iam_phone_ownership_challenges SET created_at=? WHERE account_id=?",
      )
      .bind(new Date(Date.now() - 61000).toISOString(), f.actor.accountId)
      .run();
    expect(
      (await issuePhoneOwnershipChallenge(db, f.actor, f.contactId, newId()))
        .message,
    ).toMatch(/^MotorBaldi [a-f0-9]{64}$/);
  });
  it("rejects wrong tokens and senders without consuming the valid challenge", async () => {
    const f = await issued();
    expect(await consume({ ...f.evidence, token: "b".repeat(64) })).toBe(false);
    expect(await consume({ ...f.evidence, sender: "+573009999999" })).toBe(
      false,
    );
    expect(await consume(f.evidence)).toBe(true);
  });
  it("rejects another owner's contact", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      issuePhoneOwnershipChallenge(db, a.actor, b.contactId, newId()),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each(["EMAIL", "REJECTED", "VERIFIED"])(
    "rejects issuance for %s contact",
    async (kind) => {
      const f = await fixture();
      if (kind === "EMAIL")
        await db
          .prepare("UPDATE iam_contact_methods SET type='EMAIL' WHERE id=?")
          .bind(f.contactId)
          .run();
      else
        await db
          .prepare(
            "UPDATE iam_contact_methods SET verification_status=?,verified_at=? WHERE id=?",
          )
          .bind(
            kind,
            kind === "VERIFIED" ? new Date().toISOString() : null,
            f.contactId,
          )
          .run();
      await expect(
        issuePhoneOwnershipChallenge(db, f.actor, f.contactId, newId()),
      ).rejects.toMatchObject({ status: 404 });
    },
  );
  it.each([
    "expired challenge",
    "revoked session",
    "expired session",
    "suspended account",
    "merged person",
    "modified phone",
    "reassigned contact",
    "reassigned account",
  ])("rejects consumption after %s", async (change) => {
    const f = await issued();
    switch (change) {
      case "expired challenge":
        await db
          .prepare(
            "UPDATE iam_phone_ownership_challenges SET created_at=?,expires_at=? WHERE account_id=?",
          )
          .bind(
            new Date(Date.now() - 700000).toISOString(),
            new Date(Date.now() - 1000).toISOString(),
            f.actor.accountId,
          )
          .run();
        break;
      case "revoked session":
        await db
          .prepare("DELETE FROM auth_sessions WHERE id=?")
          .bind(f.actor.sessionId)
          .run();
        break;
      case "expired session":
        await db
          .prepare("UPDATE auth_sessions SET expires_at=? WHERE id=?")
          .bind(new Date(Date.now() - 1000).toISOString(), f.actor.sessionId)
          .run();
        break;
      case "suspended account":
        await db
          .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
          .bind(f.actor.accountId)
          .run();
        break;
      case "merged person": {
        const other = await fixture();
        await db
          .prepare(
            "UPDATE iam_people SET status='MERGED',merged_into_person_id=? WHERE id=?",
          )
          .bind(other.actor.personId, f.actor.personId)
          .run();
        break;
      }
      case "modified phone":
        await db
          .prepare(
            "UPDATE iam_contact_methods SET normalized_value='+573009999999' WHERE id=?",
          )
          .bind(f.contactId)
          .run();
        break;
      case "reassigned contact": {
        const other = await fixture();
        await db
          .prepare(
            "UPDATE iam_contact_methods SET normalized_value='+573009999999' WHERE id=?",
          )
          .bind(other.contactId)
          .run();
        await db
          .prepare("UPDATE iam_contact_methods SET person_id=? WHERE id=?")
          .bind(other.actor.personId, f.contactId)
          .run();
        break;
      }
      case "reassigned account": {
        const other = await fixture();
        await db
          .prepare("UPDATE iam_accounts SET person_id=? WHERE id=?")
          .bind(other.actor.personId, f.actor.accountId)
          .run();
        break;
      }
    }
    expect(await consume(f.evidence)).toBe(false);
    expect(
      await auditCount(f.contactId, "identity.phone.ownership.verified"),
    ).toBe(0);
  });
  it("rolls back consumption and verification when audit persistence fails", async () => {
    const f = await issued();
    await db.exec(
      "CREATE TRIGGER phone_ownership_test_audit_failure BEFORE INSERT ON governance_audit_events WHEN NEW.action='identity.phone.ownership.verified' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;",
    );
    try {
      await expect(consume(f.evidence)).rejects.toThrow(
        "synthetic audit failure",
      );
      expect(
        await db
          .prepare(
            "SELECT consumed_at FROM iam_phone_ownership_challenges WHERE account_id=?",
          )
          .bind(f.actor.accountId)
          .first("consumed_at"),
      ).toBeNull();
      expect(
        await db
          .prepare(
            "SELECT verification_status FROM iam_contact_methods WHERE id=?",
          )
          .bind(f.contactId)
          .first("verification_status"),
      ).toBe("UNVERIFIED");
      expect(
        await auditCount(f.contactId, "identity.phone.ownership.verified"),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER phone_ownership_test_audit_failure");
    }
    expect(await consume(f.evidence)).toBe(true);
    expect(
      await auditCount(f.contactId, "identity.phone.ownership.verified"),
    ).toBe(1);
  });
  it("allows only one concurrent consumption and audit", async () => {
    const f = await issued();
    const results = await Promise.all([
      consume(f.evidence),
      consume(f.evidence),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(
      await auditCount(f.contactId, "identity.phone.ownership.verified"),
    ).toBe(1);
  });
});
