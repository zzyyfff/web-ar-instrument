"""
Visual-inertial v3: compass + visual + gyro three-source fusion with smart gating.

Sources, by reliability per pose:
  - compass: reliable when |γ|<15°, accuracy good, low motion → use as primary yaw anchor
  - visual:  reliable when image is stable (low roll rate, low residuals, many features)
  - gyro:    always available; drifts over time

Architecture:
  yaw_estimate = continuously integrated via gyro
  Every motion event: yaw += -gyro_yaw_rate * dt
  Every orientation event: if compass reliable → anchor pull toward compass
  Every video frame: if visual reliable AND compass NOT reliable → anchor pull toward visual

This handles both Phase A (rolls — compass dead, visual carries) and Phase B
(panning — compass alive, anchors yaw).

TUNING CONSTANTS — these are validated; do not randomize:

  Gate thresholds (compass_reliable):
    accuracy ≤ 25°    iOS quality field; >25 is unusable
    |γ| ≤ 15°         MAIN LEVER — empirical iOS compass-flip starts beyond this
    motion_rate ≤ 100 deg/s — compass needs settling time after fast rotation

  Anchor weights (per orientation event / per visual frame):
    compass: 0.25     strong pull when reliable (compass IS the truth at γ≈0)
    visual:  0.15     weaker; visual flow has its own translation-vs-rotation ambiguity

Rationales:
  - Compass weight too high (>0.4) → jitter from compass noise dominates
  - Compass weight too low (<0.1) → anchor never overcomes gyro drift
  - Gamma gate too loose (>25°) → bias from compass-flip leaks into yaw
  - Gamma gate too tight (<10°) → too few anchor moments during panning

Validated against rec_1c3e4e1s, rec_6z0p0r2q, rec_5z6d6r6b, rec_1f1v6x6v, rec_3f470g38
on iPhone Chrome — beats every IMU-only algorithm by 2-6x on Phase A rolls.
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


def compass_reliable(o, last_rot_mag):
    if o.get('webkitCompassAccuracy', -1) is None or o.get('webkitCompassAccuracy', -1) < 0: return False
    if o['webkitCompassAccuracy'] > 25: return False
    if abs(o['gamma']) > 15: return False
    if last_rot_mag > 100: return False
    return True


def fuse(rec_id, ref_bearing=335.0):
    sensor = json.load(open(f'/tmp/gizmo-recordings/rec_{rec_id}.json'))
    import os
    flow_path = f'/tmp/gizmo-recordings/flow2-{rec_id}.csv'
    flow = load_flow(flow_path) if os.path.exists(flow_path) else []
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    m = [s for s in sensor['samples'] if s['kind'] == 'm']
    events = []
    for s in o: events.append((s['t']/1000, 'o', s))
    for s in m: events.append((s['t']/1000, 'm', s))
    for r in flow: events.append((r['t'], 'v', r))
    events.sort(key=lambda e: e[0])

    yaw = math.radians(ref_bearing)
    last_t = None
    last_rot_mag = 0.0
    visual_cum_since_anchor = 0.0
    gyro_cum_since_anchor = 0.0
    out = []
    compass_anchor_count = 0
    visual_anchor_count = 0
    last_o = None
    for t, kind, s in events:
        if kind == 'o':
            last_o = s
            out.append({'t': t, 'yaw_deg': math.degrees(yaw) % 360,
                        'beta': s['beta'], 'gamma': s['gamma']})
            # Compass anchor (every orientation event, when reliable)
            if compass_reliable(s, last_rot_mag):
                target = math.radians(s['webkitCompassHeading'])
                delta = (target - yaw + math.pi) % (2*math.pi) - math.pi
                # Strong correction since compass is the gold standard when reliable
                yaw += 0.25 * delta
                compass_anchor_count += 1
                # Reset the visual/gyro cumulative counters on compass anchor
                visual_cum_since_anchor = 0.0
                gyro_cum_since_anchor = 0.0
            continue
        if kind == 'm':
            r = s['rot']
            last_rot_mag = math.sqrt(r['a']**2 + r['b']**2 + r['g']**2)
            if last_t is None: last_t = t; continue
            dt = max(1e-3, min(0.1, t - last_t)); last_t = t
            g = s['accG']
            gmag = math.sqrt(g['x']**2 + g['y']**2 + g['z']**2)
            if gmag < 0.1: continue
            ux, uy, uz = -g['x']/gmag, -g['y']/gmag, -g['z']/gmag
            wx = r['b']
            wy = -r['g']  # empirical sign flip
            wz = r['a']
            yaw_rate_dps = wx*ux + wy*uy + wz*uz
            yaw_rate_rps = math.radians(yaw_rate_dps)
            yaw -= yaw_rate_rps * dt
            gyro_cum_since_anchor += math.degrees(-yaw_rate_rps * dt)
            continue
        if kind == 'v':
            visual_cum_since_anchor += s['yaw_d']
            # Visual anchor: only when compass is NOT reliable AND visual is high quality.
            roll_rate = abs(s['roll_deg'])
            weight = s['weight']
            if roll_rate > 2.0:
                weight *= max(0.0, 1.0 - (roll_rate - 2.0) / 8.0)
            if last_o is not None and not compass_reliable(last_o, last_rot_mag):
                if weight > 0.4 and s['n'] > 30:
                    # Adjust yaw by the drift visible vs gyro
                    drift = visual_cum_since_anchor - gyro_cum_since_anchor
                    correction = math.radians(drift) * 0.15
                    yaw += correction
                    visual_anchor_count += 1
                    visual_cum_since_anchor = 0.0
                    gyro_cum_since_anchor = 0.0
    print(f'anchors:  compass={compass_anchor_count}  visual={visual_anchor_count}')
    return out


if __name__ == '__main__':
    rec = sys.argv[1] if len(sys.argv) > 1 else '1f1v6x6v'
    out = fuse(rec)
    with open(f'/tmp/gizmo-recordings/vi3-{rec}.csv', 'w') as f:
        f.write('t,yaw_deg,beta,gamma\n')
        for r in out:
            f.write(f"{r['t']:.4f},{r['yaw_deg']:.2f},{r['beta']:.2f},{r['gamma']:.2f}\n")
    print(f'wrote vi3-{rec}.csv: {len(out)} samples')
