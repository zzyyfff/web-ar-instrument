"""Validate translation-robust rotation (of4) against sensors, in the rate domain.

PITCH is the ground-truth anchor: the video clearly swings to the ceiling (~13.6s) and
floor (~16.3s), so camera pitch-rate (wx) MUST correlate strongly with beta-rate. If it
does, the rotational-flow solver is trustworthy, and we can then read off the YAW result
(wy vs compass) -- now free of the walking-translation that fooled median-dx.

Rate-domain, time-aligned by cross-correlation. Also conditional agreement during
genuine-motion windows (top-quartile camera rate), with sign auto-resolved.
"""
import json, numpy as np
import os

DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir

def unwrap_deg(a): return np.degrees(np.unwrap(np.radians(a)))

def load(rid):
    d = json.load(open(f'{DATA}/{rid}.json'))
    S = [s for s in d['samples'] if 'o' in s and s['o'].get('webkitCompassHeading') is not None]
    t = np.array([s['t']/1000 for s in S]); t -= t[0]
    comp = unwrap_deg(np.array([float(s['o']['webkitCompassHeading']) for s in S]))
    beta = np.array([float(s['o'].get('beta') or 0) for s in S])
    gamma = unwrap_deg(np.array([float(s['o'].get('gamma') or 0) for s in S]))
    r = json.load(open(f'{DIR}/{rid}.rot4.json'))
    rot = np.array(r['rot']); fps = r['fps']
    ct = rot[:, 0]
    # per-frame deg -> deg/s rate
    pit = rot[:, 1] * fps; yaw = rot[:, 2] * fps; rol = rot[:, 3] * fps
    return dict(t=t, comp=comp, beta=beta, gamma=gamma, ct=ct, pit=pit, yaw=yaw, rol=rol)

def rate(t, x, grid):
    return np.gradient(np.interp(grid, t, x), grid)

def best_align(base, cam_rate_fn, sens_rate, lo, hi):
    best = None
    for tau in np.arange(-1.5, 1.5 + 1e-9, 0.05):
        cr = cam_rate_fn(base + tau)
        if np.std(cr) < 1e-6: continue
        cc = np.corrcoef(cr, sens_rate)[0, 1]
        if best is None or abs(cc) > abs(best[1]):
            best = (tau, cc)
    return best

for rid in ['rec_106z3v43', 'rec_260r4o4b']:
    D = load(rid)
    g = np.arange(0, min(D['t'][-1], D['ct'][-1]), 0.05)
    base = g[(g > 1.6) & (g < g[-1] - 1.6)]
    # sensor rates on base grid
    s_yaw = rate(D['t'], D['comp'], base)
    s_pit = rate(D['t'], D['beta'], base)
    s_rol = rate(D['t'], D['gamma'], base)
    # camera rate interpolators (rate already per-second; just resample the rate series)
    cam_yaw = lambda tt: np.interp(tt, D['ct'], D['yaw'])
    cam_pit = lambda tt: np.interp(tt, D['ct'], D['pit'])
    cam_rol = lambda tt: np.interp(tt, D['ct'], D['rol'])
    print(f"=== {rid} ===")
    for name, camfn, srate in [('PITCH (anchor: ceiling/floor)', cam_pit, s_pit),
                               ('YAW   (the question)         ', cam_yaw, s_yaw),
                               ('ROLL                         ', cam_rol, s_rol)]:
        b = best_align(base, camfn, srate, base[0], base[-1])
        tau, cc = b
        cr = camfn(base + tau)
        # genuine-motion windows by camera rate
        thr = max(np.percentile(np.abs(cr), 75), 5.0)
        big = np.abs(cr) > thr
        sgn = np.sign(cc)  # resolve axis sign convention
        diragree = np.mean(np.sign(cr[big]) == np.sign(sgn * srate[big])) if big.sum() > 5 else float('nan')
        rms_cam = np.sqrt(np.mean(cr**2)); rms_sen = np.sqrt(np.mean(srate**2))
        print(f"  {name}: corr {cc:+.2f}  lag {tau:+.2f}s  dir-agree {diragree*100:3.0f}%"
              f"   RMS cam {rms_cam:4.0f} vs sensor {rms_sen:4.0f} deg/s")
    print()
