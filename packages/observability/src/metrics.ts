export interface OperationalMetrics {
  outboxPendingCount: number;
  processingLeaseCount: number;
  unresolvedDeadLetterCount: number;
}

export async function queryOperationalMetrics(
  db: D1Database,
): Promise<OperationalMetrics> {
  const [pending, leases, dead] = await Promise.all([
    db
      .prepare(
        "SELECT count(*) AS count FROM integration_outbox_events WHERE status = 'PENDING'",
      )
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT count(*) AS count FROM integration_outbox_events WHERE status = 'PROCESSING' AND lease_until > ?",
      )
      .bind(new Date().toISOString())
      .first<{ count: number }>(),
    db
      .prepare(
        "SELECT count(*) AS count FROM integration_dead_letters WHERE resolved_at IS NULL",
      )
      .first<{ count: number }>(),
  ]);
  return {
    outboxPendingCount: pending?.count ?? 0,
    processingLeaseCount: leases?.count ?? 0,
    unresolvedDeadLetterCount: dead?.count ?? 0,
  };
}

export function recordOperationalMetrics(
  _values: OperationalMetrics,
  _service = "worker",
) {
  void _service;
  return undefined;
}
