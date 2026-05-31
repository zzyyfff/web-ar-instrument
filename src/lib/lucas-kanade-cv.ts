// OpenCV.js wrapper exposing the same FlowResult interface as lucas-kanade.ts.
// Lazy-loads OpenCV.js from the CDN on first use; subsequent calls are fast.
// Provides a single estimateFlowCv(prev, curr, region) → FlowResult function
// since OpenCV manages the pyramid internally inside calcOpticalFlowPyrLK.

import { fitSimilarity, type FlowResult } from './lucas-kanade';

interface CvModule {
  Mat: new (...args: unknown[]) => unknown;
  matFromArray: (rows: number, cols: number, type: number, data: number[] | Uint8Array | Float32Array) => unknown;
  CV_8UC1: number;
  CV_32FC2: number;
  CV_8UC2: number;
  Size: new (w: number, h: number) => unknown;
  TermCriteria: new (type: number, count: number, eps: number) => unknown;
  TERM_CRITERIA_COUNT: number;
  TERM_CRITERIA_EPS: number;
  RANSAC: number;
  goodFeaturesToTrack: (src: unknown, corners: unknown, maxCorners: number, qualityLevel: number, minDistance: number, mask: unknown, blockSize: number, useHarris: boolean, k: number) => void;
  calcOpticalFlowPyrLK: (prevImg: unknown, nextImg: unknown, prevPts: unknown, nextPts: unknown, status: unknown, err: unknown, winSize: unknown, maxLevel: number, criteria: unknown) => void;
  estimateAffinePartial2D: (...args: unknown[]) => unknown;
  Scalar: new (...args: number[]) => unknown;
  rectangle: (img: unknown, pt1: unknown, pt2: unknown, color: unknown, thickness: number) => void;
  Point: new (x: number, y: number) => unknown;
}

export interface LoaderEvent {
  phase: 'download' | 'compile' | 'ready' | 'error';
  message: string;
  // For 'download' phase, percent is 0..1; for 'compile' phase undefined (no API).
  percent?: number;
  bytesLoaded?: number;
  bytesTotal?: number;
  elapsedMs?: number;
}

// Use @techstark/opencv-js via jsdelivr — a browser-built OpenCV with the WASM
// embedded as a base64 data URI inside the JS, so a single <script src> load is
// sufficient (no separate WASM fetch). Confirmed working on iPhone Chrome in
// ~4 seconds via the /cv-diag page; same as the iOS Simulator.
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

// === iOS Chrome workaround ===
//
// The previous wrapper-based loader (loadOpenCV-as-function with new Promise()
// + script.async=true + closure-resolved-flag) reliably HUNG on iOS Chrome 148
// after script.onload fired — Module.onRuntimeInitialized never fired and the
// poll setInterval stopped. Bisected via /cv-stage1 through /cv-stage11 (PR #8).
//
// Stage 11 confirmed the FIX: kick off the load INLINE early (no Promise
// wrapping, no script.async=true) — matches /cv-diag's working pattern.
// Caller should call startCvPreload() at module init (before user tap) so
// cv.Mat is ready by tap time.

type CvWithInit = CvModule & { onRuntimeInitialized?: (() => void); Mat?: unknown };
type CvWindow = { Module?: { onRuntimeInitialized?: () => void }; cv?: CvWithInit };

// === iOS Chrome WASM init bug — verified via /cv-stage1 through /cv-stage31 ===
//
// On iPhone Chrome 148: the OpenCV.js WASM init reliably *poisons* setTimeout /
// Promise-resolution AT THE MOMENT cv.Mat becomes constructible. Already-firing
// setIntervals continue (we use that), but setTimeouts queued before WASM init
// stop firing afterwards. Promise.then chains awaiting cv-load also die.
//
// What WORKS (verified by stage 31 PASS on iPhone Chrome):
//   - Inline script-setup in IIFE (NO `new Promise(...)` wrapping the setup)
//   - cv-load setInterval ALWAYS visible-logs each poll (not "only on change")
//   - When cv.Mat is detected, INVOKE REGISTERED CALLBACKS SYNCHRONOUSLY from
//     inside that setInterval tick. Caller does sync work in the callback.
//   - NO Promise returned. NO `await cvLoad()`. Caller registers a callback.
//
// What FAILS:
//   - `new Promise(...)` wrapping the setup (stage 22 hung iPhone+Mac)
//   - Returning a Promise that resolves via the cv-load (stage 24/25/28 hung iPhone)
//   - Caller polling cvReady via `await new Promise(r => setTimeout(r, 100))` —
//     setTimeout-chain dies the moment WASM init completes (stage 30)
//
// API: caller invokes startCvPreload() to kick the inline IIFE (idempotent),
// then registers a callback via onCvReady(cb). The callback fires SYNCHRONOUSLY
// from inside the cv-load setInterval as soon as cv.Mat is detected.

