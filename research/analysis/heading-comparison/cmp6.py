"""Integrate the gyro yaw (matched axis rot.b, from cmp5 matrix) into a cumulative
heading and compare against the translation-robust camera cumulative yaw and the
compass. Shows practical heading tracking + how fast gyro drifts (=> how much slow
compass correction a fusion needs).

camera yaw  <-> gyro rot.b  at -0.97 (sign per cmp5). So gyro_yaw_rate = -rot.b.
"""
import json, numpy as np
import os

DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir

def unwrap_deg(a): return np.degrees(np.unwrap(np.radians(a)))

def load(rid):
    d = json.load(open(f'{DATA}/{rid}.json')); S=d['samples']
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
    comp=unwrap_deg(mg(['o','webkitCompassHeading']))
    rb=mg(['m','rot','b'])
    r=json.load(open(f'{DIR}/{rid}.rot4.json')); rot=np.array(r['rot']); fps=r['fps']
    ct=rot[:,0]; cam_yaw_rate=rot[:,2]*fps
    return t,comp,rb,ct,cam_yaw_rate

for rid in ['rec_106z3v43','rec_260r4o4b']:
    t,comp,rb,ct,cyr=load(rid)
    g=np.arange(0,min(t[-1],ct[-1]),0.05)
    # integrate gyro yaw (sign -1 to match camera per cmp5)
    rb_g=np.interp(g,t,rb)
    gyro_cum=np.cumsum(-rb_g)*0.05
    # integrate camera yaw rate -> camera cumulative (its own truth, drifts a bit too)
    cyr_g=np.interp(g,ct,cyr)
    cam_cum=np.cumsum(cyr_g)*0.05
    comp_g=np.interp(g,t,comp); comp_cum=comp_g-comp_g[0]
    # align each to camera by removing mean offset (we compare SHAPE/tracking)
    def rms(a,b): return float(np.sqrt(np.mean((a-b-np.mean(a-b))**2)))
    print(f"=== {rid} (30s) ===")
    print(f"  cumulative net yaw: camera {cam_cum[-1]:+.0f}deg | gyro {gyro_cum[-1]:+.0f}deg | compass {comp_cum[-1]:+.0f}deg")
    print(f"  tracking RMS vs camera cumulative (offset-removed):  gyro {rms(gyro_cum,cam_cum):5.1f}deg | compass {rms(comp_cum,cam_cum):6.1f}deg")
    # gyro drift estimate: residual (gyro-camera) linear trend deg/s
    resid=gyro_cum-cam_cum
    drift=np.polyfit(g,resid,1)[0]
    print(f"  gyro-vs-camera drift rate {drift:+.2f} deg/s  (slow compass correction handles this)")
    print()
