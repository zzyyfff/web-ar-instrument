"""Translation-ROBUST camera rotation truth (offline only — uses full geometry).

The recordings include heavy camera TRANSLATION (walking around a room), so median
optical-flow displacement conflates yaw with sideways-translation parallax. Here we
recover the true inter-frame ROTATION independent of translation, two ways, and keep
both for cross-checking:

  (A) Essential matrix: findEssentialMat(RANSAC) + recoverPose -> R. Needs parallax
      (translation) to be well conditioned; great here because we ARE translating.
  (B) Homography: many scenes here are planar (doors/walls). findHomography +
      decomposeHomographyMat -> rotation candidates; we pick the candidate whose
      rotation axis/angle is most consistent (smallest) as the rotation part.

Intrinsics from measured FOV (~44 H / ~59 V on 480x640): f ~= 580 px, pp = (240,320).
Per frame we output incremental yaw/pitch/roll (deg) for BOTH methods + inlier counts,
so we can compare against compass(yaw)/beta(pitch)/gamma(roll) free of translation.
"""
import cv2, numpy as np, json, sys

F = 580.0
PP = (240.0, 320.0)
K = np.array([[F, 0, PP[0]], [0, F, PP[1]], [0, 0, 1]], float)

def R_to_euler_ypr(R):
    """camera-frame intrinsic: yaw about Y, pitch about X, roll about Z (deg)."""
    sy = -R[2, 0]
    sy = max(-1.0, min(1.0, sy))
    pitch = np.degrees(np.arcsin(sy))           # about X (look up/down)
    yaw = np.degrees(np.arctan2(R[2, 1], R[2, 2]))  # NOTE: recompute below cleanly
    # Use a stable decomposition (YXZ-ish). Extract from rotation matrix:
    yaw = np.degrees(np.arctan2(R[0, 2], R[2, 2]))   # about Y (pan)
    pitch = np.degrees(np.arctan2(-R[1, 2], np.hypot(R[0, 2], R[2, 2])))  # about X
    roll = np.degrees(np.arctan2(R[1, 0], R[1, 1]))  # about Z
    return yaw, pitch, roll

def flow(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, prev = cap.read()
    prevg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
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
        ey = ep = er = hy = hp = hr = 0.0
        nE = nH = 0
        p0 = cv2.goodFeaturesToTrack(prevg, maxCorners=400, qualityLevel=0.01, minDistance=7)
        if p0 is not None and len(p0) >= 8:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prevg, g, p0, None, **lk)
            if p1 is not None:
                m = (st.ravel() == 1)
                a = p0[m].reshape(-1, 2); b = p1[m].reshape(-1, 2)
                if len(a) >= 8:
                    # (A) essential matrix
                    E, em = cv2.findEssentialMat(a, b, K, method=cv2.RANSAC,
                                                 prob=0.999, threshold=1.0)
                    if E is not None and E.shape == (3, 3):
                        _, R, t, _ = cv2.recoverPose(E, a, b, K)
                        ey, ep, er = R_to_euler_ypr(R)
                        nE = int(em.sum()) if em is not None else 0
                    # (B) homography
                    Hm, hmask = cv2.findHomography(a, b, cv2.RANSAC, 3.0)
                    if Hm is not None:
                        ok2, Rs, Ts, Ns = cv2.decomposeHomographyMat(Hm, K)
                        if ok2 and len(Rs):
                            # pick rotation with smallest angle (most rotation-like, least skew)
                            best = min(Rs, key=lambda R: abs(np.degrees(
                                np.arccos(max(-1, min(1, (np.trace(R) - 1) / 2))))))
                            hy, hp, hr = R_to_euler_ypr(best)
                            nH = int(hmask.sum()) if hmask is not None else 0
        out.append([round(fi / fps, 3),
                    round(ey, 4), round(ep, 4), round(er, 4), nE,
                    round(hy, 4), round(hp, 4), round(hr, 4), nH])
        prevg = g
    cap.release()
    return {"f": F, "pp": PP, "fps": fps, "cols": "t,eyaw,epitch,eroll,nE,hyaw,hpitch,hroll,nH", "rot": out}

if __name__ == "__main__":
    path, outp = sys.argv[1], sys.argv[2]
    res = flow(path)
    json.dump(res, open(outp, "w"))
    r = np.array([x[1:] for x in res["rot"]])
    cum = np.cumsum(r, axis=0)
    print(f"{path}: frames={len(r)} fps={res['fps']:.0f}")
    print(f"  ESSENTIAL cum yaw={cum[-1,0]:7.0f} pitch={cum[-1,1]:7.0f} roll={cum[-1,2]:7.0f}  med_inl={np.median(r[:,3]):.0f}")
    print(f"  HOMOGRAPHY cum yaw={cum[-1,4]:7.0f} pitch={cum[-1,5]:7.0f} roll={cum[-1,6]:7.0f}  med_inl={np.median(r[:,7]):.0f}")
