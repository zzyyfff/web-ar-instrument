import { describe, it, expect } from 'vitest';
import { decodeRecording, detectShape } from './decode.js';
import { worldUpYawRateCompassCW } from '../../gyro-yaw.js';

// FLAT shape (calibrator schemaVersion 0.2): one event per sample, discriminated by `kind`.
const FLAT = {
  schemaVersion: '0.2',
  samples: [
    { t: 1000, kind: 'o', alpha: 10, beta: 85, gamma: -8, webkitCompassHeading: 0.2, webkitCompassAccuracy: 12 },
    { t: 1016, kind: 'm', accG: { x: 0.3, y: -7.5, z: -1.9 }, acc: { x: 0, y: 0, z: 0 }, rot: { a: -1.7, b: -3.9, g: 1.8 }, interval: 0.0166 },
  ],
};

// NESTED shape (player capture-button 0.1 + recorder.ts): no `kind`, optional m/o sub-objects.
const NESTED = {
  schemaVersion: '0.1',
  samples: [
    { t: 5000, o: { alpha: 10, beta: 85, gamma: -8, absolute: false, webkitCompassHeading: 0.2, webkitCompassAccuracy: 12 } },
    { t: 5016, m: { accG: { x: 0.3, y: -7.5, z: -1.9 }, acc: { x: 0, y: 0, z: 0 }, rot: { a: -1.7, b: -3.9, g: 1.8 }, interval: 0.0166 } },
    { t: 5033, m: { accG: { x: 0.3, y: -7.5, z: -1.9 }, rot: { a: 0, b: 0, g: 0 } }, o: { alpha: 11, beta: 84, gamma: -7, absolute: false, webkitCompassHeading: 1.0, webkitCompassAccuracy: 12 } },
  ],
};

describe('detectShape', () => {
  it('identifies flat (kind) vs nested (m/o)', () => {
    expect(detectShape(FLAT.samples)).toBe('flat');
    expect(detectShape(NESTED.samples)).toBe('nested');
    expect(detectShape([])).toBe('nested'); // ambiguous → player/recorder default
  });
});

describe('decodeRecording', () => {
  it('normalizes both shapes to the same canonical stream', () => {
    const flat = decodeRecording(FLAT);
    const nested = decodeRecording(NESTED);
    expect(flat.shape).toBe('flat');
    expect(nested.shape).toBe('nested');

    // first orientation event matches across shapes
    expect(flat.samples[0].orientation).toEqual({
      alpha: 10, beta: 85, gamma: -8, compassHeading: 0.2, compassAccuracy: 12, absolute: undefined,
    });
    expect(nested.samples[0].orientation?.compassHeading).toBe(0.2);

    // rot is converted deg/s → rad/s AND gamma sign-flipped (rg = -rawG), matching the
    // live state.rotationRate convention so it feeds worldUpYawRateCompassCW directly.
    const DEG = Math.PI / 180;
    for (const r of [flat.samples[1].motion!.rot!, nested.samples[1].motion!.rot!]) {
      expect(r.ra).toBeCloseTo(-1.7 * DEG, 9);
      expect(r.rb).toBeCloseTo(-3.9 * DEG, 9);
      expect(r.rg).toBeCloseTo(-1.8 * DEG, 9); // -(rawG=1.8) in rad
    }
  });

  it('does not fabricate partial/garbage motion (all-axes + finite required)', () => {
    const partial = decodeRecording({
      samples: [
        { t: 0, m: { rot: { a: 1 } } },                          // missing b/g → rot null
        { t: 16, m: { accG: { x: 1, y: NaN, z: 0 }, rot: { a: 1, b: 2, g: 3 } } }, // bad accG → null
      ],
    });
    expect(partial.samples[0].motion?.rot).toBeNull();
    expect(partial.samples[1].motion?.accG).toBeNull();
    expect(partial.samples[1].motion?.rot).not.toBeNull(); // rot still valid
  });

  it('decodes per-sample (a stray foreign-shape sample is not dropped)', () => {
    const mixed = decodeRecording({
      samples: [
        { t: 0, o: { alpha: 1, beta: 2, gamma: 3, absolute: false } }, // nested
        { t: 16, kind: 'o', alpha: 9, beta: 8, gamma: 7, webkitCompassHeading: 5, webkitCompassAccuracy: 1 }, // flat
      ],
    });
    expect(mixed.samples).toHaveLength(2);
    expect(mixed.samples[1].orientation?.compassHeading).toBe(5);
  });

  it('rebases time to t=0 in seconds and sorts', () => {
    const flat = decodeRecording(FLAT);
    expect(flat.samples[0].tSec).toBe(0);
    expect(flat.samples[1].tSec).toBeCloseTo(0.016, 3);
  });

  it('keeps both motion and orientation when a nested sample has both', () => {
    const nested = decodeRecording(NESTED);
    const both = nested.samples[2];
    expect(both.motion).toBeTruthy();
    expect(both.orientation).toBeTruthy();
  });

  it('feeds worldUpYawRateCompassCW directly (decoder ↔ gyro-yaw integration)', () => {
    // The normalized rot/accG drop straight into the live yaw function.
    const m = decodeRecording(FLAT).samples[1].motion!;
    const rate = worldUpYawRateCompassCW(m.rot!, m.accG!);
    const g = m.accG!;
    // self-consistent against the decoded (rad/s) values
    const expected = (m.rot!.ra * g.x + m.rot!.rb * g.y - m.rot!.rg * g.z) / Math.hypot(g.x, g.y, g.z);
    expect(rate).toBeCloseTo(expected, 9);
  });
});
