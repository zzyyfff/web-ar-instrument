// The "gyro-locar" pose path — the algorithm AD shipped (the one that "felt so good").
// Heading = gyro-integrated yaw about world-up (lib/gyro-yaw.ts, no compass); pitch/roll
// from device beta/gamma; composed via LocAR: Ry(alpha)*Rx(beta)*Rz(-gamma)*Rx(-pi/2),
// alpha = 2pi - yaw - gamma. Lifted verbatim from visual-inertial-tracker.ts (~201-231).
//
// Per the Codex-reviewed plan, advance (mutates the yaw integrator) and compose (pure) are
// SEPARATE — call advance exactly once per frame, then compose/read as many times as needed.
// gyroLocarPose() is a convenience that does both, matching the tracker's current single-call
// behavior; Phase 5 routes all consumers through advance()-once + a pure read.

import { type Quat, setAxisAngle, qMul } from '../quat.js';
import { worldUpYawRateCompassCW, type StoredRotationRate, type GravityVec } from '../../gyro-yaw.js';

export const QUAT_CONVENTION = 'three-camera-to-world; LocAR Ry*Rx*Rz*Rx(-pi/2)';
export const HEADING_CONVENTION = 'compassCWFromNorth';

const DEG = Math.PI / 180;

export interface YawState {
  yaw: number | null;   // radians, compass-style CW; null until first advance
  lastT: number | null; // seconds (performance.now()/1000) of last advance
}

export interface GyroLocarInputs {
  gravity: GravityVec | null;
  rotationRate: StoredRotationRate | null;
  betaDeg: number | null;
  gammaDeg: number | null;
  screenOrientationDeg: number;
  /** Used ONLY to seed the initial heading (absolute North is irrelevant for AD). */
  compassHeadingDeg?: number | null;
}

/** Advance the yaw integrator exactly once for this frame. Mutates `ys`. */
export function advanceGyroYaw(ys: YawState, inp: GyroLocarInputs, nowSec: number): void {
  const g = inp.gravity, r = inp.rotationRate;
  if (g == null || r == null) return;
  // Same guard the single-call path uses: never integrate on near-zero/garbage gravity
  // (keeps direct advanceGyroYaw() callers in lockstep with gyroLocarPose()).
  if (Math.hypot(g.x, g.y, g.z) < 0.1) return;
  let dt: number;
  if (ys.lastT == null) dt = 1 / 60;
  else dt = Math.max(1e-3, Math.min(0.1, nowSec - ys.lastT));
  ys.lastT = nowSec;
  const yawRate = worldUpYawRateCompassCW(r, g); // rad/s, compass-style CW
  if (ys.yaw == null) {
    ys.yaw = inp.compassHeadingDeg != null ? inp.compassHeadingDeg * DEG : 0;
  } else {
    ys.yaw += yawRate * dt;
  }
}

/**
 * Pure compose of the camera quaternion from a yaw value + device tilt. Writes `out`.
 * Reentrant — uses local scratch (no module-level shared state), safe for a standalone
 * package and for multiple consumers composing in the same frame.
 */
export function composeGyroLocarQuat(
  out: Quat, yawRad: number, betaDeg: number, gammaDeg: number, screenOrientationDeg: number,
): void {
  const a: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const b: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const betaR = betaDeg * DEG;
  const gammaR = gammaDeg * DEG;
  const alpha = 2 * Math.PI - yawRad - gammaR;
  setAxisAngle(a, 0, 1, 0, alpha);        // Ry(alpha)
  setAxisAngle(b, 1, 0, 0, betaR);        // Rx(beta)
  qMul(out, a, b);                        // Ry*Rx
  setAxisAngle(a, 0, 0, 1, -gammaR);      // Rz(-gamma)
  qMul(b, out, a);                        // (Ry*Rx)*Rz
  setAxisAngle(a, 1, 0, 0, -Math.PI / 2); // Rx(-pi/2): phone-fwd → camera-fwd
  qMul(out, b, a);
  const orientRad = (screenOrientationDeg || 0) * DEG;
  if (orientRad !== 0) {
    setAxisAngle(a, 0, 0, 1, -orientRad);
    qMul(b, out, a);
    out.x = b.x; out.y = b.y; out.z = b.z; out.w = b.w;
  }
}

/**
 * Convenience: advance the integrator and compose the camera quaternion in one call
 * (the tracker's current behavior). Returns false if sensors are missing.
 */
export function gyroLocarPose(out: Quat, inp: GyroLocarInputs, ys: YawState, nowSec: number): boolean {
  if (inp.gravity == null || inp.rotationRate == null) return false;
  const gmag = Math.hypot(inp.gravity.x, inp.gravity.y, inp.gravity.z);
  if (gmag < 0.1) return false;
  advanceGyroYaw(ys, inp, nowSec);
  composeGyroLocarQuat(out, ys.yaw ?? 0, inp.betaDeg ?? 0, inp.gammaDeg ?? 0, inp.screenOrientationDeg);
  return true;
}