let cvProgressCb: ((e: LoaderEvent) => void) | null = null;
let cvLoadStartedAt = 0;
let setupDone = false;
let cvReadyValue: CvModule | null = null;
let cvErrorValue: Error | null = null;
const cvReadyCallbacks: Array<(cv: CvModule) => void> = [];
const cvErrorCallbacks: Array<(e: Error) => void> = [];

export function onCvProgress(cb: (e: LoaderEvent) => void) {
  cvProgressCb = cb;
}

function emit(ev: LoaderEvent) {
  cvProgressCb?.(ev);
}

// Register a synchronous callback. If cv is already loaded, the callback
// fires SYNCHRONOUSLY in this call. Otherwise it fires SYNCHRONOUSLY from
// inside the cv-load setInterval when cv.Mat is detected. NEVER returns a
// Promise — iPhone Chrome poisons Promise resolution at the WASM-init moment.
export function onCvReady(cb: (cv: CvModule) => void) {
  if (cvReadyValue) { cb(cvReadyValue); return; }
  cvReadyCallbacks.push(cb);
}

export function onCvError(cb: (e: Error) => void) {
  if (cvErrorValue) { cb(cvErrorValue); return; }
  cvErrorCallbacks.push(cb);
}

export function isCvReady(): boolean { return cvReadyValue != null; }
export function getCvSync(): CvModule | null { return cvReadyValue; }

// Idempotent. Kicks off the cv-load IIFE-style. Returns void; use onCvReady
// (NOT await) to learn when cv is ready.
export function startCvPreload(): void {
  if (setupDone) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  setupDone = true;
  const w = window as unknown as CvWindow;
  cvLoadStartedAt = performance.now();
  emit({ phase: 'download', message: 'Loading OpenCV.js (~10MB)…' });

  w.Module = {
    onRuntimeInitialized: () => {
      emit({ phase: 'compile', message: 'Module.onRuntimeInitialized fired', elapsedMs: performance.now() - cvLoadStartedAt });
    },
  };

  const s = document.createElement('script');
  s.src = OPENCV_URL;
  s.onload = () => {
    emit({ phase: 'compile', message: 'OpenCV script loaded, awaiting WASM init…', elapsedMs: performance.now() - cvLoadStartedAt });
  };
  s.onerror = () => {
    cvErrorValue = new Error('OpenCV.js script load failed (network/CORS)');
    emit({ phase: 'error', message: cvErrorValue.message });
    const cbs = cvErrorCallbacks.splice(0);
    for (const cb of cbs) cb(cvErrorValue);
  };
  document.head.appendChild(s);

  const poll = setInterval(() => {
    const cv = w.cv;
    if (cv && cv.Mat) {
      clearInterval(poll);
      cvReadyValue = cv as CvModule;
      emit({ phase: 'ready', message: `OpenCV ready (${((performance.now() - cvLoadStartedAt) / 1000).toFixed(1)}s)`, elapsedMs: performance.now() - cvLoadStartedAt });
      // CRITICAL: drain callbacks SYNCHRONOUSLY in this setInterval tick.
      // Any callback work the caller has must run here (not via Promise).
      const cbs = cvReadyCallbacks.splice(0);
      for (const cb of cbs) {
        try { cb(cvReadyValue); } catch { /* swallow */ }
      }
      return;
    }
    const keys = cv ? Object.keys(cv).length : 0;
    emit({ phase: 'compile', message: `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`, elapsedMs: performance.now() - cvLoadStartedAt });
  }, 2000);

  setTimeout(() => {
    if (cvReadyValue) return;
    clearInterval(poll);
    cvErrorValue = new Error('OpenCV.js init timed out after 60s');
    emit({ phase: 'error', message: cvErrorValue.message });
    const cbs = cvErrorCallbacks.splice(0);
    for (const cb of cbs) cb(cvErrorValue);
  }, 60_000);
}

