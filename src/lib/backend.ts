/**
 * Bring-your-own-backend seam.
 *
 * v0.5 ships with **no backend**: the calibrator runs fully client-side and never
 * touches anyone's storage. A deployer who wants capture upload + device
 * diagnostics stands up the secure, Cloudflare-Access-gated reference backend
 * (see docs build plan, P3) and points this at its base URL — for *their* own
 * deployment. The shared client core hardcodes no private infrastructure, no
 * endpoint, no bucket. That is the whole point of a BYO seam.
 *
 * When `BACKEND_BASE` is null (the default):
 *   - diagnostics no-op (nothing is sent over the network)
 *   - captured recordings are saved to a local file download
 *
 * NOTE: this is a *base URL*, never a secret. Secrets (API tokens, bucket names,
 * Access policy) live in the deployer's environment / dashboard, never in this repo.
 * It is env-driven (VITE_BACKEND_BASE) so even the base URL isn't baked into the
 * shared code — the public default (unset) is fully client-only.
 */
// Read at build time from the environment (Vite inlines VITE_* vars). Three states:
//   unset    → null → no backend (client-only; capture saves to a local download)
//   ""       → ""   → same-origin backend (deployed alongside this app: calls /api/*)
//   full URL → that → a remote backend base
const raw: string | undefined = import.meta.env.VITE_BACKEND_BASE
export const BACKEND_BASE: string | null = raw === undefined ? null : raw

/** True when a backend is configured (incl. same-origin ""), so upload/diag are allowed. */
export function hasBackend(): boolean {
  return BACKEND_BASE !== null
}
