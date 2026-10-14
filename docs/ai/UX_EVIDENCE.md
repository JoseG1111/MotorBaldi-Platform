# Enterprise UX evidence

## UX-001 — verified audit, 2026-10-10

Official live `https://motorbaldi.com/` HTML, `assets/css/base.css?v=12.2.0` and `assets/css/theme.css?v=12.2.0` retrieved through HTTPS. GitHub `JoseG1111/MotorBaldi`, master, is accessible; base.css blob `8da7ba758516e556273114c406b9fe2ab24fb0ca`. Marketing files remain unchanged. Both owner screenshots visually inspected.

Verified CSS tokens: black #080b0d, black-2 #0d1114, black-3 #13181c, ink #17191b, paper #f3f1ec, paper-2 #ebe8e1, white #f7f7f4, muted #777b7e, muted-light #a8afb4, line #d1cec7, red #d7192d, red-deep #a70d1d, red-hot #ff344b. Font stack: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif. No hosted font file is declared in these styles; preserve system fallback without adding a font service. Official logo `assets/brand/motorbaldi-logo-v6.webp` and mark `motorbaldi-mark-v6.png` retrieved; logo visually inspected. White/red logo requires a dark surface.

Application adaptation: official red primary actions, official near-black navigation, warm paper workspace, white data surfaces. Derived dark text and semantic colors must meet contrast independently; marketing muted gray is not normal body text. Compact 44px controls, 48px record rows, restrained 6–10px corners, thin borders, minimal elevation. Original line icons drawn as one consistent family; no HubSpot assets.

Reality: both apps are Worker-served HTML and vanilla browser JavaScript, no frontend framework. Existing service-binding proxies, Better Auth, MFA and exact permission checks retained. Existing VM tests are functional/source tests, not visual evidence. Cached Chromium is available; real browser tooling added only for QA.

People list supports q, cursor and limit (default20/max50), identity/country/person/account status only. Contacts and organization relationships belong to detail, not a fabricated list projection. Organizations support verificationStatus/cursor/limit; CRM leads cursor/limit. Any local sorting/filtering must explicitly say current page. No unbounded fetching.

Confirmed runtime defect: showCommissions reads commissions/settlements while canonical adminCommissionOverview returns agreements/entries and manual-tracking metadata. financialSection(undefined) dereferences rows.length. Existing UI test has the same incorrect fixture; fix both in UX-003. Other API failures must remain failures with professional Spanish feedback.

## Verification ledger

UX-001 through UX-006 VERIFIED with the evidence and limits below. Synthetic browser fixtures are visual/interaction evidence only, never proof of real remote authorization or backend workflows. Remote verification recorded separately.

### UX-002 foundation evidence

Shared official brand shell integrated in both apps. `pnpm typecheck`, 39 Phase 1 UI tests and `pnpm exec playwright test` (8 checks) PASS. Browser checks use real exported Worker responses and explicitly intercepted canonical synthetic API fixtures. Four requested sizes for Admin People and Portal account: zero axe WCAG AA violations, no document overflow/page errors; desktop collapse and mobile keyboard focus/Escape passed. Main viewed desktop Admin1440 and Portal390 screenshots. Focus outline on the entire main landmark and logo-link underline corrected after review. Screen-specific redesign remains UX-003/004/005, not claimed by this foundation.

### UX-003 record evidence

52 focused tests (phase1-ui/analytics-ui) and10 Playwright record checks PASS on2026-10-11. Real browser exercises search, cursor pagination, current-page filters/sort, multi-relationship detail, malformed/network/403 failures, stale responses and denied menu items. Main inspected People1440, People detail and CRM screenshots; record detail now replaces list within workspace and retains back navigation. Original commission entries mismatch corrected and malformed financial responses tested. Full gate hit an obsolete exact markup assertion in analytics test after icon integration; assertion now verifies permission-bearing button with label and focused passes. Remaining gate stages not yet claimed.

### UX-004 Admin domain evidence

67focused tests PASS;20browser suite PASS including9Admin modules at1440/390, vehicle/support/Parts detail interactions, zero axe/overflow/page errors. Main inspected Parts desktop, structured inspection report and mobile workshop queue. Parts initially had excessive metadata cards and long forms; metrics metadata separated and catalog counts/create/matching/publication review put in meaningful disclosures. Repeated20unit+2module browser tests PASS after polish; updated Parts screenshot re-inspected. Credential legacy test now locates nested action semantically. Organization detail shadowed label function corrected. Browser fixtures are synthetic only.

