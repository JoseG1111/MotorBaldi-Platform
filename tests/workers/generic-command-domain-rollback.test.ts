import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  ensureMotorBaldiAccount,
  prepareMergePeople,
} from "@motorbaldi/identity";
import { prepareConvertLead, receiveLead } from "@motorbaldi/crm";
import {
  createOrganization,
  prepareSubmitVerification,
  prepareDecideVerification,
  submitVerification,
  startVerificationReview,
} from "@motorbaldi/organizations";
import {
  buildIdempotencyScope,
  commitIdempotentCommand,
  readReplay,
  type IdempotencyScope,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const accountId = "018f0000-0000-7000-8000-000000000c01";
let actor: { accountId: string; personId: string; mfaEnabled: boolean };

beforeAll(async () => {
  for (const migration of [foundation, phase1, closeout])
    await db.exec(migration.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Domain Rollback','domain-rollback@example.test',1)",
    )
    .bind(accountId)
    .run();
  const account = await ensureMotorBaldiAccount(db, accountId, newId());
  actor = { accountId, personId: account.personId, mfaEnabled: true };
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin'),(?,'platform-crm')",
    )
    .bind(actor.personId, actor.personId)
    .run();
});

async function count(sql: string, ...bindings: string[]) {
  return (await db
    .prepare(sql)
    .bind(...bindings)
    .first<{ n: number }>())!.n;
}

async function assertNoCommandEffects(
  scope: IdempotencyScope,
  key: string,
  requestId: string,
) {
  expect(
    await count(
      "SELECT count(*) AS n FROM governance_idempotency_records WHERE scope=? AND key=?",
      scope.scope,
      key,
    ),
  ).toBe(0);
  for (const table of [
    "governance_audit_events",
    "governance_security_events",
    "integration_outbox_events",
  ])
    expect(
      await count(
        `SELECT count(*) AS n FROM ${table} WHERE request_id=?`,
        requestId,
      ),
    ).toBe(0);
}

async function injectFailure(
  point: "replay" | "outbox",
  key: string,
  requestId: string,
  run: () => Promise<unknown>,
) {
  // Generated UUIDs are safe SQL literals; the trigger affects only this command.
  const table =
    point === "replay"
      ? "governance_idempotency_records"
      : "integration_outbox_events";
  const predicate =
    point === "replay" ? `NEW.key='${key}'` : `NEW.request_id='${requestId}'`;
  await db.exec(
    `CREATE TRIGGER domain_rollback_failure BEFORE INSERT ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(ABORT,'injected domain command failure'); END;`,
  );
  try {
    await expect(run()).rejects.toThrow("injected domain command failure");
  } finally {
    await db.exec("DROP TRIGGER domain_rollback_failure");
  }
}

async function assertCommitted(
  scope: IdempotencyScope,
  key: string,
  request: Json,
  requestId: string,
  response: Json,
  securityCount = 0,
) {
  expect((await readReplay(db, scope, key, request))?.response).toEqual(
    response,
  );
  expect(
    await count(
      "SELECT count(*) AS n FROM governance_audit_events WHERE request_id=?",
      requestId,
    ),
  ).toBe(2);
  expect(
    await count(
      "SELECT count(*) AS n FROM integration_outbox_events WHERE request_id=?",
      requestId,
    ),
  ).toBe(1);
  expect(
    await count(
      "SELECT count(*) AS n FROM governance_security_events WHERE request_id=?",
      requestId,
    ),
  ).toBe(securityCount);
}

async function organization() {
  return (
    await createOrganization(
      db,
      actor,
      {
        type: "WORKSHOP",
        legalName: "Rollback Shop",
        displayName: "Rollback Shop",
        countryCode: "US",
      },
      newId(),
    )
  ).organizationId;
}

