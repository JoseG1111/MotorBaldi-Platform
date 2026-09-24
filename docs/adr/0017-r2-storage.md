# ADR 0017 - R2 Storage

Status: Accepted.

R2 stores private bytes. D1 stores file metadata, state, SHA-256 and scan results. The lifecycle is `PENDING_UPLOAD`, `QUARANTINED`, `SCANNING`, `ACTIVE`, `REJECTED`, `DELETED`.

No permanent public file URLs are stored. Production scanner absence returns `SCANNER_UNAVAILABLE`; no production NOOP scanner is allowed.

Only `QUARANTINED` files may enter `SCANNING`. Scan completion requires the matching token and an unexpired lease. Clean promotion reserves a D1 record before R2 PUT; a lost finalization marks that promotion `CLEANUP`. Scheduled maintenance recovers expired scans, removes bounded stale uploads, and deletes technical orphan promotions without deleting active business files.
