"""
Recovery analysis: does the fused yaw RECOVER to truth when the user stops
moving? Critical for AR usability — people slow down when they want to look at
detail.

For each recording: timeline of fused-yaw error and motion magnitude. Find
"quiescent windows" (sustained low motion) and report error WITHIN them.
"""
import csv
import json
import math
import sys
from pathlib import Path

import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from fused_compare import truth_anchors, make_flow_rows, fuse_with_synthetic_flow


def motion_rate(sensor, t_window=0.5):
    """For each t, return RMS rotation-rate magnitude in deg/s over the previous t_window seconds."""
    m = sorted([s for s in sensor['samples'] if s['kind'] == 'm'], key=lambda x: x['t'])
    times = np.array([s['t']/1000 for s in m])
    mags = np.array([math.sqrt((s['rot']['a'] or 0)**2 + (s['rot']['b'] or 0)**2 + (s['rot']['g'] or 0)**2) for s in m])
    return times, mags


def analyze(rec_id, w=360, fov_deg=60):
    cmp_path = Path(f'/tmp/gizmo-recordings/compare-{rec_id}.csv')
    if not cmp_path.exists():
        sys.exit(f'no {cmp_path}')
    compare_rows = list(csv.DictReader(open(cmp_path)))
    sensor = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    anchors = truth_anchors(sensor)
    if not anchors:
        sys.exit('no truth anchors')

    flow_ls = make_flow_rows(compare_rows, w, fov_deg, 'ls')
    ts, bs, _, _ = fuse_with_synthetic_flow(rec_id, flow_ls)

    m_times, m_mags = motion_rate(sensor)

    # For each truth anchor, find the fused-yaw error AND the recent motion mag.
    print(f'\nrec_{rec_id}  ({len(anchors)} upright moments)')
    print(f'  {"t":>6} {"truth":>6} {"fused":>6} {"err":>6} {"motion_dps":>10}')
    print(f'  {"-"*6} {"-"*6} {"-"*6} {"-"*6} {"-"*10}')
    ts_arr = np.array(ts)
    bs_arr = np.array(bs)
    quiescent_errs = []
    active_errs = []
    for at, ab in anchors:
        idx = int(np.argmin(np.abs(ts_arr - at)))
        est = bs_arr[idx]
        err = ((est - ab + 540) % 360) - 180
        # motion magnitude in the 0.5s preceding this anchor
        mask = (m_times >= at - 0.5) & (m_times <= at)
        recent_mag = float(np.mean(m_mags[mask])) if mask.any() else float('nan')
        flag = ''
        if not math.isnan(recent_mag):
            if recent_mag < 30:
                flag = ' QUIESCENT'
                quiescent_errs.append(err)
            else:
                flag = ' active'
                active_errs.append(err)
        print(f'  {at:6.1f} {ab:6.1f} {est:6.1f} {err:+6.1f} {recent_mag:10.1f}{flag}')
    print()
    if quiescent_errs:
        a = np.abs(quiescent_errs)
        print(f'  QUIESCENT moments (rot_rate<30 deg/s over last 0.5s): n={len(quiescent_errs)}  RMS={np.sqrt(np.mean(np.array(quiescent_errs)**2)):.2f}°  max|err|={a.max():.1f}°  median|err|={np.median(a):.1f}°')
    if active_errs:
        a = np.abs(active_errs)
        print(f'  ACTIVE moments  (rot_rate>=30 deg/s over last 0.5s): n={len(active_errs)}  RMS={np.sqrt(np.mean(np.array(active_errs)**2)):.2f}°  max|err|={a.max():.1f}°  median|err|={np.median(a):.1f}°')


if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit('usage: recovery_analysis.py <rec_id>')
    analyze(sys.argv[1])
