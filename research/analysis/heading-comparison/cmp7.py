"""Validate the EXACT deployed yaw math before shipping it.

Deployed formula (calibrator compass-gated / AD gyro-only profile):
  u = -accG / |accG|                         (world-up in phone frame; accG = m.accG)
  ra = alpha, rb = beta, rg = -gamma   (rad/s; gamma sign-flipped, per onMotion)
  yawRate = rb*ux + rg*uy + ra*uz            (rad/s, body-rate projected onto world-up)
  yaw -= yawRate * dt                        (compass-style CW heading, free-running)

Compare integrated gyro yaw vs translation-robust camera cumulative yaw (of4). This is
pose-independent (projection onto world-up), unlike cmp5's raw axis matrix. Want: strong
corr + low tracking RMS + correct SIGN (so panning rotates the scene the right way).
"""
import json, numpy as np
import os
DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir

def load(rid):
    d=json.load(open(f'{DATA}/{rid}.json')); S=d['samples']
    t=np.array([s['t']/1000 for s in S]); t-=t[0]
    def mg(p):
        out=[]
        for s in S:
            c=s; ok=True
            for k in p:
                if isinstance(c,dict) and c.get(k) is not None: c=c[k]
                else: ok=False;break
            out.append(float(c) if ok else 0.0)
        return np.array(out)
    gx,gy,gz=mg(['m','accG','x']),mg(['m','accG','y']),mg(['m','accG','z'])
    a,b,g=mg(['m','rot','a']),mg(['m','rot','b']),mg(['m','rot','g'])  # deg/s raw
    r=json.load(open(f'{DIR}/{rid}.rot4.json')); rot=np.array(r['rot']); fps=r['fps']
    ct=rot[:,0]; cam_yaw_rate=rot[:,2]*fps  # deg/s
    return t,gx,gy,gz,a,b,g,ct,cam_yaw_rate

deg=np.pi/180
for rid in ['rec_106z3v43','rec_260r4o4b']:
    t,gx,gy,gz,a,b,g,ct,cyr=load(rid)
    grid=np.arange(0,min(t[-1],ct[-1]),0.05)
    gxg=np.interp(grid,t,gx); gyg=np.interp(grid,t,gy); gzg=np.interp(grid,t,gz)
    gm=np.sqrt(gxg**2+gyg**2+gzg**2); gm[gm<0.1]=0.1
    ux,uy,uz=-gxg/gm,-gyg/gm,-gzg/gm
    ra=np.interp(grid,t,a)*deg; rb=np.interp(grid,t,b)*deg; rg=-np.interp(grid,t,g)*deg
    yawRate=rb*ux+rg*uy+ra*uz          # rad/s
    # deployed integration: yaw -= yawRate*dt
    gyro_yaw=np.cumsum(-yawRate)*0.05/deg   # deg, cumulative
    cam_cum=np.cumsum(np.interp(grid,ct,cyr))*0.05  # deg
    # rate-domain corr
    gyro_rate_deg=-yawRate/deg
    cyr_g=np.interp(grid,ct,cyr)
    cc=np.corrcoef(gyro_rate_deg, cyr_g)[0,1]
    def rms(x,y): return float(np.sqrt(np.mean((x-y-np.mean(x-y))**2)))
    print(f"=== {rid} ===")
    print(f"  ALL poses: deployed gyro-yaw RATE vs camera-yaw RATE corr {cc:+.2f} (mismatched: camera-Y vs world-up under tilt)")
    # UPRIGHT-only: phone roughly vertical => gravity mostly along -y (screen up) =>
    # camera Y axis ~ world vertical, so world-up yaw == camera-Y yaw. This is AD's use case.
    upright = np.abs(uy) > 0.85   # world-up aligns with phone -y => |uy| large
    if upright.sum() > 20:
        ccu=np.corrcoef(gyro_rate_deg[upright], cyr_g[upright])[0,1]
        print(f"  UPRIGHT only ({upright.sum()} samp, {upright.mean()*100:.0f}% of clip): corr {ccu:+.2f}  (AD's actual pose)")
    else:
        print(f"  UPRIGHT only: too few samples ({upright.sum()}) -- this clip is mostly tilted/walking")
    print(f"  cumulative net: gyro {gyro_yaw[-1]:+.0f}deg | camera {cam_cum[-1]:+.0f}deg | tracking RMS {rms(gyro_yaw,cam_cum):.0f}deg")
