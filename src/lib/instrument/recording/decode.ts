// Recording decoder — normalizes the recording shapes we have into one event stream.
//
// There are two physical sample shapes in the wild:
//   FLAT   (calibrator schemaVersion 0.2): each sample is ONE event, discriminated by
//           `kind: 'o' | 'm'`, fields at the top level. See src/types/recording.ts.
//   NESTED (player capture-button 0.1 + recorder.ts): each sample has `t` plus optional
//           `m` (motion) and/or `o` (orientation) sub-objects, no `kind`.
// The offline Python harnesses split on this today (filters.py assumes flat, the
// heading-comparison cmp8.py assumes nested), which is why schema work must be
// decoder-first (plan Phase 6): normalize, then unify the writer.
//
// Canonical output uses the SAME rotationRate convention as the live sensor state
// (`state.rotationRate`): ra=alpha, rb=beta, rg = -gamma (the empirical iOS sign flip).
// Raw recordings store rot.g UNFLIPPED; the flip is applied here so the normalized
// stream feeds worldUpYawRateCompassCW() (lib/gyro-yaw.ts) directly.

export interface NormalizedOrientation {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  compassHeading: number | null;
  compassAccuracy: number | null;
  absolute?: boolean;
}

export interface NormalizedMotion {
  accG: { x: number; y: number; z: number } | null;
  acc: { x: number; y: number; z: number } | null;
  /**
   * Body angular velocity in the LIVE state convention: ra=alpha, rb=beta, rg=-gamma,
   * in RAD/s. Recordings store rotationRate in deg/s (raw, gamma unflipped); the deg→rad
   * conversion AND the gamma sign flip are applied here so the stream feeds
   * worldUpYawRateCompassCW() (lib/gyro-yaw.ts) directly, identically to the live paths
   * (visual-inertial-tracker.ts / calibrator.ts onMotion: `* Math.PI/180`, `-gamma`).
   */
  rot: { ra: number; rb: number; rg: number } | null;
  /** Raw DeviceMotionEvent.interval as stored (seconds on iOS). */
  intervalSec: number | null;
}

export interface NormalizedSample {
  tSec: number;
  orientation?: NormalizedOrientation;
  motion?: NormalizedMotion;
}

export type RecordingShape = 'flat' | 'nested';

export interface DecodedRecording {
  shape: RecordingShape;
  samples: NormalizedSample[];
}

const DEG = Math.PI / 180;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Only accept a fully-finite 3-vector; otherwise null (don't fabricate). */
function vec3(v: any): { x: number; y: number; z: number } | null {
  if (v && finite(v.x) && finite(v.y) && finite(v.z)) return { x: v.x, y: v.y, z: v.z };
  return null;
}

function decodeMotion(m: any): NormalizedMotion | undefined {
  if (m == null) return undefined;
  // Require all three gyro axes finite — a partial rot would invent stillness on missing axes.
  const rot =
    m.rot && finite(m.rot.a) && finite(m.rot.b) && finite(m.rot.g)
      ? { ra: m.rot.a * DEG, rb: m.rot.b * DEG, rg: -m.rot.g * DEG } // deg/s→rad/s + gamma flip
      : null;
  return {
    accG: vec3(m.accG),
    acc: vec3(m.acc),
    rot,
    intervalSec: num(m.interval),
  };
}

function decodeOrientation(o: any): NormalizedOrientation {
  return {
    alpha: num(o.alpha),
    beta: num(o.beta),
    gamma: num(o.gamma),
    compassHeading: num(o.webkitCompassHeading),
    compassAccuracy: o.webkitCompassAccuracy == null ? null : num(o.webkitCompassAccuracy),
    absolute: typeof o.absolute === 'boolean' ? o.absolute : undefined,
  };
}

/** Report the predominant physical shape (first marker seen). Decoding is per-sample. */
export function detectShape(samples: any[]): RecordingShape {
  for (const s of samples) {
    if (s && typeof s === 'object') {
      if ('kind' in s) return 'flat';
      if ('m' in s || 'o' in s) return 'nested';
    }
  }
  return 'nested'; // empty/ambiguous → nested (the player/recorder default)
}

/**
 * Normalize a recording JSON (any known shape) into a single time-sorted event stream.
 * Decoding is PER-SAMPLE (a sample's own structure decides flat vs nested), so a mixed or
 * partial capture never drops the minority shape. Times are converted ms → seconds and
 * rebased so the first sample is t=0 (matching the offline harnesses).
 */
export function decodeRecording(json: { samples?: any[] }): DecodedRecording {
  const raw = Array.isArray(json?.samples) ? json.samples : [];
  const out: NormalizedSample[] = [];

  for (const s of raw) {
    if (!s || typeof s !== 'object' || typeof s.t !== 'number') continue;
    const tSec = s.t / 1000;
    if ('kind' in s) {
      // flat (calibrator): one event per sample
      if (s.kind === 'o') out.push({ tSec, orientation: decodeOrientation(s) });
      else if (s.kind === 'm') {
        const motion = decodeMotion(s);
        if (motion) out.push({ tSec, motion });
      }
    } else {
      // nested (player/recorder): optional m and/or o
      const sample: NormalizedSample = { tSec };
      if (s.o) sample.orientation = decodeOrientation(s.o);
      if (s.m) sample.motion = decodeMotion(s.m);
      if (sample.orientation || sample.motion) out.push(sample);
    }
  }

  out.sort((a, b) => a.tSec - b.tSec);
  if (out.length) {
    const t0 = out[0].tSec;
    for (const s of out) s.tSec -= t0;
  }
  return { shape: detectShape(raw), samples: out };
}
