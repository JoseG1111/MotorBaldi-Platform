import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount, mergePeople } from "@motorbaldi/identity";
import {
  acceptInvitation,
  approveMembershipRequest,
  cancelMembershipRequest,
  createInvitation,
  createMembershipRequest,
  createOrganization,
  endMembership,
  expireInvitations,
  expireMembershipRequests,
  rejectMembershipRequest,
  revokeInvitation,
  suspendOrganization,
} from "@motorbaldi/organizations";
import {
  convertLead,
  createPersonFromLead,
  receiveLead,
} from "@motorbaldi/crm";
import {
  decideCredential,
  expireCredentials,
  submitCredential,
  upsertMechanicProfile,
} from "@motorbaldi/professional";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const accountIds = [
  "018f0000-0000-7000-8000-000000000a01",
  "018f0000-0000-7000-8000-000000000a02",
  "018f0000-0000-7000-8000-000000000a03",
];
const actors: { accountId: string; personId: string; mfaEnabled: boolean }[] =
  [];
const scope = { type: "ALL_LOCATIONS" as const, locationIds: [] };
let sequence = 0;

beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i]!;
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
      )
      .bind(accountId, `Atomic ${i}`, `atomic${i}@example.test`)
      .run();
    const account = await ensureMotorBaldiAccount(
      db,
      accountId,
      `atomic-provision-${i}`,
    );
    actors.push({ accountId, personId: account.personId, mfaEnabled: true });
  }
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin'),(?,'platform-crm')",
    )
    .bind(actors[0]!.personId, actors[0]!.personId)
    .run();
});

async function organization() {
  const name = `Atomic Shop ${++sequence}`;
  return (
    await createOrganization(
      db,
      actors[0]!,
      {
        type: "WORKSHOP",
        legalName: name,
        displayName: name,
        countryCode: "US",
      },
      `atomic-org-${sequence}`,
    )
  ).organizationId;
}

async function invitation(organizationId: string) {
  return createInvitation(
    db,
    actors[0]!,
    organizationId,
    "atomic1@example.test",
    ["MECHANIC"],
    scope,
    `atomic-invite-${++sequence}`,
  );
}

async function membershipRequest(organizationId: string) {
  return createMembershipRequest(
    db,
    actors[1]!,
    organizationId,
    ["MECHANIC"],
    scope,
    undefined,
    `atomic-request-${++sequence}`,
  );
}

