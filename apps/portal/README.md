# Portal Worker

Spanish customer, workshop and partner workspace. Operational navigation follows the selected organization and its actual permissions. Both applications use verified MotorBaldi branding and shared styles, shell and view helpers from `packages/shared/src/ui.ts`; the official logo is served locally from `/brand/logo.webp`.

Browser API calls use relative `/api/*` paths and the `API_SERVICE` service binding. The Worker has no D1, R2 or authentication secrets. Existing sessions, MFA and API authorization remain authoritative.

Run `pnpm test:ui` for synthetic Chromium workflow, responsive and accessibility checks against the real Worker-rendered pages. See `docs/ai/UX_EVIDENCE.md` for visual evidence and its scope.
