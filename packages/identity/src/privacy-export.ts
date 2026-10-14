import { Problem } from "@motorbaldi/contracts";
import { guardedBatch } from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";

const activeOwnAccount = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN auth_users u ON u.id=a.id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE' AND u.email_verified=1)`;
const collectionLimit = 500;
const boundedCollections = `
 (SELECT count(*) FROM (SELECT 1 FROM iam_contact_methods WHERE person_id=? LIMIT 501))<=500
 AND (SELECT count(*) FROM (SELECT 1 FROM iam_consent_events WHERE person_id=? AND purpose IN ('TERMS','PRIVACY') AND source='SIGNUP' LIMIT 501))<=500
 AND (SELECT count(*) FROM (SELECT 1 FROM notification_preferences WHERE account_id=? LIMIT 501))<=500`;

interface ExportAccount {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}
interface ExportPerson {
  id: string;
  status: string;
  givenName: string;
  middleName: string | null;
  familyName: string;
  secondFamilyName: string | null;
  displayName: string | null;
  preferredLocale: string;
  countryCode: string | null;
  createdAt: string;
  updatedAt: string;
}
interface ExportContact {
  id: string;
  type: string;
  rawValue: string;
  normalizedValue: string;
  label: string | null;
  isPrimary: number;
  verificationStatus: string;
  verifiedAt: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}
interface ExportSignupConsent {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string;
}
interface ExportLegalConsent {
  id: string;
  purpose: string;
  policyVersion: string;
  status: string;
  source: string;
  occurredAt: string;
}
interface ExportNotificationPreference {
  id: string;
  category: string;
  channel: string;
  enabled: number;
  contactMethodId: string | null;
  updatedAt: string;
}
export interface OwnAccountDataExport {
  schemaVersion: 1;
  scope: "ACCOUNT_DATA";
  account: ExportAccount;
  person: ExportPerson;
  contactMethods: ExportContact[];
  signupConsent: ExportSignupConsent | null;
  legalConsentEvents: ExportLegalConsent[];
  notificationPreferences: ExportNotificationPreference[];
}

/** A bounded own-account snapshot, not a full vehicle, organization or financial
 * export. Every projection is explicit: no authentication/credential/session data.
 * The atomic audit guard precedes all reads; D1 rolls the batch back on a failed
 * authority/size guard, so a revoked actor receives neither data nor a success audit. */
export async function exportOwnAccountData(
  db: D1Database,
  actor: { accountId: string; personId: string },
  requestId: string,
): Promise<OwnAccountDataExport> {
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${activeOwnAccount}`)
      .bind(actor.accountId, actor.personId)
      .first())
  )
    throw new Problem(
      403,
      "PRIVACY_EXPORT_FORBIDDEN",
      "Own active verified account required",
    );
  let results: D1Result[];
  try {
    results = await guardedBatch(
      db,
      [
        db
          .prepare(
            `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id)
        VALUES(?,?,CASE WHEN ${boundedCollections} THEN 'identity.privacy.account.exported' ELSE NULL END,'iam_account',CASE WHEN ${activeOwnAccount} THEN ? ELSE NULL END,?)`,
          )
          .bind(
            newId(),
            actor.accountId,
            actor.personId,
            actor.personId,
            actor.accountId,
            actor.accountId,
            actor.personId,
            actor.accountId,
            requestId,
          ),
        db
          .prepare(
            "SELECT id,status,created_at AS createdAt,updated_at AS updatedAt FROM iam_accounts WHERE id=? AND person_id=?",
          )
          .bind(actor.accountId, actor.personId),
        db
          .prepare(
            "SELECT id,status,given_name AS givenName,middle_name AS middleName,family_name AS familyName,second_family_name AS secondFamilyName,display_name AS displayName,preferred_locale AS preferredLocale,country_code AS countryCode,created_at AS createdAt,updated_at AS updatedAt FROM iam_people WHERE id=?",
          )
          .bind(actor.personId),
        db
          .prepare(
            "SELECT id,type,raw_value AS rawValue,normalized_value AS normalizedValue,label,is_primary AS isPrimary,verification_status AS verificationStatus,verified_at AS verifiedAt,source,created_at AS createdAt,updated_at AS updatedAt FROM iam_contact_methods WHERE person_id=? ORDER BY created_at,id LIMIT 500",
          )
          .bind(actor.personId),
        db
          .prepare(
            "SELECT terms_version AS termsVersion,privacy_version AS privacyVersion,accepted_at AS acceptedAt FROM iam_signup_consents WHERE auth_user_id=? LIMIT 1",
          )
          .bind(actor.accountId),
        db
          .prepare(
            "SELECT id,purpose,policy_version AS policyVersion,status,source,occurred_at AS occurredAt FROM iam_consent_events WHERE person_id=? AND purpose IN ('TERMS','PRIVACY') AND source='SIGNUP' ORDER BY occurred_at,id LIMIT 500",
          )
          .bind(actor.personId),
        db
          .prepare(
            "SELECT id,category,channel,enabled,contact_method_id AS contactMethodId,updated_at AS updatedAt FROM notification_preferences WHERE account_id=? ORDER BY category,channel,id LIMIT 500",
          )
          .bind(actor.accountId),
      ],
      {
        table: "governance_audit_events",
        column: "resource_id",
        code: "PRIVACY_EXPORT_AUTHORITY_CHANGED",
        message: "Account authority changed; authenticate and retry",
      },
    );
  } catch (error) {
    if (
      String(error).includes(
        "NOT NULL constraint failed: governance_audit_events.action",
      )
    )
      throw new Problem(
        413,
        "PRIVACY_EXPORT_COLLECTION_LIMIT",
        `Account export exceeds ${collectionLimit} records in a collection`,
      );
    throw error;
  }
  return {
    schemaVersion: 1,
    scope: "ACCOUNT_DATA",
    account: results[1]!.results[0] as unknown as ExportAccount,
    person: results[2]!.results[0] as unknown as ExportPerson,
    contactMethods: results[3]!.results as unknown as ExportContact[],
    signupConsent: (results[4]!.results[0] ??
      null) as ExportSignupConsent | null,
    legalConsentEvents: results[5]!.results as unknown as ExportLegalConsent[],
    notificationPreferences: results[6]!
      .results as unknown as ExportNotificationPreference[],
  };
}
