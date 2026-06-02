"""Translation-robust camera ROTATION RATE via the linear rotational-flow model.

For small inter-frame camera rotation w=(wx,wy,wz) [rad], a point at normalized image
coords (x,y)=((u-cx)/f,(v-cy)/f) has rotational flow (normalized units, focal=1):
    u_n =  x*y*wx - (1+x^2)*wy + y*wz
    v_n = (1+y^2)*wx -  x*y*wy - x*wz
This is LINEAR in (wx,wy,wz). Camera TRANSLATION adds depth-dependent flow that does
NOT fit this model -> appears as outliers, rejected by RANSAC. So we recover pure
rotation rate per frame, free of the walking-translation parallax that fooled median-dx.

wx=pitch rate (look up/down), wy=yaw rate (pan), wz=roll rate. Output deg/frame
(multiply by fps for deg/s). No integration -> no pose-winding drift.
"""
import cv2, numpy as np, json, sys

F = 580.0
CX, CY = 240.0, 320.0

def solve_rot(a, b, iters=80, thr=0.0025):
    """RANSAC linear solve for (wx,wy,wz) in radians from flow a->b."""
    xn = (a[:, 0] - CX) / F; yn = (a[:, 1] - CY) / F
    un = (b[:, 0] - a[:, 0]) / F; vn = (b[:, 1] - a[:, 1]) / F
    N = len(xn)
    # rows: [u; v] stacked. design per point:
    Au = np.stack([xn * yn, -(1 + xn**2), yn], 1)
    Av = np.stack([(1 + yn**2), -xn * yn, -xn], 1)
    A = np.concatenate([Au, Av], 0)            # 2N x 3
    rhs = np.concatenate([un, vn], 0)          # 2N
    best_in = None; best_w = None
    rng_idx = np.arange(N)
    for it in range(iters):
        s = (rng_idx * (it * 2 + 7) + it * 13) % N   # deterministic pseudo-sample
        sel = np.unique(s[:8])
        if len(sel) < 4:
            sel = rng_idx[:6]
        rows = np.concatenate([sel, sel + N])
        w, *_ = np.linalg.lstsq(A[rows], rhs[rows], rcond=None)
        res = (A @ w) - rhs
        resp = np.sqrt(res[:N]**2 + res[N:]**2)   # per-point residual magnitude
        inl = resp < thr
        if best_in is None or inl.sum() > best_in.sum():
            best_in = inl; best_w = w
    if best_in is not None and best_in.sum() >= 4:
        rows = np.concatenate([np.where(best_in)[0], np.where(best_in)[0] + N])
        w, *_ = np.linalg.lstsq(A[rows], rhs[rows], rcond=None)
        return w, int(best_in.sum())
    return best_w, int(best_in.sum()) if best_in is not None else (np.zeros(3), 0)

def flow(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, prev = cap.read()
    prevg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    out = []; fi = 0
    lk = dict(winSize=(21, 21), maxLevel=3,
              criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        fi += 1
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        wx = wy = wz = 0.0; n = 0
        p0 = cv2.goodFeaturesToTrack(prevg, maxCorners=400, qualityLevel=0.01, minDistance=7)
        if p0 is not None and len(p0) >= 8:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prevg, g, p0, None, **lk)
            if p1 is not None:
                m = (st.ravel() == 1)
                a = p0[m].reshape(-1, 2); b = p1[m].reshape(-1, 2)
                if len(a) >= 8:
                    w, n = solve_rot(a, b)
                    if w is not None:
                        wx, wy, wz = (np.degrees(w)).tolist()
        out.append([round(fi / fps, 3), round(wx, 4), round(wy, 4), round(wz, 4), n])
        prevg = g
    cap.release()
    return {"f": F, "fps": fps, "cols": "t,pitch_deg,yaw_deg,roll_deg,ninl", "rot": out}

if __name__ == "__main__":
    path, outp = sys.argv[1], sys.argv[2]
    res = flow(path)
    json.dump(res, open(outp, "w"))
    r = np.array([x[1:] for x in res["rot"]])
    cum = np.cumsum(r[:, :3], axis=0)
    tv = np.sum(np.abs(r[:, :3]), axis=0)
    print(f"{path}: frames={len(r)} fps={res['fps']:.0f} med_inl={np.median(r[:,3]):.0f}")
    print(f"  cumulative deg: pitch={cum[-1,0]:7.0f} yaw={cum[-1,1]:7.0f} roll={cum[-1,2]:7.0f}")
    print(f"  total-variation deg (how much each axis MOVED): pitch={tv[0]:6.0f} yaw={tv[1]:6.0f} roll={tv[2]:6.0f}")
