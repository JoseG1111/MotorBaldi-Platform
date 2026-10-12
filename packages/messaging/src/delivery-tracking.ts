import type { NormalizedProviderStatus } from "./provider-webhooks.js";
import { auditStatement } from "@motorbaldi/db";
import { canonical, newId, sha256Hex, utcNow } from "@motorbaldi/shared";
import {
  createCommunicationProvider,
  type CommunicationTransport,
  type DeliveryReceipt,
  type DeliveryRequest,
} from "./providers.js";

export type DeliveryProvider = "RESEND" | "META_WHATSAPP";
type Ledger = {
  status: string;
  provider: DeliveryProvider;
  payload_sha256: string;
  provider_reference: string | null;
};

/** Permanent reservation precedes HTTP. Queue redelivery never blindly repeats an ambiguous send,
 * even after the provider's idempotency window expires. No recipient/content is copied to this ledger. */
export async function dispatchTrackedCommunication(
  db: D1Database,
  options: {
    provider: DeliveryProvider;
    channel: "EMAIL" | "WHATSAPP";
    transport: CommunicationTransport;
    request: DeliveryRequest;
    authorize: () => Promise<void>;
  },
): Promise<DeliveryReceipt> {
  const { request, provider, channel, transport } = options;
  const digest = await sha256Hex(
    canonical({
      provider,
      channel,
      recipient: request.recipient,
      template: request.template,
      variables: { ...request.variables },
    }),
  );
  const results = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO notification_external_deliveries(id,source_event_id,provider,channel,payload_sha256,status) VALUES(?,?,?,?,?,'RESERVED')",
      )
      .bind(request.id, request.id, provider, channel, digest),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id) SELECT ?,'notification.delivery.reserved','notification',?,? WHERE changes()=1",
      )
      .bind(newId(), request.id, request.requestId),
  ]);
  if (results[0]!.meta.changes !== 1) {
    const row = await db
      .prepare(
        "SELECT status,provider,payload_sha256,provider_reference FROM notification_external_deliveries WHERE id=?",
      )
      .bind(request.id)
      .first<Ledger>();
    if (!row || row.provider !== provider || row.payload_sha256 !== digest)
      return { status: "REJECTED", code: "INVALID_REQUEST" };
    if (row.status === "ACCEPTED" && row.provider_reference)
      return { status: "ACCEPTED", providerReference: row.provider_reference };
    if (row.status === "REJECTED")
      return { status: "REJECTED", code: "TRANSPORT_REJECTED" };
    if (row.status === "UNAVAILABLE")
      return { status: "UNAVAILABLE", code: "TRANSPORT_UNAVAILABLE" };
    return { status: "UNKNOWN", code: "TRANSPORT_UNKNOWN" };
  }
  const receipt = await createCommunicationProvider({ transport }).send(
    channel,
    request,
    options.authorize,
  );
  await db.batch([
    db
      .prepare(
        "UPDATE notification_external_deliveries SET status=?,provider_reference=?,outcome_code=?,updated_at=? WHERE id=? AND status='RESERVED'",
      )
      .bind(
        receipt.status,
        receipt.providerReference ?? null,
        "code" in receipt ? (receipt.code ?? null) : null,
        utcNow(),
        request.id,
      ),
    auditStatement(db, {
      actorId: null,
      action: `notification.delivery.${receipt.status.toLowerCase()}`,
      resourceType: "notification",
      resourceId: request.id,
      requestId: request.requestId,
    }),
  ]);
  if (receipt.status === "ACCEPTED")
    await reconcilePendingProviderStatuses(
      db,
      provider,
      receipt.providerReference,
      request.requestId,
    );
  return receipt;
}

