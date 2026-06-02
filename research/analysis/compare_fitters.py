"""
Compare two similarity-transform fitters on the same LK output:
  A) cv2.estimateAffinePartial2D (RANSAC) — what visual_flow2.py uses, and
     what we WANTED to use in the on-device lucas-kanade-cv.ts but the
     @techstark build doesn't expose this function.
  B) fitSimilarity (least-squares + 2.5x median residual inlier filter) — the
     vanilla-JS math the on-device lucas-kanade-cv.ts NOW uses as a fallback.
     Same math as visual_inertial/non-CV path.

Run on the same recording, integrate tx → yaw per algorithm, then score against
compass-anchor truth at upright moments. RMS error is the verdict.

Usage:
  python3 compare_fitters.py <rec_id>
"""
import csv
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def fit_similarity_ls(p0, p1, cx, cy):
    """Least-squares similarity fit with 2.5x median residual inlier refinement.
    Mirrors the math of lucas-kanade.ts fitSimilarity() pixel-for-pixel.

    p0, p1: (N,2) arrays. cx, cy: image center (for conditioning).
    Returns: (tx, ty, roll_deg, residual_px_median_inliers, n_inliers, n_total)
    """
    if len(p0) < 4:
        return 0.0, 0.0, 0.0, 99.0, 0, len(p0)

    p0c = p0 - np.array([cx, cy])
    p1c = p1 - np.array([cx, cy])

    def fit(p0s, p1s):
        # Normal equations of the centered similarity model:
        #   x1 = a*x0 - b*y0 + tx
        #   y1 = b*x0 + a*y0 + ty
        x0, y0 = p0s[:, 0], p0s[:, 1]
        x1, y1 = p1s[:, 0], p1s[:, 1]
        n = len(p0s)
        # 4x4 normal matrix
        sum_xx_yy = float((x0 * x0 + y0 * y0).sum())
        sum_x = float(x0.sum())
        sum_y = float(y0.sum())
        sum_neg_y = float((-y0).sum())
        M = np.array([
            [sum_xx_yy, 0.0,        sum_x,     sum_y],
            [0.0,        sum_xx_yy, sum_neg_y, sum_x],
            [sum_x,      sum_neg_y, float(n),  0.0],
            [sum_y,      sum_x,     0.0,       float(n)],
        ])
        rhs = np.array([
            float((x0 * x1 + y0 * y1).sum()),
            float((-y0 * x1 + x0 * y1).sum()),
            float(x1.sum()),
            float(y1.sum()),
        ])
        try:
            x = np.linalg.solve(M, rhs)
        except np.linalg.LinAlgError:
            return None
        return x[0], x[1], x[2], x[3]

    f = fit(p0c, p1c)
    if f is None:
        return 0.0, 0.0, 0.0, 99.0, 0, len(p0)
    a, b, tx, ty = f
    # Residuals
    pred_x = a * p0c[:, 0] - b * p0c[:, 1] + tx
    pred_y = b * p0c[:, 0] + a * p0c[:, 1] + ty
    resid = np.hypot(pred_x - p1c[:, 0], pred_y - p1c[:, 1])
    median_r = float(np.median(resid))
    thresh = max(2.0, median_r * 2.5)
    inlier_mask = resid < thresh
    n_in = int(inlier_mask.sum())
    if n_in >= 4 and n_in < len(p0):
        f2 = fit(p0c[inlier_mask], p1c[inlier_mask])
        if f2 is not None:
            a, b, tx, ty = f2
            pred_x = a * p0c[inlier_mask, 0] - b * p0c[inlier_mask, 1] + tx
            pred_y = b * p0c[inlier_mask, 0] + a * p0c[inlier_mask, 1] + ty
            r_in = np.hypot(pred_x - p1c[inlier_mask, 0], pred_y - p1c[inlier_mask, 1])
            median_r = float(np.median(r_in))
    roll_deg = math.degrees(math.atan2(b, a))
    return float(tx), float(ty), roll_deg, median_r, n_in, len(p0)


