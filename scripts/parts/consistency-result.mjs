const keys = ["canonical_count", "offering_count", "snapshot_count"];
/** Reject empty or malformed evidence rather than treating zero rows as closeout. */
export function assessConsistency(results, baseline = false) {
  if (
    !Array.isArray(results) ||
    results.length !== 9 ||
    results.some((row) => row?.success !== true || !Array.isArray(row.results))
  )
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  const rows = results.map((row) => row.results);
  if (rows[0].length !== 1 || rows[0][0]?.environment !== "development")
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  const counts = rows[1][0],
    events = rows[2];
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  if (
    rows[1].length !== 1 ||
    !counts ||
    Object.keys(counts).length !== keys.length ||
    !keys.every((key) => count(counts[key])) ||
    !events.every(
      (row) => row?.status === "PROCESSED" && count(row.event_count),
    ) ||
    rows
      .slice(3)
      .some(
        (group) =>
          group.length !== 1 ||
          !group[0] ||
          Object.keys(group[0]).length !== 1 ||
          Object.values(group[0])[0] !== 0,
      )
  )
    throw new Error("INCONSISTENT_PARTS_STATE");
  const processed = events.reduce((total, row) => total + row.event_count, 0);
  if (!count(processed)) throw new Error("INCONSISTENT_PARTS_STATE");
  if (!baseline && (keys.some((key) => counts[key] === 0) || processed === 0))
    throw new Error("PARTS_EVENTS_REQUIRED");
  return `${baseline ? "BASELINE" : "PASS"} Development Parts D1/Queue consistency; canonical=${counts.canonical_count} offerings=${counts.offering_count} snapshots=${counts.snapshot_count} processed_events=${processed}`;
}
