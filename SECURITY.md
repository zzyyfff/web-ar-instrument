# Security model

This document is part of the artifact. An exemplary repo explains not just *what* it does
but *why it is safe* — its threat model, what an attacker cannot do, and the mistake it was
built to correct. If you copy patterns from here, copy these.

## What this protects

The backend (`functions/api/*`) stores capture recordings and device diagnostics in a private
R2 bucket. That bucket is **dev/research data and paid infrastructure**. The security goal is
simple and absolute:

> No one can read, list, or write that storage — or otherwise use infrastructure the deployer
> pays for — unless they are the authenticated deployer.

## How it is enforced (defense in depth)

1. **Cloudflare Access (edge gate).** The whole deployment sits behind a Cloudflare Access
   (Zero Trust) application whose policy is scoped to a single identity (the deployer). Anonymous
   requests are rejected at Cloudflare's edge, before any function runs.
2. **Access JWT verification (in code).** Every handler independently verifies the Access
   assertion (`Cf-Access-Jwt-Assertion` / `CF_Authorization`) using the team's published keys —
   checking signature, issuer, audience, and expiry (`functions/_lib/access.ts`, via the `jose`
   library; no hand-rolled crypto). We do **not** trust the proxy blindly. If Access were
   misconfigured or a route somehow exposed, the function still refuses.
3. **Fail closed.** If the Access config or the storage binding is absent, the backend returns
   an error and serves nothing. It never falls back to "open." Missing configuration must never
   silently disable authentication.
4. **Locked CORS.** Data routes echo `Access-Control-Allow-Origin` only for an exact configured
   origin — never `*`, never a reflected arbitrary origin.
5. **Least privilege on inputs.** Object keys are generated server-side (`rec_<random>`) or
   sanitized to a strict charset; callers cannot control storage paths (no traversal). Request
   bodies have hard size caps and content-type checks.
6. **No secrets in git.** No API tokens, bucket names, or keys are committed — ever, not even
   locally. Storage is a *binding*; Access config is non-secret deploy config; the CI deploy
   token lives in GitHub Actions secrets. See `.env.example` and `wrangler.toml` (placeholders).

## What an attacker who knows the URL cannot do

- Cannot read or list recordings/diagnostics (blocked at the edge; and the function re-verifies).
- Cannot upload data or otherwise write to the bucket.
- Cannot use the deployer's paid R2/storage for their own ends.
- Cannot bypass auth via CORS (locked) or via path tricks (keys are server-controlled).
- Cannot turn the backend "open" by stripping config — missing config fails closed.

## No LLM, ever

This is calibration/diagnostic tooling. It does not call, bundle, or proxy any language model.
There is no AI endpoint to abuse and no model key to leak. Bring your own brain.

## What this corrects (the lesson, stated plainly)

An earlier, internal version of this recording/diagnostic backend was an **unauthenticated public
endpoint in front of private R2** — anyone who knew the URL could read, list, and write the bucket
(one route even shipped `Access-Control-Allow-Origin: *`). That is the exact anti-pattern this repo
exists to demonstrate the fix for. The corrected design above — identity-aware gate, independent
token verification, fail-closed, locked CORS, server-controlled keys, secrets only via environment —
is what should have been there from the start. Publishing the *correct* version is the point: public
code teaches, and a newcomer who copies this should inherit the safe pattern, not the broken one.

## Reporting

This is a personal/educational project. If you find a security issue, open a GitHub issue (omit any
exploit detail that would endanger a live deployment) or contact the maintainer.
