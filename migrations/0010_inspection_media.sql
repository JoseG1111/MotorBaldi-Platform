PRAGMA foreign_keys = ON;

CREATE TABLE inspection_record_files (
 record_id TEXT NOT NULL REFERENCES vehicle_professional_records(id) ON DELETE RESTRICT,
 file_id TEXT NOT NULL REFERENCES storage_files(id) ON DELETE RESTRICT,
 attached_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 attached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(record_id,file_id)
) STRICT;
CREATE INDEX inspection_file_record ON inspection_record_files(file_id,record_id);
CREATE TRIGGER inspection_file_attach_guard BEFORE INSERT ON inspection_record_files
WHEN NOT EXISTS (
 SELECT 1 FROM vehicle_professional_records r JOIN iam_accounts a ON a.person_id=r.author_person_id
 JOIN storage_files f ON f.uploaded_by_account_id=a.id
 WHERE r.id=NEW.record_id AND r.record_type='INSPECTION' AND r.status='DRAFT'
 AND a.id=NEW.attached_by_account_id AND a.status='ACTIVE' AND f.id=NEW.file_id AND f.status='ACTIVE'
)
 OR (SELECT count(*) FROM inspection_record_files WHERE record_id=NEW.record_id)>=200
BEGIN SELECT RAISE(ABORT,'INSPECTION_ACTIVE_OWNED_FILE_REQUIRED'); END;
CREATE TRIGGER inspection_file_no_update BEFORE UPDATE ON inspection_record_files
BEGIN SELECT RAISE(ABORT,'inspection evidence associations are immutable'); END;
CREATE TRIGGER inspection_file_no_delete BEFORE DELETE ON inspection_record_files
BEGIN SELECT RAISE(ABORT,'inspection evidence associations retain history'); END;
