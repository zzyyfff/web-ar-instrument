# cv-stage* — iOS Chrome OpenCV.js WASM bisection (archived)

These 29 throwaway pages (`cv-stageN.html` + `cv-stageN.ts`) are the staged bisection that
diagnosed the **iOS Chrome OpenCV.js WASM poison** bug: on iPhone Chrome 148, the OpenCV.js
WASM init poisons `setTimeout` AND `Promise` resolution at the moment `cv.Mat` becomes
constructible. Only synchronous callbacks from already-firing `setInterval`s survive.

They are **archived, not deleted** — kept as the executable repro of that investigation. They
are no longer part of the build (removed from `vite.config.ts` inputs) and live outside `src/`
so they don't get type-checked. The script-src paths inside the `.html` files point at the old
`src/cv-stageN.ts` locations and are stale; restore alongside if you ever need to re-run a stage.

The **workaround that came out of this** is live and documented:
- `src/lib/lucas-kanade-cv.ts` — synchronous `onCvReady` callback registry (never `await` the load).
- `src/lib/instrument/flow/flow-tracker.ts` — `preloadCvBackend()` kept at module-init time.
- Memory: `reference_ios_chrome_wasm_poison` (stages 1–31 documented).

Do not rely on these pages as the source of truth — the code + memory above are canonical.
