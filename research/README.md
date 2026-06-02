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
  WASM initialization bug. **Archived repro pages, NOT runnable as-is** — their
  `<script src>` paths point at the stages' original in-build locations and are
  stale (see `cv-stages/README.md`). They are the historical record of the
  investigation, not exemplary code. The workaround that came out of it lives in
  `src/lib/lucas-kanade-cv.ts` and `src/lib/instrument/flow/flow-tracker.ts`.

## Notes

- **No credentials or keys are embedded.** Scripts that fetch raw recordings
  require you to supply your own endpoint via environment variable
  (`GIZMO_RECORDING_API`) — bring-your-own-backend, consistent with the rest of
  this repo.
- **The archived `cv-stage` pages do contain diagnostic `POST`s to a same-origin
  relative `/api/diag`** (and log `navigator.userAgent`/`platform`) — that was the
  original investigation's telemetry. There is no such endpoint in this repo, so
  the posts are inert; treat this as archived investigation tooling, not a pattern
  to copy.
- The Python scripts use a working directory (**`/tmp/gizmo-recordings`** by
  default) for intermediate files; raw recordings are not bundled. See
  `analysis/README.md`.
