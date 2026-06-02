"""Refined camera-truth: align (time) + scale (FOV) in the VELOCITY domain.

Why velocity domain:
  - Video clock and sensor clock have independent origins -> unknown time offset tau.
  - Cumulative integrals accumulate drift; velocities don't.
So we cross-correlate camera yaw-RATE (px/s) vs compass yaw-RATE (deg/s) over a sweep
of candidate lags tau. For each tau we regress  compass_rate = k * camera_rate  and
keep the tau with best R^2. k (deg/px) is the physical scale -> HFOV = k * W.

A physically real camera-truth should give:
  (1) a clear R^2 peak at some tau (alignment exists),
  (2) the SAME k / FOV for both recordings (same device), and
  (3) k consistent with the device's real HFOV.

Reports per recording, per axis (yaw/pitch/roll), the best lag, k, FOV, R^2.
"""
import json, numpy as np
import os

DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir

def unwrap_deg(a):
    return np.degrees(np.unwrap(np.radians(a)))

def load(rid):
    d = json.load(open(f'{DATA}/{rid}.json'))
    S = [s for s in d['samples'] if 'o' in s and s['o'].get('webkitCompassHeading') is not None]
    t = np.array([s['t'] / 1000 for s in S])
    t = t - t[0]
    comp = unwrap_deg(np.array([float(s['o']['webkitCompassHeading']) for s in S]))
    gamma = np.array([float(s['o'].get('gamma') or 0) for s in S])
    beta = np.array([float(s['o'].get('beta') or 0) for s in S])
    f2 = json.load(open(f'{DIR}/{rid}.flow2.json'))
    fr = f2['flow2']
    ft = np.array([r[0] for r in fr])
    dx = np.array([r[1] for r in fr])   # per-frame median horiz disp (px) -> yaw rate * dt
    dy = np.array([r[2] for r in fr])
    droll = np.array([r[3] for r in fr])  # per-frame roll (deg)
    n = np.array([r[4] for r in fr])
    fps = f2['fps']; W = f2['W']
    return dict(t=t, comp=comp, gamma=gamma, beta=beta,
                ft=ft, dx=dx, dy=dy, droll=droll, n=n, fps=fps, W=W)

def deriv(t, x):
    """central-difference rate dx/dt on possibly non-uniform t -> resample to 20Hz."""
    grid = np.arange(t[0], t[-1], 0.05)
    xg = np.interp(grid, t, x)
    rate = np.gradient(xg, grid)
    return grid, rate

def align_scale(cam_grid, cam_rate, sens_grid, sens_rate, lag_range=(-3, 3), step=0.05):
    """find tau maximizing R^2 of sens_rate ~ k * cam_rate(shifted by tau)."""
    best = None
    lo = max(cam_grid[0], sens_grid[0]) + abs(lag_range[1])
    hi = min(cam_grid[-1], sens_grid[-1]) - abs(lag_range[1])
    base = np.arange(lo, hi, 0.05)
    sr = np.interp(base, sens_grid, sens_rate)
    for tau in np.arange(lag_range[0], lag_range[1] + 1e-9, step):
        cr = np.interp(base + tau, cam_grid, cam_rate)
        # regress sr = k*cr (through origin; rate has natural zero)
        denom = np.dot(cr, cr)
        if denom < 1e-9:
            continue
        k = np.dot(cr, sr) / denom
        pred = k * cr
        ss_res = np.sum((sr - pred) ** 2)
        ss_tot = np.sum((sr - sr.mean()) ** 2)
        r2 = 1 - ss_res / ss_tot if ss_tot > 1e-9 else 0
        if best is None or r2 > best['r2']:
            best = dict(tau=tau, k=k, r2=r2, n=len(base))
    return best

print("AXIS-BY-AXIS velocity-domain alignment + scale (rotation-only camera-truth)\n")
results = {}
for rid in ['rec_106z3v43', 'rec_260r4o4b']:
    D = load(rid)
    results[rid] = D
    # camera cumulative signals -> rate. dx is per-frame disp; cumulative = cumsum.
    cam_t = D['ft']
    cum_dx = np.cumsum(D['dx']); cum_dy = np.cumsum(D['dy']); cum_roll = np.cumsum(D['droll'])
    cg, cyaw_rate = deriv(cam_t, cum_dx)       # px/s
    _,  cpitch_rate = deriv(cam_t, cum_dy)
    _,  croll_rate = deriv(cam_t, cum_roll)    # deg/s (roll already in deg)
    # sensor rates
    sg, comp_rate = deriv(D['t'], D['comp'])   # deg/s yaw
    _,  beta_rate = deriv(D['t'], D['beta'])   # deg/s pitch
    _,  gamma_rate = deriv(D['t'], D['gamma']) # deg/s roll
    print(f"=== {rid}  (W={D['W']}, median tracks={np.median(D['n']):.0f}) ===")
    for name, crate, srate in [('YAW  (dx vs compass)', cyaw_rate, comp_rate),
                                ('PITCH(dy vs beta)   ', cpitch_rate, beta_rate),
                                ('ROLL (rot vs gamma) ', croll_rate, gamma_rate)]:
        b = align_scale(cg if 'YAW' in name or True else cg, crate, sg, srate)
        if b is None:
            print(f"  {name}: no fit"); continue
        fov = abs(b['k'] * D['W']) if 'YAW' in name or 'PITCH' in name else None
        extra = f"FOV~{fov:.0f}deg" if fov is not None else f"gain {b['k']:.2f}deg/deg"
        print(f"  {name}: lag {b['tau']:+.2f}s  k={b['k']:+.3f}  {extra}  R2={b['r2']:.2f}")
    print()
