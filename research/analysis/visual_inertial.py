"""
Visual-inertial fusion: combine gyro (high-frequency, drifts) and visual flow
(low-frequency, accurate during stable moments) into a robust yaw estimator.

Key insight: optical-flow yaw is corrupted during high-image-roll moments (the
wrist-arc translation gets misattributed to camera yaw). So we use visual yaw
ONLY when:
  - flow quality is high (residuals low, many features tracked)
  - image-plane rotation rate is low (no fast roll)
  - feature count is sufficient

During those "stable" moments, we treat visual yaw as truth and snap the gyro-
integrated cumulative yaw toward it. Between them, gyro carries.

Algorithm per frame:
  1. Get gyro yaw_rate (project body ω onto world-up in body frame)
  2. Integrate gyro: yaw += -gyro_yaw_rate * dt
  3. Get visual yaw delta from optical flow CSV (pre-computed)
  4. Compute trust weight from flow quality + roll rate
  5. If weight > threshold: apply low-pass correction: yaw += weight * α * (visual_yaw_delta - gyro_yaw_delta) integrated over a window

Output: per-sample cumulative yaw (compass-style bearing).
"""
import csv
import json
import math
import sys

import numpy as np


def load_flow(path):
    rows = []
    with open(path) as f:
        for row in csv.DictReader(f):
            rows.append({k: float(v) if k != 'n' else int(float(v)) for k, v in row.items()})
    return rows


def visual_inertial(rec_id, ref_bearing=335.0):
    sensor = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    flow = load_flow(f'/tmp/gizmo-recordings/flow2-{rec_id}.csv')

    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    m = [s for s in sensor['samples'] if s['kind'] == 'm']

    # Merge into time-sorted events
    events = []
    for s in o:
        events.append((s['t']/1000, 'o', s))
    for s in m:
        events.append((s['t']/1000, 'm', s))
    for r in flow:
        events.append((r['t'], 'v', r))
    events.sort(key=lambda e: e[0])

    yaw = ref_bearing * math.pi / 180  # cumulative bearing in radians, compass style
    last_t = None
    last_m = None
    last_visual_yaw_d = 0
    # Track visual cumulative yaw separately for diagnostics
    cum_visual_yaw_deg = 0.0
    out = []
    for t, kind, s in events:
        if kind == 'o':
            # Snapshot output bearing
            out.append({'t': t, 'kind': 'o', 'yaw_deg': math.degrees(yaw) % 360,
                        'beta': s['beta'], 'gamma': s['gamma']})
            continue
        if kind == 'm':
            last_m = s
            if last_t is None:
                last_t = t; continue
            dt = max(1e-3, min(0.1, t - last_t))
            last_t = t
            g = s['accG']
            gmag = math.sqrt(g['x']**2 + g['y']**2 + g['z']**2)
            if gmag < 0.1: continue
            ux, uy, uz = -g['x']/gmag, -g['y']/gmag, -g['z']/gmag
            wx = s['rot']['b']  # deg/s around device X
            wy = -s['rot']['g']  # deg/s around device Y (empirical sign flip)
            wz = s['rot']['a']  # deg/s around device Z
            yaw_rate_dps = wx*ux + wy*uy + wz*uz  # deg/s
            yaw -= math.radians(yaw_rate_dps) * dt
            continue
        if kind == 'v':
            # Visual flow event: try to correct yaw if quality is high.
            visual_yaw_d = s['yaw_d']
            weight = s['weight']
            roll_rate = abs(s['roll_deg'])
            # Roll-rate gate: if image rotated >2° in this frame (i.e., user is
            # rolling fast), assume wrist-arc translation is polluting visual yaw.
            if roll_rate > 2.0:
                weight *= max(0.0, 1.0 - (roll_rate - 2.0) / 8.0)
            # If weight is high enough, blend gyro vs visual cumulative yaw.
            # Use a slow low-pass: snap cumulative yaw toward visual estimate.
            cum_visual_yaw_deg += visual_yaw_d
            if weight > 0.3:
                # Target absolute bearing if visual were truth from t=0: ref + cum_visual_yaw_deg.
                target_yaw = math.radians((ref_bearing + cum_visual_yaw_deg) % 360)
                delta = (target_yaw - yaw + math.pi) % (2*math.pi) - math.pi
                yaw += weight * 0.05 * delta  # tiny pull per frame, accumulates over many frames
    return out, cum_visual_yaw_deg


if __name__ == '__main__':
    rec = sys.argv[1] if len(sys.argv) > 1 else '1f1v6x6v'
    out, cv = visual_inertial(rec)
    print(f"final visual cumulative yaw: {cv:+.1f}°")
    print(f"fused output samples: {len(out)}")
    # Save bearings to csv for plotting
    with open(f'/tmp/gizmo-recordings/vi-{rec}.csv', 'w') as f:
        f.write('t,yaw_deg,beta,gamma\n')
        for r in out:
            f.write(f"{r['t']:.4f},{r['yaw_deg']:.2f},{r['beta']:.2f},{r['gamma']:.2f}\n")
    print(f"wrote /tmp/gizmo-recordings/vi-{rec}.csv")
