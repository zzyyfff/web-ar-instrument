/**
 * Minimal landing page. Explains what the tool is and links to the calibrator.
 * The real content (and full docs) land in later phases; this scaffold exists so
 * the build, types, and CI are green from commit 1.
 *
 * Note the XSS-safe split, kept deliberate as an example: the static chrome is a
 * literal passed to innerHTML (no interpolation at all), and the one dynamic value
 * (the build id) is written with textContent. Even though __BUILD_ID__ is a trusted
 * build-time constant, routing *values* through textContent is the habit to copy —
 * the moment a value comes from input, innerHTML interpolation is an XSS hole.
 */
const app = document.querySelector<HTMLElement>('#app')

if (app) {
  app.innerHTML = `
    <h1>web-ar-instrument</h1>
    <p>A secure-by-default, browser-based web-AR motion calibration toolkit.</p>
    <p>Bring-your-own-backend &middot; no LLM &middot; secrets via environment only.</p>
    <p><a href="/calibrator.html">Open the calibrator &rarr;</a></p>
    <p class="build-badge" style="opacity:.6;font:12px system-ui"></p>
  `
  const badge = app.querySelector<HTMLElement>('.build-badge')
  if (badge) badge.textContent = `build ${__BUILD_ID__}`
}
