-- Read-only aggregate Development evidence; no identities, bodies or credentials.
SELECT environment FROM governance_environment_metadata WHERE singleton=1;
SELECT (SELECT count(*) FROM parts_canonical) AS canonical_count,
       (SELECT count(*) FROM parts_offerings) AS offering_count,
       (SELECT count(*) FROM parts_workshop_snapshots) AS snapshot_count;
SELECT status,count(*) AS event_count FROM integration_outbox_events WHERE aggregate_type='parts' GROUP BY status;
SELECT count(*) AS unresolved_dead_letters FROM integration_dead_letters WHERE resolved_at IS NULL;
SELECT count(*) AS foreign_key_violations FROM pragma_foreign_key_check;
SELECT count(*) AS history_without_matching_audit_or_event FROM parts_change_history h
WHERE NOT EXISTS(SELECT 1 FROM governance_audit_events a JOIN integration_outbox_events e
 ON e.request_id=a.request_id AND e.aggregate_id=a.resource_id AND e.aggregate_type='parts' AND e.event_type=a.action||'.v1'
 WHERE a.resource_type='parts' AND a.resource_id=h.resource_id AND a.actor_id=h.actor_account_id
 AND a.request_id=h.request_id AND json_extract(e.payload_json,'$.version')=h.version);
SELECT count(*) AS snapshots_without_matching_audit_or_event FROM parts_workshop_snapshots s
WHERE NOT EXISTS(SELECT 1 FROM governance_audit_events a JOIN integration_outbox_events e
 ON e.request_id=a.request_id AND e.aggregate_id=a.resource_id AND e.aggregate_type='parts' AND e.event_type=a.action||'.v1'
 WHERE a.resource_type='parts' AND a.action='parts.workshop.snapshot.add' AND a.resource_id=s.id
 AND a.actor_id=s.actor_account_id AND a.organization_id=s.organization_id
 AND json_extract(e.payload_json,'$.version')=s.order_version);
SELECT count(*) AS source_versions_without_history FROM parts_workshop_snapshots s
WHERE NOT EXISTS(SELECT 1 FROM parts_change_history h WHERE h.resource_type='offering' AND h.resource_id=s.offering_id AND h.version=s.offering_version)
 OR (s.canonical_part_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM parts_change_history h WHERE h.resource_type='canonical' AND h.resource_id=s.canonical_part_id AND h.version=s.canonical_version));
SELECT count(*) AS duplicate_parts_event_versions FROM
 (SELECT aggregate_id,json_extract(payload_json,'$.version') FROM integration_outbox_events WHERE aggregate_type='parts'
  GROUP BY aggregate_id,json_extract(payload_json,'$.version') HAVING count(*)>1);
