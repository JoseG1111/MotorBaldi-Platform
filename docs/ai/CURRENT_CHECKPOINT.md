# Current checkpoint

- **Current checkpoint:** MB-P8-005 — Remote validation
- **Status:** IN PROGRESS
- **Last verified checkpoint:** MB-P8-004 — Marketplace workflows/UI
- **Work completed:** Discovery/moderation locally verified; migration 0019 applied (14 commands). Development API 73a59fb6-7a9b-4a92-8ad2-a7f82015fae3, Worker f1e7abf6-fb64-4dcd-bea3-baca39791c61, Portal 7e41cbcd-f612-4ca4-a1ce-f886e268d078, Admin 0f04c48c-2570-4db6-a67c-a99fc9c544d9 deployed.
- **Verification completed:** Full gate PASS688 tests (174 foundation/510 Worker/4 signed API+DO). Signed remote publication/moderation/review/withdrawal/cleanup and anonymous positive privacy/discovery PASS. Marketplace D1/audit/outbox/Queue PASS: one listing/11 histories/11 processed events; Parts/automation consistency PASS; zero global pending or unresolved dead letters.
- **Remaining work:** Exact implementation CI and evidence closeout only.
- **Current blocker:** None. Existing OS-backed dedicated Development authentication is provisioned.
- **Exact next action:** Commit/push the tested implementation and verify exact Platform CI, then mark MB-P8-005 VERIFIED and advance to eligible Phase 9 contract review.
- **Relevant files:** `migrations/0019_marketplace_discovery.sql`, `packages/parts/src/marketplace*`, API/Worker and Portal/Admin, `scripts/development/`.
- **Commands worth rerunning:** `pnpm gate`; `node scripts/development/authentication-smoke.mjs`.
- **Expected result:** Reviewed synthetic public discovery passes and is withdrawn after testing; preserved immutable evidence and processed events match. Disabled commerce/media stays unavailable.
