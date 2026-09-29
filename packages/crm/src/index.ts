import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import {
  auditStatement,
  guardedBatch,
  outboxStatement,
  type EventRegistry,
} from "@motorbaldi/db";
import { normalizeEmail, type PersonInput } from "@motorbaldi/identity";
import { newId, utcNow } from "@motorbaldi/shared";

const id = z.string().uuid();
async function requireActiveCrmAssignee(db: D1Database, personId: string) {
  const row = await db
    .prepare(
      "SELECT 1 FROM iam_people p JOIN iam_accounts a ON a.person_id=p.id AND a.status='ACTIVE' JOIN platform_person_roles pr ON pr.person_id=p.id JOIN authz_roles r ON r.id=pr.role_id AND r.scope='PLATFORM' JOIN authz_role_permissions rp ON rp.role_id=r.id WHERE p.id=? AND p.status='ACTIVE' AND rp.permission_code='platform.crm.manage' LIMIT 1",
    )
    .bind(personId)
    .first();
  if (!row)
    throw new Problem(400, "INVALID_CRM_ASSIGNEE", "Active CRM staff required");
}
const optionalText = (max: number) => z.string().trim().max(max).optional();
export const leadInput = z
  .object({
    givenName: optionalText(120),
    familyName: optionalText(120),
    email: optionalText(320),
    phone: optionalText(40),
    organizationName: optionalText(240),
    message: optionalText(2000),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    utmSource: optionalText(120),
    utmMedium: optionalText(120),
    utmCampaign: optionalText(120),
    utmContent: optionalText(120),
    utmTerm: optionalText(120),
    referrer: optionalText(500),
  })
  .strict()
  .refine((v) => Boolean(v.email || v.phone), "Contact method required");
