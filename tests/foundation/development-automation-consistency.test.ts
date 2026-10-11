import { describe, expect, it } from "vitest";
import { assessAutomationConsistency } from "../../scripts/development/consistency-result.mjs";
function fixture() {
  return [
    { success: true, results: [{ environment: "development" }] },
    ...Object.entries({
      active_identities: 1,
      forbidden_human_credentials: 0,
      overbroad_roles: 0,
      parts_fixtures: 1,
      accepted_security_events: 10,
      denied_security_events: 3,
      fixture_processed_events: 1,
      unprocessed_events: 0,
      active_temporary_grants: 0,
      missing_synthetic_resources: 0,
      foreign_key_violations: 0,
    }).map(([key, value]) => ({ success: true, results: [{ [key]: value }] })),
  ];
}
describe("Development automation aggregate evidence", () => {
  it("accepts positive processed evidence", () =>
    expect(assessAutomationConsistency(fixture())).toMatch(/^PASS/));
  it("distinguishes pending real events from an unavailable D1 query", () => {
    const rows = fixture();
    rows[8]!.results = [{ unprocessed_events: 10 }];
    expect(() => assessAutomationConsistency(rows)).toThrow(
      "AUTOMATION_EVENTS_PENDING",
    );
  });
  it("fails closed on wrong environment and malformed query shape", () => {
    const rows = fixture();
    rows[0]!.results = [{ environment: "production" }];
    expect(() => assessAutomationConsistency(rows)).toThrow(
      "DATABASE_ENVIRONMENT_MISMATCH",
    );
    expect(() => assessAutomationConsistency(rows.slice(1))).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
  });
  it("rejects human credentials, extra authority and unclean owned resources", () => {
    for (const index of [2, 3, 9, 10, 11]) {
      const rows = fixture(),
        key = Object.keys(rows[index]!.results[0]!)[0]!;
      rows[index]!.results = [{ [key]: 1 }];
      expect(() => assessAutomationConsistency(rows)).toThrow(
        "AUTOMATION_CONSISTENCY_FAILED",
      );
    }
  });
  it("rejects incomplete, invalid and negative counts", () => {
    for (const value of [-1, 0.5, Number.NaN]) {
      const rows = fixture();
      rows[5]!.results = [{ accepted_security_events: value }];
      expect(() => assessAutomationConsistency(rows)).toThrow(
        "CONSISTENCY_CHECK_UNAVAILABLE",
      );
    }
    const rows = fixture();
    rows[5]!.results = [{}];
    expect(() => assessAutomationConsistency(rows)).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
  });
  it("requires actual authentication, denied probe and processed fixture evidence", () => {
    for (const index of [4, 5, 6, 7]) {
      const rows = fixture(),
        key = Object.keys(rows[index]!.results[0]!)[0]!;
      rows[index]!.results = [{ [key]: 0 }];
      expect(() => assessAutomationConsistency(rows)).toThrow(
        "AUTOMATION_EVIDENCE_REQUIRED",
      );
    }
  });
});
