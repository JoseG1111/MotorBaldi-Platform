ALTER TABLE governance.files RENAME COLUMN owner_account_id TO uploaded_by_account_id;
ALTER INDEX governance.files_owner_date RENAME TO files_uploader_date;
ALTER TABLE governance.files
 ADD COLUMN scan_token uuid,
 ADD COLUMN scan_started_at timestamptz,
 ADD COLUMN scan_lease_until timestamptz,
 ADD COLUMN scan_attempts integer NOT NULL DEFAULT 0 CHECK(scan_attempts >= 0),
 ADD COLUMN last_error_code text;
-- Older SCANNING rows have no valid lease and must be retried safely.
UPDATE governance.files SET status='QUARANTINED' WHERE status='SCANNING';
ALTER TABLE governance.files ADD CONSTRAINT files_scan_lease CHECK (
 (status='SCANNING' AND scan_token IS NOT NULL AND scan_started_at IS NOT NULL AND scan_lease_until IS NOT NULL)
 OR (status<>'SCANNING' AND scan_token IS NULL AND scan_lease_until IS NULL));
CREATE INDEX files_stale_scan ON governance.files(scan_lease_until) WHERE status='SCANNING';
CREATE TABLE governance.file_promotions (
 object_key text PRIMARY KEY,
 file_id uuid NOT NULL REFERENCES governance.files(id) ON DELETE RESTRICT,
 scan_token uuid NOT NULL,
 status text NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','REFERENCED','CLEANUP','DELETED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_promotions_cleanup ON governance.file_promotions(status,created_at);
COMMENT ON COLUMN governance.files.uploaded_by_account_id IS 'Upload provenance only; not resource ownership or authorization';
COMMENT ON TABLE governance.file_promotions IS 'RESTRICTED technical object reservations; cleanup only unreferenced expired scan outputs. No domain record deletion.';