def analyze(rec_id, fov_deg=60):
    base = '/tmp/gizmo-recordings'
    video_path = f'{base}/rec_{rec_id}.mp4'
    sensor_path = f'{base}/rec_{rec_id}.json'

    if not Path(video_path).exists():
        sys.exit(f'no video at {video_path}')
    if not Path(sensor_path).exists():
        sys.exit(f'no sensor at {sensor_path}')

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit(f'cannot open {video_path}')
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    px_per_deg_yaw = w / fov_deg
    cx, cy = w / 2.0, h / 2.0

    mask = np.ones((h, w), dtype=np.uint8) * 255
    mask[: int(h * 0.14)] = 0
    mask[int(h * 0.86):] = 0
    cv2.circle(mask, (w // 2, h // 2), 24, 0, -1)

    rows = []
    prev_gray = None
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
                rows.append({'t': t, 'n0': 0, 'n_ls': 0, 'n_ransac': 0,
                             'tx_ls': 0, 'tx_ransac': 0,
                             'roll_ls': 0, 'roll_ransac': 0,
                             'resid_ls': 999, 'resid_ransac': 999})
                prev_gray = gray; frame_idx += 1; continue
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(
                prev_gray, gray, feat, None, winSize=(21, 21), maxLevel=3,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
            )
            good = st.flatten().astype(bool)
            p0 = feat[good].reshape(-1, 2)
            p1 = nxt[good].reshape(-1, 2)
            if len(p0) < 10:
                rows.append({'t': t, 'n0': len(p0), 'n_ls': 0, 'n_ransac': 0,
                             'tx_ls': 0, 'tx_ransac': 0,
                             'roll_ls': 0, 'roll_ransac': 0,
                             'resid_ls': 999, 'resid_ransac': 999})
                prev_gray = gray; frame_idx += 1; continue

            # === A) RANSAC affine ===
            M, inliers = cv2.estimateAffinePartial2D(
                p0, p1, method=cv2.RANSAC, ransacReprojThreshold=2.0,
                maxIters=2000, confidence=0.99,
            )
            if M is None:
                tx_r, roll_r, resid_r, n_in_r = 0, 0, 999.0, 0
            else:
                a_r, b_r = M[0, 0], M[0, 1]
                tx_r, ty_r = M[0, 2], M[1, 2]
                roll_r = math.degrees(math.atan2(b_r, a_r))
                ones = np.ones((p0.shape[0], 1))
                p0_h = np.hstack([p0, ones])
                p1_pred = (M @ p0_h.T).T
                resid = np.hypot(*(p1 - p1_pred).T)
                inlier_mask = inliers.flatten().astype(bool) if inliers is not None else np.ones(len(p0), dtype=bool)
                n_in_r = int(inlier_mask.sum())
                resid_r = float(np.median(resid[inlier_mask])) if n_in_r > 0 else 999.0

            # === B) Least-squares fitSimilarity ===
            tx_l, ty_l, roll_l, resid_l, n_in_l, _ = fit_similarity_ls(p0, p1, cx, cy)

            rows.append({
                't': t, 'n0': len(p0),
                'n_ls': n_in_l, 'n_ransac': n_in_r,
                'tx_ls': tx_l, 'tx_ransac': tx_r,
                'roll_ls': roll_l, 'roll_ransac': roll_r,
                'resid_ls': resid_l, 'resid_ransac': resid_r,
            })
        prev_gray = gray
        frame_idx += 1
    cap.release()

    # === Integrate tx → cumulative yaw for each algorithm ===
    cum_yaw_ls = 0.0
    cum_yaw_r = 0.0
    for r in rows:
        r['cum_yaw_ls'] = cum_yaw_ls
        r['cum_yaw_ransac'] = cum_yaw_r
        cum_yaw_ls += -r['tx_ls'] / px_per_deg_yaw
        cum_yaw_r += -r['tx_ransac'] / px_per_deg_yaw

    out = Path(f'{base}/compare-{rec_id}.csv')
    fieldnames = ['t','n0','n_ls','n_ransac','tx_ls','tx_ransac','roll_ls','roll_ransac',
                  'resid_ls','resid_ransac','cum_yaw_ls','cum_yaw_ransac']
    with out.open('w') as f:
        f.write(','.join(fieldnames) + '\n')
        for r in rows:
            f.write(','.join(f"{r[k]:.4f}" if isinstance(r[k], float) else str(r[k]) for k in fieldnames) + '\n')

    # === Truth scoring ===
    sensor = json.load(open(sensor_path))
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    pts = [(s['t']/1000, s['webkitCompassHeading']) for s in o if abs(s['gamma']) < 10 and s['beta'] > 70]
    anchors = []
    if pts:
        clusters = [[pts[0]]]
        for x in pts[1:]:
            if x[0] - clusters[-1][-1][0] < 0.1:
                clusters[-1].append(x)
            else:
                clusters.append([x])
        anchors = [(float(np.median([x[0] for x in c])), float(np.median([x[1] for x in c]))) for c in clusters]

    # Score each algorithm: at each anchor time, find the algorithm's cum_yaw
    # offset relative to the FIRST anchor (visual yaw is relative; anchor it to
    # the first compass-truth moment). Then compare the visual-anchor delta to
    # the truth-anchor delta. RMS over all subsequent anchors.
    if len(anchors) < 2:
        print(f'  not enough truth anchors ({len(anchors)}) — skip scoring')
        print(f'  wrote {out}')
        return

    t_arr = np.array([r['t'] for r in rows])
    yaw_ls_arr = np.array([r['cum_yaw_ls'] for r in rows])
    yaw_r_arr = np.array([r['cum_yaw_ransac'] for r in rows])

    def score(yaw_arr):
        # Anchor to first truth moment
        a0_t, a0_b = anchors[0]
        idx0 = int(np.argmin(np.abs(t_arr - a0_t)))
        offset = a0_b - yaw_arr[idx0]
        errs = []
        for (at, ab) in anchors[1:]:
            idx = int(np.argmin(np.abs(t_arr - at)))
            est = (yaw_arr[idx] + offset) % 360
            e = ((est - ab + 540) % 360) - 180
            errs.append(e)
        if not errs:
            return float('nan'), float('nan')
        return float(np.sqrt(np.mean(np.array(errs)**2))), float(np.max(np.abs(errs)))

    rms_ls, mx_ls = score(yaw_ls_arr)
    rms_r, mx_r = score(yaw_r_arr)

    print(f'\nrec_{rec_id}  (fps={fps:.1f}, video {w}x{h}, frames={len(rows)+1})')
    print(f'  truth anchors: {len(anchors)} (upright |γ|<10 β>70)')
    print(f'')
    print(f'  {"algorithm":<28} {"RMS":>6} {"max":>6}')
    print(f'  {"-"*28} {"-"*6} {"-"*6}')
    print(f'  {"A) cv2.estimateAffine2D + RANSAC":<28} {rms_r:6.2f} {mx_r:6.2f}')
    print(f'  {"B) fitSimilarity (LS+iters)":<28} {rms_ls:6.2f} {mx_ls:6.2f}')
    diff = rms_r - rms_ls
    if abs(diff) < 0.5:
        verdict = "≈ tie"
    elif diff > 0:
        verdict = f"B wins by {abs(diff):.1f}°"
    else:
        verdict = f"A wins by {abs(diff):.1f}°"
    print(f'\n  verdict: {verdict}')
    print(f'\n  wrote {out}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: compare_fitters.py <rec_id>')
    analyze(sys.argv[1])
