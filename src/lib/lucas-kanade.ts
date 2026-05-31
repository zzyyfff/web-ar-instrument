// Lucas-Kanade pyramidal optical flow + Shi-Tomasi feature detection + affine fit.
// Vanilla TypeScript, no deps. Designed for ~30Hz on iPhone Safari, ~30 features,
// 15-pixel window, 2 pyramid levels.
//
// Used by the calibrator's visual-inertial fusion algorithm to estimate the
// camera's per-frame image-plane motion (rotation, translation), which is then
// combined with gyroscope data to correct yaw drift during high-roll moments
// where iOS webkitCompassHeading is unreliable.

export interface FlowResult {
  tx: number;             // median x-translation of inliers (pixels)
  ty: number;             // median y-translation (pixels)
  rollDeg: number;        // 2D rotation of feature cloud (degrees)
  residualPx: number;     // median residual of similarity fit (pixels) — quality signal
  inlierCount: number;
  totalCount: number;
}

// TUNING CONSTANTS — these are NOT arbitrary. Each was validated against
// rec_1f1v6x6v synthetic-rotation tests and real video frame pairs from the
// fireplace captures. The validation runner lives at /tmp/gizmo-analysis/lk-test/.
//
//   WIN=10 (21x21 patch): matches OpenCV's calcOpticalFlowPyrLK default. Earlier
//     trials at WIN=7 (15x15) underestimated motion 3-4x in synthetic-rotation
//     tests (JS: -0.14° vs OpenCV: -2.64° for a +5° image rotation).
//   LK_ITERATIONS=15: OpenCV defaults to 30 with an epsilon early-stop. 15 is
//     enough for sub-pixel convergence on the motions we see (≤70 px/frame at
//     15 fps) and cheaper on iOS CPU.
//   MAX_FEATURES=32: caps per-frame LK cost. With 32 features × 21×21 patch ×
//     15 iter × 3 pyramid levels ≈ 600k patch ops — well within iOS budget.
//   FEATURE_MIN_DISTANCE=28: spatial non-max suppression to spread features
//     evenly across the masked band. Tuned to give ~20-30 trackable features
//     on the typical living-room scene.
//   SHI_TOMASI_QUALITY=0.02: corner-score threshold relative to the max in the
//     frame. Low enough to find features in low-contrast scenes (white walls)
//     without picking up noise.
//   Pyramid: 3 levels (180×320, 90×160, 45×80). 2 levels missed the larger
//     wrist-roll motions; 4+ doesn't measurably improve.
const WIN = 10;            // half-window for LK iteration (21x21 patch, matches OpenCV default)
const LK_ITERATIONS = 15;  // OpenCV default is 30 with eps stop; we cap lower for speed
const MAX_FEATURES = 32;
const FEATURE_MIN_DISTANCE = 28;
const SHI_TOMASI_QUALITY = 0.02;

// Convert RGBA ImageData to a Uint8 grayscale buffer (single channel).
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    // luminance from RGB
    out[j] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
  }
  return out;
}

// Downsample by 2 with simple 2x2 box average.
function downsample2(src: Uint8Array, w: number, h: number): { data: Uint8Array; w: number; h: number } {
  const w2 = w >> 1, h2 = h >> 1;
  const dst = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const sx = x << 1, sy = y << 1;
      const a = src[sy * w + sx];
      const b = src[sy * w + sx + 1];
      const c = src[(sy + 1) * w + sx];
      const d = src[(sy + 1) * w + sx + 1];
      dst[y * w2 + x] = (a + b + c + d) >> 2;
    }
  }
  return { data: dst, w: w2, h: h2 };
}

// Build a 3-level pyramid (level 0 = original, level 2 = downsampled 4x).
// 3 levels gives effective LK tracking range of ~84*4 = 336 pixels in the original
// image — enough for fast wrist-rolls at 15 fps where a feature can travel ~70 pixels.
export function buildPyramid(gray: Uint8Array, w: number, h: number): Array<{ data: Uint8Array; w: number; h: number }> {
  const p0 = { data: gray, w, h };
  const p1 = downsample2(gray, w, h);
  const p2 = downsample2(p1.data, p1.w, p1.h);
  return [p0, p1, p2];
}

