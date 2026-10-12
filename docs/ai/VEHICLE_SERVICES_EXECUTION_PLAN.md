# Vehicle services and Free/Premium execution

The registry remains [EXECUTION_PLAN.md](EXECUTION_PLAN.md); [CURRENT_CHECKPOINT.md](CURRENT_CHECKPOINT.md) is the sole recovery cursor. Owner directive 2026-10-11 authorizes this independent work after verified QA007. QA008 actual remote human MFA, Wompi P5-005 and scanner P3-005 remain parked, never treated as verified dependencies. PR1 is OPEN on codex/premium-enterprise-ui; no merge.

## Approved policy

Free COP0, one active owner vehicle, five manual maintenance entries, basic manual SOAT/RTM and email15days. Premium COP29,900/month or COP288,000/year, identical benefits, three vehicles, unlimited reasonable manual history, email30/15/7/1days, unlimited eligible human assistance and personalized technical support. No monthly request quota. Staffing is approved; hours/contact/integration configuration must be factual. Preserve privacy/security/account rights channels for Free, all historical data after downgrade, role/organization permissions independently of personal subscriptions. External insurance/CDA transactions and payments remain gated.

## Reusable implementation and gaps

- Existing billing plans already store approved prices in COP minor units (2990000/28800000), but vehicle limit defaults2 and membership Free reports2. Existing signed payment confirmations/admin grants establish entitlement; pending subscription is not Premium. Historical period prices are immutable snapshots.
- Existing customer vehicle access is explicit canonical grants; garage is not ownership. Registration currently staff-only; no first-class expiry or manual maintenance interface exists.
- Existing support uses canonical cases/messages/history plus scoped staff MFA. General support currently available to all active accounts; personalized technical/vehicle assistance must become Premium-only while rights/security remain. Old optional support policy requires finite usage: superseded for customer subscription assistance.
- Existing notifications/preferences/outbox/Queues are reusable. Actual delivery and WhatsApp provider readiness must be inspected; interactive contact is distinct.
- Portal membership panel and existing subscription request are legitimate upgrade entry points; checkout remains unavailable. Shared verified tokens red #d7192d/dark #080b0d/paper #f3f1ec/Inter retained.

## Checkpoints and evidence

| Registry checkpoint | Work                                                             | Evidence / status                                                                                  |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MB-VS-001           | Approved catalog, entitlement/support enforcement                | Implemented and verified with focused canonical D1 regressions                                     |
| MB-VS-002           | Premium comparison landing and real request CTA                  | Verified four viewport browser/axe; actual desktop/mobile image review                             |
| MB-VS-003           | Owner vehicles, manual maintenance, SOAT/RTM                     | Verified29vehicle Worker tests plus real local persisted browser and four viewport form/axe checks |
| MB-VS-004           | Expiry schedules/preferences/idempotent notification integration | Verified6D1/Queue regressions; real remote cron/outbox/Queue PASS; external delivery unavailable   |
| MB-VS-005           | Unlimited assistance and operational entry points                | Verified82support tests and real local persistence; official interactive WhatsApp entry            |
| MB-VS-006           | Integration, full gate, Development, CI and closeout             | Full817 gate and final Development deployment PASS; CI and repeat remote probe pending             |

## Recovery

Current MB-VS-006. Canonical catalog/db entitlement, billing overview, support purposes/vehicle context/official WhatsApp, vehicle commands/routes/UI, reminder scheduler/Worker, migrations0020–0022 and regressions implemented. Real local browser exposed missing central idempotency registration (mock/browser and direct domain tests did not catch it); registration ops now registered. Real local journey and four viewport new vehicle workflows PASS. Three prepared-command authorization races reproduced and fixed with canonical permission/active account guards. Full815gate PASS, followed by focused12billing/typecheck for honest availability metadata; final gate pending. Exact next action: final gate, Development0020–0022 migration/deploy, infrastructure-only cron/Queue probe, remote browser/protocol/CI.

## Operational limitations and evidence

