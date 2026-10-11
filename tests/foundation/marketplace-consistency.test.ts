import { describe, expect, it } from "vitest";
import { assessMarketplaceConsistency } from "../../scripts/marketplace/consistency-result.mjs";
function fixture() {
  return [
    { success: true, results: [{ environment: "development" }] },
    {
      success: true,
      results: [
        {
          listing_count: 1,
          history_count: 4,
          event_count: 4,
          processed_events: 4,
          owned_listing_count: 1,
          approval_history: 1,
          withdrawal_history: 1,
          authenticated_security_events: 4,
          denied_security_events: 1,
          history_without_matching_audit_or_event: 0,
          current_listing_without_matching_history: 0,
          audit_without_matching_history: 0,
          event_without_matching_history: 0,
          history_gaps: 0,
          duplicate_event_versions: 0,
          unsafe_snapshot_fields: 0,
          owned_scope_violations: 0,
          unclean_owned_listings: 0,
          unclean_owned_offerings: 0,
          unclean_owned_canonical: 0,
          unresolved_dead_letters: 0,
          foreign_key_violations: 0,
          active_identities: 1,
          pending_events: 0,
          global_pending_events: 0,
          dead_events: 0,
        },
      ],
    },
  ];
}
function mutate(key: string, value: unknown) {
  const rows = fixture();
  (rows[1]!.results[0] as Record<string, unknown>)[key] = value;
  return rows;
}
describe("Marketplace positive aggregate consistency evidence", () => {
  it("accepts real processed approval, withdrawal and clean synthetic records", () =>
    expect(assessMarketplaceConsistency(fixture())).toMatch(
      /^PASS .*listings=1 histories=4 processed_events=4 owned_listings=1$/,
    ));
  it("distinguishes pending delivery from unavailable queries", () => {
    const pending = mutate("pending_events", 1);
    (pending[1]!.results[0] as Record<string, unknown>).processed_events = 3;
    expect(() => assessMarketplaceConsistency(pending)).toThrow(
      "MARKETPLACE_EVENTS_PENDING",
    );
    expect(() =>
      assessMarketplaceConsistency(mutate("global_pending_events", 1)),
    ).toThrow("MARKETPLACE_EVENTS_PENDING");
    expect(() => assessMarketplaceConsistency([])).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
  });
  it("fails closed outside Development and on ambiguous environment shape", () => {
    const wrong = fixture();
    wrong[0]!.results[0] = { environment: "production" };
    expect(() => assessMarketplaceConsistency(wrong)).toThrow(
      "DATABASE_ENVIRONMENT_MISMATCH",
    );
    const malformed = fixture();
    malformed[0]!.results = [];
    expect(() => assessMarketplaceConsistency(malformed)).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
  });
  it("rejects malformed successful query shapes, missing or invalid counts", () => {
    for (const value of [-1, 0.5, NaN, "1", Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        assessMarketplaceConsistency(mutate("approval_history", value)),
      ).toThrow("CONSISTENCY_CHECK_UNAVAILABLE");
    const missing = fixture();
    delete (missing[1]!.results[0] as Record<string, unknown>).approval_history;
    expect(() => assessMarketplaceConsistency(missing)).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
    const failed = fixture();
    failed[1]!.success = false;
    expect(() => assessMarketplaceConsistency(failed)).toThrow(
      "CONSISTENCY_CHECK_UNAVAILABLE",
    );
  });
  it("requires positive owned approval, withdrawal and security evidence", () => {
    for (const key of [
      "owned_listing_count",
      "approval_history",
      "withdrawal_history",
      "authenticated_security_events",
      "denied_security_events",
    ])
      expect(() => assessMarketplaceConsistency(mutate(key, 0))).toThrow(
        "MARKETPLACE_EVIDENCE_REQUIRED",
      );
    const empty = fixture();
    for (const key of [
      "listing_count",
      "history_count",
      "event_count",
      "processed_events",
      "owned_listing_count",
      "approval_history",
      "withdrawal_history",
      "authenticated_security_events",
      "denied_security_events",
    ])
      (empty[1]!.results[0] as Record<string, unknown>)[key] = 0;
    expect(() => assessMarketplaceConsistency(empty)).toThrow(
      "MARKETPLACE_EVIDENCE_REQUIRED",
    );
  });
  it("rejects missing audit/history, version gaps, duplicates and exposed snapshot fields", () => {
    for (const key of [
      "history_without_matching_audit_or_event",
      "current_listing_without_matching_history",
      "audit_without_matching_history",
      "event_without_matching_history",
      "history_gaps",
      "duplicate_event_versions",
      "unsafe_snapshot_fields",
    ])
      expect(() => assessMarketplaceConsistency(mutate(key, 1))).toThrow(
        "MARKETPLACE_CONSISTENCY_FAILED",
      );
  });
  it("rejects foreign scope, active synthetic listings, incomplete cleanup and damaged Queue evidence", () => {
    for (const key of [
      "owned_scope_violations",
      "unclean_owned_listings",
      "unclean_owned_offerings",
      "unclean_owned_canonical",
      "unresolved_dead_letters",
      "foreign_key_violations",
      "dead_events",
    ])
      expect(() => assessMarketplaceConsistency(mutate(key, 1))).toThrow(
        "MARKETPLACE_CONSISTENCY_FAILED",
      );
    expect(() =>
      assessMarketplaceConsistency(mutate("active_identities", 0)),
    ).toThrow("MARKETPLACE_CONSISTENCY_FAILED");
  });
  it("rejects impossible processed totals before reporting success or pending", () => {
    expect(() =>
      assessMarketplaceConsistency(mutate("processed_events", 5)),
    ).toThrow("MARKETPLACE_CONSISTENCY_FAILED");
    expect(() =>
      assessMarketplaceConsistency(mutate("processed_events", 3)),
    ).toThrow("MARKETPLACE_CONSISTENCY_FAILED");
  });
});