// Sample with bilinear interpolation; out-of-bounds → 0.
function sample(img: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0;
  const x0 = x | 0, y0 = y | 0;
  const dx = x - x0, dy = y - y0;
  const idx = y0 * w + x0;
  const a = img[idx];
  const b = img[idx + 1];
  const c = img[idx + w];
  const d = img[idx + w + 1];
  return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
}

// Compute Sobel-ish gradients at a single point via bilinear sample of neighbors.
function gradAt(img: Uint8Array, w: number, h: number, x: number, y: number): [number, number] {
  const gx = (sample(img, w, h, x + 1, y) - sample(img, w, h, x - 1, y)) * 0.5;
  const gy = (sample(img, w, h, x, y + 1) - sample(img, w, h, x, y - 1)) * 0.5;
  return [gx, gy];
}

// Shi-Tomasi corner detection at a coarse grid of points.
// Returns array of {x, y, score} for the top MAX_FEATURES with score > quality * maxScore.
export function detectFeatures(
  gray: Uint8Array, w: number, h: number,
  region: { x0: number; y0: number; x1: number; y1: number },
): Array<{ x: number; y: number }> {
  const candidates: Array<{ x: number; y: number; score: number }> = [];
  // Sample on a grid stride
  const stride = 8;
  for (let y = Math.max(WIN + 1, region.y0); y < Math.min(h - WIN - 1, region.y1); y += stride) {
    for (let x = Math.max(WIN + 1, region.x0); x < Math.min(w - WIN - 1, region.x1); x += stride) {
      // Compute structure tensor in a small window
      let Ixx = 0, Iyy = 0, Ixy = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const [gx, gy] = gradAt(gray, w, h, x + dx, y + dy);
          Ixx += gx * gx; Iyy += gy * gy; Ixy += gx * gy;
        }
      }
      // Smaller eigenvalue (Shi-Tomasi)
      const tr = Ixx + Iyy;
      const det = Ixx * Iyy - Ixy * Ixy;
      const disc = Math.max(0, tr * tr - 4 * det);
      const eMin = (tr - Math.sqrt(disc)) * 0.5;
      if (eMin > 50) candidates.push({ x, y, score: eMin });
    }
  }
  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.score - a.score);
  const maxScore = candidates[0].score;
  const threshold = maxScore * SHI_TOMASI_QUALITY;
  const filtered = candidates.filter((c) => c.score >= threshold);
  // Spatial non-max suppression: prefer high-score, reject if within FEATURE_MIN_DISTANCE of accepted.
  const accepted: Array<{ x: number; y: number }> = [];
  const minD2 = FEATURE_MIN_DISTANCE * FEATURE_MIN_DISTANCE;
  for (const c of filtered) {
    let ok = true;
    for (const a of accepted) {
      const dx = c.x - a.x, dy = c.y - a.y;
      if (dx * dx + dy * dy < minD2) { ok = false; break; }
    }
    if (ok) accepted.push({ x: c.x, y: c.y });
    if (accepted.length >= MAX_FEATURES) break;
  }
  return accepted;
}

// Track a single feature from prev to curr using inverse-compositional LK at one pyramid level.
// Returns null if tracking failed (out of bounds or singular).
function trackOne(
  prev: Uint8Array, curr: Uint8Array, w: number, h: number,
  fx: number, fy: number,
  init_u: number, init_v: number,
): { u: number; v: number } | null {
  let u = init_u, v = init_v;
  // Precompute gradients and patch on prev around (fx, fy)
  const patchSize = (2 * WIN + 1) * (2 * WIN + 1);
  const prevPatch = new Float32Array(patchSize);
  const Ix = new Float32Array(patchSize);
  const Iy = new Float32Array(patchSize);
  let A11 = 0, A12 = 0, A22 = 0;
  let k = 0;
  for (let dy = -WIN; dy <= WIN; dy++) {
    for (let dx = -WIN; dx <= WIN; dx++) {
      const px = fx + dx, py = fy + dy;
      prevPatch[k] = sample(prev, w, h, px, py);
      const [gx, gy] = gradAt(prev, w, h, px, py);
      Ix[k] = gx; Iy[k] = gy;
      A11 += gx * gx; A12 += gx * gy; A22 += gy * gy;
      k++;
    }
  }
  const det = A11 * A22 - A12 * A12;
  if (Math.abs(det) < 1e-3) return null;
  const invDet = 1 / det;
  for (let iter = 0; iter < LK_ITERATIONS; iter++) {
    let b1 = 0, b2 = 0;
    let k2 = 0;
    for (let dy = -WIN; dy <= WIN; dy++) {
      for (let dx = -WIN; dx <= WIN; dx++) {
        const px = fx + dx + u, py = fy + dy + v;
        if (px < 0 || py < 0 || px >= w - 1 || py >= h - 1) return null;
        const diff = prevPatch[k2] - sample(curr, w, h, px, py);
        b1 += Ix[k2] * diff;
        b2 += Iy[k2] * diff;
        k2++;
      }
    }
    const du = (A22 * b1 - A12 * b2) * invDet;
    const dv = (A11 * b2 - A12 * b1) * invDet;
    u += du; v += dv;
    if (du * du + dv * dv < 0.005) break;
  }
  return { u, v };
}

