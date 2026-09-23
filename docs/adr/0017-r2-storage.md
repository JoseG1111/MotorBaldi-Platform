# ADR 0017 - R2 Storage

Status: Accepted.

R2 stores private bytes. D1 stores file metadata, state, SHA-256 and scan results. The lifecycle is `PENDING_UPLOAD`, `QUARANTINED`, `SCANNING`, `ACTIVE`, `REJECTED`, `DELETED`.

No permanent public file URLs are stored. Production scanner absence returns `SCANNER_UNAVAILABLE`; no production NOOP scanner is allowed.
