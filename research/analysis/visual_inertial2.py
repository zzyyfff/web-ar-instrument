"""
Visual-inertial v2: aggressive gating + drift correction via stable-moment anchoring.

Architecture:
- Pure gyro integration carries cumulative yaw (the dead-reckoning track).
- Visual flow is consulted ONLY at "anchor moments" where:
    * gyro angular velocity magnitude is low (|ω| < 30 deg/s)
    * image-plane rotation rate is low (< 1 deg/frame, i.e., not actively rolling)
    * visual quality is high (residuals low, features plenty)
- At anchor moments, compare visual yaw delta accumulated since the last anchor
  to gyro yaw delta accumulated over the same window. The difference is gyro drift.
- Apply a slow correction to yaw_estimate toward the visual anchor cumulative.

If no anchor moments occur (the user just rolls non-stop), fall back to pure
gyro integration, which is at least bounded (gyro drift ~1-5°/min on iOS).
"""
import csv
import json
import math
import sys


def load_flow(path):
    rows = []
    with open(path) as f:
        for row in csv.DictReader(f):
            rows.append({k: float(v) if k != 'n' else int(float(v)) for k, v in row.items()})
    return rows


def fuse(rec_id, ref_bearing=335.0):
    sensor = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    flow = load_flow(f'/tmp/gizmo-recordings/flow2-{rec_id}.csv')
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    m = [s for s in sensor['samples'] if s['kind'] == 'm']
    events = []
    for s in o: events.append((s['t']/1000, 'o', s))
    for s in m: events.append((s['t']/1000, 'm', s))
    for r in flow: events.append((r['t'], 'v', r))
    events.sort(key=lambda e: e[0])

    yaw = math.radians(ref_bearing)
    last_t = None
    gyro_cum_since_anchor = 0.0
    visual_cum_since_anchor = 0.0
    anchor_count = 0
    out = []
    for t, kind, s in events:
        if kind == 'o':
            out.append({'t': t, 'yaw_deg': math.degrees(yaw) % 360,
                        'beta': s['beta'], 'gamma': s['gamma']})
            continue
        if kind == 'm':
            if last_t is None: last_t = t; continue
            dt = max(1e-3, min(0.1, t - last_t)); last_t = t
            g = s['accG']
            gmag = math.sqrt(g['x']**2 + g['y']**2 + g['z']**2)
            if gmag < 0.1: continue
            ux, uy, uz = -g['x']/gmag, -g['y']/gmag, -g['z']/gmag
            wx = s['rot']['b']
            wy = -s['rot']['g']  # empirical sign flip
            wz = s['rot']['a']
            yaw_rate_dps = wx*ux + wy*uy + wz*uz
            yaw_rate_rps = math.radians(yaw_rate_dps)
            yaw -= yaw_rate_rps * dt
            gyro_cum_since_anchor += math.degrees(-yaw_rate_rps * dt)
            continue
        if kind == 'v':
            visual_yaw_d = s['yaw_d']
            visual_cum_since_anchor += visual_yaw_d
            # Anchor conditions: stable image + good flow quality + low angular motion
            roll_rate = abs(s['roll_deg'])
            weight = s['weight']
            # Get gyro ω magnitude from the latest m sample near this t
            wmag = 0
            for ms in reversed(m):
                if ms['t']/1000 <= t:
                    r = ms['rot']
                    wmag = math.sqrt(r['a']**2 + r['b']**2 + r['g']**2)
                    break
            is_anchor = (roll_rate < 0.5) and (weight > 0.6) and (wmag < 30) and s['n'] > 30
            if is_anchor:
                # Visual cum should equal gyro cum since last anchor; difference = gyro drift.
                drift = visual_cum_since_anchor - gyro_cum_since_anchor
                # Apply 30% correction toward visual estimate
                correction = math.radians(drift) * 0.3
                yaw += correction
                gyro_cum_since_anchor = 0.0
                visual_cum_since_anchor = 0.0
                anchor_count += 1
    print(f'anchors: {anchor_count}')
    return out


if __name__ == '__main__':
    rec = sys.argv[1] if len(sys.argv) > 1 else '1f1v6x6v'
    out = fuse(rec)
    with open(f'/tmp/gizmo-recordings/vi2-{rec}.csv', 'w') as f:
        f.write('t,yaw_deg,beta,gamma\n')
        for r in out:
            f.write(f"{r['t']:.4f},{r['yaw_deg']:.2f},{r['beta']:.2f},{r['gamma']:.2f}\n")
    print(f'wrote vi2-{rec}.csv: {len(out)} samples')
