PRAGMA foreign_keys = ON;

CREATE TABLE workshop_order_files (
 order_id TEXT NOT NULL REFERENCES workshop_orders(id) ON DELETE RESTRICT,
 file_id TEXT NOT NULL REFERENCES storage_files(id) ON DELETE RESTRICT,
 attached_by_account_id TEXT NOT NULL REFERENCES iam_accounts(id) ON DELETE RESTRICT,
 attached_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(order_id,file_id)
) STRICT;
CREATE INDEX workshop_file_order ON workshop_order_files(file_id,order_id);
CREATE TRIGGER workshop_file_attach_guard BEFORE INSERT ON workshop_order_files
WHEN NOT EXISTS(SELECT 1 FROM workshop_orders w WHERE w.id=NEW.order_id AND w.status IN ('DRAFT','OPEN','IN_PROGRESS'))
 OR NOT EXISTS(SELECT 1 FROM storage_files f WHERE f.id=NEW.file_id AND f.status='ACTIVE' AND f.uploaded_by_account_id=NEW.attached_by_account_id)
BEGIN SELECT RAISE(ABORT,'WORKSHOP_ACTIVE_OWNED_FILE_REQUIRED'); END;
CREATE TRIGGER workshop_file_no_update BEFORE UPDATE ON workshop_order_files
BEGIN SELECT RAISE(ABORT,'workshop evidence associations are append-only'); END;
CREATE TRIGGER workshop_file_no_delete BEFORE DELETE ON workshop_order_files
BEGIN SELECT RAISE(ABORT,'workshop evidence associations are append-only'); END;
