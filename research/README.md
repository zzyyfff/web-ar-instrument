# research/ — archived AR motion investigation

Reference artifacts from the browser-AR motion work that produced this toolkit's
algorithms. These are **archived research, not part of the build** — they are kept
for provenance and reproducibility, not maintained as library code.

## Contents

- **`analysis/`** — offline analysis + validation pipeline (Python). Reference
  implementations of the candidate heading/attitude algorithms, an optical-flow
  camera-truth solver, and the Lucas-Kanade validation harness. See
  `analysis/README.md`. Raw device recordings (full sensor JSON + video) are **not
  bundled** (large, capture-specific); scripts read them from a directory you point
  at via the `GIZMO_DATA_DIR` / `GIZMO_RECORDING_API` environment variables. The
  derived per-recording optical-flow outputs (`*.flow.json`, `*.rot*.json`) are
  included as worked examples.

- **`cv-stages/`** — a 29-stage bisection that diagnosed an iOS Chrome OpenCV.js
  WASM initialization bug. Executable repro pages; see `cv-stages/README.md`. The
  workaround that came out of it lives in `src/lib/lucas-kanade-cv.ts` and
  `src/lib/instrument/flow/flow-tracker.ts`.

## Notes

- No backend endpoints, credentials, or keys are embedded here. Scripts that fetch
  recordings require you to supply your own endpoint via environment variable
  (bring-your-own-backend, consistent with the rest of this repo).
- Paths are resolved relative to each script; nothing is hardcoded to a local
  machine.
