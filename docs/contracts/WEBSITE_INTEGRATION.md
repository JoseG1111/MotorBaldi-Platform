# Website Integration Contract

MotorBaldi Platform owns public lead intake and native CRM. The separate Website repository is an API client; no external CRM fallback exists.

## `POST /api/v1/public/leads`

The endpoint is available only when the `PUBLIC_LEAD_INTAKE` governance flag is enabled. Remote requests require a valid Turnstile token and the Foundation API rate limiter. Send an `Idempotency-Key` header of 8–128 characters, `Content-Type: application/json`, and a JSON body within the API body limit.

```json
{
  "givenName": "Ana",
  "familyName": "García",
  "email": "ana@example.test",
  "phone": "+573001234567",
  "organizationName": "Taller de ejemplo",
  "message": "Solicito información",
  "countryCode": "CO",
  "utmSource": "website",
  "utmMedium": "form",
  "utmCampaign": "launch",
  "utmContent": "contact",
  "utmTerm": "service",
  "referrer": "https://example.test/",
  "turnstileToken": "<ephemeral response token>"
}
```

At least one contact method is required. Country is an ISO 3166-1 alpha-2 code. Optional text and attribution fields have bounded lengths; unknown properties fail validation. A valid accepted request returns HTTP 202 with a generic receipt. The response does not disclose whether any person, account, contact, or organization exists and does not contain an internal lead ID. Reuse of the same idempotency key and request replays the receipt without a second lead.

The endpoint records a CRM lead and a versioned outbox event in one D1 batch. It does not create or merge a person. A CRM agent reviews the lead before linking a person or converting to an opportunity. Full payloads are excluded from audit and logs.

Configure the website's exact HTTPS origin in `PUBLIC_CORS_ORIGINS`, separately from Portal/Admin `CORS_ORIGINS` and Better Auth trusted origins. The Turnstile widget action must be exactly `lead`. Its sitekey is public; the secret belongs only to the Platform API Worker, which calls Siteverify server-side. The token is ephemeral transport data and is never part of the CRM lead or application idempotency fingerprint. Keep the application `Idempotency-Key` stable while retrying an unchanged logical lead, but obtain or reset the widget token after every attempted submission because Turnstile tokens are single-use. A fresh token changes the Siteverify retry UUID while preserving MotorBaldi's business replay key.

`GET /api/v1/public/plans` remains reserved for a later phase and is not implemented.

## Public parts discovery

Owner-approved Phase 8 discovery exposes `GET /api/v1/public/parts`, with optional `q`, `category`, UUID `cursor` and integer `limit` (1–50, default20). Unknown or duplicate query fields are rejected. Results contain `items` and `nextCursor`; follow a non-null cursor with unchanged filters. `GET /api/v1/public/parts/{listingId}` returns a reviewed eligible snapshot or404. Responses are `no-store`: source/eligibility changes must immediately stop discovery, including detail reads.

Public snapshots contain only approved part descriptive/compatibility fields, opaque listing reference, partner business name/country/general city-region, optional integer COP minor-unit indicative price, availability and update date. Missing price displays “Consultar”. Availability and compatibility are informational; stock is not guaranteed and workshops must confirm fitment. No partner SKU, private customer/vehicle information, street address, coordinates, VIN/plate lookup, internal commercial fields or media is included.

Public access is read-only and uses existing API rate limiting and configured public/Portal origins. Optional partner publication is private by default and requires assured staff review; an ACTIVE private offering is not publication consent. Source version, canonical state, business identity/general location and current seller eligibility are checked before each public read. Do not cache or reuse withdrawn/stale snapshots as a current offer.

`GET /api/v1/public/parts/capabilities` explicitly describes discovery and disabled commerce/media. There are no orders, checkout, payments, reservations, inventory deductions, marketplace fees/commissions, media uploads or fulfillment in this contract. “Consultar” does not establish a seller messaging workflow. Remote verification evidence is tracked separately in MB-P8-005.

## Private current-state operational reports

Analytics is private, INTERNAL and read-only. The Website's anonymous client has no analytics access. Existing Portal/Admin sessions retain verified MFA and privileged-session assurance. `GET /api/v1/admin/analytics/parts` uses exact catalog staff authority; `GET /api/v1/admin/analytics/queue` uses exact PLATFORM_SUPERADMIN/AUDITOR audit authority; `GET /api/v1/organizations/{organizationId}/analytics/parts` uses exact own OWNER/ADMIN Parts authority, optionally restricted by UUID `locationId`. Organization-wide requests require all-location scope. Unknown or duplicate queries and non-GET methods are rejected.

Version1 DTOs contain only current integer counts, UTC observation time, explicit authorized versus owned-synthetic scope and exact source-table provenance. Publication lifecycle PUBLISHED is distinct from currently discoverable. Authorized empty state is zero; unavailable/malformed evidence returns a sanitized503 instead of fabricated zeros. Return `no-store`, clear old views on scope/authentication changes and discard stale responses. Never derive financial results or show raw source records, personal information, private prices or event payloads. Development automation reuses its existing OS-backed credential and minimal synthetic Parts authority; it cannot read global Queue reports. See [ADR0029](../adr/0029-scoped-read-only-operational-analytics.md).
