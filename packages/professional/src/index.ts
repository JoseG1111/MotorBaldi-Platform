import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import { auditStatement } from "@motorbaldi/db";
import { newId, utcNow } from "@motorbaldi/shared";
import { requirePlatformPermission } from "@motorbaldi/authz";

export const mechanicProfileInput = z
  .object({
    bio: z.string().trim().max(2000).optional(),
    yearsExperience: z.number().int().min(0).max(80).optional(),
  })
  .strict();
export const credentialInput = z
  .object({
    credentialType: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    issuer: z.string().trim().min(1).max(240),
    identifier: z.string().trim().max(240).optional(),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    evidenceFileId: z.string().uuid().optional(),
  })
  .strict();
export async function upsertMechanicProfile(
  db: D1Database,
  personId: string,
  input: z.infer<typeof mechanicProfileInput>,
  expectedVersion?: number,
) {
  const c = mechanicProfileInput.parse(input);
  const existing = await db
    .prepare(
      "SELECT version FROM professional_mechanic_profiles WHERE person_id=?",
    )
    .bind(personId)
    .first<{ version: number }>();
  if (!existing) {
    await db
      .prepare(
        "INSERT INTO professional_mechanic_profiles(person_id,bio,years_experience) VALUES(?,?,?)",
      )
      .bind(personId, c.bio ?? null, c.yearsExperience ?? null)
      .run();
    return 1;
  }
  if (expectedVersion !== existing.version)
    throw new Problem(409, "VERSION_CONFLICT", "Stale profile version");
  const result = await db
    .prepare(
      "UPDATE professional_mechanic_profiles SET bio=?,years_experience=?,updated_at=?,version=version+1 WHERE person_id=? AND version=?",
    )
    .bind(
      c.bio ?? null,
      c.yearsExperience ?? null,
      utcNow(),
      personId,
      expectedVersion,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new Problem(409, "VERSION_CONFLICT", "Stale profile version");
  return existing.version + 1;
}
export async function setSpecialties(
  db: D1Database,
  personId: string,
  codes: string[],
) {
  if (codes.length > 20 || new Set(codes).size !== codes.length)
    throw new Problem(400, "INVALID_SPECIALTIES", "Invalid specialties");
  const statements = [
    db
      .prepare("DELETE FROM professional_person_specialties WHERE person_id=?")
      .bind(personId),
  ];
  for (const code of codes)
    statements.push(
      db
        .prepare(
          "INSERT INTO professional_person_specialties(person_id,code) VALUES(?,?)",
        )
        .bind(personId, code),
    );
  await db.batch(statements);
}
export async function submitCredential(
  db: D1Database,
  personId: string,
  input: z.infer<typeof credentialInput>,
  requestId: string,
) {
  const c = credentialInput.parse(input);
  const id = newId();
  if (c.evidenceFileId) {
    const file = await db
      .prepare(
        "SELECT f.status FROM storage_files f JOIN iam_accounts a ON a.id=f.uploaded_by_account_id WHERE f.id=? AND a.person_id=? AND a.status='ACTIVE'",
      )
      .bind(c.evidenceFileId, personId)
      .first<{ status: string }>();
    if (file?.status !== "ACTIVE")
      throw new Problem(400, "FILE_NOT_ACTIVE", "Evidence unavailable");
  }
  await db.batch([
    db
      .prepare(
        "INSERT INTO professional_credentials(id,person_id,credential_type,country_code,issuer,identifier,issued_at,expires_at,status,evidence_file_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        personId,
        c.credentialType,
        c.countryCode ?? null,
        c.issuer,
        c.identifier ?? null,
        c.issuedAt ?? null,
        c.expiresAt ?? null,
        "PENDING",
        c.evidenceFileId ?? null,
      ),
    auditStatement(db, {
      actorId: personId,
      action: "professional.credential.submitted",
      resourceType: "professional_credential",
      resourceId: id,
      requestId,
    }),
  ]);
  return id;
}
export async function decideCredential(
  db: D1Database,
  actor: Principal & { personId: string },
  credentialId: string,
  decision: "VERIFIED" | "REJECTED",
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.professional.verify", {
    mfa: true,
  });
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  const result = await db.batch([
    db
      .prepare(
        "UPDATE professional_credentials SET status=?,reviewed_by_person_id=?,reviewed_at=?,reason=?,updated_at=?,version=version+1 WHERE id=? AND status='PENDING'",
      )
      .bind(decision, actor.personId, utcNow(), reason, utcNow(), credentialId),
    db
      .prepare(
        "INSERT INTO professional_credential_decisions(credential_id,decision,actor_person_id,reason) VALUES(?,CASE WHEN (SELECT status FROM professional_credentials WHERE id=?)=? THEN ? ELSE NULL END,?,?)",
      )
      .bind(
        credentialId,
        credentialId,
        decision,
        decision,
        actor.personId,
        reason,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "professional.credential.reviewed",
      resourceType: "professional_credential",
      resourceId: credentialId,
      reason,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(
      409,
      "CREDENTIAL_INVALID_STATE",
      "Credential unavailable",
    );
}
