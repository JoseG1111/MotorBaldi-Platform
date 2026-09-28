import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  ensureMotorBaldiAccount,
  mergePeople,
  addContact,
  suspendAccount,
} from "@motorbaldi/identity";
import { requireOrganizationPermission } from "@motorbaldi/authz";
import {
  createOrganization,
  createInvitation,
  acceptInvitation,
  createMembershipRequest,
  approveMembershipRequest,
  submitVerification,
  startVerificationReview,
  decideVerification,
  attachVerificationFile,
  addLocation,
  changeMembershipRoles,
  endMembership,
  workspaces,
  updateOrganization,
} from "@motorbaldi/organizations";
import {
  receiveLead,
  createPersonFromLead,
  convertLead,
} from "@motorbaldi/crm";
import {
  upsertMechanicProfile,
  setSpecialties,
  submitCredential,
  decideCredential,
} from "@motorbaldi/professional";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const ids = [
  "018f0000-0000-7000-8000-000000000101",
  "018f0000-0000-7000-8000-000000000102",
  "018f0000-0000-7000-8000-000000000103",
];
const principals = [] as {
  accountId: string;
  personId: string;
  mfaEnabled: boolean;
}[];
beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  for (let index = 0; index < ids.length; index++) {
    const accountId = ids[index]!;
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,?,?,?,?)",
      )
      .bind(accountId, `Person ${index}`, `person${index}@example.test`, 1, 1)
      .run();
    const account = await ensureMotorBaldiAccount(
      db,
      accountId,
      `provision-${index}`,
    );
    principals.push({
      accountId,
      personId: account.personId,
      mfaEnabled: true,
    });
  }
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-verification')",
    )
    .bind(principals[2]!.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin'),(?,'platform-crm')",
    )
    .bind(principals[2]!.personId, principals[1]!.personId)
    .run();
});

