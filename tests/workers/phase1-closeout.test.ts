import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  ensureMotorBaldiAccount,
  mergePeople,
  reconcileVerifiedAccounts,
  resolveDuplicateCandidate,
  suspendAccount,
} from "@motorbaldi/identity";
import {
  createOrganization,
  createInvitation,
  createMembershipRequest,
  approveMembershipRequest,
  expireInvitations,
  expireMembershipRequests,
  submitVerification,
  startVerificationReview,
  decideVerification,
  requestVerificationInformation,
} from "@motorbaldi/organizations";
import {
  receiveLead,
  createPersonFromLead,
  moveOpportunityStage,
  triageLead,
  createTask,
  assignLead,
} from "@motorbaldi/crm";
import {
  upsertMechanicProfile,
  submitCredential,
  decideCredential,
  expireCredentials,
} from "@motorbaldi/professional";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const accountIds = [
  "018f0000-0000-7000-8000-000000000401",
  "018f0000-0000-7000-8000-000000000402",
  "018f0000-0000-7000-8000-000000000403",
];
const actors: { accountId: string; personId: string; mfaEnabled: boolean }[] =
  [];
let organizationId: string;
beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  for (let i = 0; i < accountIds.length; i++) {
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
      )
      .bind(accountIds[i], `Closeout ${i}`, `closeout${i}@example.test`)
      .run();
    const account = await ensureMotorBaldiAccount(
      db,
      accountIds[i]!,
      `closeout-provision-${i}`,
    );
    actors.push({
      accountId: account.accountId,
      personId: account.personId,
      mfaEnabled: true,
    });
  }
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin'),(?,'platform-crm')",
    )
    .bind(actors[0]!.personId, actors[2]!.personId)
    .run();
  organizationId = (
    await createOrganization(
      db,
      actors[0]!,
      {
        type: "WORKSHOP",
        legalName: "Closeout Shop",
        displayName: "Closeout Shop",
        countryCode: "US",
      },
      "closeout-org",
    )
  ).organizationId;
  const membershipId = "018f0000-0000-7000-8000-000000000404";
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
      )
      .bind(membershipId, organizationId, actors[1]!.personId),
    db
      .prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-admin')",
      )
      .bind(membershipId),
  ]);
});

