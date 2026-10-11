import { execFile } from "node:child_process";
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export function buildConsistencySql(organizationId, locationId) {
  if (!uuid(organizationId) || !uuid(locationId))
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  return `SELECT environment FROM governance_environment_metadata WHERE singleton=1;
 WITH identity AS (SELECT account_id FROM development_automation_identities WHERE name='development-validation' AND status='ACTIVE' AND organization_id='${organizationId}' AND location_id='${locationId}' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 canonical AS (SELECT c.status FROM parts_canonical c JOIN development_automation_resources r ON r.resource_type='canonical' AND r.resource_id=c.id JOIN identity i ON i.account_id=r.account_id),
 offerings AS (SELECT f.status FROM parts_offerings f JOIN development_automation_resources r ON r.resource_type='offering' AND r.resource_id=f.id JOIN identity i ON i.account_id=r.account_id WHERE f.organization_id='${organizationId}' AND f.location_id='${locationId}'),
 listings AS (SELECT l.* FROM marketplace_listings l JOIN development_automation_resources r ON r.resource_type='offering' AND r.resource_id=l.offering_id JOIN identity i ON i.account_id=r.account_id WHERE l.organization_id='${organizationId}' AND l.location_id='${locationId}'),
 visible AS (SELECT l.id FROM listings l JOIN marketplace_eligible_sources s ON s.offering_id=l.offering_id WHERE l.status='PUBLISHED' AND l.offering_version=s.offering_version AND l.canonical_version=s.canonical_version AND l.snapshot_json=json_set(s.source_json,'$.generalLocation',l.general_location) AND (s.location_id IS NULL OR json_extract(s.source_json,'$.generalLocation')=l.general_location))
 SELECT (SELECT count(*) FROM identity) AS identities,
 (SELECT count(*) FROM canonical WHERE status='DRAFT') AS canonical_DRAFT,
 (SELECT count(*) FROM canonical WHERE status='ACTIVE') AS canonical_ACTIVE,
 (SELECT count(*) FROM canonical WHERE status='ARCHIVED') AS canonical_ARCHIVED,
 (SELECT count(*) FROM offerings WHERE status='DRAFT') AS offering_DRAFT,
 (SELECT count(*) FROM offerings WHERE status='ACTIVE') AS offering_ACTIVE,
 (SELECT count(*) FROM offerings WHERE status='INACTIVE') AS offering_INACTIVE,
 (SELECT count(*) FROM listings WHERE status='DRAFT') AS listing_DRAFT,
 (SELECT count(*) FROM listings WHERE status='PENDING_REVIEW') AS listing_PENDING_REVIEW,
 (SELECT count(*) FROM listings WHERE status='PUBLISHED') AS listing_PUBLISHED,
 (SELECT count(*) FROM listings WHERE status='SUSPENDED') AS listing_SUSPENDED,
 (SELECT count(DISTINCT id) FROM visible) AS discoverable;`;
}
const keys = [
  "identities",
  "canonical_DRAFT",
  "canonical_ACTIVE",
  "canonical_ARCHIVED",
  "offering_DRAFT",
  "offering_ACTIVE",
  "offering_INACTIVE",
  "listing_DRAFT",
  "listing_PENDING_REVIEW",
  "listing_PUBLISHED",
  "listing_SUSPENDED",
  "discoverable",
];
export function assessAnalyticsConsistency(
  results,
  { canonical, organization },
) {
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
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  const environment = results[0].results[0];
  if (
    !environment ||
    Object.keys(environment).length !== 1 ||
    !Object.hasOwn(environment, "environment")
  )
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  if (environment.environment !== "development")
    throw new Error("DATABASE_ENVIRONMENT_MISMATCH");
  const row = results[1].results[0];
  if (
    !row ||
    Object.keys(row).length !== keys.length ||
    !keys.every(
      (key) =>
        Object.hasOwn(row, key) &&
        Number.isSafeInteger(row[key]) &&
        row[key] >= 0,
    )
  )
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  if (
    row.identities !== 1 ||
    row.canonical_ARCHIVED < 1 ||
    row.offering_INACTIVE < 1 ||
    row.listing_SUSPENDED < 1
  )
    throw new Error("ANALYTICS_EVIDENCE_REQUIRED");
  const expected = {
    identities: 1,
    discoverable: organization.counts.discoverable,
  };
  for (const status of ["DRAFT", "ACTIVE", "ARCHIVED"])
    expected["canonical_" + status] = canonical.counts[status];
  for (const status of ["DRAFT", "ACTIVE", "INACTIVE"])
    expected["offering_" + status] = organization.counts.offerings[status];
  for (const status of ["DRAFT", "PENDING_REVIEW", "PUBLISHED", "SUSPENDED"])
    expected["listing_" + status] = organization.counts.listings[status];
  if (keys.some((key) => row[key] !== expected[key]))
    throw new Error("ANALYTICS_COUNT_MISMATCH");
}
function execute(file, args) {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 1048576, timeout: 60000 },
      (error, stdout) =>
        error
          ? reject(new Error("CONSISTENCY_CHECK_UNAVAILABLE"))
          : resolve(stdout),
    ),
  );
}
/** All child stdout/stderr remains captured; only fixed success diagnostics reach the caller. */
export async function compareRemoteEvidence(evidence, { exec = execute } = {}) {
  const sql = buildConsistencySql(evidence.organizationId, evidence.locationId);
  let results;
  try {
    results = JSON.parse(
      await exec("pnpm", [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "motorbaldi-core-dev",
        "--remote",
        "--config",
        "apps/api/wrangler.jsonc",
        "--env",
        "development",
        "--command",
        sql,
        "--json",
      ]),
    );
  } catch {
    throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  }
  assessAnalyticsConsistency(results, evidence);
  for (const checker of [
    "scripts/parts/check-consistency.mjs",
    "scripts/marketplace/check-consistency.mjs",
    "scripts/development/check-consistency.mjs",
  ]) {
    const output = await exec(process.execPath, [checker]);
    if (
      typeof output !== "string" ||
      !output.startsWith("PASS ") ||
      output.includes("FAIL")
    )
      throw new Error("CONSISTENCY_CHECK_UNAVAILABLE");
  }
}
