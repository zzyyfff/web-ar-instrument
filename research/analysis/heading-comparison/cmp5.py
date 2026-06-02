"""Bring in the GYRO (m.rot, deg/s) and LINEAR ACCEL (m.acc) the recordings also carry.

Two questions:
 1. Is the gyro a better yaw source than the compass? Correlate the translation-robust
    camera rotation (of4) against gyro rates. Use a 3x3 corr matrix (camera wx/wy/wz vs
    gyro a/b/g) so the axis mapping + sign reveal themselves empirically (device vs camera
    frames differ). Compare the matched camera-yaw<->gyro corr against camera-yaw<->compass.
 2. Confirm the 'walking' hypothesis quantitatively: linear-accel magnitude (gravity removed)
    over time = translation energy. High => walking/translating (parallax), not rotate-in-place.
"""
import json, numpy as np
import os

DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir

def unwrap_deg(a): return np.degrees(np.unwrap(np.radians(a)))

def load(rid):
    d = json.load(open(f'{DATA}/{rid}.json'))
    S = d['samples']
    t = np.array([s['t']/1000 for s in S]); t -= t[0]
    def mg(path, default=0.0):
        out=[]
        for s in S:
            cur=s
            ok=True
            for k in path:
                if isinstance(cur, dict) and k in cur and cur[k] is not None: cur=cur[k]
                else: ok=False; break
            out.append(float(cur) if ok else default)
        return np.array(out)
    comp = unwrap_deg(mg(['o','webkitCompassHeading']))
    beta = mg(['o','beta'])
    # gyro rotation rate deg/s
    ra = mg(['m','rot','a']); rb = mg(['m','rot','b']); rg = mg(['m','rot','g'])
    # linear acceleration (gravity removed), m/s^2
    ax = mg(['m','acc','x']); ay = mg(['m','acc','y']); az = mg(['m','acc','z'])
    lin = np.sqrt(ax**2+ay**2+az**2)
    r = json.load(open(f'{DIR}/{rid}.rot4.json'))
    rot = np.array(r['rot']); fps=r['fps']; ct=rot[:,0]
    cam = dict(pit=rot[:,1]*fps, yaw=rot[:,2]*fps, rol=rot[:,3]*fps)  # deg/s
    return dict(t=t, comp=comp, beta=beta, ra=ra, rb=rb, rg=rg, lin=lin, ct=ct, cam=cam)

def best_corr(base, cam_series, ct, sens, st, lags=np.arange(-1.0,1.0001,0.05)):
    best=(0,0)
    for tau in lags:
        c=np.interp(base+tau, ct, cam_series)
        s=np.interp(base, st, sens)
        if np.std(c)<1e-9 or np.std(s)<1e-9: continue
        cc=np.corrcoef(c,s)[0,1]
        if abs(cc)>abs(best[1]): best=(tau,cc)
    return best

for rid in ['rec_106z3v43','rec_260r4o4b']:
    D=load(rid)
    g=np.arange(0, min(D['t'][-1], D['ct'][-1]), 0.05)
    base=g[(g>1.1)&(g<g[-1]-1.1)]
    print(f"=== {rid} ===")
    # translation energy
    linb=np.interp(base, D['t'], D['lin'])
    print(f"  linear-accel (translation) RMS {np.sqrt(np.mean(linb**2)):.2f} m/s^2  "
          f"peak {linb.max():.1f}  (walking if >~1-2)")
    # 3x3 camera-vs-gyro correlation matrix (best lag each)
    cams=[('pit',D['cam']['pit']),('yaw',D['cam']['yaw']),('rol',D['cam']['rol'])]
    gyros=[('rot.a',D['ra']),('rot.b',D['rb']),('rot.g',D['rg'])]
    print("  camera-vs-GYRO corr matrix (best |corr|, signed):")
    print("           "+ "".join(f"{gn:>9}" for gn,_ in gyros))
    for cn,cs in cams:
        row=[]
        for gn,gs in gyros:
            tau,cc=best_corr(base, cs, D['ct'], gs, D['t'])
            row.append(cc)
        print(f"    cam {cn:>3}: "+"".join(f"{v:+9.2f}" for v in row))
    # head-to-head for YAW: camera-yaw vs best gyro axis vs compass
    tau_g,cc_g=best_corr(base, D['cam']['yaw'], D['ct'], D['rg'], D['t'])  # gamma usually = pan
    tau_a,cc_a=best_corr(base, D['cam']['yaw'], D['ct'], D['ra'], D['t'])  # alpha = screen-normal
    # compass rate
    compr=np.gradient(np.interp(base, D['t'], D['comp']), base)
    tau_c,cc_c=best_corr(base, D['cam']['yaw'], D['ct'], compr, base)
    print(f"  YAW source quality (corr with translation-robust camera yaw):")
    print(f"     gyro rot.g {cc_g:+.2f} | gyro rot.a {cc_a:+.2f} | COMPASS {cc_c:+.2f}")
    print()