describe("Phase 1.1 closeout", () => {
  it("upgrades the fresh schema and grants ADMIN only non-owner role management", async () => {
    const grant = await db
      .prepare(
        "SELECT 1 FROM authz_role_permissions WHERE role_id='org-admin' AND permission_code='org.member.role.manage'",
      )
      .first();
    expect(grant).toBeTruthy();
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='org-admin' AND permission_code='org.member.role.manage'",
      )
      .run();
    await expect(
      createInvitation(
        db,
        actors[1]!,
        organizationId,
        "invite@example.test",
        ["MECHANIC"],
        { type: "ALL_LOCATIONS", locationIds: [] },
        "grant-denied",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const requestId = await createMembershipRequest(
      db,
      actors[2]!,
      organizationId,
      ["MECHANIC"],
      { type: "ALL_LOCATIONS", locationIds: [] },
      undefined,
      "role-request",
    );
    await expect(
      approveMembershipRequest(
        db,
        actors[1]!,
        organizationId,
        requestId,
        "approval-denied",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db
      .prepare(
        "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('org-admin','org.member.role.manage')",
      )
      .run();
    const invitation = await createInvitation(
      db,
      actors[1]!,
      organizationId,
      "invite@example.test",
      ["MECHANIC"],
      { type: "ALL_LOCATIONS", locationIds: [] },
      "grant-allowed",
    );
    expect(invitation.invitationId).toBeTruthy();
    await expect(
      createInvitation(
        db,
        actors[1]!,
        organizationId,
        "owner@example.test",
        ["OWNER"],
        { type: "ALL_LOCATIONS", locationIds: [] },
        "owner-denied",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await approveMembershipRequest(
      db,
      actors[1]!,
      organizationId,
      requestId,
      "approval-allowed",
    );
  });

  it("only permits mechanic and inspector self-requests", async () => {
    for (const role of [
      "OWNER",
      "ADMIN",
      "FINANCE",
      "SERVICE_ADVISOR",
      "VIEWER",
    ])
      await expect(
        createMembershipRequest(
          db,
          actors[2]!,
          organizationId,
          [role],
          { type: "ALL_LOCATIONS", locationIds: [] },
          undefined,
          `forbidden-${role}`,
        ),
      ).rejects.toMatchObject({ code: "SELF_REQUEST_ROLE_FORBIDDEN" });
    // A different organization keeps this actor eligible for a positive request.
    const second = (
      await createOrganization(
        db,
        actors[0]!,
        {
          type: "WORKSHOP",
          legalName: "Second Shop",
          displayName: "Second Shop",
          countryCode: "US",
        },
        "second-shop",
      )
    ).organizationId;
    expect(
      await createMembershipRequest(
        db,
        actors[2]!,
        second,
        ["MECHANIC"],
        { type: "ALL_LOCATIONS", locationIds: [] },
        undefined,
        "mechanic-request",
      ),
    ).toBeTruthy();
    expect(
      await createMembershipRequest(
        db,
        actors[2]!,
        second,
        ["MECHANIC", "INSPECTOR"],
        { type: "ALL_LOCATIONS", locationIds: [] },
        undefined,
        "both-request",
      ),
    ).toBeTruthy();
  });

  it("maps invalid guarded transitions to stable business errors without side effects", async () => {
    await expect(
      suspendAccount(
        db,
        "018f0000-0000-7000-8000-000000000499",
        actors[0]!,
        "Missing account",
        "suspend-invalid",
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_INVALID_STATE" });
    await expect(
      triageLead(
        db,
        "018f0000-0000-7000-8000-000000000499",
        actors[0]!,
        "TRIAGED",
        "triage-invalid",
      ),
    ).rejects.toMatchObject({ code: "CRM_LEAD_INVALID_STATE" });
    await expect(
      moveOpportunityStage(
        db,
        "018f0000-0000-7000-8000-000000000499",
        "customer-contacted",
        1,
        actors[0]!,
        "stage-invalid",
      ),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_INVALID_STATE" });
    await expect(
      decideCredential(
        db,
        actors[0]!,
        "018f0000-0000-7000-8000-000000000499",
        "VERIFIED",
        "Review",
        "credential-invalid",
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID_STATE" });
    await expect(
      startVerificationReview(
        db,
        actors[0]!,
        organizationId,
        "018f0000-0000-7000-8000-000000000499",
        "review-invalid",
      ),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
    });
    const count = await db
      .prepare(
        "SELECT count(*) AS n FROM governance_audit_events WHERE request_id IN ('triage-invalid','stage-invalid','credential-invalid','review-invalid')",
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    const leadId = await receiveLead(
      db,
      { email: "triage-state@example.test" },
      "triage-state-lead",
    );
    await triageLead(db, leadId, actors[0]!, "TRIAGED", "triage-valid");
    await expect(
      triageLead(db, leadId, actors[0]!, "TRIAGED", "triage-repeat"),
    ).rejects.toMatchObject({ code: "CRM_LEAD_INVALID_STATE" });
    const caseId = await submitVerification(
      db,
      actors[0]!,
      organizationId,
      "verification-submit",
    );
    await expect(
      submitVerification(
        db,
        actors[0]!,
        organizationId,
        "verification-repeat-submit",
      ),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
    });
    await expect(
      decideVerification(
        db,
        actors[0]!,
        organizationId,
        caseId,
        "VERIFIED",
        "Premature",
        "verification-premature",
      ),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
    });
    await expect(
      requestVerificationInformation(
        db,
        actors[0]!,
        organizationId,
        caseId,
        "Premature",
        "verification-premature-info",
      ),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
    });
    await startVerificationReview(
      db,
      actors[0]!,
      organizationId,
      caseId,
      "verification-start",
    );
    await expect(
      startVerificationReview(
        db,
        actors[0]!,
        organizationId,
        caseId,
        "verification-repeat-start",
      ),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
    });
    await decideVerification(
      db,
      actors[0]!,
      organizationId,
      caseId,
      "VERIFIED",
      "Reviewed",
      "verification-valid",
    );
    await expect(
      decideVerification(
        db,
        actors[0]!,
        organizationId,
        caseId,
        "VERIFIED",
        "Reviewed again",
        "verification-repeat-decision",
      ),
    ).rejects.toMatchObject({
      code: "ORGANIZATION_VERIFICATION_INVALID_STATE",
    });
    await upsertMechanicProfile(db, actors[0]!.personId, { bio: "Reviewer" });
    const credentialId = await submitCredential(
      db,
      actors[0]!.personId,
      { credentialType: "TRAINING", issuer: "School" },
      "credential-state",
    );
    await decideCredential(
      db,
      actors[0]!,
      credentialId,
      "VERIFIED",
      "Reviewed",
      "credential-valid",
    );
    await expect(
      decideCredential(
        db,
        actors[0]!,
        credentialId,
        "VERIFIED",
        "Reviewed again",
        "credential-repeat",
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID_STATE" });
  });

  it("closes terminal opportunities and preserves optimistic concurrency", async () => {
    for (const [suffix, terminal] of [
      ["1", "customer-activated"],
      ["2", "customer-lost"],
    ] as const) {
      const id = `018f0000-0000-7000-8000-00000000041${suffix}`;
      await db
        .prepare(
          "INSERT INTO crm_opportunities(id,pipeline_id,stage_id,title,status) VALUES(?,'customer-acquisition','customer-new','Closeout opportunity','OPEN')",
        )
        .bind(id)
        .run();
      await moveOpportunityStage(
        db,
        id,
        "customer-contacted",
        1,
        actors[0]!,
        `normal-${suffix}`,
      );
      const open = await db
        .prepare("SELECT status,closed_at FROM crm_opportunities WHERE id=?")
        .bind(id)
        .first<{ status: string; closed_at: string | null }>();
      expect(open).toMatchObject({ status: "OPEN", closed_at: null });
      await expect(
        moveOpportunityStage(
          db,
          id,
          "workshop-active",
          2,
          actors[0]!,
          `wrong-pipeline-${suffix}`,
        ),
      ).rejects.toMatchObject({ code: "INVALID_OPPORTUNITY_STAGE" });
      await expect(
        moveOpportunityStage(
          db,
          id,
          terminal,
          1,
          actors[0]!,
          `stale-${suffix}`,
        ),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      await moveOpportunityStage(
        db,
        id,
        terminal,
        2,
        actors[0]!,
        `terminal-${suffix}`,
      );
      const closed = await db
        .prepare("SELECT status,closed_at FROM crm_opportunities WHERE id=?")
        .bind(id)
        .first<{ status: string; closed_at: string | null }>();
      expect(closed?.status).toBe(
        terminal === "customer-activated" ? "WON" : "LOST",
      );
      expect(closed?.closed_at).toBeTruthy();
      await expect(
        moveOpportunityStage(
          db,
          id,
          "customer-contacted",
          3,
          actors[0]!,
          `reopen-${suffix}`,
        ),
      ).rejects.toMatchObject({ code: "OPPORTUNITY_INVALID_STATE" });
    }
  });

  it("creates duplicate candidates from CRM contact evidence and resolves them without merging", async () => {
    const leadId = await receiveLead(
      db,
      { email: "duplicate-closeout@example.test", givenName: "Duplicate" },
      "duplicate-lead",
    );
    const provisional = await createPersonFromLead(
      db,
      leadId,
      actors[0]!,
      "duplicate-person",
    );
    const contact = await db
      .prepare(
        "SELECT verification_status,source FROM iam_contact_methods WHERE person_id=?",
      )
      .bind(provisional)
      .first();
    expect(contact).toMatchObject({
      verification_status: "UNVERIFIED",
      source: "CRM_LEAD",
    });
    const accountId = "018f0000-0000-7000-8000-000000000405";
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Duplicate Person','duplicate-closeout@example.test',1)",
      )
      .bind(accountId)
      .run();
    const provisioned = await ensureMotorBaldiAccount(
      db,
      accountId,
      "duplicate-provision",
    );
    await ensureMotorBaldiAccount(db, accountId, "duplicate-reconcile");
    const candidate = await db
      .prepare(
        "SELECT id,status,reason FROM iam_duplicate_candidates WHERE source_person_id=? AND destination_person_id=?",
      )
      .bind(provisioned.personId, provisional)
      .first<{ id: string; status: string; reason: string }>();
    expect(candidate).toMatchObject({
      status: "OPEN",
      reason: "SAME_NORMALIZED_EMAIL",
    });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM iam_duplicate_candidates WHERE source_person_id=? AND destination_person_id=?",
          )
          .bind(provisioned.personId, provisional)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await expect(
      resolveDuplicateCandidate(
        db,
        actors[1]!,
        candidate!.id,
        "DISMISSED",
        "Reviewed separately",
        "duplicate-unauthorized",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await resolveDuplicateCandidate(
      db,
      actors[0]!,
      candidate!.id,
      "NOT_DUPLICATE",
      "Distinct people confirmed",
      "duplicate-resolved",
    );
    await expect(
      resolveDuplicateCandidate(
        db,
        actors[0]!,
        candidate!.id,
        "DISMISSED",
        "Again",
        "duplicate-repeat",
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_CANDIDATE_INVALID_STATE" });
    const row = await db
      .prepare(
        "SELECT status,reviewed_by_person_id,reviewed_at FROM iam_duplicate_candidates WHERE id=?",
      )
      .bind(candidate!.id)
      .first();
    expect(row).toMatchObject({
      status: "NOT_DUPLICATE",
      reviewed_by_person_id: actors[0]!.personId,
    });
    const existingAccountId = "018f0000-0000-7000-8000-000000000406";
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Existing Person','later-match@example.test',1)",
      )
      .bind(existingAccountId)
      .run();
    const existing = await ensureMotorBaldiAccount(
      db,
      existingAccountId,
      "existing-before-lead",
    );
    const laterLead = await receiveLead(
      db,
      { email: "later-match@example.test" },
      "later-lead",
    );
    const laterPerson = await createPersonFromLead(
      db,
      laterLead,
      actors[0]!,
      "later-person",
    );
    expect(
      await reconcileVerifiedAccounts(db, "later-reconcile"),
    ).toBeGreaterThan(0);
    expect(
      await db
        .prepare(
          "SELECT 1 FROM iam_duplicate_candidates WHERE source_person_id=? AND destination_person_id=? AND status='OPEN'",
        )
        .bind(existing.personId, laterPerson)
        .first(),
    ).toBeTruthy();
    const verifiedLead = await receiveLead(
      db,
      { email: "verified-match@example.test" },
      "verified-match-lead",
    );
    const verifiedPerson = await createPersonFromLead(
      db,
      verifiedLead,
      actors[0]!,
      "verified-match-person",
    );
    await db
      .prepare(
        "UPDATE iam_contact_methods SET verification_status='VERIFIED',verified_at='2026-01-01T00:00:00.000Z' WHERE person_id=? AND type='EMAIL'",
      )
      .bind(verifiedPerson)
      .run();
    const verifiedAccountId = "018f0000-0000-7000-8000-000000000407";
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Verified Match','verified-match@example.test',1)",
      )
      .bind(verifiedAccountId)
      .run();
    const verifiedAccount = await ensureMotorBaldiAccount(
      db,
      verifiedAccountId,
      "verified-match-provision",
    );
    expect(
      await db
        .prepare(
          "SELECT 1 FROM iam_duplicate_candidates WHERE source_person_id=? AND destination_person_id=? AND reason='SAME_VERIFIED_EMAIL'",
        )
        .bind(verifiedAccount.personId, verifiedPerson)
        .first(),
    ).toBeTruthy();
    await mergePeople(
      db,
      verifiedPerson,
      verifiedAccount.personId,
      actors[0]!,
      "Verified identity reviewed",
      "verified-match-merge",
    );
    expect(
      (
        await db
          .prepare(
            "SELECT status FROM iam_duplicate_candidates WHERE source_person_id=? AND destination_person_id=?",
          )
          .bind(verifiedAccount.personId, verifiedPerson)
          .first<{ status: string }>()
      )?.status,
    ).toBe("MERGED");
  });

  it("expires only eligible Phase 1 records and is safe to repeat", async () => {
    const invitation = await createInvitation(
      db,
      actors[0]!,
      organizationId,
      "expiry@example.test",
      ["MECHANIC"],
      { type: "ALL_LOCATIONS", locationIds: [] },
      "expiry-invite",
    );
    await db
      .prepare(
        "UPDATE org_invitations SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(invitation.invitationId)
      .run();
    const org = (
      await createOrganization(
        db,
        actors[1]!,
        {
          type: "WORKSHOP",
          legalName: "Expiry Shop",
          displayName: "Expiry Shop",
          countryCode: "US",
        },
        "expiry-shop",
      )
    ).organizationId;
    const requestId = await createMembershipRequest(
      db,
      actors[0]!,
      org,
      ["MECHANIC"],
      { type: "ALL_LOCATIONS", locationIds: [] },
      undefined,
      "expiry-request",
    );
    await db
      .prepare(
        "UPDATE org_membership_requests SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(requestId)
      .run();
    await upsertMechanicProfile(db, actors[1]!.personId, { bio: "Mechanic" });
    const past = await submitCredential(
      db,
      actors[1]!.personId,
      {
        credentialType: "TRAINING",
        issuer: "School",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
      "expiry-credential",
    );
    await db
      .prepare(
        "UPDATE professional_credentials SET status='VERIFIED' WHERE id=?",
      )
      .bind(past)
      .run();
    const future = await submitCredential(
      db,
      actors[1]!.personId,
      {
        credentialType: "TRAINING",
        issuer: "School",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      "future-credential",
    );
    expect(await expireInvitations(db)).toBeGreaterThan(0);
    expect(await expireMembershipRequests(db)).toBeGreaterThan(0);
    expect(await expireCredentials(db)).toBeGreaterThan(0);
    expect(await expireInvitations(db)).toBe(0);
    expect(await expireMembershipRequests(db)).toBe(0);
    expect(await expireCredentials(db)).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT status FROM org_invitations WHERE id=?")
          .bind(invitation.invitationId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("EXPIRED");
    expect(
      (
        await db
          .prepare("SELECT status FROM org_membership_requests WHERE id=?")
          .bind(requestId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("EXPIRED");
    expect(
      (
        await db
          .prepare("SELECT status FROM professional_credentials WHERE id=?")
          .bind(past)
          .first<{ status: string }>()
      )?.status,
    ).toBe("EXPIRED");
    expect(
      (
        await db
          .prepare("SELECT status FROM professional_credentials WHERE id=?")
          .bind(future)
          .first<{ status: string }>()
      )?.status,
    ).toBe("PENDING");
  });

  it("does not assign new CRM work to suspended staff", async () => {
    const leadId = await receiveLead(
      db,
      { email: "assignment@example.test" },
      "assignment-lead",
    );
    await createTask(
      db,
      actors[0]!,
      {
        ownerPersonId: actors[2]!.personId,
        description: "Active assignment",
        priority: "NORMAL",
      },
      "active-assignment",
    );
    await suspendAccount(
      db,
      actors[2]!.accountId,
      actors[0]!,
      "Suspended",
      "crm-suspension",
    );
    await expect(
      createTask(
        db,
        actors[0]!,
        {
          ownerPersonId: actors[2]!.personId,
          description: "Denied assignment",
          priority: "NORMAL",
        },
        "denied-assignment",
      ),
    ).rejects.toMatchObject({ code: "INVALID_CRM_ASSIGNEE" });
    await expect(
      assignLead(
        db,
        actors[0]!,
        leadId,
        actors[2]!.personId,
        "denied-lead-assignment",
      ),
    ).rejects.toMatchObject({ code: "INVALID_CRM_ASSIGNEE" });
  });
});