const registry: EventRegistry = new Map([
  [
    "crm.lead.received.v1:1",
    {
      aggregateType: "crm_lead",
      version: 1,
      payload: z.object({ leadId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
  [
    "crm.lead.converted.v1:1",
    {
      aggregateType: "crm_lead",
      version: 1,
      payload: z.object({ leadId: id, opportunityId: id }),
      externalEffect: "IDEMPOTENT",
    },
  ],
]);
function event(
  db: D1Database,
  leadId: string,
  type: string,
  payload: Record<string, string>,
  requestId: string,
) {
  return outboxStatement(
    db,
    {
      aggregateType: "crm_lead",
      aggregateId: leadId,
      eventType: type,
      eventVersion: 1,
      payload,
      requestId,
      externalEffectPolicy: "IDEMPOTENT",
    },
    registry,
  ).statement;
}
export async function receiveLead(
  db: D1Database,
  input: z.infer<typeof leadInput>,
  requestId: string,
) {
  const c = leadInput.parse(input);
  const leadId = newId();
  const email = c.email ? normalizeEmail(c.email) : null;
  await db.batch([
    db
      .prepare(
        "INSERT INTO crm_lead_intakes(id,source_id,given_name,family_name,email,phone,organization_name,message,country_code,utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer,request_id) VALUES(?,'WEBSITE',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        leadId,
        c.givenName ?? null,
        c.familyName ?? null,
        email,
        c.phone ?? null,
        c.organizationName ?? null,
        c.message ?? null,
        c.countryCode ?? null,
        c.utmSource ?? null,
        c.utmMedium ?? null,
        c.utmCampaign ?? null,
        c.utmContent ?? null,
        c.utmTerm ?? null,
        c.referrer ?? null,
        requestId,
      ),
    event(db, leadId, "crm.lead.received.v1", { leadId }, requestId),
  ]);
  return leadId;
}
export async function triageLead(
  db: D1Database,
  leadId: string,
  actorPersonId: string,
  action: "TRIAGED" | "REJECTED" | "SPAM",
  requestId: string,
) {
  const result = await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE crm_lead_intakes SET status=?,triaged_at=?,assigned_to_person_id=?,version=version+1 WHERE id=? AND status='RECEIVED'",
        )
        .bind(action, utcNow(), actorPersonId, leadId),
      db
        .prepare(
          "INSERT INTO crm_lead_triage_events(lead_id,decision,actor_person_id) VALUES(?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
        )
        .bind(leadId, action, actorPersonId),
      auditStatement(db, {
        actorId: actorPersonId,
        action: "crm.lead.triaged",
        resourceType: "crm_lead",
        resourceId: leadId,
        requestId,
      }),
    ],
    {
      table: "crm_lead_triage_events",
      column: "decision",
      code: "CRM_LEAD_INVALID_STATE",
      message: "Lead unavailable",
    },
  );
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "CRM_LEAD_INVALID_STATE", "Lead unavailable");
}
export async function linkLeadPerson(
  db: D1Database,
  leadId: string,
  personId: string,
  actorPersonId: string,
  requestId: string,
) {
  const person = await db
    .prepare("SELECT status FROM iam_people WHERE id=?")
    .bind(personId)
    .first<{ status: string }>();
  if (!person || person.status === "MERGED")
    throw new Problem(404, "PERSON_NOT_FOUND", "Person unavailable");
  const result = await db.batch([
    db
      .prepare(
        "UPDATE crm_lead_intakes SET person_id=?,status='TRIAGED',triaged_at=?,assigned_to_person_id=?,version=version+1 WHERE id=? AND status IN ('RECEIVED','TRIAGED')",
      )
      .bind(personId, utcNow(), actorPersonId, leadId),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.lead.person.linked",
      requirePreviousChange: true,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "CRM_LEAD_INVALID_STATE", "Lead unavailable");
}
export async function createPersonFromLead(
  db: D1Database,
  leadId: string,
  actorPersonId: string,
  requestId: string,
) {
  const lead = await db
    .prepare(
      "SELECT given_name,family_name,email,status,person_id FROM crm_lead_intakes WHERE id=?",
    )
    .bind(leadId)
    .first<{
      given_name: string | null;
      family_name: string | null;
      email: string | null;
      status: string;
      person_id: string | null;
    }>();
  if (!lead || !["RECEIVED", "TRIAGED"].includes(lead.status) || lead.person_id)
    throw new Problem(409, "CRM_LEAD_INVALID_STATE", "Lead unavailable");
  const input: PersonInput = {
    givenName: lead.given_name || "Persona",
    familyName: lead.family_name || "Sin apellido",
    preferredLocale: "es",
  };
  const personId = newId();
  let contactEmail: string | null = null;
  if (lead.email) {
    try {
      contactEmail = normalizeEmail(lead.email);
    } catch {
      /* Invalid lead email remains only on intake. */
    }
  }
  const statements = [
    db
      .prepare(
        "INSERT INTO iam_people(id,given_name,family_name,preferred_locale) VALUES(?,?,?,?)",
      )
      .bind(personId, input.givenName, input.familyName, input.preferredLocale),
  ];
  if (contactEmail)
    statements.push(
      db
        .prepare(
          "INSERT INTO iam_contact_methods(id,person_id,type,raw_value,normalized_value,verification_status,source) VALUES(?,?,'EMAIL',?,?,'UNVERIFIED','CRM_LEAD')",
        )
        .bind(newId(), personId, lead.email, contactEmail),
    );
  statements.push(
    db
      .prepare(
        "UPDATE crm_lead_intakes SET person_id=?,status='TRIAGED',triaged_at=?,assigned_to_person_id=?,version=version+1 WHERE id=? AND person_id IS NULL AND status IN ('RECEIVED','TRIAGED')",
      )
      .bind(personId, utcNow(), actorPersonId, leadId),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id) VALUES(?,?,'identity.person.created','iam_person',CASE WHEN (SELECT person_id FROM crm_lead_intakes WHERE id=?)=? THEN ? ELSE NULL END,?)",
      )
      .bind(newId(), actorPersonId, leadId, personId, personId, requestId),
  );
  await guardedBatch(db, statements, {
    table: "governance_audit_events",
    column: "resource_id",
    code: "CRM_LEAD_INVALID_STATE",
    message: "Lead unavailable",
  });
  return personId;
}
export async function convertLead(
  db: D1Database,
  leadId: string,
  actorPersonId: string,
  pipelineId: string,
  stageId: string,
  title: string,
  requestId: string,
) {
  const lead = await db
    .prepare(
      "SELECT status,person_id,organization_id FROM crm_lead_intakes WHERE id=?",
    )
    .bind(leadId)
    .first<{
      status: string;
      person_id: string | null;
      organization_id: string | null;
    }>();
  if (lead?.status === "CONVERTED") {
    const existing = await db
      .prepare("SELECT id FROM crm_opportunities WHERE lead_intake_id=?")
      .bind(leadId)
      .first<{ id: string }>();
    if (existing) return existing.id;
  }
  if (!lead || !["RECEIVED", "TRIAGED"].includes(lead.status) || !title.trim())
    throw new Problem(409, "CRM_LEAD_INVALID_STATE", "Lead unavailable");
  const opportunityId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO crm_opportunities(id,pipeline_id,stage_id,person_id,organization_id,lead_intake_id,title,owner_person_id) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        opportunityId,
        pipelineId,
        stageId,
        lead.person_id,
        lead.organization_id,
        leadId,
        title.trim(),
        actorPersonId,
      ),
    db
      .prepare(
        "INSERT INTO crm_activities(id,type,person_id,organization_id,opportunity_id,actor_person_id,occurred_at,summary) VALUES(?,'SYSTEM_EVENT',?,?,?,?,?,'Lead converted')",
      )
      .bind(
        newId(),
        lead.person_id,
        lead.organization_id,
        opportunityId,
        actorPersonId,
        utcNow(),
      ),
    db
      .prepare(
        "UPDATE crm_lead_intakes SET status='CONVERTED',converted_at=?,version=version+1 WHERE id=? AND status IN ('RECEIVED','TRIAGED')",
      )
      .bind(utcNow(), leadId),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.lead.converted",
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
    }),
    event(
      db,
      leadId,
      "crm.lead.converted.v1",
      { leadId, opportunityId },
      requestId,
    ),
  ]);
  return opportunityId;
}
export async function moveOpportunityStage(
  db: D1Database,
  opportunityId: string,
  stageId: string,
  expectedVersion: number,
  actorPersonId: string,
  requestId: string,
) {
  const current = await db
    .prepare(
      "SELECT pipeline_id,status,version FROM crm_opportunities WHERE id=?",
    )
    .bind(opportunityId)
    .first<{ pipeline_id: string; status: string; version: number }>();
  if (!current || current.status !== "OPEN")
    throw new Problem(
      409,
      "OPPORTUNITY_INVALID_STATE",
      "Opportunity is closed or unavailable",
    );
  if (current.version !== expectedVersion)
    throw new Problem(409, "VERSION_CONFLICT", "Stale opportunity version");
  const stage = await db
    .prepare(
      "SELECT terminal_outcome FROM crm_stages WHERE id=? AND pipeline_id=? AND status='ACTIVE'",
    )
    .bind(stageId, current.pipeline_id)
    .first<{ terminal_outcome: "WON" | "LOST" | null }>();
  if (!stage)
    throw new Problem(
      409,
      "INVALID_OPPORTUNITY_STAGE",
      "Stage unavailable for pipeline",
    );
  const now = utcNow();
  const result = await guardedBatch(
    db,
    [
      db
        .prepare(
          "UPDATE crm_opportunities SET stage_id=?,status=COALESCE((SELECT terminal_outcome FROM crm_stages WHERE id=?),'OPEN'),closed_at=CASE WHEN (SELECT is_terminal FROM crm_stages WHERE id=?)=1 THEN ? ELSE NULL END,updated_at=?,version=version+1 WHERE id=? AND version=? AND status='OPEN' AND EXISTS(SELECT 1 FROM crm_stages s WHERE s.id=? AND s.pipeline_id=crm_opportunities.pipeline_id AND s.status='ACTIVE')",
        )
        .bind(
          stageId,
          stageId,
          stageId,
          now,
          now,
          opportunityId,
          expectedVersion,
          stageId,
        ),
      db
        .prepare(
          "INSERT INTO crm_opportunity_stage_events(opportunity_id,from_version,stage_id,actor_person_id) VALUES(?,?,CASE WHEN changes()=1 THEN ? ELSE NULL END,?)",
        )
        .bind(opportunityId, expectedVersion, stageId, actorPersonId),
      auditStatement(db, {
        actorId: actorPersonId,
        action: "crm.opportunity.stage.changed",
        resourceType: "crm_opportunity",
        resourceId: opportunityId,
        requestId,
      }),
    ],
    {
      table: "crm_opportunity_stage_events",
      column: "stage_id",
      code: "VERSION_CONFLICT",
      message: "Opportunity stage unavailable",
    },
  );
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "VERSION_CONFLICT", "Stale opportunity version");
}

