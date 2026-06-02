import json, numpy as np
import os

def unwrap_deg(a):
    return np.degrees(np.unwrap(np.radians(a)))

def load(rid):
    d = json.load(open(f'{rid}.json'))
    S = [s for s in d['samples'] if 'o' in s and s['o'].get('webkitCompassHeading') is not None]
    t = np.array([s['t']/1000 for s in S])
    comp = np.array([float(s['o']['webkitCompassHeading']) for s in S])
    gamma = np.array([float(s['o'].get('gamma') or 0) for s in S])
    beta = np.array([float(s['o'].get('beta') or 0) for s in S])
    fl = json.load(open(f'{rid}.flow.json'))
    ft = np.array([r[0] for r in fl['flow']])
    cumtx = np.array([r[1] for r in fl['flow']])
    inl = np.array([r[2] for r in fl['flow']])
    return t, comp, gamma, beta, ft, cumtx, inl

def jit(x):  # jerk-ish: std of 2nd difference
    return float(np.std(np.diff(x, 2)))

for rid in ['rec_260r4o4b', 'rec_106z3v43']:
    t, comp, gamma, beta, ft, cumtx, inl = load(rid)
    t0, t1 = max(t[0], ft[0]), min(t[-1], ft[-1])
    grid = np.arange(t0, t1, 0.1)
    compg = np.interp(grid, t, unwrap_deg(comp))
    txg = np.interp(grid, ft, cumtx)
    gammag = np.interp(grid, t, gamma)
    inlg = np.interp(grid, ft, inl)
    # camera-truth heading = a + k*cumtx, scale k fit to compass (so they agree on average)
    A = np.vstack([np.ones_like(txg), txg]).T
    (a, k), *_ = np.linalg.lstsq(A, compg, rcond=None)
    cam = a + k * txg
    resid = compg - cam      # compass deviation from camera-truth (deg)
    rms = float(np.sqrt(np.mean(resid**2)))
    big = np.abs(resid) > 15
    print(f'=== {rid} ===')
    print(f'  overlap {t1-t0:.0f}s | compass swept {compg.max()-compg.min():.0f}° | scale {k:.3f}°/px (FOV≈{abs(480*k):.0f}°)')
    print(f'  COMPASS vs CAMERA-TRUTH residual: RMS {rms:.1f}°  max |{np.abs(resid).max():.0f}|°')
    print(f'  time compass is >15° off camera-truth: {big.mean()*100:.0f}%')
    if big.sum():
        print(f'     during those moments: mean|gamma(roll)| {np.abs(gammag[big]).mean():.0f}° vs overall {np.abs(gammag).mean():.0f}°; mean inliers {inlg[big].mean():.0f} vs {inlg.mean():.0f}')
    print(f'  jitter (std 2nd-diff): compass {jit(compg):.2f}  camera {jit(cam):.2f}  (higher = jumpier)')
    # worst few moments
    idx = np.argsort(-np.abs(resid))[:5]
    print('  worst divergences (t, compass-cam resid, gamma, inliers):')
    for i in sorted(idx):
        print(f'     t={grid[i]-t0:4.1f}s  resid {resid[i]:+5.0f}°  gamma {gammag[i]:+4.0f}°  inl {inlg[i]:.0f}')
