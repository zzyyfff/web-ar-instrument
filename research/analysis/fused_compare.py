"""
Fair fused-path comparison: take the compare-<rec>.csv output of
compare_fitters.py (which has tx_ls AND tx_ransac for the same frame pairs),
construct two synthetic flow2-style records, run them through the fusion in
visual_inertial3.py, then score each fused yaw against compass-anchor truth.

This is the apples-to-apples test of what the on-device algorithm would do
with each fitter, since the calibrator's on-device fusion does the same
compass + gyro + visual three-way fusion logic as vi3.

Usage:
  python3 fused_compare.py <rec_id>
"""
import csv
import json
import math
import sys
from pathlib import Path

import numpy as np

# Import vi3's fuse() but feed it our synthetic flow rows.
sys.path.insert(0, str(Path(__file__).parent))
import visual_inertial3 as vi3


def truth_anchors(sensor):
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    pts = [(s['t']/1000, s['webkitCompassHeading']) for s in o if abs(s['gamma']) < 10 and s['beta'] > 70]
    if not pts: return []
    clusters = [[pts[0]]]
    for x in pts[1:]:
        if x[0] - clusters[-1][-1][0] < 0.1:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    return [(float(np.median([x[0] for x in c])), float(np.median([x[1] for x in c]))) for c in clusters]


def score(anchors, ts, yaws):
    if len(anchors) < 1: return float('nan'), float('nan')
    ts = np.asarray(ts); yaws = np.asarray(yaws)
    errs = []
    for at, ab in anchors:
        if len(ts) == 0: continue
        idx = int(np.argmin(np.abs(ts - at)))
        e = ((yaws[idx] - ab + 540) % 360) - 180
        errs.append(e)
    if not errs: return float('nan'), float('nan')
    return float(np.sqrt(np.mean(np.array(errs)**2))), float(np.max(np.abs(errs)))


def make_flow_rows(compare_rows, w, fov_deg, which):
    """Build flow2-format rows from compare-csv: t, n, tx, roll_deg, residual_px,
    weight, yaw_d.  `which` is 'ls' or 'ransac'."""
    px_per_deg = w / fov_deg
    out = []
    for r in compare_rows:
        n = int(r[f'n_{which}'])
        tx = float(r[f'tx_{which}'])
        roll = float(r[f'roll_{which}'])
        resid = float(r[f'resid_{which}'])
        # quality weight: matches visual_flow2.py's formula
        n_ok = min(1.0, n / 40.0)
        r_ok = max(0.0, 1.0 - resid / 3.0)
        weight = n_ok * r_ok
        out.append({
            't': float(r['t']),
            'n': n,
            'tx': tx,
            'ty': 0.0,
            'roll_deg': roll,
            'residual_px': resid,
            'weight': weight,
            'yaw_d': -tx / px_per_deg,
            'pitch_d': 0.0,
            'cum_yaw': 0.0,
            'cum_pitch': 0.0,
            'cum_roll': 0.0,
        })
    return out