// One-shot flow estimate using OpenCV. The caller passes the grayscale prev/curr
// frames as Uint8Array; we marshal into Mat, run the pipeline, free everything.
export function estimateFlowCv(
  cv: CvModule,
  prevGray: Uint8Array, currGray: Uint8Array,
  w: number, h: number,
  region: { x0: number; y0: number; x1: number; y1: number },
): FlowResult {
  const c = cv as unknown as Record<string, unknown> & {
    Mat: new (...args: unknown[]) => { delete(): void; rows: number; cols: number; data32F: Float32Array; data: Uint8Array };
  };
  const M = c.Mat;
  const prev = new M(h, w, cv.CV_8UC1);
  const curr = new M(h, w, cv.CV_8UC1);
  (prev as unknown as { data: Uint8Array }).data.set(prevGray);
  (curr as unknown as { data: Uint8Array }).data.set(currGray);

  const mask = new M(h, w, cv.CV_8UC1, new (cv.Scalar)(0));
  // Set ROI to white inside region (band excluding top/bottom overlay zones).
  (cv as unknown as { rectangle: typeof cv.rectangle }).rectangle(
    mask as unknown,
    new (cv.Point)(region.x0, region.y0),
    new (cv.Point)(region.x1, region.y1),
    new (cv.Scalar)(255, 255, 255, 255),
    -1,
  );

  const corners = new M();
  (cv as unknown as { goodFeaturesToTrack: typeof cv.goodFeaturesToTrack }).goodFeaturesToTrack(
    prev as unknown, corners as unknown,
    32, 0.02, 28, mask as unknown, 7, false, 0.04,
  );

  const totalCount = (corners as unknown as { rows: number }).rows;
  if (totalCount < 6) {
    prev.delete(); curr.delete(); mask.delete(); corners.delete();
    return { tx: 0, ty: 0, rollDeg: 0, residualPx: 99, inlierCount: 0, totalCount };
  }

  const nextPts = new M();
  const status = new M();
  const errMat = new M();
  const winSize = new (cv.Size)(21, 21);
  const criteria = new (cv.TermCriteria)(cv.TERM_CRITERIA_COUNT + cv.TERM_CRITERIA_EPS, 15, 0.01);
  (cv as unknown as { calcOpticalFlowPyrLK: typeof cv.calcOpticalFlowPyrLK }).calcOpticalFlowPyrLK(
    prev as unknown, curr as unknown,
    corners as unknown, nextPts as unknown,
    status as unknown, errMat as unknown,
    winSize as unknown, 2, criteria as unknown,
  );

  // Filter to good tracks.
  const p0Arr: number[] = [];
  const p1Arr: number[] = [];
  const cornersData = (corners as unknown as { data32F: Float32Array }).data32F;
  const nextData = (nextPts as unknown as { data32F: Float32Array }).data32F;
  const statusData = (status as unknown as { data: Uint8Array }).data;
  for (let i = 0; i < totalCount; i++) {
    if (statusData[i] === 1) {
      p0Arr.push(cornersData[2 * i], cornersData[2 * i + 1]);
      p1Arr.push(nextData[2 * i], nextData[2 * i + 1]);
    }
  }
  const nGood = p0Arr.length / 2;

  if (nGood < 4) {
    prev.delete(); curr.delete(); mask.delete(); corners.delete();
    nextPts.delete(); status.delete(); errMat.delete();
    return { tx: 0, ty: 0, rollDeg: 0, residualPx: 99, inlierCount: 0, totalCount };
  }

  // === FIT VIA VANILLA-JS fitSimilarity ===
  // @techstark/opencv-js 4.10 doesn't export estimateAffinePartial2D (verified
  // empirically — calling it throws "is not a function" on iPhone Chrome).
  // Fall back to the same fitSimilarity used by the vanilla-LK path; it takes
  // pixel-space point pairs and returns a similarity transform.
  const pairs: Array<{ x0: number; y0: number; x1: number; y1: number; ok: boolean }> = [];
  for (let i = 0; i < nGood; i++) {
    pairs.push({
      x0: p0Arr[2 * i], y0: p0Arr[2 * i + 1],
      x1: p1Arr[2 * i], y1: p1Arr[2 * i + 1],
      ok: true,
    });
  }
  const simFit = fitSimilarity(pairs, w / 2, h / 2);

  // Override totalCount with the OpenCV-side feature count so callers see the
  // detect-vs-track funnel correctly. (fitSimilarity returns pairs.length.)
  const result: FlowResult = { ...simFit, totalCount };

  prev.delete(); curr.delete(); mask.delete(); corners.delete();
  nextPts.delete(); status.delete(); errMat.delete();
  // NOTE: no p0Mat/p1Mat to free — this path feeds plain JS arrays (p0Arr/p1Arr)
  // to fitSimilarity, not OpenCV Mats. (Removed a dead p0Mat/p1Mat .delete() that
  // referenced undefined vars and would ReferenceError on every successful frame.)
  return result;
}
