import { newId } from "@motorbaldi/shared";

export interface AuditInput {
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
  reason?: string;
  organizationId?: string;
}

export function auditStatement(db: D1Database, e: AuditInput) {
  return db
    .prepare(
      "INSERT INTO governance_audit_events(id, actor_id, action, resource_type, resource_id, request_id, reason, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      newId(),
      e.actorId,
      e.action,
      e.resourceType,
      e.resourceId,
      e.requestId,
      e.reason ?? null,
      e.organizationId ?? null,
    );
}

export async function audit(db: D1Database, e: AuditInput) {
  await auditStatement(db, e).run();
}

export async function securityEvent(
  db: D1Database,
  code: string,
  requestId: string,
  actorId: string | null = null,
) {
  await db
    .prepare(
      "INSERT INTO governance_security_events(id, code, request_id, actor_id) VALUES (?, ?, ?, ?)",
    )
    .bind(newId(), code, requestId, actorId)
    .run();
}
