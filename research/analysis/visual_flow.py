"""
Visual-inertial analysis on R2 recordings.

Extract per-frame camera angular motion (yaw, pitch, roll) from sparse optical
flow on the composite video, then compare against the IMU-derived bearings from
every candidate algorithm.

Output:
- per-frame angular delta (yaw_image, pitch_image, roll_image) from optical flow
- cumulative camera-yaw bearing relative to t=0
- overlay plot: visual-yaw vs euler-gamma, gravity-compass, compass-gated, gyro-anchored

Note: the composite video has the OVERLAY drawn on top of the camera. We mask
out the overlay region(s) before feature detection so we track real-world
features only. The overlay is bright text + dashed horizon, mostly in the
margins; we drop the top 12% and bottom 12% of each frame to be safe.

Coordinate convention:
- image x: rightward in screen
- image y: downward in screen
- positive yaw-rate = camera turns right = world features translate LEFT in image
"""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

FOV_DEG = 60  # horizontal FOV at calibrator default (matches sensor JSON fovHorizontalDeg)


def estimate_frame_motion(prev_gray, curr_gray, mask=None):
    """Use Lucas-Kanade optical flow to estimate the dominant 2D motion (rotation +
    translation) between two consecutive grayscale frames.

    Returns:
      flow_n: number of tracked features
      tx_px:  median horizontal displacement (positive = features moved right)
      ty_px:  median vertical displacement (positive = features moved down)
      roll_deg: rotation angle of the feature cloud around image center
    """
    feat = cv2.goodFeaturesToTrack(
        prev_gray, maxCorners=120, qualityLevel=0.02, minDistance=12, blockSize=7, mask=mask,
    )
    if feat is None or len(feat) < 10:
        return 0, 0.0, 0.0, 0.0
    next_pts, status, _ = cv2.calcOpticalFlowPyrLK(
        prev_gray, curr_gray, feat, None, winSize=(21, 21), maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
    )
    if next_pts is None:
        return 0, 0.0, 0.0, 0.0
    good_mask = status.flatten().astype(bool)
    p0 = feat[good_mask].reshape(-1, 2)
    p1 = next_pts[good_mask].reshape(-1, 2)
    if len(p0) < 8:
        return len(p0), 0.0, 0.0, 0.0

    # Estimate similarity transform (translation + rotation + scale) — robust via RANSAC.
    M, inliers = cv2.estimateAffinePartial2D(
        p0, p1, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=2000, confidence=0.99,
    )
    if M is None:
        return len(p0), 0.0, 0.0, 0.0
    a, b = M[0, 0], M[0, 1]
    tx, ty = M[0, 2], M[1, 2]
    roll = math.degrees(math.atan2(b, a))  # rotation angle
    return int(inliers.sum()) if inliers is not None else len(p0), tx, ty, roll


def analyze_video(video_path, sensor_path, out_csv):
    sensor = json.load(open(sensor_path))
    o = [s for s in sensor['samples'] if s['kind'] == 'o']
    o_t = np.array([s['t']/1000 for s in o])
    o_gamma = np.array([s['gamma'] for s in o])
    o_beta = np.array([s['beta'] for s in o])
    o_compass = np.array([s['webkitCompassHeading'] for s in o])

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        sys.exit('cannot open video')
    fps = cap.get(cv2.CAP_PROP_FPS)
    w_v = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h_v = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f'video {video_path}: {nframes} frames, {fps:.1f} fps, {w_v}x{h_v}')

    # Mask out overlay regions: top 14% and bottom 14% (badges, labels, build pill).
    mask = np.ones((h_v, w_v), dtype=np.uint8) * 255
    mask[: int(h_v * 0.14)] = 0
    mask[int(h_v * 0.86):] = 0
    # Also mask the center crosshair circle (radius ~16px in source).
    cv2.circle(mask, (w_v // 2, h_v // 2), 24, 0, -1)

    # Per-frame: cumulative yaw / pitch / roll from flow.
    rows = []
    prev_gray = None
    cum_yaw_deg = 0.0
    cum_roll_deg = 0.0
    cum_pitch_deg = 0.0
    px_per_deg_yaw = w_v / FOV_DEG  # horizontal: image_width pixels span FOV degrees
    aspect = h_v / w_v
    vfov_deg = 2 * math.degrees(math.atan(math.tan(math.radians(FOV_DEG) / 2) * aspect))
    px_per_deg_pitch = h_v / vfov_deg

    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)  # robust to exposure jitter
        t_frame = frame_idx / fps
        if prev_gray is not None:
            n, tx, ty, roll = estimate_frame_motion(prev_gray, gray, mask)
            # Convert image-space motion to angular delta (camera frame).
            # Positive tx (features moved right) → camera moved LEFT → yaw decreased.
            # We want bearing of camera-forward: bearing increases = camera turns right.
            # So bearing_delta = -tx / px_per_deg_yaw.
            yaw_delta = -tx / px_per_deg_yaw
            pitch_delta = -ty / px_per_deg_pitch
            # Roll sign: if the feature cloud rotated +roll_deg (CCW in image), the
            # camera rolled the SAME amount in the opposite sense — but for tracking
            # camera roll we just record the raw image-rotation.
            cum_yaw_deg += yaw_delta
            cum_pitch_deg += pitch_delta
            cum_roll_deg += roll
            rows.append({
                't': t_frame,
                'n': n, 'tx_px': tx, 'ty_px': ty, 'roll_img_deg': roll,
                'yaw_delta_deg': yaw_delta,
                'pitch_delta_deg': pitch_delta,
                'cum_yaw_deg': cum_yaw_deg,
                'cum_pitch_deg': cum_pitch_deg,
                'cum_roll_deg': cum_roll_deg,
            })
        prev_gray = gray
        frame_idx += 1

    cap.release()
    print(f'analyzed {len(rows)} frame transitions')

    # Write CSV
    out = Path(out_csv)
    with out.open('w') as f:
        f.write('t,n,tx_px,ty_px,roll_img_deg,yaw_delta_deg,pitch_delta_deg,cum_yaw_deg,cum_pitch_deg,cum_roll_deg\n')
        for r in rows:
            f.write(f"{r['t']:.4f},{r['n']},{r['tx_px']:.3f},{r['ty_px']:.3f},{r['roll_img_deg']:.3f},{r['yaw_delta_deg']:.4f},{r['pitch_delta_deg']:.4f},{r['cum_yaw_deg']:.3f},{r['cum_pitch_deg']:.3f},{r['cum_roll_deg']:.3f}\n")
    print(f'wrote {out_csv}')

    return rows, fps


if __name__ == '__main__':
    rec = sys.argv[1] if len(sys.argv) > 1 else '1f1v6x6v'
    rows, fps = analyze_video(
        f'/tmp/gizmo-recordings/rec_{rec}.mp4',
        f'/tmp/gizmo-recordings/rec_{rec}.json',
        f'/tmp/gizmo-recordings/flow-{rec}.csv',
    )
    # Summary
    cum = [r['cum_yaw_deg'] for r in rows]
    print(f"visual yaw drift over recording: {cum[-1]:+.1f}° (relative to t=0)")
    print(f"yaw delta range per-frame:       {min(r['yaw_delta_deg'] for r in rows):+.2f}° to {max(r['yaw_delta_deg'] for r in rows):+.2f}°")
    print(f"feature counts: median={sorted([r['n'] for r in rows])[len(rows)//2]}, min={min(r['n'] for r in rows)}")
