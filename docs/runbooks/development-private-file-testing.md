# Trusted private file testing in Development

The owner deferred real antimalware scanning; this is not a security verification. Use only small synthetic PNG/JPEG/PDF fixtures without personal or confidential business data. Do not spend money, create scanning resources or integrate a scanner while ADR 0024 applies.

1. Target only existing Development hosts and named `--env development` resources. Use an existing authenticated, appropriately authorized session; never record its cookie or secret in files, arguments or logs.
2. Upload through the existing authenticated `/api/v1/me/evidence-files` endpoint with declared MIME and `x-file-size`. Real type/size validation still applies; a trusted fixture is not exempt.
3. Verify HTTP 202 and private QUARANTINED metadata through the owner's metadata endpoint. Attachment must reject the pending file; download must remain unavailable. Rejected operations must not create successful replay/business effects.
4. Use `scripts/workshops/development-smoke.mjs` for the existing synthetic Workshop/core and quarantine negatives. Supply an existing assured session through stdin. Its output reports application/quarantine behavior, never a successful malware scan.
5. Local unit/Worker tests may use already-existing deterministic test doubles to verify CLEAN/REJECTED code paths. These do not assess deployed file safety. Remote configuration continues to reject deterministic scanning.

Do not manually promote files, edit scan metadata, enable a remote fake/no-op scanner, create public R2 URLs or serve quarantined bytes. No real remote ACTIVE-file delivery is expected during the deferral. Preserve synthetic append-only business history; use the established bounded maintenance lifecycle for technical temporary uploads.

Before enabling public file upload/download, revisit real private scanning under [ADR 0024](../adr/0024-owner-antimalware-deferral.md), integrate through the existing MalwareScanner port, and complete the deferred remote lifecycle/security verification. Production deployment remains a human-action boundary.