describe("prepared domain commands commit effects and replay together", () => {
  for (const point of ["replay", "outbox"] as const) {
    it(`rolls back lead conversion at ${point} and retries one opportunity`, async () => {
      const leadId = await receiveLead(
        db,
        {
          email: "rollback-lead@example.test",
          message: "Domain command rollback",
        },
        newId(),
      );
      const scope = buildIdempotencyScope({
        accountId,
        operation: "crm.lead.convert",
      });
      const key = newId(),
        requestId = newId();
      const request = {
        leadId,
        pipelineId: "customer-acquisition",
        stageId: "customer-new",
        title: "Rollback conversion",
      };
      const prepare = () =>
        prepareConvertLead(
          db,
          leadId,
          actor,
          request.pipelineId,
          request.stageId,
          request.title,
          requestId,
        );
      const failed = await prepare();
      await injectFailure(point, key, requestId, () =>
        commitIdempotentCommand(db, scope, key, request, requestId, failed),
      );
      await assertNoCommandEffects(scope, key, requestId);
      expect(
        (
          await db
            .prepare("SELECT status FROM crm_lead_intakes WHERE id=?")
            .bind(leadId)
            .first<{ status: string }>()
        )?.status,
      ).toBe("RECEIVED");
      expect(
        await count(
          "SELECT count(*) AS n FROM crm_opportunities WHERE lead_intake_id=?",
          leadId,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM crm_activities WHERE opportunity_id=?",
          failed.response.opportunityId,
        ),
      ).toBe(0);
      const response = await commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        requestId,
        await prepare(),
      );
      await assertCommitted(scope, key, request, requestId, response);
      expect(
        await count(
          "SELECT count(*) AS n FROM crm_opportunities WHERE lead_intake_id=?",
          leadId,
        ),
      ).toBe(1);
      expect(
        await count(
          "SELECT count(*) AS n FROM crm_activities WHERE opportunity_id=?",
          response.opportunityId,
        ),
      ).toBe(1);
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          key,
          request,
          newId(),
          await prepare(),
        ),
      ).rejects.toBeTruthy();
      expect(
        await count(
          "SELECT count(*) AS n FROM crm_opportunities WHERE lead_intake_id=?",
          leadId,
        ),
      ).toBe(1);
    });

    it(`rolls back person merge at ${point} including security and account links`, async () => {
      const sourceAccountId = newId();
      await db
        .prepare(
          "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Merge Source',?,1)",
        )
        .bind(sourceAccountId, `${sourceAccountId}@example.test`)
        .run();
      const sourceId = (
        await ensureMotorBaldiAccount(db, sourceAccountId, newId())
      ).personId;
      const scope = buildIdempotencyScope({
        accountId,
        operation: "identity.person.merge",
      });
      const key = newId(),
        requestId = newId();
      const request = {
        sourceId,
        destinationId: actor.personId,
        reason: "Confirmed duplicate",
      };
      const prepare = () =>
        prepareMergePeople(
          db,
          sourceId,
          actor.personId,
          actor,
          request.reason,
          requestId,
        );
      await injectFailure(point, key, requestId, async () =>
        commitIdempotentCommand(
          db,
          scope,
          key,
          request,
          requestId,
          await prepare(),
        ),
      );
      await assertNoCommandEffects(scope, key, requestId);
      expect(
        await db
          .prepare(
            "SELECT status,merged_into_person_id FROM iam_people WHERE id=?",
          )
          .bind(sourceId)
          .first(),
      ).toMatchObject({ status: "ACTIVE", merged_into_person_id: null });
      expect(
        (
          await db
            .prepare("SELECT person_id FROM iam_accounts WHERE id=?")
            .bind(sourceAccountId)
            .first()
        )?.person_id,
      ).toBe(sourceId);
      const response = await commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        requestId,
        await prepare(),
      );
      await assertCommitted(scope, key, request, requestId, response, 1);
      expect(
        await db
          .prepare(
            "SELECT status,merged_into_person_id FROM iam_people WHERE id=?",
          )
          .bind(sourceId)
          .first(),
      ).toMatchObject({
        status: "MERGED",
        merged_into_person_id: actor.personId,
      });
      expect(
        (
          await db
            .prepare("SELECT person_id FROM iam_accounts WHERE id=?")
            .bind(sourceAccountId)
            .first()
        )?.person_id,
      ).toBe(actor.personId);
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          key,
          request,
          newId(),
          await prepare(),
        ),
      ).rejects.toBeTruthy();
      await assertCommitted(scope, key, request, requestId, response, 1);
    });
  }

  it("rolls back verification submission after its final outbox insert fails", async () => {
    const organizationId = await organization();
    const scope = buildIdempotencyScope({
      accountId,
      organizationId,
      operation: "organization.verification.submit",
    });
    const key = newId(),
      requestId = newId(),
      request = { organizationId };
    const prepare = () =>
      prepareSubmitVerification(db, actor, organizationId, requestId);
    await injectFailure("outbox", key, requestId, async () =>
      commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        requestId,
        await prepare(),
      ),
    );
    await assertNoCommandEffects(scope, key, requestId);
    expect(
      await db
        .prepare(
          "SELECT verification_status,version FROM org_organizations WHERE id=?",
        )
        .bind(organizationId)
        .first(),
    ).toMatchObject({ verification_status: "DRAFT", version: 1 });
    expect(
      await count(
        "SELECT count(*) AS n FROM org_verification_cases WHERE organization_id=?",
        organizationId,
      ),
    ).toBe(0);
    const response = await commitIdempotentCommand(
      db,
      scope,
      key,
      request,
      requestId,
      await prepare(),
    );
    await assertCommitted(scope, key, request, requestId, response);
    expect(
      await count(
        "SELECT count(*) AS n FROM org_verification_cases WHERE organization_id=?",
        organizationId,
      ),
    ).toBe(1);
  });

  for (const decision of ["VERIFIED", "REJECTED"] as const) {
    it(`rolls back ${decision} verification decision including case events`, async () => {
      const organizationId = await organization();
      const caseId = await submitVerification(
        db,
        actor,
        organizationId,
        newId(),
      );
      await startVerificationReview(db, actor, organizationId, caseId, newId());
      const scope = buildIdempotencyScope({
        accountId,
        organizationId,
        operation:
          decision === "VERIFIED"
            ? "organization.verification.approve"
            : "organization.verification.reject",
      });
      const key = newId(),
        requestId = newId(),
        request = { organizationId, caseId, reason: "Reviewed evidence" };
      const prepare = () =>
        prepareDecideVerification(
          db,
          actor,
          organizationId,
          caseId,
          decision,
          request.reason,
          requestId,
        );
      await injectFailure("outbox", key, requestId, async () =>
        commitIdempotentCommand(
          db,
          scope,
          key,
          request,
          requestId,
          await prepare(),
        ),
      );
      await assertNoCommandEffects(scope, key, requestId);
      expect(
        (
          await db
            .prepare("SELECT status FROM org_verification_cases WHERE id=?")
            .bind(caseId)
            .first()
        )?.status,
      ).toBe("UNDER_REVIEW");
      expect(
        (
          await db
            .prepare(
              "SELECT verification_status FROM org_organizations WHERE id=?",
            )
            .bind(organizationId)
            .first()
        )?.verification_status,
      ).toBe("UNDER_REVIEW");
      expect(
        await count(
          "SELECT count(*) AS n FROM org_verification_case_events WHERE case_id=? AND to_status=?",
          caseId,
          decision,
        ),
      ).toBe(0);
      const response = await commitIdempotentCommand(
        db,
        scope,
        key,
        request,
        requestId,
        await prepare(),
      );
      await assertCommitted(scope, key, request, requestId, response);
      expect(
        await count(
          "SELECT count(*) AS n FROM org_verification_case_events WHERE case_id=? AND to_status=?",
          caseId,
          decision,
        ),
      ).toBe(1);
    });
  }
});
