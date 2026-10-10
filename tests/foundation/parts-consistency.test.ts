import { describe, expect, it } from "vitest";
const modulePath = "../../scripts/parts/consistency-result.mjs";
const { assessConsistency } = await import(modulePath);
function evidence(
  positive = true,
): Array<{ success: boolean; results: Record<string, unknown>[] }> {
  const groups = [
    [{ environment: "development" }],
    [
      {
        canonical_count: positive ? 1 : 0,
        offering_count: positive ? 1 : 0,
        snapshot_count: positive ? 1 : 0,
      },
    ],
    positive ? [{ status: "PROCESSED", event_count: 9 }] : [],
    ...Array.from({ length: 6 }, () => [{ violations: 0 }]),
  ];
  return groups.map((results) => ({ success: true, results }));
}
describe("Parts remote consistency evidence", () => {
  it("requires positive domain and processed Queue evidence", () => {
    expect(assessConsistency(evidence())).toMatch(/^PASS/);
    expect(() => assessConsistency(evidence(false))).toThrow(
      "PARTS_EVENTS_REQUIRED",
    );
    expect(assessConsistency(evidence(false), true)).toMatch(/^BASELINE/);
  });
  it("denies pending/dead events and inconsistent history references", () => {
    for (const status of ["PENDING", "PROCESSING", "DEAD"]) {
      const state = evidence();
      state[2]!.results = [{ status, event_count: 1 }];
      expect(() => assessConsistency(state)).toThrow(
        "INCONSISTENT_PARTS_STATE",
      );
    }
    const state = evidence();
    state[6]!.results = [{ violations: 1 }];
    expect(() => assessConsistency(state)).toThrow("INCONSISTENT_PARTS_STATE");
  });
  it("rejects missing and malformed counts even in baseline mode", () => {
    const state = evidence();
    state[1]!.results = [{}];
    expect(() => assessConsistency(state, true)).toThrow(
      "INCONSISTENT_PARTS_STATE",
    );
    state[1]!.results = [
      { canonical_count: 1, offering_count: 1, snapshot_count: -1 },
    ];
    expect(() => assessConsistency(state)).toThrow("INCONSISTENT_PARTS_STATE");
  });
  it("requires exact Development identity and complete successful query results", () => {
    const state = evidence();
    state[0]!.results = [{ environment: "production" }];
    expect(() => assessConsistency(state)).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
    expect(() => assessConsistency([])).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
    const failed = evidence();
    failed[3]!.success = false;
    expect(() => assessConsistency(failed)).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
  });
});