def fuse_with_synthetic_flow(rec_id, flow_rows, ref_bearing=335.0):
    """Same as vi3.fuse() but feed synthetic flow rows instead of loading from disk."""
    sensor = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    m = [s for s in sensor['samples'] if s['kind'] == 'm']
    events = []
    for s in o: events.append((s['t']/1000, 'o', s))
    for s in m: events.append((s['t']/1000, 'm', s))
    for r in flow_rows: events.append((r['t'], 'v', r))
    events.sort(key=lambda e: e[0])

    yaw = math.radians(ref_bearing)
    last_t = None
    last_rot_mag = 0.0
    visual_cum = 0.0
    gyro_cum = 0.0
    out_t, out_b = [], []
    n_compass_anchor = 0
    n_visual_anchor = 0
    last_o = None
    for t, kind, s in events:
        if kind == 'o':
            last_o = s
            out_t.append(t); out_b.append(math.degrees(yaw) % 360)
            if vi3.compass_reliable(s, last_rot_mag):
                target = math.radians(s['webkitCompassHeading'])
                delta = (target - yaw + math.pi) % (2 * math.pi) - math.pi
                yaw += 0.25 * delta
                n_compass_anchor += 1
                visual_cum = 0.0
                gyro_cum = 0.0
            continue
        if kind == 'm':
            r = s['rot']
            last_rot_mag = math.sqrt(r['a']**2 + r['b']**2 + r['g']**2)
            if last_t is None:
                last_t = t; continue
            dt = max(1e-3, min(0.1, t - last_t)); last_t = t
            g = s['accG']
            gmag = math.sqrt(g['x']**2 + g['y']**2 + g['z']**2)
            if gmag < 0.1: continue
            ux, uy, uz = -g['x']/gmag, -g['y']/gmag, -g['z']/gmag
            wx = r['b']
            wy = -r['g']
            wz = r['a']
            yaw_rate_dps = wx * ux + wy * uy + wz * uz
            yaw_rate_rps = math.radians(yaw_rate_dps)
            yaw -= yaw_rate_rps * dt
            gyro_cum += math.degrees(-yaw_rate_rps * dt)
            continue
        if kind == 'v':
            visual_cum += s['yaw_d']
            roll_rate = abs(s['roll_deg'])
            weight = s['weight']
            if roll_rate > 2.0:
                weight *= max(0.0, 1.0 - (roll_rate - 2.0) / 8.0)
            if last_o is not None and not vi3.compass_reliable(last_o, last_rot_mag):
                if weight > 0.4 and s['n'] > 30:
                    drift = visual_cum - gyro_cum
                    correction = math.radians(drift) * 0.15
                    yaw += correction
                    n_visual_anchor += 1
                    visual_cum = 0.0
                    gyro_cum = 0.0
    return out_t, out_b, n_compass_anchor, n_visual_anchor


def main(rec_id, w=360, fov_deg=60):
    cmp_path = Path(f'/tmp/gizmo-recordings/compare-{rec_id}.csv')
    if not cmp_path.exists():
        sys.exit(f'no {cmp_path} — run compare_fitters.py {rec_id} first')
    compare_rows = list(csv.DictReader(open(cmp_path)))

    sensor = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    anchors = truth_anchors(sensor)

    flow_ls = make_flow_rows(compare_rows, w, fov_deg, 'ls')
    flow_r = make_flow_rows(compare_rows, w, fov_deg, 'ransac')

    ts_ls, b_ls, ca_ls, va_ls = fuse_with_synthetic_flow(rec_id, flow_ls)
    ts_r, b_r, ca_r, va_r = fuse_with_synthetic_flow(rec_id, flow_r)

    rms_ls, mx_ls = score(anchors, ts_ls, b_ls)
    rms_r, mx_r = score(anchors, ts_r, b_r)

    print(f'\nrec_{rec_id}  (truth anchors: {len(anchors)})')
    print(f'  {"path":<32} {"RMS":>6} {"max":>6} {"cAnchor":>8} {"vAnchor":>8}')
    print(f'  {"-"*32} {"-"*6} {"-"*6} {"-"*8} {"-"*8}')
    print(f'  {"FUSED — fitSimilarity (LS)":<32} {rms_ls:6.2f} {mx_ls:6.2f} {ca_ls:>8d} {va_ls:>8d}')
    print(f'  {"FUSED — cv2 RANSAC":<32} {rms_r:6.2f} {mx_r:6.2f} {ca_r:>8d} {va_r:>8d}')
    diff = rms_r - rms_ls
    if abs(diff) < 0.5:
        verdict = "≈ tie"
    elif diff > 0:
        verdict = f"LS wins by {abs(diff):.1f}°"
    else:
        verdict = f"RANSAC wins by {abs(diff):.1f}°"
    print(f'\n  verdict (fused): {verdict}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: fused_compare.py <rec_id>')
    main(sys.argv[1])
