import cv2, numpy as np, json, sys

def flow(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, prev = cap.read()
    prevg = cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY)
    W = prevg.shape[1]
    cum_tx = 0.0
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
        inl = 0
        p0 = cv2.goodFeaturesToTrack(prevg, maxCorners=300, qualityLevel=0.01, minDistance=8)
        if p0 is not None and len(p0) >= 6:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(prevg, g, p0, None, **lk)
            if p1 is not None:
                m = (st.ravel() == 1)
                a = p0[m].reshape(-1, 2)
                b = p1[m].reshape(-1, 2)
                if len(a) >= 6:
                    M, inliers = cv2.estimateAffinePartial2D(a, b)
                    if M is not None:
                        cum_tx += float(M[0, 2])
                        inl = int(inliers.sum()) if inliers is not None else len(a)
        out.append([round(fi / fps, 3), round(cum_tx, 2), inl])
        prevg = g
    cap.release()
    return {"W": W, "fps": fps, "flow": out}

path, outp = sys.argv[1], sys.argv[2]
res = flow(path)
json.dump(res, open(outp, "w"))
fl = res["flow"]
print(f"{path}: frames={len(fl)} W={res['W']} fps={res['fps']:.0f} final_cum_tx={fl[-1][1]:.0f}px")
