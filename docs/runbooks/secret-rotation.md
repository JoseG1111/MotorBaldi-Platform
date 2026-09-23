# Secret Rotation

Remote secrets are Cloudflare Worker secrets.

CF-0 secrets:

- `AUTH_SECRET`
- `AUTH_SECRETS`
- future `TURNSTILE_SECRET_KEY`
- future email provider secret
- future malware scanner provider secret

Rotate auth by adding a new version to `AUTH_SECRETS`, promoting it to `AUTH_SECRET`, deploying manually after approval, then removing retired keys after session expiry.