// Track features through a pyramid (coarse-to-fine).
export function trackFeatures(
  prevPyr: Array<{ data: Uint8Array; w: number; h: number }>,
  currPyr: Array<{ data: Uint8Array; w: number; h: number }>,
  features: Array<{ x: number; y: number }>,
): Array<{ x0: number; y0: number; x1: number; y1: number; ok: boolean }> {
  const out: Array<{ x0: number; y0: number; x1: number; y1: number; ok: boolean }> = [];
  for (const f of features) {
    let u = 0, v = 0;
    let ok = true;
    // Start at coarsest level (smallest image)
    for (let lvl = prevPyr.length - 1; lvl >= 0; lvl--) {
      const scale = 1 << lvl;
      const fx = f.x / scale;
      const fy = f.y / scale;
      // Scale up the displacement from coarser level
      if (lvl < prevPyr.length - 1) { u *= 2; v *= 2; }
      const r = trackOne(prevPyr[lvl].data, currPyr[lvl].data, prevPyr[lvl].w, prevPyr[lvl].h, fx, fy, u, v);
      if (r === null) { ok = false; break; }
      u = r.u; v = r.v;
    }
    out.push({ x0: f.x, y0: f.y, x1: f.x + u, y1: f.y + v, ok });
  }
  return out;
}

