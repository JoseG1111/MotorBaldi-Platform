# ADR 0014 - Cloudflare Workers Runtime

Status: Accepted.

API and background processing run as Cloudflare Workers. Entrypoints export `fetch`, `queue` and `scheduled` handlers. No active runtime depends on `server.listen()`, Docker containers, TCP listeners or filesystem persistence.

Hono was not introduced in CF-0 because the Foundation surface is small. The API uses a direct Worker router and keeps OpenAPI as a separate contract artifact. A future route expansion may add Hono if it reduces routing and middleware complexity.

Compatibility date is `2026-09-23` across all deployables and local Workers tests.
