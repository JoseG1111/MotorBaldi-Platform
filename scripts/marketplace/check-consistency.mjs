import { execFile } from "node:child_process";
import { assessMarketplaceConsistency } from "./consistency-result.mjs";
// Read-only aggregate evidence. No identifiers, snapshots or response bodies are printed.
const sql = `SELECT environment FROM governance_environment_metadata WHERE singleton=1;
WITH owned AS (
 SELECT l.*,i.account_id AS automation_account,i.organization_id AS fixture_org,i.location_id AS fixture_location
 FROM marketplace_listings l JOIN development_automation_resources r ON r.resource_type='offering' AND r.resource_id=l.offering_id
 JOIN development_automation_identities i ON i.account_id=r.account_id
), matched AS (
 SELECT h.id AS history_id,a.id AS audit_id,e.id AS event_id FROM marketplace_listing_history h
 JOIN governance_audit_events a ON a.resource_type='marketplace' AND a.resource_id=h.listing_id AND a.organization_id=h.organization_id AND a.actor_id=h.actor_account_id AND a.action=h.operation AND a.request_id=h.request_id
 JOIN integration_outbox_events e ON e.aggregate_type='marketplace' AND e.aggregate_id=h.listing_id AND e.event_type=h.operation||'.v1' AND e.event_version=1 AND e.external_effect_policy='IDEMPOTENT' AND e.request_id=h.request_id AND json_extract(e.payload_json,'$.resourceId')=h.listing_id AND json_extract(e.payload_json,'$.organizationId')=h.organization_id AND json_extract(e.payload_json,'$.version')=h.version
), events AS (SELECT * FROM integration_outbox_events WHERE aggregate_type='marketplace')
SELECT
 (SELECT count(*) FROM marketplace_listings) AS listing_count,
 (SELECT count(*) FROM marketplace_listing_history) AS history_count,
 (SELECT count(*) FROM events) AS event_count,
 (SELECT count(*) FROM events WHERE status='PROCESSED') AS processed_events,
 (SELECT count(*) FROM owned) AS owned_listing_count,
 (SELECT count(*) FROM marketplace_listing_history h JOIN owned o ON o.id=h.listing_id WHERE h.operation='marketplace.listing.approve' AND h.status='PUBLISHED') AS approval_history,
 (SELECT count(*) FROM marketplace_listing_history h JOIN owned o ON o.id=h.listing_id WHERE h.operation IN ('marketplace.listing.withdraw','marketplace.listing.suspend') AND h.status='SUSPENDED') AS withdrawal_history,
 (SELECT count(*) FROM governance_security_events s JOIN development_automation_identities i ON i.account_id=s.actor_id WHERE s.code='DEVELOPMENT_AUTOMATION_AUTHENTICATED') AS authenticated_security_events,
 (SELECT count(*) FROM governance_security_events s JOIN development_automation_identities i ON i.account_id=s.actor_id WHERE s.code='DEVELOPMENT_AUTOMATION_DENIED') AS denied_security_events,
 (SELECT count(*) FROM marketplace_listing_history h WHERE NOT EXISTS(SELECT 1 FROM matched m WHERE m.history_id=h.id)) AS history_without_matching_audit_or_event,
 (SELECT count(*) FROM marketplace_listings l WHERE NOT EXISTS(SELECT 1 FROM marketplace_listing_history h WHERE h.listing_id=l.id AND h.organization_id=l.organization_id AND h.version=l.version AND h.status=l.status AND h.operation=l.last_operation AND h.snapshot_json=l.snapshot_json AND h.actor_account_id=l.last_actor_account_id)) AS current_listing_without_matching_history,
 (SELECT count(*) FROM governance_audit_events a WHERE a.resource_type='marketplace' AND a.action LIKE 'marketplace.listing.%' AND NOT EXISTS(SELECT 1 FROM matched m WHERE m.audit_id=a.id)) AS audit_without_matching_history,
 (SELECT count(*) FROM events e WHERE NOT EXISTS(SELECT 1 FROM matched m WHERE m.event_id=e.id) OR (SELECT count(*) FROM json_each(e.payload_json))<>3) AS event_without_matching_history,
 (SELECT count(*) FROM marketplace_listings l WHERE (SELECT count(*) FROM marketplace_listing_history h WHERE h.listing_id=l.id)<>l.version OR (SELECT min(version) FROM marketplace_listing_history h WHERE h.listing_id=l.id) IS NOT 1 OR (SELECT max(version) FROM marketplace_listing_history h WHERE h.listing_id=l.id) IS NOT l.version) AS history_gaps,
 (SELECT count(*) FROM (SELECT aggregate_id,json_extract(payload_json,'$.version') FROM events GROUP BY aggregate_id,json_extract(payload_json,'$.version') HAVING count(*)>1)) AS duplicate_event_versions,
 (SELECT count(*) FROM marketplace_listing_history h WHERE EXISTS(SELECT 1 FROM json_each(h.snapshot_json) j WHERE j.key NOT IN ('name','category','brand','manufacturerReference','description','unit','compatibility','priceMinor','currency','priceIndicative','availability','lastUpdatedAt','partnerBusinessName','country','generalLocation','compatibilityNotice','availabilityNotice')) OR EXISTS(SELECT 1 FROM json_each(h.snapshot_json,'$.compatibility') c,json_each(c.value) field WHERE field.key NOT IN ('vehicleKind','brand','model','note','verified'))) AS unsafe_snapshot_fields,
 (SELECT count(*) FROM owned o WHERE o.organization_id<>o.fixture_org OR o.location_id IS NOT o.fixture_location OR NOT EXISTS(SELECT 1 FROM parts_offerings f WHERE f.id=o.offering_id AND f.organization_id=o.fixture_org AND f.location_id=o.fixture_location)) AS owned_scope_violations,
 (SELECT count(*) FROM owned WHERE status<>'SUSPENDED') AS unclean_owned_listings,
 (SELECT count(*) FROM owned o JOIN parts_offerings f ON f.id=o.offering_id WHERE f.status<>'INACTIVE') AS unclean_owned_offerings,
 (SELECT count(*) FROM owned o JOIN parts_offerings f ON f.id=o.offering_id JOIN parts_canonical c ON c.id=f.canonical_part_id WHERE c.status<>'ARCHIVED' OR NOT EXISTS(SELECT 1 FROM development_automation_resources r WHERE r.account_id=o.automation_account AND r.resource_type='canonical' AND r.resource_id=c.id)) AS unclean_owned_canonical,
 (SELECT count(*) FROM integration_dead_letters WHERE resolved_at IS NULL) AS unresolved_dead_letters,
 (SELECT count(*) FROM pragma_foreign_key_check) AS foreign_key_violations,
 (SELECT count(*) FROM development_automation_identities i JOIN iam_accounts a ON a.id=i.account_id WHERE i.name='development-validation' AND i.status='ACTIVE' AND i.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.status='ACTIVE') AS active_identities,
 (SELECT count(*) FROM events WHERE status NOT IN ('PROCESSED','DEAD')) AS pending_events,
 (SELECT count(*) FROM integration_outbox_events WHERE status NOT IN ('PROCESSED','DEAD')) AS global_pending_events,
 (SELECT count(*) FROM integration_outbox_events WHERE status='DEAD') AS dead_events;`;
function query() {
  return new Promise((resolve, reject) =>
    execFile(
      "pnpm",
      [
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
      ],
      { encoding: "utf8", maxBuffer: 1048576, timeout: 60000 },
      (error, out) => (error ? reject(new Error()) : resolve(out)),
    ),
  );
}
async function main() {
  if (process.argv.length !== 2) throw new Error();
  process.stdout.write(
    assessMarketplaceConsistency(JSON.parse(await query())) + "\n",
  );
}
main().catch((error) => {
  const codes = new Set([
    "CONSISTENCY_CHECK_UNAVAILABLE",
    "DATABASE_ENVIRONMENT_MISMATCH",
    "MARKETPLACE_CONSISTENCY_FAILED",
    "MARKETPLACE_EVENTS_PENDING",
    "MARKETPLACE_EVIDENCE_REQUIRED",
  ]);
  const code = codes.has(error?.message)
    ? error.message
    : "CONSISTENCY_CHECK_UNAVAILABLE";
  process.stderr.write(
    `FAIL step=marketplace-d1-queue-consistency code=${code}\n`,
  );
  process.exitCode = 1;
});