describe("Phase 1 domain integration", () => {
  let orgA: string, orgB: string;
  it("provisions people separately from accounts without duplicates", async () => {
    const again = await ensureMotorBaldiAccount(db, ids[0]!, "provision-again");
    expect(again.created).toBe(false);
    expect(again.personId).toBe(principals[0]!.personId);
    const count = await db
      .prepare("SELECT count(*) AS n FROM iam_people")
      .first<{ n: number }>();
    expect(count?.n).toBe(3);
  });
  it("suspends business access with one audit and one security event", async () => {
    const accountId = "018f0000-0000-7000-8000-000000000104";
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
      )
      .bind(accountId, "Suspension Test", "suspended@example.test")
      .run();
    await ensureMotorBaldiAccount(db, accountId, "suspension-provision");
    await suspendAccount(
      db,
      accountId,
      principals[2]!.accountId,
      "Policy review",
      "suspend-once",
    );
    await expect(
      ensureMotorBaldiAccount(db, accountId, "suspension-login"),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED" });
    await expect(
      suspendAccount(
        db,
        accountId,
        principals[2]!.accountId,
        "Policy review",
        "suspend-again",
      ),
    ).rejects.toBeTruthy();
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM governance_audit_events WHERE action='identity.account.suspended' AND resource_id=?",
          )
          .bind(accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM governance_security_events WHERE code='ACCOUNT_SUSPENDED' AND actor_id=?",
          )
          .bind(principals[2]!.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("creates organizations with owner memberships and tenant permissions", async () => {
    const a = await createOrganization(
      db,
      principals[0]!,
      {
        type: "WORKSHOP",
        legalName: "Workshop A",
        displayName: "Workshop A",
        countryCode: "US",
      },
      "org-a",
    );
    const b = await createOrganization(
      db,
      principals[1]!,
      {
        type: "WORKSHOP",
        legalName: "Workshop B",
        displayName: "Workshop B",
        countryCode: "US",
      },
      "org-b",
    );
    orgA = a.organizationId;
    orgB = b.organizationId;
    expect(
      (await workspaces(db, principals[0]!.personId)).map((w) => w.id),
    ).toContain(orgA);
    await expect(
      requireOrganizationPermission(
        db,
        principals[0]!,
        orgB,
        "org.member.read",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      db
        .prepare(
          "UPDATE org_memberships SET status='ENDED',valid_to=? WHERE id=?",
        )
        .bind(new Date().toISOString(), a.membershipId)
        .run(),
    ).rejects.toThrow(/LAST_OWNER_REQUIRED/);
    await expect(
      updateOrganization(
        db,
        principals[0]!,
        orgA,
        { legalName: "Stale", displayName: "Stale", version: 99 },
        "stale-organization-update",
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const failedAudit = await db
      .prepare(
        "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
      )
      .bind("stale-organization-update")
      .first<{ n: number }>();
    expect(failedAudit?.n).toBe(0);
  });
  it("accepts invitations once and checks verified email", async () => {
    const invitation = await createInvitation(
      db,
      principals[0]!,
      orgA,
      "person1@example.test",
      ["MECHANIC"],
      { type: "ALL_LOCATIONS", locationIds: [] },
      "invite-a",
    );
    await expect(
      acceptInvitation(db, principals[2]!, invitation.token, "wrong-email"),
    ).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });
    const accepted = await acceptInvitation(
      db,
      principals[1]!,
      invitation.token,
      "accept-a",
    );
    expect(accepted.accepted).toBe(true);
    expect(
      (await acceptInvitation(db, principals[1]!, invitation.token, "repeat-a"))
        .accepted,
    ).toBe(true);
    await expect(
      requireOrganizationPermission(
        db,
        principals[1]!,
        orgA,
        "org.owner.manage",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("approves only a same-organization membership request", async () => {
    const requestId = await createMembershipRequest(
      db,
      principals[2]!,
      orgA,
      ["MECHANIC", "INSPECTOR"],
      { type: "ALL_LOCATIONS", locationIds: [] },
      "I would like to join",
      "membership-request",
    );
    await expect(
      approveMembershipRequest(
        db,
        principals[1]!,
        orgA,
        requestId,
        "cross-org",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await approveMembershipRequest(
      db,
      principals[0]!,
      orgA,
      requestId,
      "approve-request",
    );
    await approveMembershipRequest(
      db,
      principals[0]!,
      orgA,
      requestId,
      "approve-repeat",
    );
    await expect(
      requireOrganizationPermission(
        db,
        principals[2]!,
        orgA,
        "org.owner.manage",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const roleCount = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM org_membership_roles mr JOIN org_memberships m ON m.id=mr.membership_id WHERE m.organization_id=? AND m.person_id=?",
      )
      .bind(orgA, principals[2]!.personId)
      .first<{ n: number }>();
    expect(roleCount?.n).toBe(2);
  });
  it("keeps mechanic profiles independent and restricts credential review to staff", async () => {
    const personId = principals[2]!.personId;
    expect(
      await upsertMechanicProfile(db, personId, {
        bio: "Experienced technician",
        yearsExperience: 5,
      }),
    ).toBe(1);
    await setSpecialties(db, personId, ["BRAKES", "DIAGNOSTICS"]);
    const otherFileId = "018f0000-0000-7000-8000-000000000299";
    await db
      .prepare(
        "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,active_key,declared_mime,size_bytes,sha256,status,request_id) VALUES(?,?,'quarantine/other-professional','active/other-professional','application/pdf',8,?,'ACTIVE','credential-owner-test')",
      )
      .bind(otherFileId, principals[0]!.accountId, "b".repeat(64))
      .run();
    await expect(
      submitCredential(
        db,
        personId,
        {
          credentialType: "TRAINING",
          issuer: "Training body",
          evidenceFileId: otherFileId,
        },
        "cross-person-evidence",
      ),
    ).rejects.toMatchObject({ code: "FILE_NOT_ACTIVE" });
    const credentialId = await submitCredential(
      db,
      personId,
      { credentialType: "TRAINING", issuer: "Training body" },
      "credential-submit",
    );
    await expect(
      decideCredential(
        db,
        principals[0]!,
        credentialId,
        "VERIFIED",
        "Reviewed evidence",
        "owner-attempt",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      decideCredential(
        db,
        { ...principals[2]!, mfaEnabled: false },
        credentialId,
        "VERIFIED",
        "Reviewed evidence",
        "no-factor",
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await decideCredential(
      db,
      principals[2]!,
      credentialId,
      "VERIFIED",
      "Reviewed evidence",
      "staff-review",
    );
    const profile = await db
      .prepare(
        "SELECT professional_status FROM professional_mechanic_profiles WHERE person_id=?",
      )
      .bind(personId)
      .first<{ professional_status: string }>();
    expect(profile?.professional_status).toBe("ACTIVE");
  });
  it("enforces selected locations and protects the final owner", async () => {
    const selected = await addLocation(
      db,
      principals[1]!,
      orgB,
      {
        name: "North",
        locationType: "BRANCH",
        countryCode: "US",
        administrativeArea: "State",
        city: "North City",
        addressLine1: "1 North Street",
      },
      "north-location",
    );
    const denied = await addLocation(
      db,
      principals[1]!,
      orgB,
      {
        name: "South",
        locationType: "BRANCH",
        countryCode: "US",
        administrativeArea: "State",
        city: "South City",
        addressLine1: "2 South Street",
      },
      "south-location",
    );
    const requestId = await createMembershipRequest(
      db,
      principals[2]!,
      orgB,
      ["VIEWER"],
      { type: "SELECTED_LOCATIONS", locationIds: [selected] },
      undefined,
      "selected-request",
    );
    await approveMembershipRequest(
      db,
      principals[1]!,
      orgB,
      requestId,
      "selected-approval",
    );
    await expect(
      requireOrganizationPermission(
        db,
        principals[2]!,
        orgB,
        "org.read",
        denied,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      requireOrganizationPermission(
        db,
        principals[2]!,
        orgB,
        "org.read",
        selected,
      ),
    ).resolves.toBeTypeOf("string");
    const membership = await db
      .prepare(
        "SELECT id FROM org_memberships WHERE organization_id=? AND person_id=? AND status='ACTIVE'",
      )
      .bind(orgB, principals[2]!.personId)
      .first<{ id: string }>();
    await changeMembershipRoles(
      db,
      principals[1]!,
      orgB,
      membership!.id,
      ["OWNER"],
      "grant-owner",
    );
    const original = await db
      .prepare(
        "SELECT id FROM org_memberships WHERE organization_id=? AND person_id=? AND status='ACTIVE'",
      )
      .bind(orgB, principals[1]!.personId)
      .first<{ id: string }>();
    await endMembership(
      db,
      principals[1]!,
      orgB,
      original!.id,
      "owner-offboard",
    );
    await expect(
      endMembership(
        db,
        principals[2]!,
        orgB,
        membership!.id,
        "last-owner-attempt",
      ),
    ).rejects.toMatchObject({ code: "LAST_OWNER_REQUIRED" });
  });
  it("keeps verification decisions for platform staff with MFA", async () => {
    const caseId = await submitVerification(
      db,
      principals[0]!,
      orgA,
      "submit-a",
    );
    await expect(
      decideVerification(
        db,
        principals[0]!,
        orgA,
        caseId,
        "VERIFIED",
        "Reviewed",
        "owner-verify",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const fileId = "018f0000-0000-7000-8000-000000000201";
    await db
      .prepare(
        "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,active_key,declared_mime,size_bytes,sha256,status,request_id) VALUES(?,?,'quarantine/phase1','active/phase1','application/pdf',8,?,'ACTIVE','evidence-test')",
      )
      .bind(fileId, principals[0]!.accountId, "a".repeat(64))
      .run();
    await expect(
      attachVerificationFile(
        db,
        principals[1]!,
        orgA,
        caseId,
        fileId,
        "cross-org-evidence",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const otherFileId = "018f0000-0000-7000-8000-000000000202";
    await db
      .prepare(
        "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,active_key,declared_mime,size_bytes,sha256,status,request_id) VALUES(?,?,'quarantine/other-org','active/other-org','application/pdf',8,?,'ACTIVE','other-evidence-test')",
      )
      .bind(otherFileId, principals[1]!.accountId, "b".repeat(64))
      .run();
    await expect(
      attachVerificationFile(
        db,
        principals[0]!,
        orgA,
        caseId,
        otherFileId,
        "foreign-file-evidence",
      ),
    ).rejects.toMatchObject({ code: "FILE_NOT_ACTIVE" });
    await attachVerificationFile(
      db,
      principals[0]!,
      orgA,
      caseId,
      fileId,
      "attach-evidence",
    );
    const linked = await db
      .prepare(
        "SELECT 1 FROM org_verification_files WHERE case_id=? AND file_id=?",
      )
      .bind(caseId, fileId)
      .first();
    expect(linked).toBeTruthy();
    await startVerificationReview(db, principals[2]!, orgA, caseId, "review-a");
    await expect(
      decideVerification(
        db,
        { ...principals[2]!, mfaEnabled: false },
        orgA,
        caseId,
        "VERIFIED",
        "Reviewed",
        "no-mfa",
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await decideVerification(
      db,
      principals[2]!,
      orgA,
      caseId,
      "VERIFIED",
      "Reviewed",
      "verify-a",
    );
    const org = await db
      .prepare("SELECT verification_status FROM org_organizations WHERE id=?")
      .bind(orgA)
      .first<{ verification_status: string }>();
    expect(org?.verification_status).toBe("VERIFIED");
  });
  it("records an anonymous lead, creates a provisional person, and converts once", async () => {
    const leadId = await receiveLead(
      db,
      { email: "new@example.test", givenName: "New", familyName: "Lead" },
      "lead-one",
    );
    const personId = await createPersonFromLead(
      db,
      leadId,
      principals[2]!.personId,
      "triage-one",
    );
    const opportunityId = await convertLead(
      db,
      leadId,
      principals[2]!.personId,
      "customer-acquisition",
      "customer-new",
      "New lead",
      "convert-one",
    );
    expect(
      await convertLead(
        db,
        leadId,
        principals[2]!.personId,
        "customer-acquisition",
        "customer-new",
        "New lead",
        "convert-repeat",
      ),
    ).toBe(opportunityId);
    const person = await db
      .prepare("SELECT status FROM iam_people WHERE id=?")
      .bind(personId)
      .first<{ status: string }>();
    expect(person?.status).toBe("PROVISIONAL");
  });
  it("does not leave a second provisional person when reviewers race", async () => {
    const leadId = await receiveLead(
      db,
      {
        email: "race@example.test",
        givenName: "Race",
        familyName: "Candidate",
      },
      "lead-race",
    );
    const before = (await db
      .prepare("SELECT count(*) AS n FROM iam_people")
      .first<{ n: number }>())!.n;
    const attempts = await Promise.allSettled([
      createPersonFromLead(db, leadId, principals[2]!.personId, "race-a"),
      createPersonFromLead(db, leadId, principals[2]!.personId, "race-b"),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM iam_people")
          .first<{ n: number }>()
      )?.n,
    ).toBe(before + 1);
    const lead = await db
      .prepare("SELECT person_id FROM crm_lead_intakes WHERE id=?")
      .bind(leadId)
      .first<{ person_id: string }>();
    expect(lead?.person_id).toBe(
      (
        attempts.find(
          (result) => result.status === "fulfilled",
        ) as PromiseFulfilledResult<string>
      ).value,
    );
  });
  it("preserves references when merging people", async () => {
    const leadId = await receiveLead(
      db,
      { email: "duplicate@example.test" },
      "duplicate-lead",
    );
    const source = await createPersonFromLead(
      db,
      leadId,
      principals[2]!.personId,
      "duplicate-triage",
    );
    await addContact(
      db,
      source,
      "EMAIL",
      "duplicate@example.test",
      "CRM_REVIEW",
    );
    const sourceMembership = "018f0000-0000-7000-8000-000000000401";
    await db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
      )
      .bind(sourceMembership, orgB, source)
      .run();
    await db
      .prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-viewer')",
      )
      .bind(sourceMembership)
      .run();
    await upsertMechanicProfile(db, source, { bio: "Independent technician" });
    const sourceCredential = await submitCredential(
      db,
      source,
      { credentialType: "TRAINING", issuer: "Training body" },
      "source-credential",
    );
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-support')",
      )
      .bind(source)
      .run();
    await expect(
      mergePeople(
        db,
        source,
        principals[0]!.personId,
        principals[1]!,
        "Manual review",
        "merge-denied",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      mergePeople(
        db,
        source,
        principals[0]!.personId,
        { ...principals[2]!, mfaEnabled: false },
        "Manual review",
        "merge-no-mfa",
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await mergePeople(
      db,
      source,
      principals[0]!.personId,
      principals[2]!,
      "Manual review",
      "merge-one",
    );
    await mergePeople(
      db,
      source,
      principals[0]!.personId,
      principals[2]!,
      "Manual review",
      "merge-repeat",
    );
    const lead = await db
      .prepare("SELECT person_id FROM crm_lead_intakes WHERE id=?")
      .bind(leadId)
      .first<{ person_id: string }>();
    expect(lead?.person_id).toBe(principals[0]!.personId);
    expect(
      (
        await db
          .prepare("SELECT person_id FROM org_memberships WHERE id=?")
          .bind(sourceMembership)
          .first<{ person_id: string }>()
      )?.person_id,
    ).toBe(principals[0]!.personId);
    const inheritedStaffRole = await db
      .prepare(
        "SELECT 1 FROM platform_person_roles WHERE person_id=? AND role_id='platform-support'",
      )
      .bind(principals[0]!.personId)
      .first();
    expect(inheritedStaffRole).toBeNull();
    expect(
      (
        await db
          .prepare("SELECT person_id FROM professional_credentials WHERE id=?")
          .bind(sourceCredential)
          .first<{ person_id: string }>()
      )?.person_id,
    ).toBe(principals[0]!.personId);
    expect(
      (
        await db
          .prepare(
            "SELECT person_id FROM iam_contact_methods WHERE normalized_value='duplicate@example.test'",
          )
          .first<{ person_id: string }>()
      )?.person_id,
    ).toBe(principals[0]!.personId);
  });
});
