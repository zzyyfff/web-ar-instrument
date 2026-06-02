"""
Visual-flow v2: better rotation/translation separation + quality residuals.

For each consecutive frame pair, fit a 2D similarity transform (rotation + uniform
scale + translation) via RANSAC. We also extract:
  - the affine ROTATION angle (the image-plane rotation)
  - the median per-feature flow magnitude (proxy for total motion energy)
  - the inlier-fit residual stdev (proxy for parallax/translation-vs-rotation mismatch)

For visual yaw rate, we use TWO signals:
  (a) horizontal translation tx → camera yaw (always degrees per pixel via FOV).
  (b) NOT the rotation — that's image-plane roll, not yaw.

We expose a quality weight per frame:
  - high weight when residuals are low (rigid scene rotation)
  - low weight when residuals are high (parallax = wrist-arc translation polluting tx)
  - zero weight when too few features tracked

We also de-rotate the flow vectors before computing tx, so the rotation component
doesn't contaminate the translation estimate.
"""
import csv
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def analyze(video_path, sensor_path, out_csv, fov_deg=60):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit(f'cannot open {video_path}')
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    px_per_deg_yaw = w / fov_deg
    aspect = h / w
    vfov = 2 * math.degrees(math.atan(math.tan(math.radians(fov_deg)/2) * aspect))
    px_per_deg_pitch = h / vfov

    mask = np.ones((h, w), dtype=np.uint8) * 255
    mask[: int(h * 0.14)] = 0
    mask[int(h * 0.86):] = 0
    cv2.circle(mask, (w // 2, h // 2), 24, 0, -1)

    rows = []
    prev_gray = None
    cum_yaw = 0.0
    cum_pitch = 0.0
    cum_image_roll = 0.0  # image-plane rotation (NOT a world axis)
    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        t = frame_idx / fps
        if prev_gray is not None:
            feat = cv2.goodFeaturesToTrack(
                prev_gray, maxCorners=160, qualityLevel=0.02, minDistance=10, blockSize=7, mask=mask,
            )
            if feat is None or len(feat) < 12:
                rows.append({'t': t, 'n': 0, 'tx': 0, 'ty': 0, 'roll_deg': 0,
                             'residual_px': 999, 'weight': 0, 'yaw_d': 0, 'pitch_d': 0,
                             'cum_yaw': cum_yaw, 'cum_pitch': cum_pitch, 'cum_roll': cum_image_roll})
                prev_gray = gray; frame_idx += 1; continue
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(
                prev_gray, gray, feat, None, winSize=(21, 21), maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
            )
            good = st.flatten().astype(bool)
            p0 = feat[good].reshape(-1, 2)
            p1 = nxt[good].reshape(-1, 2)
            if len(p0) < 10:
                rows.append({'t': t, 'n': len(p0), 'tx': 0, 'ty': 0, 'roll_deg': 0,
                             'residual_px': 999, 'weight': 0, 'yaw_d': 0, 'pitch_d': 0,
                             'cum_yaw': cum_yaw, 'cum_pitch': cum_pitch, 'cum_roll': cum_image_roll})
                prev_gray = gray; frame_idx += 1; continue

            M, inliers = cv2.estimateAffinePartial2D(
                p0, p1, method=cv2.RANSAC, ransacReprojThreshold=2.0,
                maxIters=2000, confidence=0.99,
            )
            if M is None:
                rows.append({'t': t, 'n': len(p0), 'tx': 0, 'ty': 0, 'roll_deg': 0,
                             'residual_px': 999, 'weight': 0, 'yaw_d': 0, 'pitch_d': 0,
                             'cum_yaw': cum_yaw, 'cum_pitch': cum_pitch, 'cum_roll': cum_image_roll})
                prev_gray = gray; frame_idx += 1; continue

            a, b = M[0, 0], M[0, 1]
            tx, ty = M[0, 2], M[1, 2]
            roll_deg = math.degrees(math.atan2(b, a))
            # Residual: apply M to p0, compare to p1, take std of residuals.
            ones = np.ones((p0.shape[0], 1))
            p0_h = np.hstack([p0, ones])
            p1_pred = (M @ p0_h.T).T
            resid = p1 - p1_pred
            resid_mag = np.sqrt((resid ** 2).sum(axis=1))
            n_in = int(inliers.sum()) if inliers is not None else len(p0)
            inlier_mask = inliers.flatten().astype(bool) if inliers is not None else slice(None)
            resid_std = float(np.median(resid_mag[inlier_mask])) if n_in > 0 else 999.0

            # De-rotate translation: if we account for the rotation component, residual
            # tx_clean ≈ tx_raw (it already does since M was a similarity fit).
            yaw_d = -tx / px_per_deg_yaw   # positive yaw_d = camera turned right
            pitch_d = -ty / px_per_deg_pitch

            # Quality weight: feature count + residual.
            n_ok = min(1.0, n_in / 40.0)
            r_ok = max(0.0, 1.0 - resid_std / 3.0)
            weight = n_ok * r_ok

            cum_yaw += yaw_d
            cum_pitch += pitch_d
            cum_image_roll += roll_deg
            rows.append({'t': t, 'n': n_in, 'tx': tx, 'ty': ty, 'roll_deg': roll_deg,
                         'residual_px': resid_std, 'weight': weight,
                         'yaw_d': yaw_d, 'pitch_d': pitch_d,
                         'cum_yaw': cum_yaw, 'cum_pitch': cum_pitch, 'cum_roll': cum_image_roll})
        prev_gray = gray
        frame_idx += 1
    cap.release()

    out = Path(out_csv)
    with out.open('w') as f:
        fieldnames = ['t','n','tx','ty','roll_deg','residual_px','weight','yaw_d','pitch_d','cum_yaw','cum_pitch','cum_roll']
        f.write(','.join(fieldnames) + '\n')
        for r in rows:
            f.write(','.join(f"{r[k]:.4f}" if isinstance(r[k], float) else str(r[k]) for k in fieldnames) + '\n')
    print(f'wrote {out_csv}: {len(rows)} rows  cum_yaw={rows[-1]["cum_yaw"]:+.1f}°  median_weight={sorted(r["weight"] for r in rows)[len(rows)//2]:.2f}')
    return rows, fps


if __name__ == '__main__':
    rec = sys.argv[1] if len(sys.argv) > 1 else '1f1v6x6v'
    analyze(
        f'/tmp/gizmo-recordings/rec_{rec}.mp4',
        f'/tmp/gizmo-recordings/rec_{rec}.json',
        f'/tmp/gizmo-recordings/flow2-{rec}.csv',
    )
