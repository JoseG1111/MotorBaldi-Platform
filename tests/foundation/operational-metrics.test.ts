import { describe, expect, it, vi } from "vitest";
import {
  evaluateOperationalAlerts,
  queryOperationalMetrics,
  recordOperationalMetrics,
  recordOperationalAlerts,
  type OperationalMetrics,
} from "../../packages/observability/src/metrics.js";

const values: OperationalMetrics = {
  outboxPendingCount: 12,
  processingLeaseCount: 3,
  unresolvedDeadLetterCount: 2,
  paymentFailureCount: 5,
  paymentUnknownCount: 1,
  notificationFailureCount: 4,
  notificationUnknownCount: 0,
};

describe("operational metric emission", () => {
  it("emits structured aggregate evidence through the default log sink", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      recordOperationalMetrics(values);
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
        event: "operational.metrics",
        service: "worker",
        counts: values,
      });
    } finally {
      log.mockRestore();
    }
  });
  it("copies no contact, identifier, arbitrary string, nested object or service input", () => {
    const sink = vi.fn();
    const enriched = {
      ...values,
      recipient: "secret@example.test",
      requestId: "private-event-id",
      accessToken: "private-token",
      extraCount: 99,
      nested: { value: "private-content" },
    };
    recordOperationalMetrics(enriched, "private-email@example.test", sink);
    expect(JSON.parse(sink.mock.calls[0]![0])).toEqual({
      event: "operational.metrics",
      service: "unknown",
      counts: values,
    });
    expect(sink.mock.calls[0]![0]).not.toMatch(
      /private|secret|recipient|Token/,
    );
  });
  it.each([-1, 1.25, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", {}, 1n])(
    "omits unsupported count %s without serializing it",
    (invalid) => {
      const sink = vi.fn();
      recordOperationalMetrics(
        { ...values, paymentFailureCount: invalid } as OperationalMetrics,
        "api",
        sink,
      );
      const parsed = JSON.parse(sink.mock.calls[0]![0]);
      expect(parsed.counts).not.toHaveProperty("paymentFailureCount");
      expect(parsed.counts.outboxPendingCount).toBe(12);
    },
  );
  it("preserves old caller shape and valid zero/bounded counts", () => {
    const sink = vi.fn();
    const legacy = {
      outboxPendingCount: 0,
      processingLeaseCount: Number.MAX_SAFE_INTEGER,
      unresolvedDeadLetterCount: 0,
    };
    recordOperationalMetrics(legacy, "worker", sink);
    expect(JSON.parse(sink.mock.calls[0]![0]).counts).toEqual(legacy);
  });
});

