import { Problem, type Principal } from "@motorbaldi/contracts";
import { auditStatement } from "@motorbaldi/db";
import { sha256Hex } from "@motorbaldi/shared";

const activeSession = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id JOIN auth_sessions s ON s.user_id=a.id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1 AND s.id=? AND s.expires_at>?)`;

/** Issue a 256-bit challenge once per minute, replacing any prior challenge. */
export async function issuePhoneOwnershipChallenge(
  db: D1Database,
  actor: Principal & { personId: string },
  contactId: string,
  requestId: string,
) {
  if (!actor.sessionId || actor.automationAuthorizationId)
    throw new Problem(403, "HUMAN_SESSION_REQUIRED", "Human session required");
  const now = new Date();
  const at = now.toISOString();
  const contact = await db
    .prepare(
      `SELECT normalized_value FROM iam_contact_methods WHERE id=? AND person_id=? AND type='PHONE' AND verification_status IN ('UNVERIFIED','PENDING') AND ${activeSession}`,
    )
    .bind(
      contactId,
      actor.personId,
      actor.accountId,
      actor.personId,
      actor.sessionId,
      at,
    )
    .first<{ normalized_value: string }>();
  if (!contact || !/^\+[1-9]\d{7,14}$/.test(contact.normalized_value))
    throw new Problem(404, "CONTACT_UNAVAILABLE", "Contact unavailable");
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const tokenHash = await sha256Hex(token);
  const phoneHash = await sha256Hex(contact.normalized_value);
  const expiresAt = new Date(now.getTime() + 600_000).toISOString();
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO iam_phone_ownership_challenges(account_id,person_id,contact_method_id,session_id,token_sha256,phone_sha256,created_at,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE ${activeSession} AND EXISTS(SELECT 1 FROM iam_contact_methods WHERE id=? AND person_id=? AND type='PHONE' AND normalized_value=? AND verification_status IN ('UNVERIFIED','PENDING')) ON CONFLICT(account_id) DO UPDATE SET person_id=excluded.person_id,contact_method_id=excluded.contact_method_id,session_id=excluded.session_id,token_sha256=excluded.token_sha256,phone_sha256=excluded.phone_sha256,created_at=excluded.created_at,expires_at=excluded.expires_at,consumed_at=NULL,provider_reference_sha256=NULL WHERE iam_phone_ownership_challenges.created_at<=?`,
      )
      .bind(
        actor.accountId,
        actor.personId,
        contactId,
        actor.sessionId,
        tokenHash,
        phoneHash,
        at,
        expiresAt,
        actor.accountId,
        actor.personId,
        actor.sessionId,
        at,
        contactId,
        actor.personId,
        contact.normalized_value,
        new Date(now.getTime() - 60_000).toISOString(),
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "identity.phone.challenge.issued",
      resourceType: "iam_contact_method",
      resourceId: contactId,
      requestId,
      requirePreviousChange: true,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(
      429,
      "PHONE_CHALLENGE_UNAVAILABLE",
      "Wait before requesting another challenge",
    );
  return { message: `MotorBaldi ${token}`, expiresAt };
}

/** Only call with authenticated provider evidence; never with a client-submitted sender. */
export async function consumePhoneOwnershipChallenge(
  db: D1Database,
  evidence: {
    token: string;
    sender: string;
    providerReference: string;
    occurredAt: string;
  },
  requestId: string,
) {
  if (
    !/^[a-f0-9]{64}$/.test(evidence.token) ||
    !/^\+[1-9]\d{7,14}$/.test(evidence.sender)
  )
    return false;
  const now = new Date();
  const occurred = Date.parse(evidence.occurredAt);
  if (
    !Number.isFinite(occurred) ||
    occurred < now.getTime() - 600_000 ||
    occurred > now.getTime() + 30_000
  )
    return false;
  const tokenHash = await sha256Hex(evidence.token);
  const phoneHash = await sha256Hex(evidence.sender);
  const row = await db
    .prepare(
      "SELECT account_id,person_id,contact_method_id,session_id FROM iam_phone_ownership_challenges WHERE token_sha256=? AND phone_sha256=? AND consumed_at IS NULL",
    )
    .bind(tokenHash, phoneHash)
    .first<{
      account_id: string;
      person_id: string;
      contact_method_id: string;
      session_id: string;
    }>();
  if (!row) return false;
  const at = now.toISOString();
  const referenceHash = await sha256Hex(evidence.providerReference);
  const result = await db.batch([
    db
      .prepare(
        `UPDATE iam_phone_ownership_challenges SET consumed_at=?,provider_reference_sha256=? WHERE account_id=? AND token_sha256=? AND phone_sha256=? AND consumed_at IS NULL AND expires_at>? AND created_at<=? AND ${activeSession} AND EXISTS(SELECT 1 FROM iam_contact_methods WHERE id=iam_phone_ownership_challenges.contact_method_id AND person_id=iam_phone_ownership_challenges.person_id AND type='PHONE' AND normalized_value=? AND verification_status IN ('UNVERIFIED','PENDING'))`,
      )
      .bind(
        at,
        referenceHash,
        row.account_id,
        tokenHash,
        phoneHash,
        at,
        new Date(occurred + 1000).toISOString(),
        row.account_id,
        row.person_id,
        row.session_id,
        at,
        evidence.sender,
      ),
    db
      .prepare(
        "UPDATE iam_contact_methods SET verification_status='VERIFIED',verified_at=?,updated_at=? WHERE id=? AND person_id=? AND changes()=1",
      )
      .bind(at, at, row.contact_method_id, row.person_id),
    auditStatement(db, {
      actorId: row.account_id,
      action: "identity.phone.ownership.verified",
      resourceType: "iam_contact_method",
      resourceId: row.contact_method_id,
      requestId,
      requirePreviousChange: true,
    }),
  ]);
  return result[0]?.meta.changes === 1;
}