// Fit a similarity transform (rotation + uniform scale + translation) via least squares
// with a one-pass robust filter on residuals.
//
// Model: [x1; y1] = s*R*[x0; y0] + t, with R = [[cosθ -sinθ];[sinθ cosθ]] and s = uniform scale.
// Equivalently: x1 = a*x0 - b*y0 + tx, y1 = b*x0 + a*y0 + ty   where (a,b) = s*(cos,sin).
// Solve linear system A*[a,b,tx,ty]^T = z by normal equations.
export function fitSimilarity(
  pairs: Array<{ x0: number; y0: number; x1: number; y1: number; ok: boolean }>,
  cx: number, cy: number,
): FlowResult {
  // Filter ok pairs first.
  const ok = pairs.filter((p) => p.ok);
  if (ok.length < 4) return { tx: 0, ty: 0, rollDeg: 0, residualPx: 99, inlierCount: 0, totalCount: pairs.length };

  // Center the coords around image center to make the math better-conditioned.
  const fit = (subset: typeof ok): { a: number; b: number; tx: number; ty: number } | null => {
    let M11 = 0, M12 = 0, M13 = 0, M14 = 0;
    let M22 = 0, M23 = 0, M24 = 0;
    let M33 = 0, M34 = 0, M44 = 0;
    let r1 = 0, r2 = 0, r3 = 0, r4 = 0;
    for (const p of subset) {
      const x0 = p.x0 - cx, y0 = p.y0 - cy;
      const x1 = p.x1 - cx, y1 = p.y1 - cy;
      // Row 1: x0*a - y0*b + 1*tx + 0*ty = x1
      // Row 2: y0*a + x0*b + 0*tx + 1*ty = y1
      // Normal equations: A^T A * x = A^T z
      M11 += x0 * x0 + y0 * y0;
      M12 += 0;  // x0*-y0 + y0*x0 = 0
      M13 += x0;
      M14 += y0;
      M22 += y0 * y0 + x0 * x0;
      M23 += -y0;
      M24 += x0;
      M33 += 1;
      M34 += 0;
      M44 += 1;
      r1 += x0 * x1 + y0 * y1;
      r2 += -y0 * x1 + x0 * y1;
      r3 += x1;
      r4 += y1;
    }
    // Symmetric 4x4 matrix M. We use the fact that M12=M34=0 and the block structure.
    // Solve via direct inversion (regularization-stable).
    // Build matrix
    const M = [
      [M11, M12, M13, M14],
      [M12, M22, M23, M24],
      [M13, M23, M33, M34],
      [M14, M24, M34, M44],
    ];
    const rhs = [r1, r2, r3, r4];
    // Solve via Gaussian elimination
    const x = solve4x4(M, rhs);
    if (!x) return null;
    return { a: x[0], b: x[1], tx: x[2], ty: x[3] };
  };

  const first = fit(ok);
  if (!first) return { tx: 0, ty: 0, rollDeg: 0, residualPx: 99, inlierCount: 0, totalCount: pairs.length };

  // Compute residuals
  const residuals: number[] = [];
  for (const p of ok) {
    const x0 = p.x0 - cx, y0 = p.y0 - cy;
    const x1 = p.x1 - cx, y1 = p.y1 - cy;
    const px = first.a * x0 - first.b * y0 + first.tx;
    const py = first.b * x0 + first.a * y0 + first.ty;
    const r = Math.hypot(px - x1, py - y1);
    residuals.push(r);
  }
  const sortedR = [...residuals].sort((a, b) => a - b);
  const medianR = sortedR[sortedR.length >> 1];
  const inlierThresh = Math.max(2, medianR * 2.5);
  const inliers = ok.filter((_, i) => residuals[i] < inlierThresh);
  let refined = first;
  let inlierMedian = medianR;
  if (inliers.length >= 4 && inliers.length < ok.length) {
    const r2 = fit(inliers);
    if (r2) {
      refined = r2;
      // recompute median residual on inliers
      const inResiduals: number[] = [];
      for (const p of inliers) {
        const x0 = p.x0 - cx, y0 = p.y0 - cy;
        const x1 = p.x1 - cx, y1 = p.y1 - cy;
        const px = refined.a * x0 - refined.b * y0 + refined.tx;
        const py = refined.b * x0 + refined.a * y0 + refined.ty;
        inResiduals.push(Math.hypot(px - x1, py - y1));
      }
      inResiduals.sort((a, b) => a - b);
      inlierMedian = inResiduals[inResiduals.length >> 1];
    }
  }
  const rollDeg = Math.atan2(refined.b, refined.a) * 180 / Math.PI;
  return {
    tx: refined.tx,
    ty: refined.ty,
    rollDeg,
    residualPx: inlierMedian,
    inlierCount: inliers.length,
    totalCount: pairs.length,
  };
}

// Solve a 4x4 linear system Ax = b via Gauss-Jordan with partial pivoting.
function solve4x4(A: number[][], b: number[]): number[] | null {
  // Copy
  const M = [
    [A[0][0], A[0][1], A[0][2], A[0][3], b[0]],
    [A[1][0], A[1][1], A[1][2], A[1][3], b[1]],
    [A[2][0], A[2][1], A[2][2], A[2][3], b[2]],
    [A[3][0], A[3][1], A[3][2], A[3][3], b[3]],
  ];
  for (let c = 0; c < 4; c++) {
    let maxR = c, maxV = Math.abs(M[c][c]);
    for (let r = c + 1; r < 4; r++) {
      const v = Math.abs(M[r][c]);
      if (v > maxV) { maxR = r; maxV = v; }
    }
    if (maxV < 1e-10) return null;
    if (maxR !== c) { const tmp = M[c]; M[c] = M[maxR]; M[maxR] = tmp; }
    const piv = M[c][c];
    for (let cc = c; cc <= 4; cc++) M[c][cc] /= piv;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const factor = M[r][c];
      if (Math.abs(factor) < 1e-14) continue;
      for (let cc = c; cc <= 4; cc++) M[r][cc] -= factor * M[c][cc];
    }
  }
  return [M[0][4], M[1][4], M[2][4], M[3][4]];
}
