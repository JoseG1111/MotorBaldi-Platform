import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  commitPreparedCommand,
  commitIdempotentCommand,
  buildIdempotencyScope,
  readReplay,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  parseSupportCommand,
  prepareSupportCommand,
  authorizeSupportCommand,
  listSupportCases,
  getSupportCase,
  type SupportOperation,
} from "../../packages/messaging/src/support.js";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m9 from "../../migrations/0009_workshop_files.sql?raw";
import m10 from "../../migrations/0010_inspection_media.sql?raw";
import m11 from "../../migrations/0011_inspection_workflow.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";
import m14 from "../../migrations/0014_notifications.sql?raw";
import m15 from "../../migrations/0015_support.sql?raw";
import m16 from "../../migrations/0016_support_history_boundary.sql?raw";
const db = (env as unknown as ApiBindings).DB;
type Actor = { accountId: string; personId: string; mfaEnabled: boolean };
beforeAll(async () => {
  for (const m of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m9,
    m10,
    m11,
    m12,
    m13,
    m14,
    m15,
    m16,
  ])
    await db.exec(m.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function member(staff = false): Promise<Actor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Support Fixture',?,1,?)",
    )
    .bind(accountId, `${accountId}@example.test`, staff ? 1 : 0)
    .run();
  const personId = (await ensureMotorBaldiAccount(db, accountId, newId()))
    .personId;
  if (staff) {
    await db
      .prepare(
        "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES(?,?,'synthetic-fixture','[]',1)",
      )
      .bind(newId(), accountId)
      .run();
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-support')",
      )
      .bind(personId)
      .run();
  }
  return { accountId, personId, mfaEnabled: staff };
}
async function command(
  actor: Actor,
  operation: SupportOperation,
  body: Record<string, Json>,
) {
  return (await commitPreparedCommand(
    db,
    await prepareSupportCommand(db, actor, operation, body, newId()),
  )) as { caseId: string; version: number; status: string };
}
const create = (actor: Actor) =>
  command(actor, "support.case.create", {
    subject: "Private subject",
    body: "Private message",
  });
