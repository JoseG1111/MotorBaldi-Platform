const keys = [
  "active_identities",
  "forbidden_human_credentials",
  "overbroad_roles",
  "parts_fixtures",
  "accepted_security_events",
  "denied_security_events",
  "fixture_processed_events",
  "unprocessed_events",
  "active_temporary_grants",
  "missing_synthetic_resources",
  "foreign_key_violations",
];
export function assessAutomationConsistency(results) {
  const unavailable = () => {
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  };
  if (
    !Array.isArray(results) ||
    results.length !== 12 ||
    results.some(
      (r) =>
        r.success !== true ||
        !Array.isArray(r.results) ||
        r.results.length !== 1,
    )
  )
    unavailable();
  if (results[0].results[0]?.environment !== "development")
    throw new Error("DATABASE_ENVIRONMENT_MISMATCH");
  const counts = Object.assign(
    {},
    ...results.slice(1).map((r) => r.results[0]),
  );
  if (
    Object.keys(counts).length !== keys.length ||
    !keys.every((k) => Number.isSafeInteger(counts[k]) && counts[k] >= 0)
  )
    unavailable();
  if (
    counts.active_identities !== 1 ||
    [
      "forbidden_human_credentials",
      "overbroad_roles",
      "active_temporary_grants",
      "missing_synthetic_resources",
      "foreign_key_violations",
    ].some((k) => counts[k] !== 0)
  )
    throw new Error("AUTOMATION_CONSISTENCY_FAILED");
  if (counts.unprocessed_events > 0)
    throw new Error("AUTOMATION_EVENTS_PENDING");
  if (
    counts.parts_fixtures !== 1 ||
    counts.accepted_security_events < 1 ||
    counts.denied_security_events < 1 ||
    counts.fixture_processed_events < 1
  )
    throw new Error("AUTOMATION_EVIDENCE_REQUIRED");
  return "PASS Development automation identity, least privilege, audit, fixture outbox/Queue and synthetic cleanup consistency";
}
