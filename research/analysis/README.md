# gizmo-portfolio offline analysis pipeline

Scripts for analyzing AR motion captures uploaded to R2 from the calibrator.
Lives at `site/scripts/analysis/`. Install deps with:

```bash
pip3 install --user -r requirements.txt
```

## Quick start

```bash
# Analyze a recording end-to-end (downloads JSON + video, runs offline flow,
# scores every algorithm against truth anchors)
cd site/scripts/analysis
python3 analyze_recording.py <rec_id>
```

Output: per-algorithm RMS + max error vs truth anchors. The "VI v3 (offline
OpenCV)" line is the reference signal.

## What each file does

### Core algorithms (`filters.py`)

Canonical Python implementations of every algorithm shipped to the calibrator,
plus a `simulate(<Class>, <rec_id>)` runner that returns per-sample bearings.
Used by every other script that needs an algorithm output.

Classes:
- `EulerGamma`, `GravityCompass`, `CompassGated`, `GyroAnchored` — the IMU-only algorithms
- `Mahony`, `Madgwick`, `TiltCompensatedCompass` — alternate filters (Mahony/Madgwick have known bugs in the current implementation, not yet validated)
- `CompassGatedTight`, `CompassPredictiveGated`, `AccuracyWeightedCompass` — variants of CompassGated

`load_recording(rec_id)` reads the JSON, deserializes samples, and **applies
the empirical -1 sign flip on `rot.gamma`** (iOS reports it with LH convention
relative to RH-rule expectation).

### Optical flow (`visual_flow.py`, `visual_flow2.py`)

Run OpenCV's pyramidal Lucas-Kanade on a recording's composite video.
Outputs per-frame motion: rotation (image-plane roll), tx/ty translation,
residuals. `visual_flow2.py` is the current canonical version; `visual_flow.py`
is the first-pass kept for reference.

Outputs `/tmp/gizmo-recordings/flow2-<rec_id>.csv`.

### Visual-inertial fusion (`visual_inertial3.py`)

The canonical Python implementation of the production fusion algorithm.
Combines compass + gyro + (gated) visual flow into a yaw estimate per
orientation sample. **This is the offline reference for `?algo=visual-inertial`.**

Outputs `/tmp/gizmo-recordings/vi3-<rec_id>.csv`.

`visual_inertial.py` and `visual_inertial2.py` are superseded — keep until v3 is canonized.

### End-to-end runner (`analyze_recording.py`)

Orchestrates: downloads JSON + video from R2, runs flow + fusion, scores all
algorithms against truth anchors, prints comparison table. The one-command
analysis tool.

### Validation harness (`lk-test/`)

Synthetic-rotation tests for the vanilla-JS LK port. Compares JS-LK output
against OpenCV-LK on the same frame pairs. Confirmed both pipelines have
the same sign convention. Run via `npx tsx lk-test/test_synthetic.ts` from
the `site/` directory.

## Truth-anchor methodology

Every algorithm score uses **upright-moment compass anchors** as truth.

The idea: iOS `webkitCompassHeading` IS reliable when the phone is held
near-vertical with no significant roll. It's only unreliable at high γ
(the bug we've been chasing). So:

1. Filter `samples` for `kind=='o'` AND `|γ|<10°` AND `β>70°`
2. Cluster consecutive samples into "upright moments" (gap > 100ms = new cluster)
3. Take the median time and median compass per cluster
4. That's the truth bearing at that moment

Algorithm error = `((algo_bearing_at_t - truth_compass + 540) % 360) - 180`.

This isn't perfect — it relies on iOS compass being correct at γ≈0 — but
empirically the compass error stdev at upright is <4° (validated against
multiple recordings on the same target).

For the controlled fireplace captures (rec_1c, 6z, 5z, 1f, 3f), the camera
is held on the mantel at compass ≈ **335° NW**. Confirmed empirically from
upright-cluster averages.

## Sensor convention quick-ref

iOS via web APIs:
- `accelerationIncludingGravity` reports the **gravity vector itself** (not specific force). Vertical phone → `(0, -9.8, 0)`. So world-UP in phone frame = `-gravity / |gravity|`.
- `rotationRate.gamma` sign is flipped vs RH-rule. Always apply `-r.g` on ingest (filters.py does this).
- `webkitCompassHeading` is the bearing of phone +Y axis projected onto horizontal. At vertical phone with γ=0, iOS uses a heuristic to give camera-forward bearing.
- iOS rotationRate is in **deg/s** per W3C spec; convert to rad/s before mixing with radian-domain math.

## Recordings format

See the schema comment at the top of `site/functions/api/recording.ts` in the
gizmo-portfolio repo. Most recent versions are 0.2 (which adds `compVideo`
metadata). 0.1 recordings exist (before composite video was added) — they
still work but have no `compVideo` field and no `.video.mp4` companion file.

## TODO

- Move into repo at `site/scripts/analysis/`
- Fix Mahony+Madgwick (currently RMS 70-100°; my sign conventions are off)
- Add a `--bisect` mode that runs algorithm variants side-by-side
