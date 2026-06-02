"""
Validate JS Lucas-Kanade by comparing OpenCV's output to what my JS LK would
produce on the same input frame pairs. Run OpenCV in Python on the same PNG
files that the TS test will use; emit reference output.
"""
import cv2
import numpy as np
import json

LK_W = 180
LK_H = 320
WIN = 7

pairs = [
    ('t0.5.png', 't4.0.png',  'upright → start of roll'),
    ('t4.0.png', 't5.5.png',  'mid-roll'),
    ('t5.5.png', 't8.0.png',  'late roll → return upright'),
    ('t8.0.png', 't15.0.png', 'between rolls (calm)'),
    ('t15.0.png','t22.0.png', 'exploration'),
]

results = []
for a, b, desc in pairs:
    img_a = cv2.imread(f'/tmp/gizmo-analysis/lk-test/{a}', cv2.IMREAD_GRAYSCALE)
    img_b = cv2.imread(f'/tmp/gizmo-analysis/lk-test/{b}', cv2.IMREAD_GRAYSCALE)
    if img_a is None or img_b is None:
        print(f'  skip {a} -> {b}: file missing'); continue
    mask = np.ones((LK_H, LK_W), dtype=np.uint8) * 255
    mask[: int(LK_H * 0.18)] = 0
    mask[int(LK_H * 0.82):] = 0
    feat = cv2.goodFeaturesToTrack(img_a, maxCorners=32, qualityLevel=0.02,
                                    minDistance=28, blockSize=7, mask=mask)
    if feat is None: continue
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(img_a, img_b, feat, None,
                                          winSize=(2*WIN+1, 2*WIN+1), maxLevel=1,
                                          criteria=(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT, 6, 0.01))
    good = st.flatten().astype(bool)
    p0 = feat[good].reshape(-1, 2)
    p1 = nxt[good].reshape(-1, 2)
    M, inliers = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC,
                                              ransacReprojThreshold=2.0, maxIters=2000)
    if M is None:
        print(f'  {a} -> {b}: M=None'); continue
    a_, b_ = M[0, 0], M[0, 1]
    tx, ty = M[0, 2], M[1, 2]
    roll = np.degrees(np.arctan2(b_, a_))
    n_in = int(inliers.sum()) if inliers is not None else 0
    results.append({'a': a, 'b': b, 'desc': desc, 'n_features': len(p0),
                    'n_inliers': n_in, 'tx': float(tx), 'ty': float(ty),
                    'roll_deg': float(roll)})
    print(f'  {a:>10} → {b:<10} ({desc}): {len(p0):>3} feat, {n_in:>3} inliers, tx={tx:+6.2f}px ty={ty:+6.2f}px roll={roll:+6.2f}°')

with open('/tmp/gizmo-analysis/lk-test/opencv-reference.json', 'w') as f:
    json.dump(results, f, indent=2)
print(f'\nwrote opencv-reference.json with {len(results)} pairs')
