"""Rotation-only optical flow camera-truth extractor (refinement of of.py).

For a camera rotating in place, every scene point shifts by the SAME pixel amount
regardless of depth:  yaw -> uniform horizontal shift (f*dyaw), pitch -> uniform
vertical shift (f*dpitch), roll -> rotation about the principal point. Camera
*translation* instead produces depth-dependent (parallax) shift. So the robust
*median* per-point displacement isolates rotation and rejects parallax/translation
outliers better than a plain affine translation term.

Per frame we output:
  t, dx_med, dy_med, roll_deg, n           (instantaneous, rotation-only)
and the consumer integrates to cumulative yaw/pitch/roll.

  dx_med : median horizontal point displacement (px)  -> yaw signal
  dy_med : median vertical point displacement (px)     -> pitch signal
  roll   : affine rotation angle (deg) from the robust similarity fit -> roll signal
  n      : inlier/track count (flow confidence)
"""
import cv2, numpy as np, json, sys

def flow(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, prev = cap.read()
    prevg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    H, W = prevg.shape[:2]
    out = []
    fi = 0
    lk = dict(winSize=(21, 21), maxLevel=3,
              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        fi += 1
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        dx_med = dy_med = roll = 0.0
        n = 0
        p0 = cv2.goodFeaturesToTrack(prevg, maxCorners=300, qualityLevel=0.01, minDistance=8)
        if p0 is not None and len(p0) >= 6:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prevg, g, p0, None, **lk)
            if p1 is not None:
                m = (st.ravel() == 1)
                a = p0[m].reshape(-1, 2)
                b = p1[m].reshape(-1, 2)
                if len(a) >= 6:
                    d = b - a
                    # robust rotation-only translation = median displacement (rejects parallax)
                    dx_med = float(np.median(d[:, 0]))
                    dy_med = float(np.median(d[:, 1]))
                    M, inliers = cv2.estimateAffinePartial2D(a, b)
                    if M is not None:
                        roll = float(np.degrees(np.arctan2(M[1, 0], M[0, 0])))
                        n = int(inliers.sum()) if inliers is not None else len(a)
                    else:
                        n = len(a)
        out.append([round(fi / fps, 3), round(dx_med, 3), round(dy_med, 3),
                    round(roll, 4), n])
        prevg = g
    cap.release()
    return {"W": W, "H": H, "fps": fps, "flow2": out}

if __name__ == "__main__":
    path, outp = sys.argv[1], sys.argv[2]
    res = flow(path)
    json.dump(res, open(outp, "w"))
    fl = res["flow2"]
    cdx = np.cumsum([r[1] for r in fl])
    cdy = np.cumsum([r[2] for r in fl])
    croll = np.cumsum([r[3] for r in fl])
    print(f"{path}: frames={len(fl)} W={res['W']} H={res['H']} fps={res['fps']:.0f} "
          f"cum_dx={cdx[-1]:.0f}px cum_dy={cdy[-1]:.0f}px cum_roll={croll[-1]:.0f}deg "
          f"median_n={np.median([r[4] for r in fl]):.0f}")
