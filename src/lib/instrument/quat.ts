// Pure quaternion helpers, extracted verbatim from the copies in calibrator.ts (~379-413)
// and visual-inertial-tracker.ts (~84-99). Single source so the two tools can't drift.
// No allocation in the hot path: callers pass an `out` to mutate.

export interface Quat { x: number; y: number; z: number; w: number }

export function setAxisAngle(q: Quat, ax: number, ay: number, az: number, angle: number): void {
  const half = angle / 2;
  const s = Math.sin(half);
  q.x = ax * s; q.y = ay * s; q.z = az * s; q.w = Math.cos(half);
}

export function qMul(out: Quat, a: Quat, b: Quat): void {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}

export function qCopy(out: Quat, src: Quat): void {
  out.x = src.x; out.y = src.y; out.z = src.z; out.w = src.w;
}

/**
 * Rotate a vector by the INVERSE of a unit quaternion (world→camera direction).
 * v_local = q^-1 * v * q when q is camera-to-world; conjugate of unit q is (-x,-y,-z,w).
 */
export function rotateByQuatInverse(
  out: { x: number; y: number; z: number },
  q: Quat, vx: number, vy: number, vz: number,
): void {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
}
