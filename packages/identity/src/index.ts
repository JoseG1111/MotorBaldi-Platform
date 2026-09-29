import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import { auditStatement, guardedBatch } from "@motorbaldi/db";
import { newId, utcNow } from "@motorbaldi/shared";
import { requirePlatformPermission } from "@motorbaldi/authz";

export const personInput = z
  .object({
    givenName: z.string().trim().min(1).max(120),
    middleName: z.string().trim().max(120).optional(),
    familyName: z.string().trim().min(1).max(120),
    secondFamilyName: z.string().trim().max(120).optional(),
    displayName: z.string().trim().max(240).optional(),
    preferredLocale: z.string().min(2).max(20).default("es"),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict();
export type PersonInput = z.infer<typeof personInput>;

export function normalizeEmail(value: string) {
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
    throw new Problem(400, "INVALID_EMAIL", "Invalid email");
  return email;
}
export function normalizePhone(value: string, countryCode?: string) {
  const normalized = value.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(normalized)) return normalized;
  if (countryCode)
    throw new Problem(
      400,
      "PHONE_COUNTRY_CONTEXT_REQUIRED",
      "Use international phone format",
    );
  throw new Problem(
    400,
    "PHONE_COUNTRY_CONTEXT_REQUIRED",
    "Use international phone format",
  );
}

async function detectEmailDuplicates(
  db: D1Database,
  personId: string,
  email: string,
) {
  const matches = await db
    .prepare(
      "SELECT evidence.person_id,MAX(evidence.verified) AS verified FROM (SELECT person_id,CASE WHEN verification_status='VERIFIED' THEN 1 ELSE 0 END AS verified FROM iam_contact_methods WHERE type='EMAIL' AND normalized_value=? UNION ALL SELECT person_id,0 AS verified FROM crm_lead_intakes WHERE email=? AND person_id IS NOT NULL) evidence JOIN iam_people p ON p.id=evidence.person_id WHERE evidence.person_id<>? AND p.status<>'MERGED' GROUP BY evidence.person_id LIMIT 50",
    )
    .bind(email, email, personId)
    .all<{ person_id: string; verified: number }>();
  for (const match of matches.results)
    await createDuplicateCandidate(
      db,
      personId,
      match.person_id,
      match.verified === 1 ? "SAME_VERIFIED_EMAIL" : "SAME_NORMALIZED_EMAIL",
    );
}

export async function ensureMotorBaldiAccount(
  db: D1Database,
  authUserId: string,
  requestId: string,
) {
  const user = await db
    .prepare("SELECT id,name,email,email_verified FROM auth_users WHERE id=?")
    .bind(authUserId)
    .first<{
      id: string;
      name: string;
      email: string;
      email_verified: number;
    }>();
  if (!user || user.email_verified !== 1)
    throw new Problem(
      403,
      "VERIFIED_ACCOUNT_REQUIRED",
      "Verified account required",
    );
  const existing = await db
    .prepare(
      "SELECT a.id,a.person_id,a.status,p.status AS person_status FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=?",
    )
    .bind(authUserId)
    .first<{
      id: string;
      person_id: string;
      status: string;
      person_status: string;
    }>();
  if (existing) {
    if (existing.status !== "ACTIVE")
      throw new Problem(
        403,
        existing.status === "SUSPENDED"
          ? "ACCOUNT_SUSPENDED"
          : "ACCOUNT_CLOSED",
        "Account unavailable",
      );
    if (existing.person_status !== "ACTIVE")
      throw new Problem(403, "PERSON_NOT_ACTIVE", "Person unavailable");
    await detectEmailDuplicates(
      db,
      existing.person_id,
      normalizeEmail(user.email),
    );
    return {
      accountId: existing.id,
      personId: existing.person_id,
      created: false,
    };
  }
  const personId = newId();
  const words = user.name.trim().split(/\s+/).filter(Boolean);
  const givenName = words[0] || "Persona";
  const familyName = words.slice(1).join(" ") || "Sin apellido";
  const email = normalizeEmail(user.email);
  await db.batch([
    db
      .prepare(
        "INSERT INTO iam_people(id,status,given_name,family_name,display_name) SELECT ?,'ACTIVE',?,?,? WHERE NOT EXISTS(SELECT 1 FROM iam_accounts WHERE id=?)",
      )
      .bind(personId, givenName, familyName, user.name, authUserId),
    db
      .prepare(
        "INSERT INTO iam_accounts(id,person_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM iam_people WHERE id=?) ON CONFLICT(id) DO NOTHING",
      )
      .bind(authUserId, personId, personId),
    db
      .prepare(
        "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,is_primary,verification_status,verified_at,source) SELECT ?,?,'EMAIL',?,?,1,'VERIFIED',?,'AUTH' WHERE EXISTS(SELECT 1 FROM iam_accounts WHERE id=? AND person_id=?)",
      )
      .bind(
        newId(),
        personId,
        user.email,
        email,
        utcNow(),
        authUserId,
        personId,
      ),
    db
      .prepare(
        "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id) SELECT ?,?,'TERMS',terms_version,'GRANTED','SIGNUP',request_id FROM iam_signup_consents WHERE auth_user_id=? AND EXISTS(SELECT 1 FROM iam_accounts WHERE id=? AND person_id=?)",
      )
      .bind(newId(), personId, authUserId, authUserId, personId),
    db
      .prepare(
        "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id) SELECT ?,?,'PRIVACY',privacy_version,'GRANTED','SIGNUP',request_id FROM iam_signup_consents WHERE auth_user_id=? AND EXISTS(SELECT 1 FROM iam_accounts WHERE id=? AND person_id=?)",
      )
      .bind(newId(), personId, authUserId, authUserId, personId),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) SELECT ?,?,'identity.account.created','iam_account',?,? WHERE EXISTS(SELECT 1 FROM iam_accounts WHERE id=? AND person_id=?)",
      )
      .bind(newId(), authUserId, authUserId, requestId, authUserId, personId),
    db
      .prepare(
        "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) SELECT ?,'identity',?,'identity.account.created.v1',1,?,?, 'IDEMPOTENT' WHERE EXISTS(SELECT 1 FROM iam_accounts WHERE id=? AND person_id=?)",
      )
      .bind(
        newId(),
        authUserId,
        JSON.stringify({ accountId: authUserId, personId }),
        requestId,
        authUserId,
        personId,
      ),
  ]);
  const account = await db
    .prepare(
      "SELECT a.id,a.person_id,a.status,p.status AS person_status FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=?",
    )
    .bind(authUserId)
    .first<{
      id: string;
      person_id: string;
      status: string;
      person_status: string;
    }>();
  if (
    !account ||
    account.status !== "ACTIVE" ||
    account.person_status !== "ACTIVE"
  )
    throw new Problem(
      503,
      "ACCOUNT_PROVISIONING_UNAVAILABLE",
      "Account unavailable",
    );
  await detectEmailDuplicates(db, account.person_id, email);
  return {
    accountId: account.id,
    personId: account.person_id,
    created: account.person_id === personId,
  };
}