### UX-005 Portal evidence

Customer garage/history, membership, notifications/support, workshop queues/inspection and partner offerings now share the brand system with permission-scoped workspace navigation. Four Portal Chromium tests PASS at1440/390: canonical synthetic fixtures, axe/overflow/page-error checks, real profile submission and stale organization response after return to personal workspace. Main inspected organization/workshop/partner desktop and mobile vehicle history screenshots. Corrected history list/detail composition, overlong partner metadata/forms, Spanish history labels/dates and COP price entry.51 Phase1+Parts focused tests PASS, including exact pesos-to-minor-units validation. Signed Development authentication smoke PASS independently (machine assurance, nonce replay, freshness, path binding, workflow isolation); no machine grants expanded and no human-session browser authorization claimed.

### UX-006 final validation — 2026-10-11

Full `pnpm gate` PASS:208foundation+532Worker+5automation+27Chromium tests (772 total). Lint, TypeScript, execution state, workspace boundaries, OpenAPI, security fixtures, dependency audit (no known vulnerabilities) and built-artifact checks PASS. Intentional D1 rollback fixture exceptions are expected test evidence; all532Worker tests pass.

59synthetic screenshots generated under ignored `test-results/browser/`. Four requested viewports1440x900/1280x800/768x1024/390x844 cover both shells. Admin domain/Portal customer/workshop/partner scenarios cover1440/390. Browser assertions cover keyboard collapse/mobile focus/Escape, permitted navigation, real profile submission, bounded cursors/search/sort, malformed responses, network/403 errors, late-response suppression and no document overflow/page exceptions. Automated axe WCAG2/2.1/2.2 AA checks report zero violations on tested views; this is not a certification or an exhaustive screen-reader audit. Main visually inspected final dense20People desktop, partner offerings desktop and mobile vehicle history, in addition to checkpoint reviews. Representative synthetic screenshots use only invented records; none committed.

Development only deployed: Admin `fb72ab80-d7b3-4bf4-880b-341b9abd9264`, Portal `1ab3bc6f-1eb9-4b84-9049-2504c1ebbb74`. Wrangler bundles112.23/154.15KiB, gzip40.35/48.97KiB; both startup2ms. Shared vanilla UI adds no production frontend dependency. No API/Queue Worker/schema changes or deployments.

Actual remote browser checks at1440/390 for both apps PASS: HTTP200, official logo bytes match, CSP present, anonymous private API denied401, zero axe/page errors and no overflow. Main viewed remote Admin desktop login and Portal mobile discovery/login screenshots under ignored `.local/ux/remote-evidence/`. Remote check is read-only, anonymous and contains no credentials/private records. `node scripts/development/authentication-smoke.mjs` independently passes signed machine assurance/replay/freshness/path/workflow restrictions. `node scripts/analytics/development-smoke.mjs` passes read-only scope/privacy/denial and independent canonical D1 consistency. Human privileged MFA browser sessions were not impersonated or expanded; full remote human-session workflow replay is not claimed. Existing local Worker auth/session/MFA regressions pass.

Final implementation01b7796 passed Platform CI38175650011. Wompi, marketplace commerce and real antimalware/public private-media release remain disabled/deferred under established policy.

Final additional review inspected Admin1280, Portal768, operational analytics, professionals and mobile inspection detail. Inspection creation now uses a contextual disclosure hidden while reading a report; returning to Workshop/Inspection/CRM restores the list.52focused unit tests, four Portal browser tests and the complete772test gate PASS after this correction; mobile inspection screenshot re-inspected. Final screenshots preserved under ignored `.local/ux/evidence/` (59synthetic images); source tests regenerate them. Repeated final frontend deployments and four remote browser checks PASS with the versions above. Fresh names-only Wompi inventory remains0/4.

Initial implementation `ad9d7f4` passed [Platform CI38175243210](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/38175243210), including browser checks and Git history secret scan. Final navigation polish01b7796 passed [Platform CI38175650011](https://github.com/JoseG1111/MotorBaldi-Platform/actions/runs/38175650011) on [PR1](https://github.com/JoseG1111/MotorBaldi-Platform/pull/1). To reproduce browser QA on a fresh checkout: `pnpm exec playwright install --with-deps chromium`, then `pnpm test:ui`.

MB-UX-006 VERIFIED after final implementation CI success. Repository cursor returns to the existing MB-P5-005 human configuration boundary; no eligible approved engineering remains. The UI implementation is deployed in Development and available in PR1. Documentation-only closeout does not change runtime artifacts.