describe("private general support domain", () => {
  it("bounds detail history and explicitly reports omitted older entries", async () => {
    const owner = await member(),
      c = await create(owner);
    for (let version = 1; version <= 101; version++)
      await command(owner, "support.case.reply", {
        caseId: c.caseId,
        version,
        body: `Message ${version}`,
      });
    const detail = await getSupportCase(db, owner, c.caseId);
    expect(detail.messages).toHaveLength(100);
    expect(detail.history).toHaveLength(100);
    expect(detail.messagesTruncated).toBe(true);
    expect(detail.historyTruncated).toBe(true);
  });
  it("rolls back prepared customer effects after active ownership is revoked", async () => {
    const owner = await member(),
      c = await create(owner),
      requestId = newId();
    const prepared = await prepareSupportCommand(
      db,
      owner,
      "support.case.close",
      { caseId: c.caseId, version: 1 },
      requestId,
    );
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(owner.accountId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await db
        .prepare("SELECT 1 FROM governance_audit_events WHERE request_id=?")
        .bind(requestId)
        .first(),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT status,version FROM support_cases WHERE id=?")
        .bind(c.caseId)
        .first(),
    ).toMatchObject({ status: "OPEN", version: 1 });
  });

  it("validates bounded strict commands without contextual authority", () => {
    for (const body of [
      { subject: " ", body: "hello" },
      { subject: "subject", body: "hello", staff: true },
      { subject: "subject", body: "hello", vehicleId: newId() },
      { subject: "subject", body: "x".repeat(4001) },
    ])
      expect(() =>
        parseSupportCommand("support.case.create", body as unknown as Json),
      ).toThrow();
  });
  it("isolates owners, cursors and staff with current MFA and exact roles", async () => {
    const owner = await member(),
      other = await member(),
      staff = await member(true),
      c = await create(owner);
    await expect(getSupportCase(db, other, c.caseId)).rejects.toMatchObject({
      code: "SUPPORT_NOT_FOUND",
    });
    await expect(
      listSupportCases(db, other, { cursor: c.caseId }),
    ).rejects.toMatchObject({ code: "SUPPORT_NOT_FOUND" });
    await expect(
      getSupportCase(db, { ...staff, mfaEnabled: false }, c.caseId, {
        staff: true,
      }),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(
      listSupportCases(db, { ...other, mfaEnabled: true }, { staff: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      listSupportCases(db, { ...owner, personId: other.personId }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCOUNT_UNAVAILABLE" });
    expect(
      (await getSupportCase(db, staff, c.caseId, { staff: true })).messages,
    ).toHaveLength(1);
  });
  it("supports assignment, replies, closure and own previous-case reference with immutable records", async () => {
    const owner = await member(),
      staff = await member(true),
      c = await create(owner);
    const assigned = await command(staff, "support.case.assign", {
      caseId: c.caseId,
      version: 1,
      staff: true,
      assigneePersonId: staff.personId,
    });
    expect(assigned.status).toBe("ASSIGNED");
    await command(owner, "support.case.reply", {
      caseId: c.caseId,
      version: 2,
      body: "Customer reply",
    });
    await command(staff, "support.case.reply", {
      caseId: c.caseId,
      version: 3,
      staff: true,
      body: "Staff reply",
    });
    await command(owner, "support.case.close", {
      caseId: c.caseId,
      version: 4,
      resolution: "Resolved",
    });
    const detail = await getSupportCase(db, owner, c.caseId);
    expect(detail).toMatchObject({
      status: "CLOSED",
      version: 5,
      closedByAccountId: owner.accountId,
      resolution: "Resolved",
    });
    expect(detail.messages).toHaveLength(3);
    expect(detail.history).toHaveLength(5);
    await expect(
      db
        .prepare(
          "INSERT INTO support_case_history(id,case_id,actor_account_id,action) VALUES(?,?,?,'CLOSE')",
        )
        .bind(newId(), c.caseId, owner.accountId)
        .run(),
    ).rejects.toThrow("SUPPORT_HISTORY_BOUNDARY");
    expect((await getSupportCase(db, owner, c.caseId)).history).toHaveLength(5);
    await expect(
      command(owner, "support.case.reply", {
        caseId: c.caseId,
        version: 5,
        body: "Late",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      db
        .prepare("UPDATE support_messages SET body='overwrite' WHERE case_id=?")
        .bind(c.caseId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM support_case_history WHERE case_id=?")
        .bind(c.caseId)
        .run(),
    ).rejects.toThrow();
    const follow = await command(owner, "support.case.create", {
      subject: "Follow up",
      body: "New request",
      previousCaseId: c.caseId,
    });
    expect(
      (await getSupportCase(db, owner, follow.caseId)).previousCaseId,
    ).toBe(c.caseId);
    await expect(
      command(await member(), "support.case.create", {
        subject: "Other",
        body: "request",
        previousCaseId: c.caseId,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_NOT_FOUND" });
  });
  it("rolls back stale CAS including audit, messages, outbox and replay", async () => {
    const owner = await member(),
      c = await create(owner),
      requestId = newId(),
      body = { caseId: c.caseId, version: 1, body: "Stale private text" };
    const prepared = await prepareSupportCommand(
        db,
        owner,
        "support.case.reply",
        body,
        requestId,
      ),
      scope = buildIdempotencyScope({
        accountId: owner.accountId,
        operation: "support.case.reply",
      });
    await command(owner, "support.case.reply", {
      caseId: c.caseId,
      version: 1,
      body: "First wins",
    });
    await expect(
      commitIdempotentCommand(
        db,
        scope,
        "stale-case-reply",
        body,
        requestId,
        prepared,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readReplay(db, scope, "stale-case-reply", body)).toBeNull();
    for (const table of [
      "governance_audit_events",
      "integration_outbox_events",
    ])
      expect(
        await db
          .prepare(`SELECT 1 FROM ${table} WHERE request_id=?`)
          .bind(requestId)
          .first(),
      ).toBeNull();
    expect(
      (await getSupportCase(db, owner, c.caseId)).messages.map((m) => m.body),
    ).toEqual(["Private message", "First wins"]);
  });
  it("rechecks revoked staff and assignee authority at commit", async () => {
    const owner = await member(),
      staff = await member(true),
      assignee = await member(true),
      c = await create(owner);
    const prepared = await prepareSupportCommand(
      db,
      staff,
      "support.case.assign",
      {
        caseId: c.caseId,
        version: 1,
        staff: true,
        assigneePersonId: assignee.personId,
      },
      newId(),
    );
    await db
      .prepare("DELETE FROM platform_person_roles WHERE person_id=?")
      .bind(assignee.personId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toMatchObject({
      status: 409,
    });
    const reply = await prepareSupportCommand(
      db,
      staff,
      "support.case.reply",
      { caseId: c.caseId, version: 1, staff: true, body: "Staff" },
      newId(),
    );
    await db
      .prepare("UPDATE auth_two_factors SET verified=0 WHERE user_id=?")
      .bind(staff.accountId)
      .run();
    await expect(commitPreparedCommand(db, reply)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      getSupportCase(db, staff, c.caseId, { staff: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      command(owner, "support.case.create", {
        subject: "Follow up",
        body: "request",
        previousCaseId: c.caseId,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_STATE_CONFLICT" });
    expect((await getSupportCase(db, owner, c.caseId)).version).toBe(1);
  });
  it("records atomic replay and redacts private body and resolution from event/audit", async () => {
    const owner = await member(),
      requestId = newId(),
      body = { subject: "Secret subject", body: "Secret body" },
      scope = buildIdempotencyScope({
        accountId: owner.accountId,
        operation: "support.case.create",
      });
    const response = await commitIdempotentCommand(
      db,
      scope,
      "create-support-once",
      body,
      requestId,
      await prepareSupportCommand(
        db,
        owner,
        "support.case.create",
        body,
        requestId,
      ),
    );
    expect(
      (await readReplay(db, scope, "create-support-once", body))?.response,
    ).toEqual(response);
    const event = await db
      .prepare(
        "SELECT payload_json FROM integration_outbox_events WHERE request_id=?",
      )
      .bind(requestId)
      .first<{ payload_json: string }>();
    expect(event!.payload_json).not.toContain("Secret");
    await db
      .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
      .bind(owner.accountId)
      .run();
    await expect(
      authorizeSupportCommand(db, owner, "support.case.create", body),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCOUNT_UNAVAILABLE" });
  });
});