export async function reconcileVerifiedAccounts(
  db: D1Database,
  requestId: string,
  limit = 50,
) {
  const rows = await db
    .prepare(
      "SELECT u.id FROM auth_users u LEFT JOIN iam_accounts a ON a.id=u.id WHERE u.email_verified=1 AND a.id IS NULL ORDER BY u.created_at,u.id LIMIT ?",
    )
    .bind(Math.min(100, Math.max(1, limit)))
    .all<{ id: string }>();
  for (const row of rows.results)
    await ensureMotorBaldiAccount(db, row.id, requestId);
  const remaining = Math.min(100, Math.max(1, limit)) - rows.results.length;
  if (remaining > 0) {
    const existing = await db
      .prepare(
        "SELECT u.id FROM auth_users u JOIN iam_accounts a ON a.id=u.id JOIN iam_people own ON own.id=a.person_id WHERE u.email_verified=1 AND a.status='ACTIVE' AND own.status='ACTIVE' AND (EXISTS(SELECT 1 FROM iam_contact_methods cm JOIN iam_people p ON p.id=cm.person_id WHERE cm.type='EMAIL' AND cm.normalized_value=lower(trim(u.email)) AND cm.person_id<>a.person_id AND p.status<>'MERGED' AND NOT EXISTS(SELECT 1 FROM iam_duplicate_candidates d WHERE d.source_person_id=a.person_id AND d.destination_person_id=cm.person_id AND d.reason IN ('SAME_VERIFIED_EMAIL','SAME_NORMALIZED_EMAIL'))) OR EXISTS(SELECT 1 FROM crm_lead_intakes l JOIN iam_people p ON p.id=l.person_id WHERE l.email=lower(trim(u.email)) AND l.person_id<>a.person_id AND p.status<>'MERGED' AND NOT EXISTS(SELECT 1 FROM iam_duplicate_candidates d WHERE d.source_person_id=a.person_id AND d.destination_person_id=l.person_id AND d.reason IN ('SAME_VERIFIED_EMAIL','SAME_NORMALIZED_EMAIL')))) ORDER BY u.created_at,u.id LIMIT ?",
      )
      .bind(remaining)
      .all<{ id: string }>();
    for (const row of existing.results)
      await ensureMotorBaldiAccount(db, row.id, requestId);
    return rows.results.length + existing.results.length;
  }
  return rows.results.length;
}

