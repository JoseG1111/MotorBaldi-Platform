import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  outboxStatement,
  type EventRegistry,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";

type Actor = Principal & { personId: string };
const id = z.string().uuid();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v));
const base = {
  caseId: id,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  staff: z.boolean().optional().default(false),
};
const schemas = {
  "support.case.create": z
    .object({
      subject: text(200),
      body: text(4000),
      previousCaseId: id.nullable().optional().default(null),
      staff: z.literal(false).optional().default(false),
    })
    .strict(),
  "support.case.reply": z.object({ ...base, body: text(4000) }).strict(),
  "support.case.assign": z
    .object({ ...base, staff: z.literal(true), assigneePersonId: id })
    .strict(),
  "support.case.close": z
    .object({
      ...base,
      resolution: text(2000).nullable().optional().default(null),
    })
    .strict(),
};
export type SupportOperation = keyof typeof schemas;
export function parseSupportCommand(
  operation: string,
  request: Json,
): Record<string, Json> {
  if (!Object.hasOwn(schemas, operation))
    throw new Problem(
      400,
      "UNKNOWN_SUPPORT_OPERATION",
      "Unknown support operation",
    );
  const result = schemas[operation as SupportOperation].safeParse(request);
  if (!result.success)
    throw new Problem(
      400,
      "INVALID_SUPPORT_COMMAND",
      "Invalid support command",
    );
  return result.data;
}
const active = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE')`;
const staffRole = `EXISTS(SELECT 1 FROM platform_person_roles pr JOIN authz_roles r ON r.id=pr.role_id WHERE pr.person_id=? AND r.scope='PLATFORM' AND r.code IN ('SUPPORT_AGENT','PLATFORM_SUPERADMIN') AND EXISTS(SELECT 1 FROM iam_accounts a JOIN auth_users u ON u.id=a.id JOIN auth_two_factors tf ON tf.user_id=u.id WHERE a.person_id=pr.person_id AND a.status='ACTIVE' AND u.email_verified=1 AND u.two_factor_enabled=1 AND tf.verified=1))`;
const eligible = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id JOIN platform_person_roles pr ON pr.person_id=p.id JOIN authz_roles r ON r.id=pr.role_id WHERE p.id=? AND p.status='ACTIVE' AND a.status='ACTIVE' AND EXISTS(SELECT 1 FROM auth_users u WHERE u.id=a.id AND u.email_verified=1 AND u.two_factor_enabled=1 AND EXISTS(SELECT 1 FROM auth_two_factors tf WHERE tf.user_id=u.id AND tf.verified=1)) AND r.scope='PLATFORM' AND r.code IN ('SUPPORT_AGENT','PLATFORM_SUPERADMIN'))`;
async function requireActor(db: D1Database, actor: Actor, staff: boolean) {
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${active}`)
      .bind(actor.accountId, actor.personId)
      .first())
  )
    throw new Problem(
      403,
      "SUPPORT_ACCOUNT_UNAVAILABLE",
      "Support account unavailable",
    );
  if (staff) {
    if (!actor.mfaEnabled)
      throw new Problem(
        403,
        "MFA_REQUIRED",
        "Multi-factor authentication required",
      );
    if (
      !(await db
        .prepare(`SELECT 1 WHERE ${staffRole}`)
        .bind(actor.personId)
        .first())
    )
      throw new Problem(403, "FORBIDDEN", "Access denied");
  }
}
async function caseRow(
  db: D1Database,
  actor: Actor,
  caseId: string,
  staff: boolean,
) {
  const row = await db
    .prepare(
      `SELECT * FROM support_cases WHERE id=? ${staff ? "" : "AND account_id=?"}`,
    )
    .bind(caseId, ...(!staff ? [actor.accountId] : []))
    .first<SupportRow>();
  if (!row)
    throw new Problem(404, "SUPPORT_NOT_FOUND", "Support case unavailable");
  return row;
}
export async function authorizeSupportCommand(
  db: D1Database,
  actor: Actor,
  operation: SupportOperation,
  request: Record<string, Json>,
) {
  const body = parseSupportCommand(operation, request),
    staff = body.staff === true;
  await requireActor(db, actor, staff);
  if (operation === "support.case.create") {
    if (body.previousCaseId) {
      const prior = await caseRow(
        db,
        actor,
        String(body.previousCaseId),
        false,
      );
      if (prior.status !== "CLOSED")
        throw new Problem(
          409,
          "SUPPORT_STATE_CONFLICT",
          "Previous support case must be closed",
        );
    }
  } else await caseRow(db, actor, String(body.caseId), staff);
  if (
    operation === "support.case.assign" &&
    !(await db
      .prepare(`SELECT 1 WHERE ${eligible}`)
      .bind(String(body.assigneePersonId))
      .first())
  )
    throw new Problem(
      403,
      "SUPPORT_ASSIGNEE_UNAVAILABLE",
      "Support assignee unavailable",
    );
}
export const supportCommandEventRegistry: EventRegistry = new Map(
  Object.keys(schemas).map((operation) => [
    `${operation}.v1:1`,
    {
      aggregateType: "support",
      version: 1,
      payload: z.object({ caseId: id, accountId: id }).strict(),
      externalEffect: "IDEMPOTENT" as const,
    },
  ]),
);
export async function prepareSupportCommand(
  db: D1Database,
  actor: Actor,
  operation: SupportOperation,
  request: Record<string, Json>,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = parseSupportCommand(operation, request);
  await authorizeSupportCommand(db, actor, operation, body);
  const caseId =
      operation === "support.case.create" ? newId() : String(body.caseId),
    now = utcNow(),
    statements: D1PreparedStatement[] = [];
  let accountId = actor.accountId,
    version = 1,
    status = "OPEN";
  const staff = body.staff === true;
  const authority = `${active}${staff ? ` AND ${staffRole}` : ""}`;
  const actorBindings = [
    actor.accountId,
    actor.personId,
    ...(staff ? [actor.personId] : []),
  ];
  if (operation === "support.case.create") {
    statements.push(
      db
        .prepare(
          `INSERT INTO support_cases(id,account_id,previous_case_id,subject,status,version,created_at,updated_at,last_actor_account_id) SELECT ?,?,?,?,'OPEN',1,?,?,? WHERE ${active} AND (? IS NULL OR EXISTS(SELECT 1 FROM support_cases WHERE id=? AND account_id=?))`,
        )
        .bind(
          caseId,
          actor.accountId,
          body.previousCaseId as string | null,
          String(body.subject),
          now,
          now,
          actor.accountId,
          ...actorBindings,
          body.previousCaseId as string | null,
          body.previousCaseId as string | null,
          actor.accountId,
        ),
    );
  } else {
    const current = await caseRow(db, actor, caseId, staff);
    accountId = current.account_id;
    version = Number(body.version) + 1;
    status =
      operation === "support.case.close"
        ? "CLOSED"
        : operation === "support.case.assign"
          ? "ASSIGNED"
          : current.status;
    let set =
      "version=version+1,updated_at=?,last_actor_account_id=?,last_action_staff=?";
    const values: (string | number | null)[] = [
      now,
      actor.accountId,
      staff ? 1 : 0,
    ];
    if (operation === "support.case.assign") {
      set += ",status='ASSIGNED',assignee_person_id=?";
      values.push(String(body.assigneePersonId));
    }
    if (operation === "support.case.close") {
      set += ",status='CLOSED',closed_at=?,closed_by_account_id=?,resolution=?";
      values.push(now, actor.accountId, body.resolution as string | null);
    }
    statements.push(
      db
        .prepare(
          `UPDATE support_cases SET ${set} WHERE id=? AND version=? AND status IN ('OPEN','ASSIGNED') ${staff ? "" : "AND account_id=?"} AND ${authority} ${operation === "support.case.assign" ? `AND ${eligible}` : ""}`,
        )
        .bind(
          ...values,
          caseId,
          Number(body.version),
          ...(!staff ? [actor.accountId] : []),
          ...actorBindings,
          ...(operation === "support.case.assign"
            ? [String(body.assigneePersonId)]
            : []),
        ),
    );
  }
  // This guard immediately follows the CAS write, before any append can mask changes().
  statements.push(
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) VALUES(?,?,?,'support',CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
      )
      .bind(newId(), actor.accountId, operation, caseId, requestId),
  );
  if (operation === "support.case.create" || operation === "support.case.reply")
    statements.push(
      db
        .prepare(
          "INSERT INTO support_messages(id,case_id,actor_account_id,body,created_at) VALUES(?,?,?,?,?)",
        )
        .bind(newId(), caseId, actor.accountId, String(body.body), now),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO support_case_history(id,case_id,actor_account_id,action,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(
        newId(),
        caseId,
        actor.accountId,
        operation.split(".").at(-1)!.toUpperCase(),
        now,
      ),
  );
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "support",
        aggregateId: caseId,
        eventType: `${operation}.v1`,
        eventVersion: 1,
        payload: { caseId, accountId },
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      supportCommandEventRegistry,
    ).statement,
  );
  return {
    statements,
    response: { caseId, version, status },
    guard: {
      table: "governance_audit_events",
      column: "resource_id",
      code: "SUPPORT_VERSION_CONFLICT",
      message: "Support state changed; refresh and retry",
    },
    recover: async (error) => {
      if (/SUPPORT_|constraint failed/.test(String(error)))
        throw new Problem(
          409,
          "SUPPORT_STATE_CONFLICT",
          "Support state or authority changed; refresh and retry",
        );
      return null;
    },
  };
}
type SupportRow = {
  id: string;
  account_id: string;
  previous_case_id: string | null;
  subject: string;
  status: string;
  assignee_person_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by_account_id: string | null;
  resolution: string | null;
};
function present(row: SupportRow) {
  return {
    caseId: row.id,
    accountId: row.account_id,
    previousCaseId: row.previous_case_id,
    subject: row.subject,
    status: row.status,
    assigneePersonId: row.assignee_person_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedByAccountId: row.closed_by_account_id,
    resolution: row.resolution,
  };
}
export async function listSupportCases(
  db: D1Database,
  actor: Actor,
  options: { staff?: boolean; cursor?: string; limit?: number } = {},
) {
  const parsed = z
    .object({
      staff: z.boolean().default(false),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict()
    .safeParse(options);
  if (!parsed.success)
    throw new Problem(400, "INVALID_SUPPORT_CURSOR", "Invalid support cursor");
  const { staff, cursor, limit } = parsed.data;
  await requireActor(db, actor, staff);
  const after = cursor ? await caseRow(db, actor, cursor, staff) : null;
  const rows = (
    await db
      .prepare(
        `SELECT * FROM support_cases WHERE ${staff ? "1=1" : "account_id=?"} ${after ? "AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        ...(!staff ? [actor.accountId] : []),
        ...(after ? [after.created_at, after.created_at, after.id] : []),
        limit + 1,
      )
      .all<SupportRow>()
  ).results;
  return {
    items: rows.slice(0, limit).map(present),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}
export async function getSupportCase(
  db: D1Database,
  actor: Actor,
  caseId: string,
  options: { staff?: boolean } = {},
) {
  const parsed = z
    .object({ caseId: id, staff: z.boolean().default(false) })
    .strict()
    .safeParse({ caseId, ...options });
  if (!parsed.success)
    throw new Problem(
      400,
      "INVALID_SUPPORT_COMMAND",
      "Invalid support request",
    );
  await requireActor(db, actor, parsed.data.staff);
  const row = await caseRow(db, actor, caseId, parsed.data.staff);
  const messages = (
    await db
      .prepare(
        "SELECT id,actor_account_id,body,created_at FROM support_messages WHERE case_id=? ORDER BY created_at DESC,id DESC LIMIT 101",
      )
      .bind(caseId)
      .all<{
        id: string;
        actor_account_id: string;
        body: string;
        created_at: string;
      }>()
  ).results;
  const history = (
    await db
      .prepare(
        "SELECT id,actor_account_id,action,created_at FROM support_case_history WHERE case_id=? ORDER BY created_at DESC,id DESC LIMIT 101",
      )
      .bind(caseId)
      .all<{
        id: string;
        actor_account_id: string;
        action: string;
        created_at: string;
      }>()
  ).results;
  return {
    ...present(row),
    messagesTruncated: messages.length > 100,
    historyTruncated: history.length > 100,
    messages: messages
      .slice(0, 100)
      .reverse()
      .map((m) => ({
        id: m.id,
        actorAccountId: m.actor_account_id,
        body: m.body,
        createdAt: m.created_at,
      })),
    history: history
      .slice(0, 100)
      .reverse()
      .map((h) => ({
        id: h.id,
        actorAccountId: h.actor_account_id,
        action: h.action,
        createdAt: h.created_at,
      })),
  };
}
