import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { toAdAttitude, reSynthAdQuat, type Attitude } from './ad-attitude.js';
import { type Quat } from '../quat.js';

// q and -q are the same rotation; compare by |dot|≈1.
function sameRotation(a: Quat, b: Quat): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  return Math.abs(dot);
}
function norm(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

describe('toAdAttitude ↔ reSynthAdQuat round-trip', () => {
  // The core guarantee: AD posts toAdAttitude(q), AD's SDK rebuilds via ×0.8 YXZ; the
  // rebuilt quaternion must represent the SAME rotation as q. This is the contract that
  // lets the virtual world (Phase 8) validate exactly what AD renders.
  const samples: Quat[] = [
    norm({ x: 0, y: 0, z: 0, w: 1 }),
    norm({ x: 0.1, y: -0.2, z: 0.05, w: 0.97 }),
    norm({ x: 0.7071, y: 0, z: 0, w: -0.7071 }), // the gyro-locar base pose (Rx(-pi/2))
    norm({ x: -0.3, y: 0.4, z: 0.1, w: 0.86 }),
    norm({ x: 0.5, y: 0.5, z: -0.5, w: 0.5 }),
  ];
  it('reconstructs each quaternion as the same rotation', () => {
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    for (const q of samples) {
      const att = toAdAttitude(q);
      reSynthAdQuat(out, att);
      expect(sameRotation(q, norm(out))).toBeCloseTo(1, 6);
    }
  });

  it('reSynthAdQuat matches three.js setFromEuler(YXZ) — convention ORACLE (not self-referential)', () => {
    // AD's SDK is three.js: camera.quaternion = Euler(pitch*0.8, yaw*0.8, -roll*0.8, 'YXZ').
    // Pin reSynthAdQuat against the real library so a convention mistake can't pass.
    const atts: Attitude[] = [
      { roll: 0.1, pitch: -0.2, yaw: 0.3 },
      { roll: -0.5, pitch: 0.4, yaw: -0.6 },
      { roll: 0, pitch: 0, yaw: 0 },
    ];
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    for (const a of atts) {
      reSynthAdQuat(out, a);
      const e = new THREE.Euler(a.pitch * 0.8, a.yaw * 0.8, -a.roll * 0.8, 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(e);
      expect(out.x).toBeCloseTo(q.x, 9);
      expect(out.y).toBeCloseTo(q.y, 9);
      expect(out.z).toBeCloseTo(q.z, 9);
      expect(out.w).toBeCloseTo(q.w, 9);
    }
  });

  it('undoes AD’s 0.8 damping (attitude is the pre-damp value)', () => {
    // A pure-yaw camera quat → attitude.yaw should be larger than the ×0.8 angle.
    const q = norm({ x: 0, y: Math.sin(0.4), z: 0, w: Math.cos(0.4) }); // yaw 0.8 rad about Y
    const att: Attitude = toAdAttitude(q);
    expect(att.yaw).toBeCloseTo(0.8 / 0.8, 6); // 0.8 rad rotation ÷ 0.8 damp = 1.0
  });
});
