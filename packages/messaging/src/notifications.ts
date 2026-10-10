import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  outboxStatement,
  type EventRegistry,
  type PreparedCommand,
} from "@motorbaldi/db";
import { newId, utcNow, type Json } from "@motorbaldi/shared";

type Actor = Principal & { personId: string };
const category = z.enum(["TRANSACTIONAL", "SUPPORT", "MARKETING"]);
const channel = z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"]);
const id = z.string().uuid();
const preferenceInput = z
  .object({
    category,
    channel,
    enabled: z.boolean(),
    contactMethodId: id.nullable().optional().default(null),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (v) =>
      !(v.category === "MARKETING" && v.channel === "IN_APP") &&
      (v.channel !== "IN_APP" || v.contactMethodId === null) &&
      (!v.enabled || v.channel === "IN_APP" || v.contactMethodId !== null),
  );
const inboxReadInput = z
  .object({
    notificationId: id,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NotificationOperation =
  "notification.preference.update" | "notification.inbox.read";
export function parseNotificationCommand(
  operation: string,
  request: Json,
): Record<string, Json> {
  const schema =
    operation === "notification.preference.update"
      ? preferenceInput
      : operation === "notification.inbox.read"
        ? inboxReadInput
        : null;
  if (!schema)
    throw new Problem(
      400,
      "UNKNOWN_NOTIFICATION_OPERATION",
      "Unknown notification operation",
    );
  const parsed = schema.safeParse(request);
  if (!parsed.success)
    throw new Problem(
      400,
      "INVALID_NOTIFICATION_COMMAND",
      "Invalid notification command",
    );
  return parsed.data;
}
const activeActor = `EXISTS(SELECT 1 FROM iam_accounts a JOIN iam_people p ON p.id=a.person_id WHERE a.id=? AND a.person_id=? AND a.status='ACTIVE' AND p.status='ACTIVE')`;
async function requireActiveActor(db: D1Database, actor: Actor) {
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${activeActor}`)
      .bind(actor.accountId, actor.personId)
      .first())
  )
    throw new Problem(
      403,
      "NOTIFICATION_ACCOUNT_UNAVAILABLE",
      "Notification account unavailable",
    );
}
async function requireContact(
  db: D1Database,
  actor: Actor,
  selected: string,
  currentChannel: string,
  verified: boolean,
) {
  const contact = await db
    .prepare(
      `SELECT 1 FROM iam_contact_methods c WHERE c.id=? AND c.person_id=? AND c.type=? ${verified ? "AND c.verification_status='VERIFIED' AND c.verified_at IS NOT NULL AND (c.source<>'AUTH' OR EXISTS(SELECT 1 FROM auth_users u WHERE u.id=? AND u.email_verified=1 AND c.type='EMAIL' AND lower(trim(u.email))=c.normalized_value))" : ""}`,
    )
    .bind(
      selected,
      actor.personId,
      currentChannel === "EMAIL" ? "EMAIL" : "PHONE",
      ...(verified ? [actor.accountId] : []),
    )
    .first();
  if (!contact)
    throw new Problem(
      404,
      "NOTIFICATION_CONTACT_UNAVAILABLE",
      "Notification contact unavailable",
    );
}
async function requireMarketingConsent(
  db: D1Database,
  actor: Actor,
  currentChannel: string,
) {
  const consent = await db
    .prepare(
      "SELECT status,occurred_at FROM iam_consent_events WHERE person_id=? AND purpose=? ORDER BY occurred_at DESC,id DESC LIMIT 1",
    )
    .bind(actor.personId, `MARKETING_${currentChannel}`)
    .first<{ status: string; occurred_at: string }>();
  if (consent?.status !== "GRANTED" || consent.occurred_at > utcNow())
    throw new Problem(
      403,
      "NOTIFICATION_CONSENT_REQUIRED",
      "Current channel consent required",
    );
}
export async function authorizeNotificationCommand(
  db: D1Database,
  actor: Actor,
  operation: NotificationOperation,
  request: Record<string, Json>,
) {
  const body = parseNotificationCommand(operation, request);
  await requireActiveActor(db, actor);
  if (operation === "notification.inbox.read") {
    if (
      !(await db
        .prepare("SELECT 1 FROM notification_inbox WHERE id=? AND account_id=?")
        .bind(String(body.notificationId), actor.accountId)
        .first())
    )
      throw new Problem(
        404,
        "NOTIFICATION_NOT_FOUND",
        "Notification unavailable",
      );
  } else {
    if (body.contactMethodId)
      await requireContact(
        db,
        actor,
        String(body.contactMethodId),
        String(body.channel),
        body.enabled === true,
      );
    if (body.enabled === true && body.category === "MARKETING")
      await requireMarketingConsent(db, actor, String(body.channel));
  }
}
export const notificationCommandEventRegistry: EventRegistry = new Map([
  [
    "notification.preference.changed.v1:1",
    {
      aggregateType: "notification",
      version: 1,
      payload: z.object({ preferenceId: id, accountId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "notification.inbox.read.v1:1",
    {
      aggregateType: "notification",
      version: 1,
      payload: z.object({ notificationId: id, accountId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
function auditGuard(
  db: D1Database,
  actor: Actor,
  operation: string,
  resourceId: string,
  requestId: string,
) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) VALUES(?,?,?,'notification',CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
    )
    .bind(newId(), actor.accountId, operation, resourceId, requestId);
}
export async function prepareNotificationCommand(
  db: D1Database,
  actor: Actor,
  operation: NotificationOperation,
  request: Record<string, Json>,
  requestId: string,
): Promise<PreparedCommand<Json>> {
  const body = parseNotificationCommand(operation, request);
  await authorizeNotificationCommand(db, actor, operation, body);
  const statements: D1PreparedStatement[] = [],
    now = utcNow();
  let resourceId: string,
    response: Json,
    eventType: string,
    payload: Record<string, Json>;
  if (operation === "notification.preference.update") {
    const current = await db
      .prepare(
        "SELECT id,version FROM notification_preferences WHERE account_id=? AND category=? AND channel=?",
      )
      .bind(actor.accountId, String(body.category), String(body.channel))
      .first<{ id: string; version: number }>();
    resourceId = current?.id ?? newId();
    const expected = Number(body.version);
    if (expected === 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO notification_preferences(id,account_id,category,channel,enabled,contact_method_id) SELECT ?,?,?,?,?,? WHERE ${activeActor}`,
          )
          .bind(
            resourceId,
            actor.accountId,
            String(body.category),
            String(body.channel),
            body.enabled ? 1 : 0,
            body.contactMethodId as string | null,
            actor.accountId,
            actor.personId,
          ),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE notification_preferences SET enabled=?,contact_method_id=?,version=version+1,updated_at=? WHERE id=? AND account_id=? AND category=? AND channel=? AND version=? AND ${activeActor}`,
          )
          .bind(
            body.enabled ? 1 : 0,
            body.contactMethodId as string | null,
            now,
            resourceId,
            actor.accountId,
            String(body.category),
            String(body.channel),
            expected,
            actor.accountId,
            actor.personId,
          ),
      );
    }
    response = {
      preferenceId: resourceId,
      category: body.category!,
      channel: body.channel!,
      enabled: body.enabled!,
      contactMethodId: body.contactMethodId!,
      version: expected + 1,
      externalAvailable: false,
    };
    eventType = "notification.preference.changed.v1";
    payload = { preferenceId: resourceId, accountId: actor.accountId };
  } else {
    resourceId = String(body.notificationId);
    const row = await db
      .prepare(
        "SELECT version,read_at FROM notification_inbox WHERE id=? AND account_id=?",
      )
      .bind(resourceId, actor.accountId)
      .first<{ version: number; read_at: string | null }>();
    if (row?.read_at && row.version === body.version)
      return {
        statements: [],
        response: {
          notificationId: resourceId,
          read: true,
          readAt: row.read_at,
          version: row.version,
        },
      };
    statements.push(
      db
        .prepare(
          `UPDATE notification_inbox SET read_at=?,version=version+1 WHERE id=? AND account_id=? AND version=? AND read_at IS NULL AND ${activeActor}`,
        )
        .bind(
          now,
          resourceId,
          actor.accountId,
          Number(body.version),
          actor.accountId,
          actor.personId,
        ),
    );
    response = {
      notificationId: resourceId,
      read: true,
      readAt: now,
      version: Number(body.version) + 1,
    };
    eventType = "notification.inbox.read.v1";
    payload = { notificationId: resourceId, accountId: actor.accountId };
  }
  statements.push(auditGuard(db, actor, operation, resourceId, requestId));
  statements.push(
    outboxStatement(
      db,
      {
        aggregateType: "notification",
        aggregateId: resourceId,
        eventType,
        eventVersion: 1,
        payload,
        requestId,
        externalEffectPolicy: "IDEMPOTENT",
      },
      notificationCommandEventRegistry,
    ).statement,
  );
  return {
    statements,
    response,
    guard: {
      table: "governance_audit_events",
      column: "resource_id",
      code: "NOTIFICATION_VERSION_CONFLICT",
      message: "Notification state changed; refresh and retry",
    },
    recover: async (error) => {
      if (
        String(error).includes("NOTIFICATION_") ||
        String(error).includes("constraint failed")
      )
        throw new Problem(
          409,
          "NOTIFICATION_STATE_CONFLICT",
          "Notification state or authority changed; refresh and retry",
        );
      return null;
    },
  };
}

/** Saved external preferences record intent; no configured delivery transport exists. */
export async function listNotificationPreferences(
  db: D1Database,
  actor: Actor,
) {
  await requireActiveActor(db, actor);
  const saved = (
    await db
      .prepare(
        "SELECT id,category,channel,enabled,contact_method_id,version FROM notification_preferences WHERE account_id=?",
      )
      .bind(actor.accountId)
      .all<{
        id: string;
        category: string;
        channel: string;
        enabled: number;
        contact_method_id: string | null;
        version: number;
      }>()
  ).results;
  const items = [];
  for (const currentCategory of [
    "TRANSACTIONAL",
    "SUPPORT",
    "MARKETING",
  ] as const)
    for (const currentChannel of [
      "IN_APP",
      "EMAIL",
      "SMS",
      "WHATSAPP",
    ] as const) {
      if (currentCategory === "MARKETING" && currentChannel === "IN_APP")
        continue;
      const row = saved.find(
        (r) => r.category === currentCategory && r.channel === currentChannel,
      );
      const enabled = row ? row.enabled === 1 : currentChannel === "IN_APP";
      let effectiveEnabled = enabled;
      if (enabled && currentChannel !== "IN_APP") {
        try {
          if (!row?.contact_method_id) effectiveEnabled = false;
          else
            await requireContact(
              db,
              actor,
              row.contact_method_id,
              currentChannel,
              true,
            );
          if (currentCategory === "MARKETING")
            await requireMarketingConsent(db, actor, currentChannel);
        } catch {
          effectiveEnabled = false;
        }
      }
      items.push({
        id: row?.id ?? null,
        category: currentCategory,
        channel: currentChannel,
        enabled,
        contactMethodId: row?.contact_method_id ?? null,
        version: row?.version ?? 0,
        effectiveEnabled,
        externalAvailable: false,
      });
    }
  return { items, externalDeliveryAvailable: false };
}

/** UUID cursor belongs to this inbox; other accounts' cursors cannot probe their notifications. */
export async function listNotificationInbox(
  db: D1Database,
  actor: Actor,
  options: { cursor?: string; limit?: number } = {},
) {
  await requireActiveActor(db, actor);
  const parsed = z
    .object({
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict()
    .safeParse(options);
  if (!parsed.success)
    throw new Problem(
      400,
      "INVALID_NOTIFICATION_CURSOR",
      "Invalid notification cursor",
    );
  let cursor: { created_at: string; id: string } | null = null;
  if (parsed.data.cursor) {
    cursor = await db
      .prepare(
        "SELECT id,created_at FROM notification_inbox WHERE id=? AND account_id=?",
      )
      .bind(parsed.data.cursor, actor.accountId)
      .first();
    if (!cursor)
      throw new Problem(
        404,
        "NOTIFICATION_NOT_FOUND",
        "Notification unavailable",
      );
  }
  const rows = (
    await db
      .prepare(
        `SELECT i.id,i.template_code,i.template_version,i.locale,i.parameters_json,i.read_at,i.version,i.created_at,t.title,t.body FROM notification_inbox i JOIN notification_template_versions t ON t.code=i.template_code AND t.version=i.template_version AND t.locale=i.locale WHERE i.account_id=? ${cursor ? "AND (i.created_at<? OR (i.created_at=? AND i.id<?))" : ""} ORDER BY i.created_at DESC,i.id DESC LIMIT ?`,
      )
      .bind(
        actor.accountId,
        ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []),
        parsed.data.limit + 1,
      )
      .all<{
        id: string;
        template_code: string;
        template_version: number;
        locale: string;
        parameters_json: string;
        read_at: string | null;
        version: number;
        created_at: string;
        title: string;
        body: string;
      }>()
  ).results;
  const page = rows.slice(0, parsed.data.limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      templateCode: row.template_code,
      templateVersion: row.template_version,
      locale: row.locale,
      title: row.title,
      body: row.body,
      parameters: JSON.parse(row.parameters_json) as Record<string, Json>,
      readAt: row.read_at,
      version: row.version,
      createdAt: row.created_at,
    })),
    nextCursor: rows.length > parsed.data.limit ? page.at(-1)!.id : null,
  };
}

/** Current authority callback for a future transport. Present policy always reports external unavailability. */
export async function authorizeNotificationDelivery(
  db: D1Database,
  input: {
    accountId: string;
    personId: string;
    category: "TRANSACTIONAL" | "SUPPORT" | "MARKETING";
    channel: "EMAIL" | "SMS" | "WHATSAPP";
    contactMethodId: string;
  },
) {
  const parsed = z
    .object({
      accountId: id,
      personId: id,
      category,
      channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
      contactMethodId: id,
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw new Problem(
      400,
      "INVALID_NOTIFICATION_COMMAND",
      "Invalid notification delivery authority",
    );
  input = parsed.data;
  const actor: Actor = {
    accountId: input.accountId,
    personId: input.personId,
    mfaEnabled: false,
  };
  await requireActiveActor(db, actor);
  const pref = await db
    .prepare(
      "SELECT enabled,contact_method_id FROM notification_preferences WHERE account_id=? AND category=? AND channel=?",
    )
    .bind(input.accountId, input.category, input.channel)
    .first<{ enabled: number; contact_method_id: string | null }>();
  if (pref?.enabled !== 1 || pref.contact_method_id !== input.contactMethodId)
    throw new Problem(
      403,
      "NOTIFICATION_PREFERENCE_DISABLED",
      "Notification preference disabled",
    );
  await requireContact(db, actor, input.contactMethodId, input.channel, true);
  if (input.category === "MARKETING")
    await requireMarketingConsent(db, actor, input.channel);
  return {
    status: "UNAVAILABLE" as const,
    code: "TRANSPORT_UNAVAILABLE" as const,
  };
}
