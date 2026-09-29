import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { assessAuthenticatedSession } from "@motorbaldi/auth";
import { buildIdempotencyScope } from "@motorbaldi/db/idempotency";
import {
  ensureMotorBaldiAccount,
  suspendAccount,
  resolveDuplicateCandidate,
} from "@motorbaldi/identity";
import { receiveLead, triageLead, createTag } from "@motorbaldi/crm";
import { requestVerificationInformation } from "@motorbaldi/organizations";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const bindings = env as unknown as ApiBindings;
const db = bindings.DB;
const accountId = "018f0000-0000-7000-8000-000000000901";
const otherId = "018f0000-0000-7000-8000-000000000902";
const sessionId = "targeted-session";
const enrollment = new Date(Date.now() - 60_000).toISOString();
const beforeEnrollment = new Date(Date.now() - 120_000).toISOString();
const afterEnrollment = new Date().toISOString();
let actor: { accountId: string; personId: string; mfaEnabled: boolean };
let other: typeof actor;

beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  for (const [id, email] of [
    [accountId, "targeted@example.test"],
    [otherId, "other-targeted@example.test"],
  ]) {
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled,updated_at) VALUES(?,'Targeted',?,1,1,?)",
      )
      .bind(id, email, enrollment)
      .run();
  }
  const first = await ensureMotorBaldiAccount(
    db,
    accountId,
    "targeted-provision",
  );
  const second = await ensureMotorBaldiAccount(
    db,
    otherId,
    "targeted-provision-other",
  );
  actor = { accountId, personId: first.personId, mfaEnabled: true };
  other = { accountId: otherId, personId: second.personId, mfaEnabled: false };
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    )
    .bind(actor.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(
      sessionId,
      accountId,
      "targeted-token",
      new Date(Date.now() + 3600_000).toISOString(),
      beforeEnrollment,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES('targeted-factor',?,'secret','[]',0)",
    )
    .bind(accountId)
    .run();
});

async function coordinator(
  operation: string,
  key: string,
  request: Record<string, unknown>,
  session = sessionId,
) {
  const scope = buildIdempotencyScope({ accountId, operation });
  const response = await bindings.IDEMPOTENCY_COORDINATOR.getByName(
    scope.scope + ":" + key,
  ).fetch("https://idempotency/run", {
    method: "POST",
    body: JSON.stringify({
      key,
      scope,
      request,
      requestId: key,
      sessionId: session,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("Phase 1 targeted security boundaries", () => {
  it("requires verified MFA and a post-enrollment session in both API assurance and sensitive coordinator commands", async () => {
    const merge = {
      sourceId: actor.personId,
      destinationId: actor.personId,
      reason: "Duplicate review",
    };
    const verification = {
      organizationId: other.personId,
      caseId: other.personId,
      reason: "Verification review",
    };
    expect(
      (await assessAuthenticatedSession(db, accountId, sessionId))?.mfaEnabled,
    ).toBe(false);
    expect(
      (
        await coordinator(
          "identity.person.merge",
          "targeted-merge-unverified",
          merge,
        )
      ).body.code,
    ).toBe("MFA_REQUIRED");
    await db
      .prepare(
        "UPDATE auth_two_factors SET verified=1 WHERE id='targeted-factor'",
      )
      .run();
    expect(
      (await assessAuthenticatedSession(db, accountId, sessionId))?.mfaEnabled,
    ).toBe(false);
    expect(
      (
        await coordinator(
          "organization.verification.approve",
          "targeted-verify-stale",
          verification,
        )
      ).body.code,
    ).toBe("MFA_REQUIRED");
    await db
      .prepare("UPDATE auth_sessions SET created_at=? WHERE id=?")
      .bind(afterEnrollment, sessionId)
      .run();
    expect(
      (await assessAuthenticatedSession(db, accountId, sessionId))?.mfaEnabled,
    ).toBe(true);
    expect(await assessAuthenticatedSession(db, otherId, sessionId)).toBeNull();
    expect(
      (
        await coordinator(
          "identity.person.merge",
          "targeted-merge-fresh",
          merge,
        )
      ).body.code,
    ).toBe("INVALID_PERSON_MERGE");
    expect(
      (
        await coordinator(
          "organization.verification.approve",
          "targeted-verify-fresh",
          verification,
        )
      ).body.code,
    ).toBe("ORGANIZATION_VERIFICATION_INVALID_STATE");
    const audit = await db
      .prepare(
        "SELECT count(*) AS n FROM governance_audit_events WHERE action IN ('identity.person.merged','organization.verification.approved')",
      )
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it("preserves idempotent replay without repeating organization creation", async () => {
    const request = {
      type: "WORKSHOP",
      legalName: "Targeted Replay",
      displayName: "Targeted Replay",
      countryCode: "US",
    };
    const first = await coordinator(
      "organization.create",
      "targeted-replay-key",
      request,
    );
    const replay = await coordinator(
      "organization.create",
      "targeted-replay-key",
      request,
    );
    expect(first.status).toBe(200);
    expect(replay.body).toMatchObject({
      organizationId: first.body.organizationId,
      replayed: true,
    });
    const count = await db
      .prepare(
        "SELECT count(*) AS n FROM org_organizations WHERE legal_name='Targeted Replay'",
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("denies direct privileged domain mutations without their permission or MFA", async () => {
    const leadId = await receiveLead(
      db,
      { email: "direct-denial@example.test" },
      "direct-denial-lead",
    );
    await expect(
      triageLead(db, leadId, other, "TRIAGED", "direct-denial-triage"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createTag(db, other, "DIRECT_DENY", "Denied"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      suspendAccount(
        db,
        other.accountId,
        { ...actor, mfaEnabled: false },
        "Review reason",
        "direct-denial-suspend",
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(
      requestVerificationInformation(
        db,
        { ...actor, mfaEnabled: false },
        other.personId,
        other.personId,
        "Review reason",
        "direct-denial-verification",
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(
      resolveDuplicateCandidate(
        db,
        { ...actor, mfaEnabled: false },
        other.personId,
        "DISMISSED",
        "Review reason",
        "direct-denial-duplicate",
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    const lead = await db
      .prepare("SELECT status FROM crm_lead_intakes WHERE id=?")
      .bind(leadId)
      .first<{ status: string }>();
    expect(lead?.status).toBe("RECEIVED");
  });
});