export const activityInput = z
  .object({
    type: z.enum([
      "CALL",
      "EMAIL",
      "WHATSAPP",
      "MEETING",
      "NOTE",
      "TASK",
      "SYSTEM_EVENT",
    ]),
    personId: id.optional(),
    organizationId: id.optional(),
    opportunityId: id.optional(),
    occurredAt: z.string().datetime(),
    summary: z.string().trim().min(1).max(2000),
  })
  .strict();
export async function recordActivity(
  db: D1Database,
  actorPersonId: string,
  input: z.infer<typeof activityInput>,
) {
  const c = activityInput.parse(input);
  const activityId = newId();
  await db
    .prepare(
      "INSERT INTO crm_activities(id,type,person_id,organization_id,opportunity_id,actor_person_id,occurred_at,summary) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(
      activityId,
      c.type,
      c.personId ?? null,
      c.organizationId ?? null,
      c.opportunityId ?? null,
      actorPersonId,
      c.occurredAt,
      c.summary,
    )
    .run();
  return activityId;
}
export const noteInput = z
  .object({
    personId: id.optional(),
    organizationId: id.optional(),
    opportunityId: id.optional(),
    body: z.string().trim().min(1).max(10000),
  })
  .strict()
  .refine((c) => Boolean(c.personId || c.organizationId || c.opportunityId));
