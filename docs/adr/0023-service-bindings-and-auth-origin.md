# ADR 0023 — Platform UI Service Bindings and Auth Origin

Status: Accepted.

Portal and Admin browsers use relative `/api/*` URLs. Their Workers forward those requests with the environment specific `API_SERVICE` binding. The browser therefore receives cookies from its own app origin, CSP remains `connect-src 'self'`, and Worker to Worker traffic does not use a public Internet hop. Portal and Admin receive no D1, R2, or authentication secret bindings.

Service binding access is established by Cloudflare configuration. The API does not accept an arbitrary header as proof of internal traffic and no shared secret header is invented. Foundation health, OpenAPI, supported Better Auth routes, and the authenticated principal endpoint remain reachable on the API Worker. Future endpoint access policy must be explicit.

During workers.dev development, each app uses its own same origin `/api/*` proxy and the API uses exact trusted origins. Future custom domains retain the same pattern. Host only, HTTP only, SameSite Lax cookies avoid reliance on third party cookie behavior. Better Auth's base URL is the API execution origin in direct API tests and the final app/API strategy must be revalidated when custom domains are assigned.
