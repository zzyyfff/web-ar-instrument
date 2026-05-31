# Security

A factual description of how the backend is secured. (Any public-facing framing or prose is the
owner's to write.)

## Backend access control

The recording/diagnostics backend (`functions/api/*`) stores data in a private R2 bucket reachable
only through these functions. Controls in code:

- **Cloudflare Access** gates the deployment; unauthenticated requests are rejected at the edge.
- Each function independently **verifies the Access JWT** (`functions/_lib/access.ts`, via `jose`):
  signature, issuer, audience, and expiry.
- **Fails closed:** if the Access configuration or the storage binding is absent, the function returns
  an error and serves nothing — it never falls back to open.
- **Locked CORS:** data routes return `Access-Control-Allow-Origin` only for an exact configured
  origin, never `*`.
- **Server-controlled object keys** (generated or sanitized) — callers cannot control storage paths.
- Request **size caps** and content-type checks.

## Secrets

No API tokens, keys, or bucket names are committed to git. Storage is a binding; Access configuration
is non-secret deploy config; the CI deploy token lives in GitHub Actions secrets. See `.env.example`
and `wrangler.toml`.

## No LLM

This tool does not call, bundle, or proxy any language model.

## Reporting

Found a security issue? Open a GitHub issue (omitting exploit detail that would endanger a live
deployment) or contact the maintainer.
