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
 * NOTE: the value here is a *base URL*, never a secret. Secrets (API tokens,
 * bucket names, Access policy) live in the deployer's environment / dashboard,
 * never in this repo. When the backend lands (P3), this becomes env-driven
 * (e.g. `import.meta.env.VITE_BACKEND_BASE`) so even the base URL isn't baked in.
 */
export const BACKEND_BASE: string | null = null

/** True when a backend base URL is configured, so upload/diag are allowed. */
export function hasBackend(): boolean {
  return typeof BACKEND_BASE === 'string' && BACKEND_BASE.length > 0
}
