export interface OperationalMetrics {
  outboxPendingCount: number;
  processingLeaseCount: number;
  unresolvedDeadLetterCount: number;
  paymentFailureCount?: number;
  paymentUnknownCount?: number;
  notificationFailureCount?: number;
  notificationUnknownCount?: number;
}

/** Current canonical state counts, not delivery claims or historical failure rates.
 * DECLINED/ERROR are payment failures; VOIDED is not treated as a failure.
 * Provider FAILED evidence and known transport REJECTED outcomes are counted once
 * per notification. UNAVAILABLE means a closed/unconfigured channel, not failure. */
export async function queryOperationalMetrics(
  db: D1Database,
): Promise<OperationalMetrics> {
  // Earlier migration fixtures have no billing/messaging schema. Absence is
  // unavailable evidence, not a zero count. Once a canonical table exists, its
  // query must succeed: schema corruption and infrastructure errors propagate.
  const available = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('billing_payments','notification_external_deliveries')",
    )
    .all<{ name: string }>();
  const tables = new Set(available.results.map((row) => row.name));
  const [pending, leases, dead, payments, notifications] = await Promise.all([
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
    tables.has("billing_payments")
      ? db
          .prepare(
            "SELECT count(CASE WHEN status IN ('DECLINED','ERROR') THEN 1 END) AS failure_count,count(CASE WHEN status='UNKNOWN' THEN 1 END) AS unknown_count FROM billing_payments",
          )
          .first<{ failure_count: number; unknown_count: number }>()
      : null,
    tables.has("notification_external_deliveries")
      ? db
          .prepare(
            "SELECT count(CASE WHEN status='REJECTED' OR delivery_status='FAILED' THEN 1 END) AS failure_count,count(CASE WHEN status='UNKNOWN' THEN 1 END) AS unknown_count FROM notification_external_deliveries",
          )
          .first<{ failure_count: number; unknown_count: number }>()
      : null,
  ]);
  return {
    outboxPendingCount: pending?.count ?? 0,
    processingLeaseCount: leases?.count ?? 0,
    unresolvedDeadLetterCount: dead?.count ?? 0,
    ...(payments
      ? {
          paymentFailureCount: payments.failure_count,
          paymentUnknownCount: payments.unknown_count,
        }
      : {}),
    ...(notifications
      ? {
          notificationFailureCount: notifications.failure_count,
          notificationUnknownCount: notifications.unknown_count,
        }
      : {}),
  };
}

const metricNames = [
  "outboxPendingCount",
  "processingLeaseCount",
  "unresolvedDeadLetterCount",
  "paymentFailureCount",
  "paymentUnknownCount",
  "notificationFailureCount",
  "notificationUnknownCount",
] as const satisfies readonly (keyof OperationalMetrics)[];
export type OperationalMetricName = (typeof metricNames)[number];
const services = new Set([
  "worker",
  "api",
  "portal",
  "admin",
  "motorbaldi-core",
  "unknown",
]);
function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type OperationalMetricsSink = (json: string) => void;

/** Emits only known aggregate names with bounded nonnegative integer values.
 * Optional metrics absent from older callers are omitted, never fabricated as zero.
 * An unknown service becomes a fixed marker rather than copying untrusted text. */
export function recordOperationalMetrics(
  values: OperationalMetrics,
  service = "worker",
  sink: OperationalMetricsSink = (json) => console.log(json),
) {
  const counts: Partial<Record<OperationalMetricName, number>> = {};
  for (const metric of metricNames) {
    if (values && Object.hasOwn(values, metric) && validCount(values[metric]))
      counts[metric] = values[metric];
  }
  sink(
    JSON.stringify({
      event: "operational.metrics",
      service: services.has(service) ? service : "unknown",
      counts,
    }),
  );
}

export type OperationalAlertThresholds = Partial<
  Record<OperationalMetricName, number>
>;
export interface OperationalAlert {
  metric: OperationalMetricName;
  count: number;
  threshold: number;
}

/** Inclusive thresholds are supplied explicitly by the caller. No default alert
 * policy, delivery channel, recipient, or side effect is installed here. Invalid
 * thresholds or missing/invalid requested evidence fail rather than clear an alert. */
export function evaluateOperationalAlerts(
  values: OperationalMetrics,
  thresholds: OperationalAlertThresholds,
): OperationalAlert[] {
  if (
    !thresholds ||
    typeof thresholds !== "object" ||
    Array.isArray(thresholds) ||
    Object.keys(thresholds).some(
      (name) => !metricNames.includes(name as OperationalMetricName),
    )
  )
    throw new RangeError("INVALID_OPERATIONAL_ALERT_THRESHOLDS");
  const alerts: OperationalAlert[] = [];
  for (const metric of metricNames) {
    if (!Object.hasOwn(thresholds, metric)) continue;
    const threshold = thresholds[metric];
    if (!validCount(threshold))
      throw new RangeError("INVALID_OPERATIONAL_ALERT_THRESHOLDS");
    const count =
      values && Object.hasOwn(values, metric) ? values[metric] : undefined;
    if (!validCount(count))
      throw new RangeError("OPERATIONAL_ALERT_EVIDENCE_UNAVAILABLE");
    if (count >= threshold) alerts.push({ metric, count, threshold });
  }
  return alerts;
}

/** Emits one bounded technical action-needed log per evaluated aggregate. It
 * neither addresses an external destination nor retries unknown external effects. */
export function recordOperationalAlerts(
  values: OperationalMetrics,
  thresholds: OperationalAlertThresholds,
  service = "worker",
  sink: OperationalMetricsSink = (json) => console.warn(json),
) {
  for (const alert of evaluateOperationalAlerts(values, thresholds)) {
    sink(
      JSON.stringify({
        event: "operational.alert",
        code: "OPERATOR_ACTION_NEEDED",
        service: services.has(service) ? service : "unknown",
        metric: alert.metric,
        count: alert.count,
        threshold: alert.threshold,
      }),
    );
  }
}
