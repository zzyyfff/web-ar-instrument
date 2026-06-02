# Offline analysis pipeline (archived reference)

Python scripts that analyzed AR motion captures during the development of this
toolkit's algorithms. **Archived reference implementations**, not turnkey
software: they read recordings + write intermediate CSVs in a working directory
and assume you supply your own capture data (see below). Install deps with:

```bash
pip3 install --user -r requirements.txt
```

## Working directory & data

These scripts read raw recordings (full sensor JSON + composite video) and write
intermediate CSVs under a working directory, **`/tmp/gizmo-recordings` by
default**. Raw recordings are **not bundled** in this repo (large, capture-
specific); supply your own:

- Pre-place `rec_<id>.json` (+ optional `rec_<id>.mp4`) in `/tmp/gizmo-recordings`, or
- Set `GIZMO_RECORDING_API` to your own deployed recording endpoint so
  `analyze_recording.py` can fetch them (bring-your-own-backend — no endpoint
  ships in this repo).

The derived per-recording optical-flow outputs (`heading-comparison/*.flow.json`,
`*.rot*.json`) ARE included as worked examples.

## Quick start

```bash
# Score every algorithm against truth anchors for one recording
python3 analyze_recording.py <rec_id>
```

Output: per-algorithm RMS + max error vs truth anchors. The "VI v3 (offline
OpenCV)" line is the reference signal.

## What each file does

### Core algorithms (`filters.py`)

Canonical Python implementations of every algorithm shipped to the calibrator,
plus a `simulate(<Class>, <rec_id>)` runner that returns per-sample bearings.

Classes:
- `EulerGamma`, `GravityCompass`, `CompassGated`, `GyroAnchored` — the IMU-only algorithms
- `Mahony`, `Madgwick`, `TiltCompensatedCompass` — alternate filters (Mahony/Madgwick have known sign-convention bugs in the current implementation, not yet validated)
- `CompassGatedTight`, `CompassPredictiveGated`, `AccuracyWeightedCompass` — variants of CompassGated

`load_recording(rec_id)` reads the JSON, deserializes samples, and **applies
the empirical -1 sign flip on `rot.gamma`** (iOS reports it with LH convention
relative to RH-rule expectation).

### Optical flow (`visual_flow.py`, `visual_flow2.py`)

Run OpenCV's pyramidal Lucas-Kanade on a recording's composite video. Outputs
per-frame motion (image-plane roll, tx/ty translation, residuals) as a CSV in
the working directory. `visual_flow2.py` is the current version; `visual_flow.py`
is the first pass, kept for reference.

### Visual-inertial fusion (`visual_inertial3.py`)

Python implementation of the production fusion algorithm: compass + gyro +
(gated) visual flow into a yaw estimate per orientation sample. Offline reference
for the calibrator's `?algo=visual-inertial`. `visual_inertial.py` / `2.py` are
superseded, kept for provenance.

### End-to-end runner (`analyze_recording.py`)

Orchestrates: fetch/locate recording, run flow + fusion (invoking the sibling
scripts in this directory), score all algorithms against truth anchors, print a
comparison table.

### Validation harness (`lk-test/`)

Synthetic-rotation tests for the vanilla-JS LK port (imports `src/lib/lucas-kanade`
from this repo). Confirms the JS-LK and OpenCV-LK pipelines share a sign
convention. These read synthetic frame fixtures from `/tmp/gizmo-analysis/lk-test/`
which are **not bundled** — generate or place your own raw frames there before
running (e.g. `npx tsx research/analysis/lk-test/test_synthetic.ts`).

## Truth-anchor methodology

Every algorithm score uses **upright-moment compass anchors** as truth.

iOS `webkitCompassHeading` is reliable when the phone is held near-vertical with
no significant roll; it's unreliable at high γ. So:

1. Filter `samples` for `kind=='o'` AND `|γ|<10°` AND `β>70°`
2. Cluster consecutive samples into "upright moments" (gap > 100ms = new cluster)
3. Take the median time and median compass per cluster — the truth bearing

Algorithm error = `((algo_bearing_at_t - truth_compass + 540) % 360) - 180`.

This relies on iOS compass being correct at γ≈0, but empirically the compass
error stdev at upright is <4° (validated across multiple recordings of a fixed
target).

## Sensor convention quick-ref

iOS via web APIs:
- `accelerationIncludingGravity` reports the **gravity vector itself** (not specific force). Vertical phone → `(0, -9.8, 0)`. World-UP in phone frame = `-gravity / |gravity|`.
- `rotationRate.gamma` sign is flipped vs RH-rule. Always apply `-r.g` on ingest (filters.py does this).
- `webkitCompassHeading` is the bearing of phone +Y axis projected onto horizontal.
- iOS rotationRate is in **deg/s** per W3C spec; convert to rad/s before mixing with radian-domain math.

## Recording JSON format

A recording is `{durationMs, buildId, url, samples: [...]}` where each sample has
a `t` (ms), a `kind` (`'o'` orientation, `'m'` motion), and the corresponding
fields (`webkitCompassHeading`, `alpha/beta/gamma`, `rot`, `acc`). Some
recordings also carry `overlayStates` (per-snapshot live LK diagnostics) and
`compVideo` metadata for the composite video. Recordings without `compVideo`
predate composite video and have no `.mp4` companion.