async function countMemberships(organizationId: string) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM org_memberships WHERE organization_id=? AND person_id=? AND status='ACTIVE'",
    )
    .bind(organizationId, actors[1]!.personId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function assertNoEffects(requestId: string) {
  for (const table of [
    "governance_audit_events",
    "governance_security_events",
    "integration_outbox_events",
  ]) {
    const row = await db
      .prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`)
      .bind(requestId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  }
}

describe("Phase 1 atomic state closeout", () => {
  it("accepts an invitation only after its pending state is claimed", async () => {
    const org = await organization();
    const invite = await invitation(org);
    await expect(
      acceptInvitation(db, actors[2]!, invite.token, "atomic-wrong-email"),
    ).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });
    await assertNoEffects("atomic-wrong-email");
    const results = await Promise.allSettled([
      acceptInvitation(db, actors[1]!, invite.token, "atomic-accept-race"),
      revokeInvitation(
        db,
        actors[0]!,
        org,
        invite.invitationId,
        "atomic-revoke-race",
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const state = await db
      .prepare("SELECT status FROM org_invitations WHERE id=?")
      .bind(invite.invitationId)
      .first<{ status: string }>();
    expect(await countMemberships(org)).toBe(
      state?.status === "ACCEPTED" ? 1 : 0,
    );
    if (state?.status === "REVOKED")
      await assertNoEffects("atomic-accept-race");
    else await assertNoEffects("atomic-revoke-race");

    const expiredOrg = await organization();
    const expiring = await invitation(expiredOrg);
    const expiry = await Promise.allSettled([
      acceptInvitation(db, actors[1]!, expiring.token, "atomic-accept-expiry"),
      expireInvitations(db, new Date(Date.now() + 8 * 86400000).toISOString()),
    ]);
    expect(expiry[0]?.status).toMatch(/fulfilled|rejected/);
    const expiredState = await db
      .prepare("SELECT status FROM org_invitations WHERE id=?")
      .bind(expiring.invitationId)
      .first<{ status: string }>();
    expect(await countMemberships(expiredOrg)).toBe(
      expiredState?.status === "ACCEPTED" ? 1 : 0,
    );

    const duplicateOrg = await organization();
    const duplicateInvite = await invitation(duplicateOrg);
    const concurrent = await Promise.allSettled([
      acceptInvitation(
        db,
        actors[1]!,
        duplicateInvite.token,
        "atomic-accept-a",
      ),
      acceptInvitation(
        db,
        actors[1]!,
        duplicateInvite.token,
        "atomic-accept-b",
      ),
    ]);
    expect(concurrent.some((result) => result.status === "fulfilled")).toBe(
      true,
    );
    expect(await countMemberships(duplicateOrg)).toBe(1);
    expect(
      (
        await acceptInvitation(
          db,
          actors[1]!,
          duplicateInvite.token,
          "atomic-accept-repeat",
        )
      ).accepted,
    ).toBe(true);

    const rollbackOrg = await organization();
    const rollbackInvite = await invitation(rollbackOrg);
    await db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
      )
      .bind(
        "018f0000-0000-7000-8000-000000000a91",
        rollbackOrg,
        actors[1]!.personId,
      )
      .run();
    await expect(
      acceptInvitation(
        db,
        actors[1]!,
        rollbackInvite.token,
        "atomic-accept-rollback",
      ),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const rolledBack = await db
      .prepare("SELECT status FROM org_invitations WHERE id=?")
      .bind(rollbackInvite.invitationId)
      .first<{ status: string }>();
    expect(rolledBack?.status).toBe("PENDING");
    await assertNoEffects("atomic-accept-rollback");
  });

  it("approves membership requests only after claiming pending state", async () => {
    for (const [decision, terminal] of [
      ["reject", "REJECTED"],
      ["cancel", "CANCELLED"],
      ["expire", "EXPIRED"],
    ] as const) {
      const org = await organization();
      const request = await membershipRequest(org);
      const approveId = `atomic-approve-${decision}`;
      const competitor =
        decision === "reject"
          ? rejectMembershipRequest(
              db,
              actors[0]!,
              org,
              request,
              "Review reason",
              `atomic-reject-${sequence}`,
            )
          : decision === "cancel"
            ? cancelMembershipRequest(db, actors[1]!, org, request)
            : expireMembershipRequests(
                db,
                new Date(Date.now() + 15 * 86400000).toISOString(),
              );
      await Promise.allSettled([
        approveMembershipRequest(db, actors[0]!, org, request, approveId),
        competitor,
      ]);
      const state = await db
        .prepare("SELECT status FROM org_membership_requests WHERE id=?")
        .bind(request)
        .first<{ status: string }>();
      expect(["APPROVED", terminal]).toContain(state?.status);
      expect(await countMemberships(org)).toBe(
        state?.status === "APPROVED" ? 1 : 0,
      );
      if (state?.status !== "APPROVED") await assertNoEffects(approveId);
    }
    const org = await organization();
    const request = await membershipRequest(org);
    const concurrent = await Promise.allSettled([
      approveMembershipRequest(
        db,
        actors[0]!,
        org,
        request,
        "atomic-approve-a",
      ),
      approveMembershipRequest(
        db,
        actors[0]!,
        org,
        request,
        "atomic-approve-b",
      ),
    ]);
    expect(concurrent.some((result) => result.status === "fulfilled")).toBe(
      true,
    );
    expect(await countMemberships(org)).toBe(1);
    const event = await db
      .prepare(
        "SELECT count(*) AS n FROM integration_outbox_events WHERE event_type='organization.membership.approved.v1' AND json_extract(payload_json,'$.requestId')=?",
      )
      .bind(request)
      .first<{ n: number }>();
    expect(event?.n).toBe(1);

    const rollbackOrg = await organization();
    const rollbackRequest = await membershipRequest(rollbackOrg);
    await db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
      )
      .bind(
        "018f0000-0000-7000-8000-000000000a92",
        rollbackOrg,
        actors[1]!.personId,
      )
      .run();
    await expect(
      approveMembershipRequest(
        db,
        actors[0]!,
        rollbackOrg,
        rollbackRequest,
        "atomic-approve-rollback",
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUEST_INVALID_STATE" });
    const rolledBack = await db
      .prepare("SELECT status FROM org_membership_requests WHERE id=?")
      .bind(rollbackRequest)
      .first<{ status: string }>();
    expect(rolledBack?.status).toBe("PENDING");
    await assertNoEffects("atomic-approve-rollback");
  });

  it("leaves no audit or security record for failed related transitions", async () => {
    const org = await organization();
    const invite = await invitation(org);
    await revokeInvitation(
      db,
      actors[0]!,
      org,
      invite.invitationId,
      "atomic-revoke-once",
    );
    await expect(
      revokeInvitation(
        db,
        actors[0]!,
        org,
        invite.invitationId,
        "atomic-revoke-repeat",
      ),
    ).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    await assertNoEffects("atomic-revoke-repeat");
    const request = await membershipRequest(org);
    await rejectMembershipRequest(
      db,
      actors[0]!,
      org,
      request,
      "Review reason",
      "atomic-reject-once",
    );
    await expect(
      rejectMembershipRequest(
        db,
        actors[0]!,
        org,
        request,
        "Review reason",
        "atomic-reject-repeat",
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUEST_INVALID_STATE" });
    await assertNoEffects("atomic-reject-repeat");

    const memberInvite = await invitation(org);
    await acceptInvitation(
      db,
      actors[1]!,
      memberInvite.token,
      "atomic-member-accept",
    );
    const member = await db
      .prepare(
        "SELECT id FROM org_memberships WHERE organization_id=? AND person_id=? AND status='ACTIVE'",
      )
      .bind(org, actors[1]!.personId)
      .first<{ id: string }>();
    await endMembership(db, actors[0]!, org, member!.id, "atomic-end-once");
    await expect(
      endMembership(db, actors[0]!, org, member!.id, "atomic-end-repeat"),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });
    await assertNoEffects("atomic-end-repeat");
    await suspendOrganization(
      db,
      actors[0]!,
      org,
      "Review reason",
      "atomic-suspend-once",
    );
    await expect(
      suspendOrganization(
        db,
        actors[0]!,
        org,
        "Review reason",
        "atomic-suspend-repeat",
      ),
    ).rejects.toMatchObject({ code: "ORGANIZATION_INVALID_STATE" });
    await assertNoEffects("atomic-suspend-repeat");
  });

  it("lets only one person-merge destination win and emits only its event", async () => {
    const leadId = await receiveLead(
      db,
      { email: "atomic-merge@example.test" },
      "atomic-merge-lead",
    );
    const sourceId = await createPersonFromLead(
      db,
      leadId,
      actors[0]!,
      "atomic-merge-source",
    );
    const destinations = [actors[1]!.personId, actors[2]!.personId];
    await Promise.allSettled(
      destinations.map((destination, index) =>
        mergePeople(
          db,
          sourceId,
          destination,
          actors[0]!,
          "Manual review",
          `atomic-merge-${index}`,
        ),
      ),
    );
    const source = await db
      .prepare("SELECT status,merged_into_person_id FROM iam_people WHERE id=?")
      .bind(sourceId)
      .first<{ status: string; merged_into_person_id: string }>();
    expect(source?.status).toBe("MERGED");
    expect(destinations).toContain(source?.merged_into_person_id);
    const events = await db
      .prepare(
        "SELECT payload_json FROM integration_outbox_events WHERE event_type='identity.person.merged.v1' AND json_extract(payload_json,'$.sourceId')=?",
      )
      .bind(sourceId)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(1);
    expect(JSON.parse(events.results[0]!.payload_json).destinationId).toBe(
      source?.merged_into_person_id,
    );
    const lead = await db
      .prepare("SELECT person_id FROM crm_lead_intakes WHERE id=?")
      .bind(leadId)
      .first<{ person_id: string }>();
    expect(lead?.person_id).toBe(source?.merged_into_person_id);
    const losing = destinations.find(
      (destination) => destination !== source?.merged_into_person_id,
    )!;
    await expect(
      mergePeople(
        db,
        sourceId,
        losing,
        actors[0]!,
        "Manual review",
        "atomic-merge-loser",
      ),
    ).rejects.toMatchObject({ code: "INVALID_PERSON_MERGE" });
    await assertNoEffects("atomic-merge-loser");
    await mergePeople(
      db,
      sourceId,
      source!.merged_into_person_id,
      actors[0]!,
      "Manual review",
      "atomic-merge-repeat",
    );
    await assertNoEffects("atomic-merge-repeat");
  });

  it("rolls back a claimed merge when a relationship move fails", async () => {
    const leadId = await receiveLead(
      db,
      { email: "atomic-merge-rollback@example.test" },
      "atomic-merge-rollback-lead",
    );
    const sourceId = await createPersonFromLead(
      db,
      leadId,
      actors[0]!,
      "atomic-merge-rollback-source",
    );
    await db.exec(
      `CREATE TRIGGER atomic_merge_failure BEFORE UPDATE OF person_id ON crm_lead_intakes WHEN OLD.person_id='${sourceId}' BEGIN SELECT RAISE(ABORT,'FORCED_MERGE_FAILURE'); END;`,
    );
    try {
      await expect(
        mergePeople(
          db,
          sourceId,
          actors[1]!.personId,
          actors[0]!,
          "Manual review",
          "atomic-merge-rollback",
        ),
      ).rejects.toThrow();
      const source = await db
        .prepare(
          "SELECT status,merged_into_person_id FROM iam_people WHERE id=?",
        )
        .bind(sourceId)
        .first<{ status: string; merged_into_person_id: string | null }>();
      expect(source).toMatchObject({
        status: "PROVISIONAL",
        merged_into_person_id: null,
      });
      await assertNoEffects("atomic-merge-rollback");
    } finally {
      await db.exec("DROP TRIGGER atomic_merge_failure;");
    }
  });

  it("returns one opportunity for concurrent lead conversions with distinct request keys", async () => {
    const leadId = await receiveLead(
      db,
      { email: "atomic-convert@example.test" },
      "atomic-convert-lead",
    );
    const results = await Promise.allSettled([
      convertLead(
        db,
        leadId,
        actors[0]!,
        "customer-acquisition",
        "customer-new",
        "Atomic lead",
        "atomic-convert-a",
      ),
      convertLead(
        db,
        leadId,
        actors[0]!,
        "customer-acquisition",
        "customer-new",
        "Atomic lead",
        "atomic-convert-b",
      ),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const ids = results.map((result) =>
      result.status === "fulfilled" ? result.value : null,
    );
    expect(ids[0]).toBe(ids[1]);
    const opportunities = await db
      .prepare(
        "SELECT count(*) AS n FROM crm_opportunities WHERE lead_intake_id=?",
      )
      .bind(leadId)
      .first<{ n: number }>();
    expect(opportunities?.n).toBe(1);
    const events = await db
      .prepare(
        "SELECT count(*) AS n FROM integration_outbox_events WHERE event_type='crm.lead.converted.v1' AND aggregate_id=?",
      )
      .bind(leadId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);

    const inconsistentLead = await receiveLead(
      db,
      { email: "atomic-existing-opportunity@example.test" },
      "atomic-existing-lead",
    );
    await db
      .prepare(
        "INSERT INTO crm_opportunities(id,pipeline_id,stage_id,lead_intake_id,title,owner_person_id) VALUES(?,'customer-acquisition','customer-new',?,'Existing opportunity',?)",
      )
      .bind(
        "018f0000-0000-7000-8000-000000000a93",
        inconsistentLead,
        actors[0]!.personId,
      )
      .run();
    await expect(
      convertLead(
        db,
        inconsistentLead,
        actors[0]!,
        "customer-acquisition",
        "customer-new",
        "Duplicate opportunity",
        "atomic-convert-unique",
      ),
    ).rejects.toMatchObject({ code: "CRM_LEAD_INVALID_STATE" });
    const staleLead = await db
      .prepare("SELECT status FROM crm_lead_intakes WHERE id=?")
      .bind(inconsistentLead)
      .first<{ status: string }>();
    expect(staleLead?.status).toBe("RECEIVED");
    await assertNoEffects("atomic-convert-unique");
  });

  it("cannot verify an already-expired credential even while expiry maintenance runs", async () => {
    await upsertMechanicProfile(db, actors[1]!.personId, {
      bio: "Atomic technician",
    });
    const expiredId = await submitCredential(
      db,
      actors[1]!.personId,
      {
        credentialType: "TRAINING",
        issuer: "School",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
      "atomic-credential-expired",
    );
    await expect(
      decideCredential(
        db,
        actors[0]!,
        expiredId,
        "VERIFIED",
        "Review reason",
        "atomic-verify-expired",
      ),
    ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID_STATE" });
    await assertNoEffects("atomic-verify-expired");
    await Promise.allSettled([
      decideCredential(
        db,
        actors[0]!,
        expiredId,
        "VERIFIED",
        "Review reason",
        "atomic-verify-race",
      ),
      expireCredentials(db),
    ]);
    const expired = await db
      .prepare("SELECT status FROM professional_credentials WHERE id=?")
      .bind(expiredId)
      .first<{ status: string }>();
    expect(expired?.status).toBe("EXPIRED");
    await assertNoEffects("atomic-verify-race");
    const futureId = await submitCredential(
      db,
      actors[1]!.personId,
      {
        credentialType: "TRAINING",
        issuer: "School",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      "atomic-credential-future",
    );
    await decideCredential(
      db,
      actors[0]!,
      futureId,
      "VERIFIED",
      "Review reason",
      "atomic-verify-future",
    );
    const future = await db
      .prepare("SELECT status FROM professional_credentials WHERE id=?")
      .bind(futureId)
      .first<{ status: string }>();
    expect(future?.status).toBe("VERIFIED");
  });
});
