import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { assessAuthenticatedSession } from "@motorbaldi/auth";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { buildIdempotencyScope } from "@motorbaldi/db";
import { newId } from "@motorbaldi/shared";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const bindings = env as unknown as ApiBindings;
const db = bindings.DB;
type Actor = { accountId: string; personId: string; sessionId: string };

beforeAll(async () => {
  for (const migration of [foundation, phase1, closeout])
    await db.exec(migration.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
});

async function actor(): Promise<Actor> {
  const accountId = newId(),
    sessionId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Coordinator fixture',?,1)",
    )
    .bind(accountId, accountId + "@example.test")
    .run();
  const account = await ensureMotorBaldiAccount(db, accountId, newId());
  // Local trusted fixture still exercises the production session assessment seam.
  await db
    .prepare(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(?,?,?,?)",
    )
    .bind(
      sessionId,
      accountId,
      newId(),
      new Date(Date.now() + 3600_000).toISOString(),
    )
    .run();
  expect(await assessAuthenticatedSession(db, accountId, sessionId)).toEqual({
    mfaEnabled: false,
  });
  return { accountId, personId: account.personId, sessionId };
}

async function run(
  actor: Actor,
  operation: string,
  key: string,
  request: Record<string, unknown>,
  requestId = newId(),
) {
  const scope = buildIdempotencyScope({
    accountId: actor.accountId,
    operation,
  });
  const response = await bindings.IDEMPOTENCY_COORDINATOR.getByName(
    scope.scope + ":" + key,
  ).fetch("https://coordinator.internal/run", {
    method: "POST",
    body: JSON.stringify({
      scope,
      key,
      request,
      requestId,
      sessionId: actor.sessionId,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function organizationRequest(name = "Coordinator Workshop") {
  return {
    type: "WORKSHOP",
    legalName: name,
    displayName: name,
    countryCode: "US",
  };
}
async function count(sql: string, ...values: string[]) {
  return (
    await db
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n;
}
async function commandCounts(
  actor: Actor,
  operation: string,
  key: string,
  requestId: string,
) {
  return {
    replay: await count(
      "SELECT count(*) AS n FROM governance_idempotency_records WHERE scope=? AND key=?",
      buildIdempotencyScope({ accountId: actor.accountId, operation }).scope,
      key,
    ),
    receipt: await count(
      "SELECT count(*) AS n FROM governance_audit_events WHERE action='command.accepted' AND request_id=?",
      requestId,
    ),
  };
}
async function createOrganization(actor: Actor) {
  const result = await run(
    actor,
    "organization.create",
    newId(),
    organizationRequest(),
  );
  expect(result.status).toBe(200);
  expect(result.body.organizationId).toEqual(expect.any(String));
  return String(result.body.organizationId);
}
function invitationRequest(organizationId: string) {
  return {
    organizationId,
    targetEmail: "invitee@example.test",
    roles: ["MECHANIC"],
    scope: { type: "ALL_LOCATIONS", locationIds: [] },
  };
}

describe("generic command coordinator runtime integration", () => {
  it("replays organization creation with one business effect, replay and receipt", async () => {
    const owner = await actor(),
      key = newId(),
      requestId = newId();
    const request = organizationRequest("Coordinator single creation");
    const first = await run(
      owner,
      "organization.create",
      key,
      request,
      requestId,
    );
    expect(first.status).toBe(200);
    const retryRequestId = newId();
    const retry = await run(
      owner,
      "organization.create",
      key,
      request,
      retryRequestId,
    );
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ...first.body, replayed: true });
    expect(
      await count(
        "SELECT count(*) AS n FROM org_organizations WHERE created_by_person_id=?",
        owner.personId,
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM org_memberships WHERE organization_id=?",
        String(first.body.organizationId),
      ),
    ).toBe(1);
    expect(
      await commandCounts(owner, "organization.create", key, requestId),
    ).toEqual({ replay: 1, receipt: 1 });
    expect(
      (await commandCounts(owner, "organization.create", key, retryRequestId))
        .receipt,
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
        requestId,
      ),
    ).toBe(1);
  });

  it("returns the invitation token once and persists only its redacted replay", async () => {
    const owner = await actor(),
      organizationId = await createOrganization(owner),
      key = newId(),
      requestId = newId();
    const request = invitationRequest(organizationId);
    const first = await run(
      owner,
      "organization.invitation.create",
      key,
      request,
      requestId,
    );
    expect(first.status).toBe(200);
    expect(first.body.token).toMatch(/^[0-9a-f]{64}$/);
    const retry = await run(
      owner,
      "organization.invitation.create",
      key,
      request,
    );
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({
      invitationId: first.body.invitationId,
      expiresAt: first.body.expiresAt,
      replayed: true,
    });
    const stored = await db
      .prepare(
        "SELECT response_json FROM governance_idempotency_records WHERE scope=? AND key=?",
      )
      .bind(
        buildIdempotencyScope({
          accountId: owner.accountId,
          operation: "organization.invitation.create",
        }).scope,
        key,
      )
      .first<{ response_json: string }>();
    expect(stored).not.toBeNull();
    expect(stored?.response_json).not.toContain("token");
    expect(stored?.response_json).not.toContain(first.body.token);
    expect(
      await count(
        "SELECT count(*) AS n FROM org_invitations WHERE organization_id=?",
        organizationId,
      ),
    ).toBe(1);
    expect(
      await commandCounts(
        owner,
        "organization.invitation.create",
        key,
        requestId,
      ),
    ).toEqual({ replay: 1, receipt: 1 });
  });

  it("denies cached invitation success after the owner's membership is revoked", async () => {
    const owner = await actor(),
      organizationId = await createOrganization(owner),
      key = newId(),
      requestId = newId();
    const request = invitationRequest(organizationId);
    expect(
      (
        await run(
          owner,
          "organization.invitation.create",
          key,
          request,
          requestId,
        )
      ).status,
    ).toBe(200);
    const remainingOwner = await actor();
    const remainingMembershipId = newId();
    await db.batch([
      db
        .prepare(
          "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
        )
        .bind(remainingMembershipId, organizationId, remainingOwner.personId),
      db
        .prepare(
          "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-owner')",
        )
        .bind(remainingMembershipId),
    ]);
    await db
      .prepare(
        "UPDATE org_memberships SET status='ENDED',valid_to=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND person_id=?",
      )
      .bind(organizationId, owner.personId)
      .run();
    const retryRequestId = newId();
    const retry = await run(
      owner,
      "organization.invitation.create",
      key,
      request,
      retryRequestId,
    );
    expect(retry.status).toBe(403);
    expect(retry.body).not.toHaveProperty("invitationId");
    expect(retry.body).not.toHaveProperty("token");
    expect(
      await count(
        "SELECT count(*) AS n FROM org_invitations WHERE organization_id=?",
        organizationId,
      ),
    ).toBe(1);
    expect(
      (
        await commandCounts(
          owner,
          "organization.invitation.create",
          key,
          retryRequestId,
        )
      ).receipt,
    ).toBe(0);
  });

  it("denies a suspended account before returning cached organization success", async () => {
    const owner = await actor(),
      key = newId(),
      requestId = newId(),
      request = organizationRequest();
    expect(
      (await run(owner, "organization.create", key, request, requestId)).status,
    ).toBe(200);
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(owner.accountId)
      .run();
    const retryRequestId = newId();
    const retry = await run(
      owner,
      "organization.create",
      key,
      request,
      retryRequestId,
    );
    expect(retry).toMatchObject({
      status: 403,
      body: { code: "ACCOUNT_SUSPENDED" },
    });
    expect(retry.body).not.toHaveProperty("organizationId");
    expect(
      await count(
        "SELECT count(*) AS n FROM org_organizations WHERE created_by_person_id=?",
        owner.personId,
      ),
    ).toBe(1);
    expect(
      (await commandCounts(owner, "organization.create", key, retryRequestId))
        .receipt,
    ).toBe(0);
  });

  it("rolls back domain effects, replay and receipt on a real batch failure and permits a safe retry", async () => {
    const owner = await actor(),
      key = newId(),
      requestId = newId();
    const request = organizationRequest("Coordinator rollback fixture");
    // Reject the final outbox write after the transaction has attempted its domain/audit writes.
    await db.exec(
      "CREATE TRIGGER test_coordinator_outbox_failure BEFORE INSERT ON integration_outbox_events WHEN NEW.event_type='organization.created.v1' BEGIN SELECT RAISE(ABORT,'coordinator fixture failure'); END;",
    );
    try {
      await expect(
        run(owner, "organization.create", key, request, requestId),
      ).rejects.toThrow();
      expect(
        await commandCounts(owner, "organization.create", key, requestId),
      ).toEqual({ replay: 0, receipt: 0 });
      expect(
        await count(
          "SELECT count(*) AS n FROM org_organizations WHERE created_by_person_id=?",
          owner.personId,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM org_memberships WHERE person_id=?",
          owner.personId,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
          requestId,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
          requestId,
        ),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER test_coordinator_outbox_failure");
    }
    const retried = await run(
      owner,
      "organization.create",
      key,
      request,
      requestId,
    );
    expect(retried.status).toBe(200);
    const replayed = await run(owner, "organization.create", key, request);
    expect(replayed.body).toEqual({ ...retried.body, replayed: true });
    expect(
      await count(
        "SELECT count(*) AS n FROM org_organizations WHERE created_by_person_id=?",
        owner.personId,
      ),
    ).toBe(1);
    expect(
      await commandCounts(owner, "organization.create", key, requestId),
    ).toEqual({ replay: 1, receipt: 1 });
  });
  it.each([
    "organization.invitation.accept",
    "organization.membership-request.create",
    "organization.membership-request.approve",
  ])(
    "keeps %s atomic when its replay insert fails, then commits and replays once",
    async (operation) => {
      const owner = await actor(),
        recipient = await actor();
      const organizationId = await createOrganization(owner);
      let executor = recipient;
      let request: Record<string, unknown>;
      let invitationId: string | undefined;
      let membershipRequestId: string | undefined;
      const membershipRequest = {
        organizationId,
        roles: ["MECHANIC"],
        scope: { type: "ALL_LOCATIONS", locationIds: [] },
        message: "Coordinator membership request",
      };
      if (operation === "organization.invitation.accept") {
        const invitation = await run(
          owner,
          "organization.invitation.create",
          newId(),
          {
            ...invitationRequest(organizationId),
            targetEmail: recipient.accountId + "@example.test",
          },
        );
        expect(invitation.status).toBe(200);
        invitationId = String(invitation.body.invitationId);
        request = { token: invitation.body.token };
      } else if (operation === "organization.membership-request.approve") {
        const created = await run(
          recipient,
          "organization.membership-request.create",
          newId(),
          membershipRequest,
        );
        expect(created.status).toBe(200);
        membershipRequestId = String(created.body.membershipRequestId);
        executor = owner;
        request = { organizationId, membershipRequestId };
      } else request = membershipRequest;
      const key = newId(),
        requestId = newId();
      await db.exec(
        `CREATE TRIGGER test_organization_replay_failure BEFORE INSERT ON governance_idempotency_records WHEN NEW.operation='${operation}' BEGIN SELECT RAISE(ABORT,'organization replay fixture failure'); END;`,
      );
      try {
        if (operation === "organization.membership-request.create")
          await expect(
            run(executor, operation, key, request, requestId),
          ).rejects.toThrow();
        else {
          const failed = await run(
            executor,
            operation,
            key,
            request,
            requestId,
          );
          expect(failed).toMatchObject({
            status: 409,
            body: {
              code:
                operation === "organization.invitation.accept"
                  ? "INVITATION_INVALID"
                  : "MEMBERSHIP_REQUEST_INVALID_STATE",
            },
          });
        }
        expect(
          await commandCounts(executor, operation, key, requestId),
        ).toEqual({ replay: 0, receipt: 0 });
        expect(
          await count(
            "SELECT count(*) AS n FROM org_memberships WHERE organization_id=? AND person_id=?",
            organizationId,
            recipient.personId,
          ),
        ).toBe(0);
        expect(
          await count(
            "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
            requestId,
          ),
        ).toBe(0);
        expect(
          await count(
            "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
            requestId,
          ),
        ).toBe(0);
        if (invitationId)
          expect(
            await db
              .prepare(
                "SELECT status,accepted_by_person_id FROM org_invitations WHERE id=?",
              )
              .bind(invitationId)
              .first(),
          ).toEqual({ status: "PENDING", accepted_by_person_id: null });
        if (membershipRequestId)
          expect(
            await db
              .prepare(
                "SELECT status,reviewed_by_person_id FROM org_membership_requests WHERE id=?",
              )
              .bind(membershipRequestId)
              .first(),
          ).toEqual({ status: "PENDING", reviewed_by_person_id: null });
        if (operation === "organization.membership-request.create")
          expect(
            await count(
              "SELECT count(*) AS n FROM org_membership_requests WHERE organization_id=? AND person_id=?",
              organizationId,
              recipient.personId,
            ),
          ).toBe(0);
      } finally {
        await db.exec("DROP TRIGGER test_organization_replay_failure");
      }
      const success = await run(executor, operation, key, request, requestId);
      expect(success.status).toBe(200);
      const replay = await run(executor, operation, key, request);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...success.body, replayed: true });
      expect(await commandCounts(executor, operation, key, requestId)).toEqual({
        replay: 1,
        receipt: 1,
      });
      if (operation === "organization.membership-request.create") {
        expect(success.body.membershipRequestId).toEqual(expect.any(String));
        expect(
          await count(
            "SELECT count(*) AS n FROM org_membership_requests WHERE organization_id=? AND person_id=?",
            organizationId,
            recipient.personId,
          ),
        ).toBe(1);
      } else {
        expect(success.body).toMatchObject(
          operation === "organization.invitation.accept"
            ? { invitationId, accepted: true }
            : { approved: true },
        );
        expect(
          await count(
            "SELECT count(*) AS n FROM org_memberships WHERE organization_id=? AND person_id=? AND status='ACTIVE'",
            organizationId,
            recipient.personId,
          ),
        ).toBe(1);
        expect(
          await count(
            "SELECT count(*) AS n FROM org_membership_roles r JOIN org_memberships m ON m.id=r.membership_id WHERE m.organization_id=? AND m.person_id=? AND r.role_id='org-mechanic'",
            organizationId,
            recipient.personId,
          ),
        ).toBe(1);
        if (invitationId)
          expect(
            await db
              .prepare(
                "SELECT status,accepted_by_person_id FROM org_invitations WHERE id=?",
              )
              .bind(invitationId)
              .first(),
          ).toEqual({
            status: "ACCEPTED",
            accepted_by_person_id: recipient.personId,
          });
        if (membershipRequestId)
          expect(
            await db
              .prepare(
                "SELECT status,reviewed_by_person_id FROM org_membership_requests WHERE id=?",
              )
              .bind(membershipRequestId)
              .first(),
          ).toEqual({
            status: "APPROVED",
            reviewed_by_person_id: owner.personId,
          });
      }
    },
  );

  it("rolls back invitation creation when its final outbox write fails and redacts the eventual replay", async () => {
    const owner = await actor(),
      organizationId = await createOrganization(owner),
      key = newId(),
      requestId = newId();
    const request = invitationRequest(organizationId);
    await db.exec(
      "CREATE TRIGGER test_invitation_outbox_failure BEFORE INSERT ON integration_outbox_events WHEN NEW.event_type='organization.invitation.created.v1' BEGIN SELECT RAISE(ABORT,'invitation outbox fixture failure'); END;",
    );
    try {
      await expect(
        run(owner, "organization.invitation.create", key, request, requestId),
      ).rejects.toThrow();
      expect(
        await commandCounts(
          owner,
          "organization.invitation.create",
          key,
          requestId,
        ),
      ).toEqual({ replay: 0, receipt: 0 });
      expect(
        await count(
          "SELECT count(*) AS n FROM org_invitations WHERE organization_id=?",
          organizationId,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
          requestId,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
          requestId,
        ),
      ).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER test_invitation_outbox_failure");
    }
    const success = await run(
      owner,
      "organization.invitation.create",
      key,
      request,
      requestId,
    );
    expect(success.status).toBe(200);
    expect(success.body.token).toMatch(/^[0-9a-f]{64}$/);
    const replay = await run(
      owner,
      "organization.invitation.create",
      key,
      request,
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      invitationId: success.body.invitationId,
      expiresAt: success.body.expiresAt,
      replayed: true,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM org_invitations WHERE organization_id=?",
        organizationId,
      ),
    ).toBe(1);
    expect(
      await commandCounts(
        owner,
        "organization.invitation.create",
        key,
        requestId,
      ),
    ).toEqual({ replay: 1, receipt: 1 });
  });
});
