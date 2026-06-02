"""Nail the device-frame gyro axis assignment empirically before shipping.

The world-up yaw projection yawRate = w . u_up needs the gyro vector w expressed in the
DEVICE frame (wx,wy,wz about X,Y,Z) and u_up = world-up in device frame (from accG).
The calibrator assumed W3C (wx=beta, wy=gamma, wz=alpha); cmp5/cmp7 say that's wrong here.

Sweep every assignment of {alpha,beta,gamma}->(wx,wy,wz) and each u sign, score the
world-up-projected yaw RATE against the translation-robust camera yaw rate, RESTRICTED TO
UPRIGHT frames (where camera-Y ~ world-up so the comparison is valid). The physically
correct assignment should give a strong, consistent correlation on BOTH recordings.
"""
import json, numpy as np, itertools
import os
DIR = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GIZMO_DATA_DIR', DIR)  # raw recordings not bundled; set GIZMO_DATA_DIR to your local capture dir
deg=np.pi/180

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
    accG=(mg(['m','accG','x']),mg(['m','accG','y']),mg(['m','accG','z']))
    gy={'alpha':mg(['m','rot','a']),'beta':mg(['m','rot','b']),'gamma':mg(['m','rot','g'])}
    r=json.load(open(f'{DIR}/{rid}.rot4.json')); rot=np.array(r['rot']); fps=r['fps']
    return t,accG,gy,rot[:,0],rot[:,2]*fps  # camera yaw rate deg/s

def grid_resample(t,x,grid): return np.interp(grid,t,x)

print("Sweep field->axis assignment; score world-up yaw projection vs camera yaw (UPRIGHT only)\n")
labels=['alpha','beta','gamma']
results={}
for rid in ['rec_106z3v43','rec_260r4o4b']:
    t,accG,gy,ct,cyr=load(rid)
    grid=np.arange(0,min(t[-1],ct[-1]),0.05)
    gx_,gy_,gz_=[grid_resample(t,a,grid) for a in accG]
    gm=np.sqrt(gx_**2+gy_**2+gz_**2); gm[gm<0.1]=0.1
    ux,uy,uz=-gx_/gm,-gy_/gm,-gz_/gm           # u = -accG (test +accG via sign too)
    A={k:grid_resample(t,gy[k],grid)*deg for k in labels}
    camyaw=np.interp(grid,ct,cyr)
    upright=np.abs(uy)>0.85
    res=[]
    for perm in itertools.permutations(labels):      # (wx,wy,wz) <- which field
        wx,wy,wz=A[perm[0]],A[perm[1]],A[perm[2]]
        for su in (+1,-1):
            yawrate=su*(wx*ux+wy*uy+wz*uz)/deg        # deg/s, world-up projection
            if upright.sum()>20:
                cc=np.corrcoef(yawrate[upright],camyaw[upright])[0,1]
                res.append((abs(cc),cc,perm,su))
    res.sort(reverse=True)
    results[rid]=res[:4]
    print(f"=== {rid} (upright {upright.sum()} samp) — top assignments ===")
    for ac,cc,perm,su in res[:4]:
        print(f"   wx<-{perm[0]:5} wy<-{perm[1]:5} wz<-{perm[2]:5}  u_sign{su:+d}  corr {cc:+.2f}")
    print()
# which assignment is best on BOTH?
print("Best assignment consistent across BOTH recordings:")
from collections import defaultdict
score=defaultdict(float)
for rid in results:
    for ac,cc,perm,su in results[rid]:
        score[(perm,su)]+=ac
for (perm,su),sc in sorted(score.items(),key=lambda x:-x[1])[:3]:
    print(f"   wx<-{perm[0]} wy<-{perm[1]} wz<-{perm[2]} u_sign{su:+d}  sum|corr| {sc:.2f}")
