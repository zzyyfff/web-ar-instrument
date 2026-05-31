import { describe, it, expect } from 'vitest';
import {
  advanceGyroYaw, composeGyroLocarQuat, gyroLocarPose,
  type YawState, type GyroLocarInputs,
} from './gyro-locar.js';
import { toAdAttitude, reSynthAdQuat } from '../consumer/ad-attitude.js';
import { type Quat } from '../quat.js';

const UPRIGHT = { x: 0, y: -9.8, z: 0 }; // gravity, phone held vertical
function inputs(over: Partial<GyroLocarInputs> = {}): GyroLocarInputs {
  return {
    gravity: UPRIGHT, rotationRate: { ra: 0, rb: 0, rg: 0 },
    betaDeg: 0, gammaDeg: 0, screenOrientationDeg: 0, compassHeadingDeg: null, ...over,
  };
}

describe('advanceGyroYaw (the integrator)', () => {
  it('first call seeds yaw (no rate applied); later calls integrate once each', () => {
    const ys: YawState = { yaw: null, lastT: null };
    // upright + rb=0.5 → yawRate = (rb*gy)/|g| = 0.5*-9.8/9.8 = -0.5 rad/s
    const inp = inputs({ rotationRate: { ra: 0, rb: 0.5, rg: 0 } });
    advanceGyroYaw(ys, inp, 0);        // seed → yaw 0, lastT 0
    expect(ys.yaw).toBe(0);
    advanceGyroYaw(ys, inp, 0.05);     // dt 0.05 → yaw += -0.5*0.05
    expect(ys.yaw).toBeCloseTo(-0.025, 9);
    advanceGyroYaw(ys, inp, 0.10);     // another dt 0.05
    expect(ys.yaw).toBeCloseTo(-0.05, 9);
  });

  it('seeds initial heading from compass when present (absolute start only)', () => {
    const ys: YawState = { yaw: null, lastT: null };
    advanceGyroYaw(ys, inputs({ compassHeadingDeg: 90 }), 0);
    expect(ys.yaw).toBeCloseTo(Math.PI / 2, 9);
  });

  it('clamps dt (no huge jump after a long gap)', () => {
    const ys: YawState = { yaw: 0, lastT: 0 };
    advanceGyroYaw(ys, inputs({ rotationRate: { ra: 0, rb: 1, rg: 0 } }), 100); // 100s gap
    expect(ys.yaw).toBeCloseTo(-1 * 0.1, 9); // dt clamped to 0.1
  });
});

describe('composeGyroLocarQuat (pure)', () => {
  it('base pose (yaw=beta=gamma=0) is Rx(-pi/2) — frozen golden', () => {
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    composeGyroLocarQuat(out, 0, 0, 0, 0);
    expect(out.x).toBeCloseTo(0.7071, 4);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(0, 6);
    expect(out.w).toBeCloseTo(-0.7071, 4);
  });

  it('always produces a unit quaternion', () => {
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    composeGyroLocarQuat(out, 1.1, 35, -20, 90);
    expect(Math.hypot(out.x, out.y, out.z, out.w)).toBeCloseTo(1, 9);
  });

  it('nonzero yaw/beta/gamma/orientation — frozen golden pins the LocAR math', () => {
    // Independently computed (see commit msg); locks the full composition incl. screen orient.
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    composeGyroLocarQuat(out, 0.5, 30, -15, 90);
    expect(out.x).toBeCloseTo(0.202025, 5);
    expect(out.y).toBeCloseTo(0.505032, 5);
    expect(out.z).toBeCloseTo(0.589164, 5);
    expect(out.w).toBeCloseTo(-0.597507, 5);
  });

  it('reentrant: a second compose does not corrupt the first', () => {
    const a: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const b: Quat = { x: 0, y: 0, z: 0, w: 1 };
    composeGyroLocarQuat(a, 0.5, 30, -15, 90);
    const snap = { ...a };
    composeGyroLocarQuat(b, 1.1, 35, -20, 0); // different inputs into a different out
    expect(a).toEqual(snap); // a untouched (no shared module scratch)
  });
});

describe('gyroLocarPose ↔ AD adapter round-trip', () => {
  it('AD reconstructs the gyro-locar quaternion exactly', () => {
    const ys: YawState = { yaw: null, lastT: null };
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const inp = inputs({ betaDeg: 30, gammaDeg: -15, rotationRate: { ra: 0.1, rb: 0.3, rg: -0.2 } });
    gyroLocarPose(out, inp, ys, 0);
    gyroLocarPose(out, inp, ys, 0.05);
    const reb: Quat = { x: 0, y: 0, z: 0, w: 1 };
    reSynthAdQuat(reb, toAdAttitude(out));
    const dot = Math.abs(out.x * reb.x + out.y * reb.y + out.z * reb.z + out.w * reb.w);
    expect(dot).toBeCloseTo(1, 6); // same rotation AD would render
  });

  it('returns false when sensors are missing', () => {
    const ys: YawState = { yaw: null, lastT: null };
    const out: Quat = { x: 0, y: 0, z: 0, w: 1 };
    expect(gyroLocarPose(out, inputs({ gravity: null }), ys, 0)).toBe(false);
    expect(gyroLocarPose(out, inputs({ rotationRate: null }), ys, 0)).toBe(false);
  });
});