describe("explicit deterministic alert evaluation", () => {
  it("fires at the inclusive threshold in stable metric order without mutating input", () => {
    const thresholds = {
      paymentUnknownCount: 1,
      outboxPendingCount: 12,
      notificationUnknownCount: 1,
    };
    expect(evaluateOperationalAlerts(values, thresholds)).toEqual([
      { metric: "outboxPendingCount", count: 12, threshold: 12 },
      { metric: "paymentUnknownCount", count: 1, threshold: 1 },
    ]);
    expect(evaluateOperationalAlerts(values, thresholds)).toEqual(
      evaluateOperationalAlerts(values, thresholds),
    );
    expect(thresholds.outboxPendingCount).toBe(12);
    expect(values.outboxPendingCount).toBe(12);
  });
  it("has no invented thresholds and returns no alerts below explicit thresholds", () => {
    expect(evaluateOperationalAlerts(values, {})).toEqual([]);
    expect(
      evaluateOperationalAlerts(values, { outboxPendingCount: 13 }),
    ).toEqual([]);
    expect(
      evaluateOperationalAlerts(values, { notificationUnknownCount: 0 }),
    ).toEqual([{ metric: "notificationUnknownCount", count: 0, threshold: 0 }]);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid threshold %s",
    (threshold) => {
      expect(() =>
        evaluateOperationalAlerts(values, { paymentFailureCount: threshold }),
      ).toThrow("INVALID_OPERATIONAL_ALERT_THRESHOLDS");
    },
  );
  it("rejects unknown threshold names and absent evidence", () => {
    expect(() =>
      evaluateOperationalAlerts(values, { inventedCount: 1 } as never),
    ).toThrow("INVALID_OPERATIONAL_ALERT_THRESHOLDS");
    expect(() =>
      evaluateOperationalAlerts(
        { ...values, paymentFailureCount: undefined },
        { paymentFailureCount: 1 },
      ),
    ).toThrow("OPERATIONAL_ALERT_EVIDENCE_UNAVAILABLE");
    expect(() =>
      evaluateOperationalAlerts(
        { ...values, paymentFailureCount: -1 },
        { paymentFailureCount: 1 },
      ),
    ).toThrow("OPERATIONAL_ALERT_EVIDENCE_UNAVAILABLE");
  });
});

it("queries only canonical aggregate state, never identifiers or content", async () => {
  const queries: string[] = [];
  const prepared = (sql: string) => {
    queries.push(sql);
    return {
      bind: vi.fn().mockReturnThis(),
      all: async () => ({
        results: [
          { name: "billing_payments" },
          { name: "notification_external_deliveries" },
        ],
      }),
      first: async () =>
        sql.includes("billing_payments")
          ? { failure_count: 5, unknown_count: 1 }
          : sql.includes("notification_external_deliveries")
            ? { failure_count: 4, unknown_count: 0 }
            : {
                count: sql.includes("lease_until")
                  ? 3
                  : sql.includes("integration_dead_letters")
                    ? 2
                    : 12,
              },
    };
  };
  expect(
    await queryOperationalMetrics({
      prepare: prepared,
    } as unknown as D1Database),
  ).toEqual(values);
  expect(queries).toHaveLength(6);
  expect(queries.slice(1).every((sql) => /SELECT count\(/.test(sql))).toBe(
    true,
  );
  expect(queries.join(" ")).not.toMatch(
    /recipient|payload|reference|account_id|person_id/,
  );
});

it.each([null, undefined, [], 1, "private-text"])(
  "rejects non-object threshold input %s",
  (thresholds) => {
    expect(() =>
      evaluateOperationalAlerts(values, thresholds as never),
    ).toThrow("INVALID_OPERATIONAL_ALERT_THRESHOLDS");
  },
);

it("emits each technical alert once with aggregate-only redacted evidence", () => {
  const sink = vi.fn();
  recordOperationalAlerts(
    {
      ...values,
      notificationUnknownCount: 2,
      requestId: "private-id",
      recipient: "private@example.test",
    } as OperationalMetrics,
    {
      unresolvedDeadLetterCount: 1,
      paymentUnknownCount: 1,
      notificationUnknownCount: 1,
    },
    "private-service-text",
    sink,
  );
  expect(sink).toHaveBeenCalledTimes(3);
  const logs = sink.mock.calls.map(([json]) => JSON.parse(json));
  expect(logs.map((row) => row.metric)).toEqual([
    "unresolvedDeadLetterCount",
    "paymentUnknownCount",
    "notificationUnknownCount",
  ]);
  for (const row of logs) {
    expect(row.event).toBe("operational.alert");
    expect(row.code).toBe("OPERATOR_ACTION_NEEDED");
    expect(row.service).toBe("unknown");
    expect(Object.keys(row)).toEqual([
      "event",
      "code",
      "service",
      "metric",
      "count",
      "threshold",
    ]);
  }
  expect(JSON.stringify(logs)).not.toContain("private");
});

it("logs no false alert below thresholds and rejects invalid evidence", () => {
  const sink = vi.fn();
  recordOperationalAlerts(
    values,
    { notificationUnknownCount: 1 },
    "worker",
    sink,
  );
  expect(sink).not.toHaveBeenCalled();
  expect(() =>
    recordOperationalAlerts(
      { ...values, paymentUnknownCount: -1 },
      { paymentUnknownCount: 1 },
      "worker",
      sink,
    ),
  ).toThrow("OPERATIONAL_ALERT_EVIDENCE_UNAVAILABLE");
  expect(sink).not.toHaveBeenCalled();
});
