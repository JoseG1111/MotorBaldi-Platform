# ADR 0022 - Cloudflare Deployment Model

Status: Accepted.

CF-0 prepares Wrangler config, code, tests, docs and dry-run bundle validation only. It does not run `wrangler login`, `wrangler deploy`, D1/R2/Queue creation or Cloudflare API provisioning.

Remote setup is manual so the project owner can learn Cloudflare step by step before adopting IaC.