/** Call only after signature verification. Provider status evidence is immutable and replay-safe. */
export async function applyProviderDeliveryStatus(
  db: D1Database,
  evidence: NormalizedProviderStatus,
  requestId: string,
) {
  const namespace = "NOTIFICATION_" + evidence.provider;
  const stored = await db
    .prepare(
      "SELECT payload_json FROM integration_inbound_events WHERE provider=? AND provider_event_id=?",
    )
    .bind(namespace, evidence.evidenceId)
    .first<{ payload_json: string }>();
  if (stored) {
    const prior = JSON.parse(stored.payload_json) as NormalizedProviderStatus;
    if (
      prior.providerReference !== evidence.providerReference ||
      prior.status !== evidence.status ||
      prior.occurredAt !== evidence.occurredAt ||
      (evidence.provider === "RESEND" &&
        prior.payloadSha256 !== evidence.payloadSha256)
    )
      throw new Error("PROVIDER_EVIDENCE_CONFLICT");
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO integration_inbound_events(id,provider,provider_event_id,payload_json,request_id) VALUES(?,?,?,?,?)",
    )
    .bind(
      newId(),
      namespace,
      evidence.evidenceId,
      JSON.stringify(evidence),
      requestId,
    )
    .run();
  const canonicalReceipt = await db
    .prepare(
      "SELECT payload_json FROM integration_inbound_events WHERE provider=? AND provider_event_id=?",
    )
    .bind(namespace, evidence.evidenceId)
    .first<{ payload_json: string }>();
  if (!canonicalReceipt) throw new Error("PROVIDER_RECEIPT_UNAVAILABLE");
  const acceptedEvidence = JSON.parse(
    canonicalReceipt.payload_json,
  ) as NormalizedProviderStatus;
  if (
    acceptedEvidence.providerReference !== evidence.providerReference ||
    acceptedEvidence.status !== evidence.status ||
    acceptedEvidence.occurredAt !== evidence.occurredAt ||
    (evidence.provider === "RESEND" &&
      acceptedEvidence.payloadSha256 !== evidence.payloadSha256)
  )
    throw new Error("PROVIDER_EVIDENCE_CONFLICT");
  const row = await db
    .prepare(
      "SELECT id FROM notification_external_deliveries WHERE provider=? AND provider_reference=? AND status='ACCEPTED'",
    )
    .bind(evidence.provider, evidence.providerReference)
    .first<{ id: string }>();
  if (!row) return { applied: false };
  const prior = await db
    .prepare(
      "SELECT delivery_id,status,occurred_at,payload_sha256 FROM notification_provider_status_events WHERE provider=? AND evidence_id=?",
    )
    .bind(evidence.provider, evidence.evidenceId)
    .first<{
      delivery_id: string;
      status: string;
      occurred_at: string;
      payload_sha256: string;
    }>();
  if (prior) {
    if (
      prior.delivery_id !== row.id ||
      prior.status !== evidence.status ||
      prior.occurred_at !== evidence.occurredAt ||
      (evidence.provider === "RESEND" &&
        prior.payload_sha256 !== evidence.payloadSha256)
    )
      throw new Error("PROVIDER_EVIDENCE_CONFLICT");
    await db
      .prepare(
        "UPDATE integration_inbound_events SET status='PROCESSED',processed_at=? WHERE provider=? AND provider_event_id=? AND status='PENDING'",
      )
      .bind(utcNow(), namespace, evidence.evidenceId)
      .run();
    return { applied: false };
  }
  const evidenceRowId = newId();
  const results = await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO notification_provider_status_events(id,delivery_id,provider,evidence_id,status,occurred_at,payload_sha256) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        evidenceRowId,
        row.id,
        evidence.provider,
        evidence.evidenceId,
        evidence.status,
        evidence.occurredAt,
        evidence.payloadSha256,
      ),
    db
      .prepare(
        "UPDATE notification_external_deliveries SET delivery_status=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM notification_provider_status_events WHERE id=?) AND CASE delivery_status WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 WHEN 'FAILED' THEN 2 WHEN 'DELIVERED' THEN 3 WHEN 'READ' THEN 4 END < ?",
      )
      .bind(
        evidence.status,
        utcNow(),
        row.id,
        evidenceRowId,
        { SENT: 1, FAILED: 2, DELIVERED: 3, READ: 4 }[evidence.status],
      ),
    db
      .prepare(
        "INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id) SELECT ?,?,'notification',?,? WHERE EXISTS(SELECT 1 FROM notification_provider_status_events WHERE id=?)",
      )
      .bind(
        newId(),
        `notification.delivery.${evidence.status.toLowerCase()}`,
        row.id,
        requestId,
        evidenceRowId,
      ),
  ]);
  await db
    .prepare(
      "UPDATE integration_inbound_events SET status='PROCESSED',processed_at=? WHERE provider=? AND provider_event_id=? AND status='PENDING'",
    )
    .bind(utcNow(), namespace, evidence.evidenceId)
    .run();
  return { applied: results[0]!.meta.changes === 1 };
}

async function reconcilePendingProviderStatuses(
  db: D1Database,
  provider: DeliveryProvider,
  reference: string,
  requestId: string,
) {
  const rows = await db
    .prepare(
      "SELECT payload_json FROM integration_inbound_events WHERE provider=? AND status='PENDING' AND json_extract(payload_json,'$.providerReference')=? ORDER BY received_at,id LIMIT 100",
    )
    .bind("NOTIFICATION_" + provider, reference)
    .all<{ payload_json: string }>();
  for (const row of rows.results)
    await applyProviderDeliveryStatus(
      db,
      JSON.parse(row.payload_json) as NormalizedProviderStatus,
      requestId,
    );
}
