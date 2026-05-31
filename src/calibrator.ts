/**
 * Calibrator entry point — scaffold placeholder.
 *
 * The real calibrator (pose algorithms, optical-flow pipeline, overlays,
 * choreography, local/no-upload recording) is moved in P2 of the build plan
 * (docs/web-ar-instrument-build-plan.md). This stub keeps the build green and
 * reserves the entry point.
 */
const root = document.querySelector<HTMLElement>('#calibrator')

if (root) {
  root.innerHTML = `
    <h1>Calibrator</h1>
    <p>Coming in P2 — the calibration tool moves here, wired to local/no-upload
       mode (records to a downloadable file; touches no remote storage).</p>
    <p><a href="/">&larr; Back</a></p>
    <p class="build-badge" style="opacity:.6;font:12px system-ui"></p>
  `
  const badge = root.querySelector<HTMLElement>('.build-badge')
  if (badge) badge.textContent = `build ${__BUILD_ID__}`
}