export async function createNote(
  db: D1Database,
  actorPersonId: string,
  input: z.infer<typeof noteInput>,
) {
  const c = noteInput.parse(input);
  const noteId = newId();
  await db
    .prepare(
      "INSERT INTO crm_notes(id,author_person_id,person_id,organization_id,opportunity_id,body) VALUES(?,?,?,?,?,?)",
    )
    .bind(
      noteId,
      actorPersonId,
      c.personId ?? null,
      c.organizationId ?? null,
      c.opportunityId ?? null,
      c.body,
    )
    .run();
  return noteId;
}
export const taskInput = z
  .object({
    ownerPersonId: id,
    description: z.string().trim().min(1).max(2000),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
    dueAt: z.string().datetime().optional(),
    personId: id.optional(),
    organizationId: id.optional(),
    opportunityId: id.optional(),
  })
  .strict();
export async function createTask(
  db: D1Database,
  actorPersonId: string,
  input: z.infer<typeof taskInput>,
  requestId: string,
) {
  const c = taskInput.parse(input);
  await requireActiveCrmAssignee(db, c.ownerPersonId);
  const taskId = newId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO crm_tasks(id,owner_person_id,assigned_by_person_id,due_at,priority,description,person_id,organization_id,opportunity_id) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        taskId,
        c.ownerPersonId,
        actorPersonId,
        c.dueAt ?? null,
        c.priority,
        c.description,
        c.personId ?? null,
        c.organizationId ?? null,
        c.opportunityId ?? null,
      ),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.task.created",
      resourceType: "crm_task",
      resourceId: taskId,
      requestId,
    }),
  ]);
  return taskId;
}
export async function updateTask(
  db: D1Database,
  actorPersonId: string,
  taskId: string,
  input: {
    status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
    version: number;
  },
  requestId: string,
) {
  const c = z
    .object({
      status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
      version: z.number().int().positive(),
    })
    .strict()
    .parse(input);
  const result = await db.batch([
    db
      .prepare(
        "UPDATE crm_tasks SET status=?,completed_at=CASE WHEN ?='COMPLETED' THEN ? ELSE NULL END,updated_at=?,version=version+1 WHERE id=? AND version=?",
      )
      .bind(c.status, c.status, utcNow(), utcNow(), taskId, c.version),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.task.updated",
      requirePreviousChange: true,
      resourceType: "crm_task",
      resourceId: taskId,
      requestId,
    }),
  ]);
  if (result[0]?.meta.changes !== 1)
    throw new Problem(409, "VERSION_CONFLICT", "Stale task version");
  return c.version + 1;
}
export async function assignLead(
  db: D1Database,
  actorPersonId: string,
  leadId: string,
  targetPersonId: string,
  requestId: string,
) {
  await requireActiveCrmAssignee(db, targetPersonId);
  const current = await db
    .prepare("SELECT assigned_to_person_id FROM crm_lead_intakes WHERE id=?")
    .bind(leadId)
    .first<{ assigned_to_person_id: string | null }>();
  if (!current)
    throw new Problem(404, "CRM_LEAD_NOT_FOUND", "Lead unavailable");
  await db.batch([
    db
      .prepare(
        "UPDATE crm_lead_intakes SET assigned_to_person_id=?,version=version+1 WHERE id=?",
      )
      .bind(targetPersonId, leadId),
    db
      .prepare(
        "INSERT INTO crm_assignment_history(id,entity_type,entity_id,from_person_id,to_person_id,actor_person_id) VALUES(?,'LEAD',?,?,?,?)",
      )
      .bind(
        newId(),
        leadId,
        current.assigned_to_person_id,
        targetPersonId,
        actorPersonId,
      ),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.lead.assigned",
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
    }),
  ]);
}
export async function createTag(db: D1Database, code: string, label: string) {
  const c = z
    .object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      label: z.string().trim().min(1).max(80),
    })
    .strict()
    .parse({ code, label });
  const tagId = newId();
  await db
    .prepare("INSERT INTO crm_tags(id,code,label) VALUES(?,?,?)")
    .bind(tagId, c.code, c.label)
    .run();
  return tagId;
}

