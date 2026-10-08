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
