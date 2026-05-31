# web-ar-instrument

An exemplary, **secure-by-default** browser-based **web-AR motion calibration** toolkit.

It exists to do two things well: (1) help you calibrate and compare device-orientation /
camera-fusion algorithms for browser AR on real phones, and (2) be a *good example* — a codebase a
newcomer can copy from without learning bad habits.

> **Status: v0.5, in active build.** This is the scaffold (P0). The calibrator, the reusable
> instrument core, the offline analysis, and the secure backend land in subsequent phases. Today the
> app builds, types, and tests are green; the calibrator page is a placeholder.

## Principles (the bar this repo holds itself to)

- **No LLM. Bring your own brain.** This is calibration/diagnostic tooling. It never calls, bundles,
  or proxies a language model.
- **No unauthenticated endpoint in front of private storage or a paid service.** The (forthcoming)
  reference backend sits behind an identity-aware proxy (Cloudflare Access) *and* verifies the access
  token itself — defense in depth. It fails closed if auth or config is absent.
- **Secrets come from the environment, never from git** — not even locally. A `.env.example`
  documents what's needed; real values are deploy-time secrets/bindings.
- **Bring-your-own-backend.** The reusable client core hardcodes no private infrastructure. With no
  backend configured, the calibrator runs fully client-side and records to a local file download —
  touching nobody's storage.
- **Least privilege, locked CORS, input validation, fail closed.** Tight defaults everywhere.
- **The docs are part of the artifact.** Architecture *and* threat model are written down.

## Develop

```bash
npm install
npm run dev         # local dev server
npm run typecheck   # tsc --noEmit
npm run test        # vitest
npm run build       # static build to dist/
```

Node 22+. No backend, no secrets, no accounts required to run the tool locally.

## Architecture (three layers)

1. **Reusable client core** — pose math, the optical-flow tracker, recording schema + decoders,
   overlays. Pure, dependency-light, no secrets, no hardcoded endpoints.
2. **Reference backend (secure adapter)** — a thin Cloudflare Pages Functions backend for capture
   upload + diagnostics, **behind Cloudflare Access + access-token verification**, storage binding and
   config from the deployer's environment. *(Lands in a later phase; not present yet.)*
3. **Docs** — this README, a `SECURITY.md` threat model, and a candid "what not to do" note.

## License

MIT — see [LICENSE](./LICENSE).