export async function assignOpportunity(
  db: D1Database,
  actorPersonId: string,
  opportunityId: string,
  targetPersonId: string,
  requestId: string,
) {
  await requireActiveCrmAssignee(db, targetPersonId);
  const current = await db
    .prepare("SELECT owner_person_id FROM crm_opportunities WHERE id=?")
    .bind(opportunityId)
    .first<{ owner_person_id: string | null }>();
  if (!current)
    throw new Problem(404, "OPPORTUNITY_NOT_FOUND", "Opportunity unavailable");
  await db.batch([
    db
      .prepare(
        "UPDATE crm_opportunities SET owner_person_id=?,updated_at=?,version=version+1 WHERE id=?",
      )
      .bind(targetPersonId, utcNow(), opportunityId),
    db
      .prepare(
        "INSERT INTO crm_assignment_history(id,entity_type,entity_id,from_person_id,to_person_id,actor_person_id) VALUES(?,'OPPORTUNITY',?,?,?,?)",
      )
      .bind(
        newId(),
        opportunityId,
        current.owner_person_id,
        targetPersonId,
        actorPersonId,
      ),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.opportunity.assigned",
      resourceType: "crm_opportunity",
      resourceId: opportunityId,
      requestId,
    }),
  ]);
}
export async function assignTask(
  db: D1Database,
  actorPersonId: string,
  taskId: string,
  targetPersonId: string,
  requestId: string,
) {
  await requireActiveCrmAssignee(db, targetPersonId);
  const current = await db
    .prepare("SELECT owner_person_id FROM crm_tasks WHERE id=?")
    .bind(taskId)
    .first<{ owner_person_id: string }>();
  if (!current)
    throw new Problem(404, "CRM_TASK_NOT_FOUND", "Task unavailable");
  await db.batch([
    db
      .prepare(
        "UPDATE crm_tasks SET owner_person_id=?,updated_at=?,version=version+1 WHERE id=?",
      )
      .bind(targetPersonId, utcNow(), taskId),
    db
      .prepare(
        "INSERT INTO crm_assignment_history(id,entity_type,entity_id,from_person_id,to_person_id,actor_person_id) VALUES(?,'TASK',?,?,?,?)",
      )
      .bind(
        newId(),
        taskId,
        current.owner_person_id,
        targetPersonId,
        actorPersonId,
      ),
    auditStatement(db, {
      actorId: actorPersonId,
      action: "crm.task.assigned",
      resourceType: "crm_task",
      resourceId: taskId,
      requestId,
    }),
  ]);
}
export async function assignTag(
  db: D1Database,
  tagId: string,
  entityType: "PERSON" | "ORGANIZATION" | "LEAD" | "OPPORTUNITY",
  entityId: string,
) {
  const table = {
    PERSON: "iam_people",
    ORGANIZATION: "org_organizations",
    LEAD: "crm_lead_intakes",
    OPPORTUNITY: "crm_opportunities",
  }[entityType];
  if (!table)
    throw new Problem(400, "INVALID_CRM_ENTITY", "Invalid tagged entity");
  const entity = await db
    .prepare(`SELECT 1 FROM ${table} WHERE id=?`)
    .bind(entityId)
    .first();
  if (!entity)
    throw new Problem(404, "CRM_ENTITY_NOT_FOUND", "Entity unavailable");
  await db
    .prepare(
      "INSERT INTO crm_tag_assignments(tag_id,entity_type,entity_id) VALUES(?,?,?) ON CONFLICT(tag_id,entity_type,entity_id) DO NOTHING",
    )
    .bind(tagId, entityType, entityId)
    .run();
}