export async function requireMotorBaldiPrincipal(
  db: D1Database,
  technical: Principal | null,
  requestId: string,
) {
  if (!technical)
    throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
  const account = await ensureMotorBaldiAccount(
    db,
    technical.accountId,
    requestId,
  );
  return { ...technical, personId: account.personId } as Principal & {
    personId: string;
  };
}

export async function createProvisionalPerson(
  db: D1Database,
  input: PersonInput,
  actorId: string,
  requestId: string,
) {
  const c = personInput.parse(input);
  const id = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO iam_people(id,given_name,middle_name,family_name,second_family_name,display_name,preferred_locale,country_code) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        c.givenName,
        c.middleName ?? null,
        c.familyName,
        c.secondFamilyName ?? null,
        c.displayName ?? null,
        c.preferredLocale,
        c.countryCode ?? null,
      ),
    auditStatement(db, {
      actorId,
      action: "identity.person.created",
      resourceType: "iam_person",
      resourceId: id,
      requestId,
    }),
  ]);
  return id;
}
export async function recordConsent(
  db: D1Database,
  personId: string,
  purpose:
    | "TERMS"
    | "PRIVACY"
    | "MARKETING_EMAIL"
    | "MARKETING_SMS"
    | "MARKETING_WHATSAPP",
  policyVersion: string,
  status: "GRANTED" | "REVOKED",
  source: string,
  requestId: string,
) {
  await db
    .prepare(
      "INSERT INTO iam_consent_events(id,person_id,purpose,policy_version,status,source,request_id) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(newId(), personId, purpose, policyVersion, status, source, requestId)
    .run();
}
export async function addContact(
  db: D1Database,
  personId: string,
  type: "EMAIL" | "PHONE",
  rawValue: string,
  source: string,
) {
  const normalized =
    type === "EMAIL" ? normalizeEmail(rawValue) : normalizePhone(rawValue);
  const id = newId();
  await db
    .prepare(
      "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,source) VALUES(?,?,?,?,?,?)",
    )
    .bind(id, personId, type, rawValue, normalized, source)
    .run();
  return id;
}
export async function createDuplicateCandidate(
  db: D1Database,
  sourceId: string,
  destinationId: string,
  reason:
    | "SAME_VERIFIED_EMAIL"
    | "SAME_NORMALIZED_EMAIL"
    | "SAME_PHONE"
    | "MANUAL_REPORT",
) {
  if (sourceId === destinationId)
    throw new Problem(400, "SAME_PERSON", "Distinct people required");
  const id = newId();
  await db
    .prepare(
      "INSERT INTO iam_duplicate_candidates(id,source_person_id,destination_person_id,reason) VALUES(?,?,?,?) ON CONFLICT(source_person_id,destination_person_id,reason) DO NOTHING",
    )
    .bind(id, sourceId, destinationId, reason)
    .run();
}
export async function resolveDuplicateCandidate(
  db: D1Database,
  actor: Principal & { personId: string },
  candidateId: string,
  decision: "NOT_DUPLICATE" | "DISMISSED",
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.people.merge");
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  const result = await db.batch([
    db
      .prepare(
        "UPDATE iam_duplicate_candidates SET status=?,reviewed_by_person_id=?,reviewed_at=?,resolution=? WHERE id=? AND status='OPEN'",
      )
      .bind(decision, actor.personId, utcNow(), reason, candidateId),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "identity.duplicate.resolved",
      resourceType: "iam_duplicate_candidate",
      resourceId: candidateId,
      reason,
      requestId,
      requirePreviousChange: true,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(
      409,
      "DUPLICATE_CANDIDATE_INVALID_STATE",
      "Candidate unavailable",
    );
}
export async function mergePeople(
  db: D1Database,
  sourceId: string,
  destinationId: string,
  actor: Principal & { personId: string },
  reason: string,
  requestId: string,
) {
  await requirePlatformPermission(db, actor, "platform.people.merge", {
    mfa: true,
  });
  if (sourceId === destinationId || !reason.trim())
    throw new Problem(
      400,
      "INVALID_PERSON_MERGE",
      "Distinct people and reason required",
    );
  const rows = await db
    .prepare(
      "SELECT id,status,merged_into_person_id FROM iam_people WHERE id IN (?,?)",
    )
    .bind(sourceId, destinationId)
    .all<{
      id: string;
      status: string;
      merged_into_person_id: string | null;
    }>();
  const source = rows.results.find((p) => p.id === sourceId),
    destination = rows.results.find((p) => p.id === destinationId);
  if (
    source?.status === "MERGED" &&
    source.merged_into_person_id === destinationId
  )
    return;
  if (
    !source ||
    !destination ||
    destination.status === "MERGED" ||
    source.status === "MERGED"
  )
    throw new Problem(409, "INVALID_PERSON_MERGE", "Merge unavailable");
  const conflict = await db
    .prepare(
      "SELECT 1 FROM org_memberships s JOIN org_memberships d ON d.organization_id=s.organization_id AND d.person_id=? AND d.status='ACTIVE' WHERE s.person_id=? AND s.status='ACTIVE' LIMIT 1",
    )
    .bind(destinationId, sourceId)
    .first();
  const profile = await db
    .prepare(
      "SELECT 1 FROM professional_mechanic_profiles WHERE person_id IN (?,?)",
    )
    .bind(sourceId, destinationId)
    .all();
  if (conflict || profile.results.length > 1)
    throw new Problem(
      409,
      "PERSON_MERGE_REVIEW_REQUIRED",
      "Resolve relationships before merge",
    );
  const statements = [
    db
      .prepare(
        "UPDATE iam_accounts SET person_id=?,updated_at=?,version=version+1 WHERE person_id=?",
      )
      .bind(destinationId, utcNow(), sourceId),
    db
      .prepare(
        "UPDATE OR IGNORE iam_contact_methods SET person_id=? WHERE person_id=?",
      )
      .bind(destinationId, sourceId),
    db
      .prepare(
        "UPDATE org_memberships SET person_id=?,updated_at=?,version=version+1 WHERE person_id=?",
      )
      .bind(destinationId, utcNow(), sourceId),
    db
      .prepare("DELETE FROM platform_person_roles WHERE person_id=?")
      .bind(sourceId),
    db
      .prepare(
        "INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES(?,'PERSON_MERGED_ACCESS_REVIEW',?,?)",
      )
      .bind(newId(), actor.accountId, requestId),
    db
      .prepare(
        "UPDATE professional_mechanic_profiles SET person_id=? WHERE person_id=?",
      )
      .bind(destinationId, sourceId),
    db
      .prepare("UPDATE crm_lead_intakes SET person_id=? WHERE person_id=?")
      .bind(destinationId, sourceId),
    db
      .prepare(
        "UPDATE crm_lead_intakes SET assigned_to_person_id=? WHERE assigned_to_person_id=?",
      )
      .bind(destinationId, sourceId),
    db
      .prepare("UPDATE crm_opportunities SET person_id=? WHERE person_id=?")
      .bind(destinationId, sourceId),
    db
      .prepare(
        "UPDATE crm_opportunities SET owner_person_id=? WHERE owner_person_id=?",
      )
      .bind(destinationId, sourceId),
    db
      .prepare("UPDATE crm_activities SET person_id=? WHERE person_id=?")
      .bind(destinationId, sourceId),
    db
      .prepare("UPDATE crm_notes SET person_id=? WHERE person_id=?")
      .bind(destinationId, sourceId),
    db
      .prepare("UPDATE crm_tasks SET person_id=? WHERE person_id=?")
      .bind(destinationId, sourceId),
    db
      .prepare("UPDATE crm_tasks SET owner_person_id=? WHERE owner_person_id=?")
      .bind(destinationId, sourceId),
    db
      .prepare(
        "UPDATE org_membership_requests SET person_id=? WHERE person_id=?",
      )
      .bind(destinationId, sourceId),
    db
      .prepare(
        "UPDATE iam_people SET status='MERGED',merged_into_person_id=?,updated_at=?,version=version+1 WHERE id=? AND status<>'MERGED'",
      )
      .bind(destinationId, utcNow(), sourceId),
    db
      .prepare(
        "UPDATE iam_duplicate_candidates SET status='MERGED',reviewed_by_person_id=?,reviewed_at=?,resolution=? WHERE ((source_person_id=? AND destination_person_id=?) OR (source_person_id=? AND destination_person_id=?)) AND status='OPEN'",
      )
      .bind(
        actor.personId,
        utcNow(),
        reason,
        sourceId,
        destinationId,
        destinationId,
        sourceId,
      ),
    auditStatement(db, {
      actorId: actor.accountId,
      action: "identity.person.merged",
      resourceType: "iam_person",
      resourceId: sourceId,
      reason,
      requestId,
    }),
    db
      .prepare(
        "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES(?,'identity',?,'identity.person.merged.v1',1,?,?,'IDEMPOTENT')",
      )
      .bind(
        newId(),
        destinationId,
        JSON.stringify({ sourceId, destinationId }),
        requestId,
      ),
  ];
  await db.batch(statements);
}

export async function suspendAccount(
  db: D1Database,
  accountId: string,
  actorId: string,
  reason: string,
  requestId: string,
) {
  if (!reason.trim())
    throw new Problem(400, "REASON_REQUIRED", "Reason required");
  const result = await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE iam_accounts SET status='SUSPENDED',updated_at=?,version=version+1 WHERE id=? AND status='ACTIVE'",
        )
        .bind(utcNow(), accountId),
      db
        .prepare(
          "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,reason,request_id) VALUES(?,?,'identity.account.suspended','iam_account',CASE WHEN changes()=1 THEN ? ELSE NULL END,?,?)",
        )
        .bind(newId(), actorId, accountId, reason, requestId),
      db
        .prepare(
          "INSERT INTO governance_security_events(id,code,actor_id,request_id) VALUES(?,'ACCOUNT_SUSPENDED',?,?)",
        )
        .bind(newId(), actorId, requestId),
    ],
    {
      table: "governance_audit_events",
      column: "resource_id",
      code: "ACCOUNT_INVALID_STATE",
      message: "Account unavailable",
    },
  );
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "ACCOUNT_INVALID_STATE", "Account unavailable");
}