Official interactive WhatsApp https://wa.me/573104602615 was read from public motorbaldi.com HTML on2026-10-11. Availability is confirmed with the team; no hours fabricated. Premium server API exposes the real contact and covered vehicle context; canonical support cases retain actual staff workflow. Automated email/WhatsApp remain unavailable: notification_policy explicitly prevents external delivery and no transport is configured. Scheduled outbox work records UNAVAILABLE, never sent/delivered. Premium Portal summary derives actual current Colombia-month maintenance and mileage/expiry data; automatic monthly delivery remains unavailable. Wompi pending requests do not activate Premium. Real remote human MFA/customer journey verification remains separate from local/session automation.

## Changed files and integration findings

Shared customer catalog/design-scoped vehicle controls; DB current entitlement/idempotency registry; payments membership; canonical vehicle commands/routes/permission predicate; support purposes/context/contact policy; reminders/Worker cron;0020–0022 migrations; browser/domain/Foundation fixture regressions; ADR0030/OpenAPI. Real browser found missing idempotency registry. Security race tests demonstrated writes after prepared account suspension/read or mileage-grant revocation; now rejected atomically. Support form gained a second action, so native submitter now controls loading/disabled state; real persisted test pauses actual POST to assert correct button without mocking success. Maintenance history now uses scoped chronological cursor ordering.

## Development rollout recovery

0020–0022 applied to named Development D1. First annotated SQL attempt failed with7500 before any migration applied; pure SQL statements passed unchanged business schema. API a99d8c8d-0ab7-4b0f-af2d-eca286cdcc55 deployed. Worker/Portal rollout pending. Simultaneous final lint inspected Wrangler transient generated JavaScript under apps/api/.wrangler/tmp; exclude generated **/.wrangler/**, retaining all source checks. Final asynchronous vehicle selection regression passes focused browser; final full gate/CI must include it. Exact next action: finish Worker deploy, deploy Portal, execute infrastructure-only reminder probe and remote checks, then frozen-source full gate/commit/CI.

## 2026-10-12 frozen-source verification

Full pnpm gate PASS: 208 foundation, 555 Worker, 5 automation and 49 browser tests (817 total), including lint/typecheck/contracts/security/audit/artifact checks. Latest focused7 vehicle browser tests PASS. Actual rendered1440/390 screenshots reviewed again; upgrade and vehicle screens tested1440x900,1280x800,768x1024,390x844 with axe and contained layout checks. Real LOCAL password/MFA/profile/support/CRM and vehicle registration/SOAT/maintenance/readback/refresh/logout invalidation pass; this is not deployed human MFA evidence.

Final response-shape validation caught malformed data without false empty success. Browser regression exposed template-generated regex escaping which blocked boot; fixed and all browser tests pass. Public Fasecolda authorized SOAT channels and RUNT actor/CDA directory links verified against their public pages, without scraping or fabricated issuance/appointments. Shared official brand tokens unchanged.

Development0020–0023 applied. Final versions: API a99d8c8d-0ab7-4b0f-af2d-eca286cdcc55; Worker ffa4cf0a-db66-41b2-a6b6-54006813f61b; Portal fec77cd5-ec03-47aa-bba9-14643ef2b9b1; Admin fd635c9b-b47d-4233-8497-57eded816e94. Actual cron + canonical reminder + Queue passed Free15-only, UNAVAILABLE/TRANSPORT_UNAVAILABLE, outbox PROCESSED. Independent readback confirmed disabled preference, revoked grant, ended ownership and suspended synthetic account; immutable history retained. Foreign-key check empty; EXPLAIN uses vehicle_compliance_due. Repeat probe against final Worker underway.

Final remote two-surface logout/cookie expiry/no-store/origin/private denial checks PASS. Four actual anonymous deployed browser checks1440/390 PASS (logo/CSP/axe/overflow/no runtime error). Remote human-authenticated plan/vehicle/assistance journey remains pending QA008; isolated automation and synthetic infrastructure do not prove it. Wompi checkout and automated email/WhatsApp/monthly-summary delivery remain unavailable, never claimed activated or delivered. CI/PR closeout next.
