"""Disambiguate the low YAW R^2: is the compass genuinely bad, or was there just
little yaw motion (low SNR)? And report per-axis motion magnitude.

Tests:
 1. Per-axis motion magnitude (camera + sensor): RMS rate, total variation. Tells us
    whether each axis actually had signal to measure.
 2. Conditional yaw agreement: restrict to windows where the CAMERA yaw rate is large
    (real yaw is happening). If compass tracks there, low overall R^2 was just SNR.
    If compass still doesn't track during genuine yaw, the compass is bad.
 3. Using the consensus physical scale k=0.092 deg/px, integrate camera yaw and compare
    cumulative camera-yaw vs compass over the recording (time-aligned at lag=0).
"""
import json, numpy as np
import os

DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir
K = 0.092  # deg/px consensus scale (HFOV~44, VFOV~59 on 480x640)

def unwrap_deg(a): return np.degrees(np.unwrap(np.radians(a)))

def load(rid):
    d = json.load(open(f'{DATA}/{rid}.json'))
    S = [s for s in d['samples'] if 'o' in s and s['o'].get('webkitCompassHeading') is not None]
    t = np.array([s['t']/1000 for s in S]); t -= t[0]
    comp = unwrap_deg(np.array([float(s['o']['webkitCompassHeading']) for s in S]))
    beta = np.array([float(s['o'].get('beta') or 0) for s in S])
    f2 = json.load(open(f'{DIR}/{rid}.flow2.json'))['flow2']
    ft = np.array([r[0] for r in f2])
    dx = np.array([r[1] for r in f2]); dy = np.array([r[2] for r in f2])
    return dict(t=t, comp=comp, beta=beta, ft=ft, dx=dx, dy=dy)

def resample(t, x, grid): return np.interp(grid, t, x)

for rid in ['rec_106z3v43', 'rec_260r4o4b']:
    D = load(rid)
    g = np.arange(0, min(D['t'][-1], D['ft'][-1]), 0.05)
    # camera cumulative deg via consensus scale
    cam_yaw = resample(D['ft'], np.cumsum(D['dx'])*K, g)
    cam_pit = resample(D['ft'], np.cumsum(D['dy'])*K, g)
    comp = resample(D['t'], D['comp'], g)
    beta = resample(D['t'], D['beta'], g)
    # rates (deg/s)
    cyr = np.gradient(cam_yaw, g); cpr = np.gradient(cam_pit, g)
    compr = np.gradient(comp, g); betar = np.gradient(beta, g)
    print(f"=== {rid} ===")
    # 1. motion magnitude
    def tv(x): return np.sum(np.abs(np.diff(x)))  # total variation (deg)
    print(f"  motion magnitude (total variation over {g[-1]:.0f}s):")
    print(f"     camera yaw  {tv(cam_yaw):6.0f}deg   compass     {tv(comp):6.0f}deg")
    print(f"     camera pitch{tv(cam_pit):6.0f}deg   beta        {tv(beta):6.0f}deg")
    print(f"  RMS rate: cam_yaw {np.sqrt(np.mean(cyr**2)):5.1f}  compass {np.sqrt(np.mean(compr**2)):6.1f}"
          f"  | cam_pitch {np.sqrt(np.mean(cpr**2)):5.1f}  beta {np.sqrt(np.mean(betar**2)):5.1f} deg/s")
    # 2. conditional yaw agreement during genuine large camera-yaw windows
    thr = np.percentile(np.abs(cyr), 75)
    big = np.abs(cyr) > max(thr, 5.0)   # real yaw happening (>5deg/s and top quartile)
    if big.sum() > 10:
        # correlation of rates within those windows
        cc = np.corrcoef(cyr[big], compr[big])[0,1]
        # sign agreement: do they move the same direction?
        sign_agree = np.mean(np.sign(cyr[big]) == np.sign(compr[big]))
        print(f"  during genuine yaw ({big.sum()} samples, |cam_yaw_rate|>{max(thr,5.0):.0f}deg/s):")
        print(f"     rate corr cam-vs-compass {cc:+.2f}   direction-agreement {sign_agree*100:.0f}%")
    else:
        print(f"  (too little large-yaw motion: only {big.sum()} samples)")
    # pitch counterpart for contrast
    thrp = np.percentile(np.abs(cpr), 75)
    bigp = np.abs(cpr) > max(thrp, 5.0)
    if bigp.sum() > 10:
        ccp = np.corrcoef(cpr[bigp], betar[bigp])[0,1]
        sap = np.mean(np.sign(cpr[bigp]) == np.sign(betar[bigp]))
        print(f"  during genuine pitch ({bigp.sum()} samples): rate corr cam-vs-beta {ccp:+.2f}   dir-agree {sap*100:.0f}%")
    print()
