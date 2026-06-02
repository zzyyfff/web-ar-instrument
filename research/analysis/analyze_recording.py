"""
End-to-end recording analysis: pull a recording (sensor JSON + composite video),
run all algorithms offline, score against truth, generate comparison plot.

Usage:
  python3 analyze_recording.py <rec_id>

If the recording's video file exists, also runs OpenCV optical flow as the
"reference" visual-flow signal, useful for comparing to the live JS LK output
captured in overlayStates.visualInertial.
"""
import csv
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

_HERE = str(Path(__file__).parent)
sys.path.insert(0, _HERE)
from filters import simulate, EulerGamma, GravityCompass, CompassGated, GyroAnchored


def ensure_downloaded(rec_id):
    base = '/tmp/gizmo-recordings'
    json_path = f'{base}/rec_{rec_id}.json'
    video_path = f'{base}/rec_{rec_id}.mp4'
    # BYO backend: set GIZMO_RECORDING_API to your own deployed recording endpoint.
    base_url = os.environ.get('GIZMO_RECORDING_API', '')
    if not base_url:
        raise SystemExit('Set GIZMO_RECORDING_API to your recording endpoint, or pre-place files in /tmp/gizmo-recordings')
    if not os.path.exists(json_path):
        subprocess.run(['curl', '-sL', f'{base_url}?id=rec_{rec_id}', '-o', json_path], check=True)
    if not os.path.exists(video_path):
        r = subprocess.run(['curl', '-sIL', f'{base_url}?video=rec_{rec_id}'], capture_output=True, text=True)
        if '200' in r.stdout.split('\n')[0]:
            subprocess.run(['curl', '-sL', f'{base_url}?video=rec_{rec_id}', '-o', video_path], check=True)
        else:
            print(f'  (no video for rec_{rec_id})')
            return json_path, None
    return json_path, video_path


def truth_anchors(sensor):
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    pts = [(s['t']/1000, s['webkitCompassHeading']) for s in o if abs(s['gamma']) < 10 and s['beta'] > 70]
    if not pts: return []
    clusters = [[pts[0]]]
    for x in pts[1:]:
        if x[0] - clusters[-1][-1][0] < 0.1: clusters[-1].append(x)
        else: clusters.append([x])
    return [(np.median([x[0] for x in c]), np.median([x[1] for x in c])) for c in clusters]


def run_opencv_flow(video_path, sensor_path, out_csv):
    """Run OpenCV optical flow and write the result CSV (used by visual_inertial3 fusion)."""
    if os.path.exists(out_csv):
        return
    cmd = ['python3', f'{_HERE}/visual_flow2.py']
    # visual_flow2 takes a rec_id; derive
    rec_id = Path(sensor_path).stem.replace('rec_', '')
    subprocess.run(cmd + [rec_id], check=True)


def err_for(anchors, algo_t, algo_b):
    if not anchors: return float('nan'), float('nan')
    errs = [(((algo_b[np.argmin(np.abs(algo_t - ta))] - ba + 540) % 360) - 180) for ta, ba in anchors]
    return float(np.sqrt(np.mean(np.array(errs)**2))), float(np.max(np.abs(errs)))


def extract_live_lk_telemetry(sensor):
    """If algo=visual-inertial(-cv) was used, overlayStates carries per-snapshot LK
    diagnostics. Pull them out for comparison."""
    if 'overlayStates' not in sensor: return None
    out = []
    for s in sensor['overlayStates']:
        vi = s.get('state', {}).get('visualInertial')
        if not vi: continue
        out.append({
            't': s['t']/1000,
            'yaw': vi.get('yawDeg'),
            'cumYaw': vi.get('cumYawDeg'),
            'lastVisualYaw': vi.get('lastVisualYawDeg'),
            'rollRate': vi.get('rollRate'),
            'weight': vi.get('weight'),
            'inliers': vi.get('inlierCount'),
            'residual': vi.get('residualPx'),
        })
    return out


def main(rec_id):
    base = '/tmp/gizmo-recordings'
    json_path, video_path = ensure_downloaded(rec_id)
    sensor = json.load(open(json_path))
    print(f'\nrec_{rec_id}: build={sensor.get("buildId")} algo-url={sensor.get("url","").split("algo=")[-1].split("&")[0] if "algo=" in sensor.get("url","") else "default"}')
    print(f'  duration={sensor["durationMs"]/1000:.1f}s o-samples={sum(1 for s in sensor["samples"] if s["kind"]=="o")}')

    anchors = truth_anchors(sensor)
    print(f'  truth anchors (upright |γ|<10, β>70): {len(anchors)}')

    if video_path:
        flow_csv = f'{base}/flow2-{rec_id}.csv'
        if not os.path.exists(flow_csv):
            print(f'  running OpenCV flow → {flow_csv}')
            subprocess.run(['python3', f'{_HERE}/visual_flow2.py', rec_id], check=True)
        # And run the fusion v3
        vi_csv = f'{base}/vi3-{rec_id}.csv'
        if not os.path.exists(vi_csv):
            subprocess.run(['python3', f'{_HERE}/visual_inertial3.py', rec_id], check=True)

    # Score all algorithms
    print(f'\n  {"algo":<24} {"RMS":>5} {"max":>5}')
    for cls in [GravityCompass, EulerGamma, CompassGated, GyroAnchored]:
        r = simulate(cls, rec_id)
        rms, mx = err_for(anchors, r.timestamps_s, r.bearings_deg)
        print(f'  {cls.__name__:<24} {rms:5.1f} {mx:5.1f}')
    if video_path:
        vt, vb = [], []
        with open(f'{base}/vi3-{rec_id}.csv') as f:
            for row in csv.DictReader(f):
                vt.append(float(row['t'])); vb.append(float(row['yaw_deg']))
        rms, mx = err_for(anchors, np.array(vt), np.array(vb))
        print(f'  {"VI v3 (offline OpenCV)":<24} {rms:5.1f} {mx:5.1f}   ← visual-inertial reference')

    # Live JS LK telemetry comparison
    telem = extract_live_lk_telemetry(sensor)
    if telem:
        print(f'\n  live LK telemetry recorded: {len(telem)} snapshots')
        if telem[-1]['yaw'] is not None:
            print(f'    final live yaw: {telem[-1]["yaw"]:.1f}°  cumYaw: {telem[-1]["cumYaw"]:.1f}°')
            wts = [t["weight"] for t in telem if t["weight"] is not None]
            inls = [t["inliers"] for t in telem if t["inliers"] is not None]
            if wts: print(f'    median weight: {sorted(wts)[len(wts)//2]:.2f}  median inliers: {sorted(inls)[len(inls)//2]}')


if __name__ == '__main__':
    rec_id = sys.argv[1] if len(sys.argv) > 1 else None
    if rec_id is None:
        print('usage: analyze_recording.py <rec_id>')
        sys.exit(1)
    main(rec_id)
