// AD consumer adapter. Atmospheric Descent's SDK rebuilds the camera quaternion from a
// posted attitude via: camera.quaternion = Euler(pitch*0.8, yaw*0.8, -roll*0.8, 'YXZ').
// So to make AD reproduce a fused camera quaternion EXACTLY, decompose it to YXZ Euler
// and divide out the 0.8 damping. Extracted verbatim from player.ts (~450-458).
//
// This is the named, tested adapter the plan calls for: the virtual world and AD must
// drive through THIS function (not a divergent path) so the calibrator validates what AD
// actually renders. Round-trip property: reSynthAdQuat(toAdAttitude(q)) === q (see test).

import type { Quat } from '../quat.js';

export interface Attitude { roll: number; pitch: number; yaw: number } // radians

const E = 0.8; // AD SDK's internal damping factor

/** Camera quaternion → the attitude AD should be posted (so its ×0.8 YXZ rebuild == q). */
export function toAdAttitude(q: Quat): Attitude {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const m23 = 2 * (y * z - w * x);
  const m13 = 2 * (x * z + w * y);
  const m33 = 1 - 2 * (x * x + y * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const m31 = 2 * (x * z - w * y);
  const m11 = 1 - 2 * (y * y + z * z);
  const ex = Math.asin(Math.max(-1, Math.min(1, -m23)));
  let ey: number, ez: number;
  if (Math.abs(m23) < 0.9999999) { ey = Math.atan2(m13, m33); ez = Math.atan2(m21, m22); }
  else { ey = Math.atan2(-m31, m11); ez = 0; }
  return { roll: -ez / E, pitch: ex / E, yaw: ey / E };
}

/**
 * Re-synthesize the camera quaternion AD produces from a posted attitude:
 * Euler(pitch*0.8, yaw*0.8, -roll*0.8, 'YXZ'). Used to verify the round-trip; mirrors
 * three.js setFromEuler('YXZ'). Writes into `out`.
 */
export function reSynthAdQuat(out: Quat, a: Attitude): void {
  const x = a.pitch * E, y = a.yaw * E, z = -a.roll * E; // AD applies ×0.8 then YXZ
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  // three.js 'YXZ' order:
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 - s1 * s2 * c3;
  out.w = c1 * c2 * c3 + s1 * s2 * s3;
}
