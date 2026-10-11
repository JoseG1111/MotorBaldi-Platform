const positive = [
  "listing_count",
  "history_count",
  "event_count",
  "processed_events",
  "owned_listing_count",
  "approval_history",
  "withdrawal_history",
  "authenticated_security_events",
  "denied_security_events",
];
const zero = [
  "history_without_matching_audit_or_event",
  "current_listing_without_matching_history",
  "audit_without_matching_history",
  "event_without_matching_history",
  "history_gaps",
  "duplicate_event_versions",
  "unsafe_snapshot_fields",
  "owned_scope_violations",
  "unclean_owned_listings",
  "unclean_owned_offerings",
  "unclean_owned_canonical",
  "unresolved_dead_letters",
  "foreign_key_violations",
];
const keys = [
  ...positive,
  ...zero,
  "active_identities",
  "pending_events",
  "global_pending_events",
  "dead_events",
];
/** Accept only complete positive, persisted, processed Development evidence. */
export function assessMarketplaceConsistency(results) {
  const unavailable = () => {
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  };
  if (
    !Array.isArray(results) ||
    results.length !== 2 ||
    results.some(
      (row) =>
        row?.success !== true ||
        !Array.isArray(row.results) ||
        row.results.length !== 1,
    )
  )
    unavailable();
  const environment = results[0].results[0];
  if (
    !environment ||
    Object.keys(environment).length !== 1 ||
    !Object.hasOwn(environment, "environment")
  )
    unavailable();
  if (environment.environment !== "development")
    throw new Error("DATABASE_ENVIRONMENT_MISMATCH");
  const counts = results[1].results[0];
  if (
    !counts ||
    Object.keys(counts).length !== keys.length ||
    !keys.every(
      (key) =>
        Object.hasOwn(counts, key) &&
        Number.isSafeInteger(counts[key]) &&
        counts[key] >= 0,
    )
  )
    unavailable();
  if (
    counts.active_identities !== 1 ||
    counts.dead_events !== 0 ||
    zero.some((key) => counts[key] !== 0) ||
    counts.processed_events > counts.event_count ||
    counts.pending_events + counts.dead_events + counts.processed_events !==
      counts.event_count
  )
    throw new Error("MARKETPLACE_CONSISTENCY_FAILED");
  if (counts.pending_events > 0 || counts.global_pending_events > 0)
    throw new Error("MARKETPLACE_EVENTS_PENDING");
  if (positive.some((key) => counts[key] < 1))
    throw new Error("MARKETPLACE_EVIDENCE_REQUIRED");
  return `PASS Development Marketplace D1/audit/outbox/Queue consistency; listings=${counts.listing_count} histories=${counts.history_count} processed_events=${counts.processed_events} owned_listings=${counts.owned_listing_count}`;
}
