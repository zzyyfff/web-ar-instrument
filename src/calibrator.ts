// AR Calibrator standalone page.
//
// Live back-camera fullscreen + canvas overlay that draws compass-rose with
// cardinal direction labels (N/E/S/W) at their true-world positions based on
// the algorithm's interpretation of sensor data.
//
// User-visible feedback loop: point the phone at something known to be north,
// see if the "N" label lands on it. Same for E/S/W.
//
// Agent-visible feedback loop: tap the green capture button to record 30s of
// sensor + camera + algorithm state into R2; paste the recording id to the
// agent for offline diagnosis.

import './styles/calibrator.css';
import { toGray, buildPyramid, detectFeatures, trackFeatures, fitSimilarity } from './lib/lucas-kanade';
import { worldUpYawRateCompassCW } from './lib/gyro-yaw';
import { gyroLocarPose, type YawState } from './lib/instrument/pose/gyro-locar';
// Static import keeps cv module in the main bundle. The actual cv WASM load
// is gated by startCvPreload() below, which we only call when the algo needs it.
import * as cvLib from './lib/lucas-kanade-cv';
import { BACKEND_BASE, hasBackend } from './lib/backend';

declare const __BUILD_ID__: string;

// Local / no-upload save (the BYO-backend default). Rather than a synthetic click
// after the async capture — which browsers may block without a fresh user gesture,
// silently losing the capture while the UI reports success — we mint object URLs and
// hand them back as user-tappable download links (the tap supplies the activation, so
// it can't fail silently). A deployer who wires the secure, Access-gated backend
// (build plan P3) gets upload instead; see lib/backend.ts. This local path is also
// what makes a future public read-only mode possible.
interface LocalDownload { filename: string; url: string }

function saveRecordingLocally(
  jsonBody: string, durationMs: number, videoBlob: Blob | null, videoExt: string,
): { result: { id: string; size_bytes: number; duration_s: number; ts: string }; downloads: LocalDownload[] } {
  const ts = new Date().toISOString();
  const id = 'rec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const downloads: LocalDownload[] = [
    { filename: `${id}.json`, url: URL.createObjectURL(new Blob([jsonBody], { type: 'application/json' })) },
  ];
  if (videoBlob) downloads.push({ filename: `${id}.${videoExt}`, url: URL.createObjectURL(videoBlob) });
  return {
    result: { id, size_bytes: jsonBody.length, duration_s: Math.round(durationMs / 100) / 10, ts },
    downloads,
  };
}

const DEFAULT_FOV_DEG = 60; // horizontal FOV assumption; URL ?fov=N overrides

interface SensorState {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  webkitCompassHeading: number | null;
  webkitCompassAccuracy: number | null;
  gravity: { x: number; y: number; z: number } | null;
  // Body-frame angular velocity (rad/s) — iOS rotationRate (deg/s) with empirical
  // sign correction on gamma. ra=rotation around Z, rb=around X, rg=around Y.
  rotationRate: { ra: number; rb: number; rg: number; magDegps: number } | null;
  screenOrientation: number;
}

const state: SensorState = {
  alpha: null,
  beta: null,
  gamma: null,
  webkitCompassHeading: null,
  webkitCompassAccuracy: null,
  gravity: null,
  rotationRate: null,
  screenOrientation: screen.orientation?.angle ?? 0,
};

const fov = (() => {
  const p = new URLSearchParams(location.search);
  const n = parseFloat(p.get('fov') || '');
  return n > 20 && n < 120 ? n : DEFAULT_FOV_DEG;
})();

// Algorithm selector via ?algo=... URL param. Available methods:
//   euler-gamma         : iOS DeviceOrientation Euler with -γ compensation
//   gravity-compass     : gravity-vector attitude + raw compass yaw
//   compass-gated       : gravity attitude + gyro-integrated yaw with gated compass
//   visual-inertial     : compass + gyro + vanilla-JS Lucas-Kanade optical flow
//                         (3-level pyramid, 21x21 window, ~300 LOC, no deps).
//                         Tested on iPhone Chrome: RMS 7.3° error against truth
//                         anchors during roll cycles — best of all algorithms.
//   gyro-locar          : the algorithm AD shipped — gyro-integrated yaw about world-up
//                         (no compass), gravity-stable pitch/roll, LocAR composition.
//                         Shared module lib/instrument/pose/gyro-locar.ts (golden-tested).
//
// ?algo=visual-inertial-cv uses OpenCV.js for optical flow. Loaded BEFORE the
// camera/sensors/animation start so the WASM compile has a quiet main thread
// (the previous "hangs forever" behavior was due to concurrent load).
type AlgoId = 'euler-gamma' | 'gravity-compass' | 'compass-gated' | 'visual-inertial' | 'visual-inertial-cv' | 'gyro-locar';
const algoId: AlgoId = (() => {
  const a = new URLSearchParams(location.search).get('algo');
  if (a === 'euler-gamma') return 'euler-gamma';
  if (a === 'compass-gated') return 'compass-gated';
  if (a === 'visual-inertial') return 'visual-inertial';
  if (a === 'visual-inertial-cv') return 'visual-inertial-cv';
  if (a === 'gyro-locar') return 'gyro-locar';
  return 'gravity-compass';
})();

// === Choreography mode ===
// URL ?choreography=NAME enables a guided multi-phase capture. During capture
// the UI shows the current phase + countdown; the recording JSON gets a
// `choreography: { name, phases: [{label, hint, startMs, endMs}] }` field so
// offline analysis can align per-phase signals with truth.
interface Phase { label: string; hint: string; durationMs: number; }
interface Choreography { name: string; description: string; phases: Phase[]; }
const CHOREOGRAPHIES: Record<string, Choreography> = {
  baseline: {
    name: 'baseline',
    description: 'Cardinal-direction holds. Truth: each held bearing should match compass.',
    phases: [
      { label: 'Hold NORTH', hint: 'Point phone N, hold steady', durationMs: 6000 },
      { label: 'Pan to East', hint: 'Slowly turn right ~90°', durationMs: 4000 },
      { label: 'Hold EAST', hint: 'Point phone E, hold steady', durationMs: 6000 },
      { label: 'Pan to South', hint: 'Slowly turn right ~90°', durationMs: 4000 },
      { label: 'Hold SOUTH', hint: 'Point phone S, hold steady', durationMs: 6000 },
      { label: 'Pan to West', hint: 'Slowly turn right ~90°', durationMs: 4000 },
      { label: 'Hold WEST', hint: 'Point phone W, hold steady', durationMs: 6000 },
    ],
  },
  'whip-hold': {
    name: 'whip-hold',
    description: 'Rapid pans interleaved with steady holds. Measures recovery time after fast motion.',
    phases: [
      { label: 'Hold steady', hint: 'Any direction, hold still', durationMs: 5000 },
      { label: 'WHIP right', hint: 'Fast rotation, anywhere', durationMs: 2000 },
      { label: 'Hold steady', hint: 'Stop and hold for recovery', durationMs: 5000 },
      { label: 'WHIP left', hint: 'Fast rotation back', durationMs: 2000 },
      { label: 'Hold steady', hint: 'Stop and hold for recovery', durationMs: 5000 },
      { label: 'WHIP up/down', hint: 'Tilt phone vigorously', durationMs: 2000 },
      { label: 'Hold steady', hint: 'Return upright, hold', durationMs: 5000 },
    ],
  },
  'slow-pan': {
    name: 'slow-pan',
    description: 'Smooth 360° pan with brief pauses at cardinals. Tests continuous-motion tracking.',
    phases: [
      { label: 'Pan NW → N → NE', hint: 'Smooth slow rotation', durationMs: 6000 },
      { label: 'Brief pause at E', hint: 'Stop briefly', durationMs: 2000 },
      { label: 'Pan E → S → W', hint: 'Continue smooth rotation', durationMs: 8000 },
      { label: 'Brief pause at W', hint: 'Stop briefly', durationMs: 2000 },
      { label: 'Pan W → N', hint: 'Complete the loop', durationMs: 6000 },
      { label: 'Settle at start', hint: 'Hold final direction', durationMs: 6000 },
    ],
  },
  'roll-stress': {
    name: 'roll-stress',
    description: 'Roll and pitch the phone while maintaining direction. Tests sensor-fusion robustness.',
    phases: [
      { label: 'Hold upright N', hint: 'β≈90°, γ≈0°', durationMs: 5000 },
      { label: 'Roll left (γ → -45°)', hint: 'Tilt phone left, keep aimed N', durationMs: 4000 },
      { label: 'Return upright N', hint: 'γ → 0°', durationMs: 4000 },
      { label: 'Roll right (γ → +45°)', hint: 'Tilt phone right, keep aimed N', durationMs: 4000 },
      { label: 'Return upright N', hint: 'γ → 0°', durationMs: 4000 },
      { label: 'Pitch up (β → 70°)', hint: 'Aim phone up', durationMs: 4000 },
      { label: 'Return upright N', hint: 'β → 90°', durationMs: 4000 },
    ],
  },
  'real-walk': {
    name: 'real-walk',
    description: 'Natural arm motion + walking + direction-pointing. Realistic AR use.',
    phases: [
      { label: 'Stand still, point N', hint: 'Just hold', durationMs: 5000 },
      { label: 'Walk forward 3 steps', hint: 'Natural arm motion', durationMs: 5000 },
      { label: 'Stop, point N again', hint: 'Settle and hold', durationMs: 5000 },
      { label: 'Turn 90° right, walk', hint: 'Walk and turn', durationMs: 5000 },
      { label: 'Stop, point in walking direction', hint: 'Hold', durationMs: 5000 },
      { label: 'Look around', hint: 'Move phone naturally', durationMs: 5000 },
    ],
  },
};
const choreography: Choreography | null = (() => {
  const c = new URLSearchParams(location.search).get('choreography');
  return c ? (CHOREOGRAPHIES[c] ?? null) : null;
})();

const els = {
  gate: document.getElementById('gate') as HTMLDivElement,
  proceed: document.getElementById('proceed') as HTMLButtonElement,
  video: document.getElementById('video') as HTMLVideoElement,
  overlay: document.getElementById('overlay') as HTMLCanvasElement,
  buildPill: document.getElementById('build-pill') as HTMLDivElement,
  reloadBtn: document.getElementById('reload-btn') as HTMLButtonElement,
  captureHost: document.getElementById('capture-host') as HTMLDivElement,
  status: document.getElementById('status') as HTMLDivElement,
};

// diagSession is declared later (after this line in source order). The build pill
// gets updated again immediately after diagSession is initialized — see below.
els.buildPill.textContent = `build ${__BUILD_ID__}  fov ${fov}°  algo:${algoId}`;

els.reloadBtn.onclick = () => {
  const u = new URL(location.href);
  u.searchParams.set('_cb', Date.now().toString(36));
  location.replace(u.toString());
};

// Device-side diagnostics: every status change + key event POSTs to /api/diag,
// so the agent can see real-time what's happening on the user's device — even
// if the page later freezes and the on-screen status stops updating.
const diagSession = 'calib' + Math.random().toString(36).slice(2, 8);
console.log(`[calibrator] diag session: ${diagSession}`);
const diagBuffer: Array<{ t: number; tag: string; msg: string; data?: unknown }> = [];
const diagStart = performance.now();
let diagFlushTimer: number | null = null;
function diagFlush() {
  diagFlushTimer = null;
  if (diagBuffer.length === 0) return;
  const batch = diagBuffer.splice(0);
  const body = JSON.stringify(batch);
  // Bring-your-own-backend: events were already rendered to the on-screen panel in
  // diag(); only send over the network if a backend is configured. With none (the
  // v0.5 default) we drain the buffer and stop here — the tool never phones home.
  if (!hasBackend()) return;
  const diagUrl = `${BACKEND_BASE}/api/diag?session=${diagSession}`;
  // Prefer sendBeacon (designed for telemetry; survives navigation/freeze).
  // Fallback to fetch.
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      const ok = navigator.sendBeacon(diagUrl, blob);
      if (ok) return;
    }
  } catch { /* fall through */ }
  fetch(diagUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    keepalive: true,
  }).catch(() => { /* swallow */ });
}
function diag(tag: string, msg: string, data?: unknown) {
  const t = (performance.now() - diagStart) / 1000;
  diagBuffer.push({ t, tag, msg, data });
  // FALLBACK: also append to on-screen panel so the user can read it directly
  // if the agent can't fetch (network down, R2 issue, anything else).
  try {
    const panel = document.getElementById('gate-diag');
    if (panel) {
      const cls = tag === 'window' ? 'err'
        : tag.startsWith('chain') ? 'ok'
        : tag === 'heartbeat' ? 'info'
        : tag === 'env' ? 'meta'
        : 'tick';
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = `[${t.toFixed(2)}s] ${tag} · ${msg}`;
      panel.appendChild(line);
      panel.scrollTop = panel.scrollHeight;
    }
  } catch { /* never let diag throw */ }
  // 1500ms debounce matches cv-diag (which loads OpenCV successfully on iPhone
  // Chrome in 4s). Frequent flushes mean frequent fetch/sendBeacon which competes
  // with WASM compile on the main thread.
  if (!diagFlushTimer) diagFlushTimer = window.setTimeout(diagFlush, 1500);
}
window.addEventListener('pagehide', () => diagFlush());
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') diagFlush(); });
window.addEventListener('error', (e) => { diag('window', `ERROR ${e.message}`, { filename: e.filename, lineno: e.lineno }); diagFlush(); });
window.addEventListener('unhandledrejection', (e) => { diag('window', `UNHANDLED ${String(e.reason).slice(0, 200)}`); diagFlush(); });
diag('boot', `algo=${(() => { try { return new URLSearchParams(location.search).get('algo'); } catch { return null; } })()} ua=${navigator.userAgent}`);
// Rich environment dump so the agent knows the device's capabilities/constraints
// even if the page later hangs before tap.
(() => {
  try {
    const env: Record<string, unknown> = {
      platform: navigator.platform,
      cores: navigator.hardwareConcurrency,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      wasm: typeof WebAssembly,
      worker: typeof Worker,
      sendBeacon: typeof navigator.sendBeacon,
      mediaRecorder: typeof MediaRecorder,
      getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
      deviceMemoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    };
    const conn = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
    if (conn) env.connection = `${conn.effectiveType} ${conn.downlink}Mbps ${conn.rtt}ms`;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (mem) env.jsHeapUsedMB = (mem.usedJSHeapSize / 1e6).toFixed(1);
    if (mem) env.jsHeapLimitMB = (mem.jsHeapSizeLimit / 1e6).toFixed(1);
    if (typeof MediaRecorder !== 'undefined') {
      const codecs = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'];
      env.mrSupports = codecs.filter((c) => MediaRecorder.isTypeSupported?.(c)).join(',');
    }
    diag('env', JSON.stringify(env));
  } catch (e) {
    diag('env', `error gathering env: ${e}`);
  }
})();
// Force an immediate flush on boot so the agent sees the session ASAP.
diagFlush();

// === iOS Chrome cv-load workaround (PR #8, verified via stages 1-31) ===
// On iPhone Chrome 148, the OpenCV.js WASM init poisons setTimeout AND
// Promise resolution at the moment cv.Mat becomes constructible. Caller
// MUST register a synchronous callback (onCvReady) — NEVER await a Promise.
// We kick the preload at module init so cv is ready by tap time.
type CvModule = Parameters<Parameters<typeof cvLib.onCvReady>[0]>[0];
let lkCvModule: CvModule | null = null;
if (algoId === 'visual-inertial-cv') {
  cvLib.onCvProgress((ev) => { diag('cv-preload', ev.message); });
  cvLib.startCvPreload();
  cvLib.onCvReady((cv) => {
    lkCvModule = cv;
    diag('cv-preload', 'PRELOAD DONE — lkCvModule set');
  });
  cvLib.onCvError((e) => { diag('cv-preload', `PRELOAD ERROR: ${e.message}`); });
}
// Append diag session id to the build pill now that diagSession exists.
els.buildPill.textContent = `${els.buildPill.textContent}  diag:${diagSession}`;

function setStatus(msg: string | null, progressPct?: number) {
  diag('status', msg ?? '<hide>', progressPct != null ? { pct: progressPct } : undefined);
  const text = document.getElementById('status-text');
  const bar = document.getElementById('loader-bar');
  const fill = bar?.firstElementChild as HTMLElement | null;
  if (!msg) { els.status.hidden = true; if (bar) bar.hidden = true; return; }
  els.status.hidden = false;
  if (text) text.textContent = msg;
  else els.status.textContent = msg;
  if (bar && fill) {
    if (typeof progressPct === 'number') {
      bar.hidden = false;
      fill.style.width = `${Math.max(0, Math.min(100, progressPct * 100)).toFixed(1)}%`;
    } else {
      bar.hidden = true;
    }
  }
}

function onMotion(e: DeviceMotionEvent) {
  const g = e.accelerationIncludingGravity;
  if (g) state.gravity = { x: g.x ?? 0, y: g.y ?? 0, z: g.z ?? 0 };
  const r = e.rotationRate;
  if (r) {
    // iOS rotationRate fields are degrees per second (W3C spec). Empirically the
    // gamma-axis sign is flipped vs our right-hand-rule convention — verified by
    // negating-and-comparing against compass deltas at upright moments (offline harness).
    const ra = (r.alpha ?? 0) * Math.PI / 180;
    const rb = (r.beta  ?? 0) * Math.PI / 180;
    const rg = -(r.gamma ?? 0) * Math.PI / 180;
    const magDegps = Math.sqrt(
      (r.alpha ?? 0) ** 2 + (r.beta ?? 0) ** 2 + (r.gamma ?? 0) ** 2,
    );
    state.rotationRate = { ra, rb, rg, magDegps };
  }
}

function onOrientation(e: DeviceOrientationEvent) {
  state.alpha = e.alpha;
  state.beta = e.beta;
  state.gamma = e.gamma;
  const anyE = e as unknown as { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
  if (typeof anyE.webkitCompassHeading === 'number') state.webkitCompassHeading = anyE.webkitCompassHeading;
  if (typeof anyE.webkitCompassAccuracy === 'number') state.webkitCompassAccuracy = anyE.webkitCompassAccuracy;
}

function onOrientationChange() {
  state.screenOrientation = screen.orientation?.angle ?? 0;
  sizeCanvas();
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = els.overlay.clientWidth;
  const h = els.overlay.clientHeight;
  els.overlay.width = Math.round(w * dpr);
  els.overlay.height = Math.round(h * dpr);
  const ctx = els.overlay.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  els.video.srcObject = stream;
  await els.video.play();
}

// iOS 13+ gates DeviceMotionEvent + DeviceOrientationEvent behind a permission
// prompt that MUST be triggered from a user-gesture handler (a tap). If you
// call requestPermission() from a timer or async-resolved promise that lost
// the user-gesture context, iOS rejects silently and the prompt never appears.
// → call this only from inside an onclick/touchstart handler.
async function requestSensorPermission(): Promise<boolean> {
  // Reference the constructors as window properties, NOT bare globals: on browsers
  // that don't expose them (many desktops, unsupported contexts) a bare reference
  // throws ReferenceError, which would crash the gate instead of falling back to
  // the intended static/no-motion behavior. A missing property is just undefined.
  const w = window as unknown as {
    DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
    DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
  };
  const DME = w.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    const r = await DME.requestPermission();
    if (r !== 'granted') return false;
  }
  const DOE = w.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try { await DOE.requestPermission(); } catch { /* non-fatal */ }
  }
  return true;
}

// --- Camera quaternion from sensor data (LocAR.js / camera-override.ts algorithm) ---
//
// Computes the camera-to-world rotation quaternion in three.js convention
// (right-handed, Y up, camera looks -Z in camera-local frame). Same algorithm
// used by camera-override.ts for AD, so any disagreement we see in the
// calibrator IS the bug AD is suffering from.

type Q = { x: number; y: number; z: number; w: number };
const qScratchA: Q = { x: 0, y: 0, z: 0, w: 1 };
const qScratchB: Q = { x: 0, y: 0, z: 0, w: 1 };
const qScratchC: Q = { x: 0, y: 0, z: 0, w: 1 };
const qScratchD: Q = { x: 0, y: 0, z: 0, w: 1 };

function setAxisAngle(q: Q, ax: number, ay: number, az: number, angle: number) {
  const half = angle / 2;
  const s = Math.sin(half);
  q.x = ax * s; q.y = ay * s; q.z = az * s; q.w = Math.cos(half);
}
function qMul(out: Q, a: Q, b: Q) {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}
function qCopy(out: Q, src: Q) { out.x = src.x; out.y = src.y; out.z = src.z; out.w = src.w; }

// Rotate a vector by the INVERSE of a quaternion (world-to-camera direction).
// For unit quaternion, inverse = conjugate.
function rotateByQuatInverse(out: { x: number; y: number; z: number }, q: Q, vx: number, vy: number, vz: number) {
  // v_local = q^-1 * v * q  (when q is camera-to-world). Conjugate of unit q is (-x,-y,-z,w).
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  // t = 2 * (qxyz × v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // out = v + qw * t + qxyz × t
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
}

// Method 1: iOS DeviceOrientation Euler with gamma compensation.
// alpha = (360 - compass - gamma)·deg, then standard YXZ Euler composition.
// Good in normal poses, breaks down at β=90° gimbal lock during pure roll
// (because iOS distributes the roll between alpha and gamma non-physically).
function computeCameraQuatEulerGamma(out: Q): boolean {
  if (state.beta == null || state.gamma == null) return false;
  const betaRad  = state.beta  * Math.PI / 180;
  const gammaRad = state.gamma * Math.PI / 180;
  let alphaRad: number;
  if (state.webkitCompassHeading != null) {
    alphaRad = (360 - state.webkitCompassHeading - state.gamma) * Math.PI / 180;
  } else if (state.alpha != null) {
    alphaRad = state.alpha * Math.PI / 180;
  } else {
    return false;
  }
  setAxisAngle(qScratchA, 0, 1, 0, alphaRad);
  setAxisAngle(qScratchB, 1, 0, 0, betaRad);
  setAxisAngle(qScratchC, 0, 0, 1, -gammaRad);
  qMul(qScratchD, qScratchA, qScratchB);
  qMul(out, qScratchD, qScratchC);
  setAxisAngle(qScratchA, 1, 0, 0, -Math.PI / 2);
  qMul(qScratchD, out, qScratchA);
  qCopy(out, qScratchD);
  const orientRad = (state.screenOrientation ?? 0) * Math.PI / 180;
  if (orientRad !== 0) {
    setAxisAngle(qScratchA, 0, 0, 1, -orientRad);
    qMul(qScratchD, out, qScratchA);
    qCopy(out, qScratchD);
  }
  return true;
}

// Method 2: gravity-vector attitude + compass yaw (skip iOS Euler entirely).
// Avoids the β=90° gimbal lock issue at the cost of being more sensitive to
// gravity vector noise. Algorithm:
//   1. world UP in phone-local = -gravity / |gravity|   (iOS web API: accelIncludingGravity
//      is the GRAVITY vector itself pointing DOWN; verified empirically)
//   2. project phone +Y onto plane perpendicular to up → horizontal direction
//      that iOS compass references. Fallback to projecting phone -Z if degenerate.
//   3. rotate that projection by +compass around up → world-north in phone-local
//   4. east_in_phone = north × up   (world: +X east, +Y up, -Z north → right-handed)
//   5. Build rotation matrix P2W with rows = (E_p, U_p, S_p=-N_p)
//   6. Convert to quaternion, apply screen-orientation correction
function computeCameraQuatGravityCompass(out: Q): boolean {
  const g = state.gravity;
  if (g == null) return false;
  const gmag = Math.hypot(g.x, g.y, g.z);
  if (gmag < 0.1) return false;
  if (state.webkitCompassHeading == null) return false;

  const ux = -g.x / gmag, uy = -g.y / gmag, uz = -g.z / gmag;

  const pyDotU = uy;
  let px = -pyDotU * ux;
  let py = 1 - pyDotU * uy;
  let pz = -pyDotU * uz;
  let pmag = Math.hypot(px, py, pz);
  let perpX: number, perpY: number, perpZ: number;
  if (pmag < 0.05) {
    const pzDotU = -uz;
    const qx = 0 - pzDotU * ux;
    const qy = 0 - pzDotU * uy;
    const qz = -1 - pzDotU * uz;
    const qmag = Math.hypot(qx, qy, qz);
    if (qmag < 0.05) return false;
    perpX = qx / qmag; perpY = qy / qmag; perpZ = qz / qmag;
  } else {
    perpX = px / pmag; perpY = py / pmag; perpZ = pz / pmag;
  }

  const cRad = state.webkitCompassHeading * Math.PI / 180;
  const cosC = Math.cos(cRad), sinC = Math.sin(cRad);
  const kDotV = ux * perpX + uy * perpY + uz * perpZ;
  const kxvX = uy * perpZ - uz * perpY;
  const kxvY = uz * perpX - ux * perpZ;
  const kxvZ = ux * perpY - uy * perpX;
  const nx = perpX * cosC + kxvX * sinC + ux * kDotV * (1 - cosC);
  const ny = perpY * cosC + kxvY * sinC + uy * kDotV * (1 - cosC);
  const nz = perpZ * cosC + kxvZ * sinC + uz * kDotV * (1 - cosC);

  const ex = ny * uz - nz * uy;
  const ey = nz * ux - nx * uz;
  const ez = nx * uy - ny * ux;

  // P2W rows = (E_p, U_p, S_p) where S_p = -N_p.
  const m00 = ex,  m01 = ey,  m02 = ez;
  const m10 = ux,  m11 = uy,  m12 = uz;
  const m20 = -nx, m21 = -ny, m22 = -nz;

  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  out.x = qx; out.y = qy; out.z = qz; out.w = qw;

  const orientRad = (state.screenOrientation ?? 0) * Math.PI / 180;
  if (orientRad !== 0) {
    setAxisAngle(qScratchA, 0, 0, 1, -orientRad);
    qMul(qScratchD, out, qScratchA);
    qCopy(out, qScratchD);
  }
  return true;
}

// Method 3: gravity + gated compass with gyro-integrated yaw carry-through.
// Roll/pitch always from gravity (reliable). Yaw maintained by integrating the
// world-up component of body-frame angular velocity; when compass is in its
// reliable zone (|γ|<15°, accuracy good, motion not too fast) we low-pass-blend
// it into the current yaw. Avoids the iOS compass-flip during high-roll vertical
// pose that breaks both euler-gamma and gravity-compass.
//
// Offline against gyro-anchored truth on the controlled roll captures: this hits
// RMS 5°, max ~13° deviation, vs gravity-compass at RMS 87°, max 144°.
const gatedYawState = {
  yaw: null as number | null,       // current best estimate of phone +Y world heading, radians
  lastT: null as number | null,
  alphaCompass: 0.15,
  gammaThresholdDeg: 15,
  motionRateThresholdDegps: 120,
  accuracyMaxDeg: 25,
};

function compassIsReliable(): boolean {
  const accuracy = state.webkitCompassAccuracy;
  if (accuracy == null || accuracy < 0 || accuracy > gatedYawState.accuracyMaxDeg) return false;
  if (state.gamma == null || Math.abs(state.gamma) > gatedYawState.gammaThresholdDeg) return false;
  if (state.rotationRate == null || state.rotationRate.magDegps > gatedYawState.motionRateThresholdDegps) return false;
  return true;
}

function computeCameraQuatCompassGated(out: Q): boolean {
  const g = state.gravity;
  const r = state.rotationRate;
  if (g == null || r == null || state.webkitCompassHeading == null) return false;
  const gmag = Math.hypot(g.x, g.y, g.z);
  if (gmag < 0.1) return false;

  const ux = -g.x / gmag, uy = -g.y / gmag, uz = -g.z / gmag;

  const now = performance.now() / 1000;
  let dt: number;
  if (gatedYawState.lastT == null) dt = 1 / 60;
  else dt = Math.max(1e-3, Math.min(0.1, now - gatedYawState.lastT));
  gatedYawState.lastT = now;

  // Phone +Y projected onto plane ⊥ world-up (same as gravity-compass), with -Z fallback.
  const pyDotU = uy;
  let px = -pyDotU * ux;
  let py = 1 - pyDotU * uy;
  let pz = -pyDotU * uz;
  let pmag = Math.hypot(px, py, pz);
  let perpX: number, perpY: number, perpZ: number;
  if (pmag < 0.05) {
    const pzDotU = -uz;
    const qx_ = 0 - pzDotU * ux;
    const qy_ = 0 - pzDotU * uy;
    const qz_ = -1 - pzDotU * uz;
    const qmag = Math.hypot(qx_, qy_, qz_);
    if (qmag < 0.05) return false;
    perpX = qx_ / qmag; perpY = qy_ / qmag; perpZ = qz_ / qmag;
  } else {
    perpX = px / pmag; perpY = py / pmag; perpZ = pz / pmag;
  }

  const compassYaw = state.webkitCompassHeading * Math.PI / 180;
  if (gatedYawState.yaw == null) {
    gatedYawState.yaw = compassYaw;
  } else {
    // Integrate body-frame angular velocity projected onto world-up. Uses the shared,
    // camera-validated device axis assignment (ωx=alpha,ωy=beta,ωz=gamma) — the old inline
    // W3C assignment (ωx=beta,ωy=gamma,ωz=alpha) scored ~0 vs camera-truth. See lib/gyro-yaw.ts.
    gatedYawState.yaw += worldUpYawRateCompassCW(r, g) * dt;
    if (compassIsReliable()) {
      let delta = compassYaw - gatedYawState.yaw;
      delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      gatedYawState.yaw += gatedYawState.alphaCompass * delta;
    }
  }

  // Build phone-to-world rotation: north_in_phone = Rodrigues(perp, +yaw, around up).
  const cRad = gatedYawState.yaw;
  const cosC = Math.cos(cRad), sinC = Math.sin(cRad);
  const kDotV = ux * perpX + uy * perpY + uz * perpZ;
  const kxvX = uy * perpZ - uz * perpY;
  const kxvY = uz * perpX - ux * perpZ;
  const kxvZ = ux * perpY - uy * perpX;
  const nx = perpX * cosC + kxvX * sinC + ux * kDotV * (1 - cosC);
  const ny = perpY * cosC + kxvY * sinC + uy * kDotV * (1 - cosC);
  const nz = perpZ * cosC + kxvZ * sinC + uz * kDotV * (1 - cosC);

  const ex = ny * uz - nz * uy;
  const ey = nz * ux - nx * uz;
  const ez = nx * uy - ny * ux;

  const m00 = ex,  m01 = ey,  m02 = ez;
  const m10 = ux,  m11 = uy,  m12 = uz;
  const m20 = -nx, m21 = -ny, m22 = -nz;

  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  out.x = qx; out.y = qy; out.z = qz; out.w = qw;

  const orientRad = (state.screenOrientation ?? 0) * Math.PI / 180;
  if (orientRad !== 0) {
    setAxisAngle(qScratchA, 0, 0, 1, -orientRad);
    qMul(qScratchD, out, qScratchA);
    qCopy(out, qScratchD);
  }
  return true;
}

// Method 4: visual-inertial fusion (compass + optical flow + gyro).
// See header for offline test results. Uses Lucas-Kanade optical flow at ~15Hz
// on a downsampled video canvas.

// LK pipeline state. We downsample the camera video to a small canvas and run
// feature detection + tracking on it. Per-frame results feed visualYawState.
const LK_W = 180, LK_H = 320;
const lkCanvas: HTMLCanvasElement = document.createElement('canvas');
lkCanvas.width = LK_W;
lkCanvas.height = LK_H;
const lkCtx = lkCanvas.getContext('2d', { willReadFrequently: true });

let lkPrevPyr: ReturnType<typeof buildPyramid> | null = null;
let lkFeatures: Array<{ x: number; y: number }> = [];
let lkFramesSinceDetect = 0;
const LK_REDETECT_EVERY = 8;  // re-detect features every N tracked frames

const visualYawState = {
  // Per-frame deltas accumulated since last fusion update.
  cumYawDeg: 0,
  cumGyroDegSinceAnchor: 0,
  cumVisualDegSinceAnchor: 0,
  lastT: null as number | null,
  weight: 0,
  rollRate: 0,
  lastInlierCount: 0,
  lastVisualYawDeg: 0,
  lastResidualPx: 0,
  lastTotalCount: 0,
  // Fused yaw state (radians, compass style: CW from north)
  yaw: null as number | null,
};

const VI_FOV_DEG = DEFAULT_FOV_DEG;  // assumes the calibrator's default; see fov override.

function lkDrawAndGetGray(): Uint8Array | null {
  if (!lkCtx) return null;
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  if (!vw || !vh) return null;
  const targetAspect = LK_W / LK_H;
  const videoAspect = vw / vh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (videoAspect > targetAspect) {
    sw = vh * targetAspect; sx = (vw - sw) / 2;
  } else {
    sh = vw / targetAspect; sy = (vh - sh) / 2;
  }
  lkCtx.drawImage(els.video, sx, sy, sw, sh, 0, 0, LK_W, LK_H);
  const imgData = lkCtx.getImageData(0, 0, LK_W, LK_H);
  return toGray(imgData.data, LK_W, LK_H);
}

function lkApplyFit(fit: { tx: number; rollDeg: number; residualPx: number; inlierCount: number; totalCount: number }) {
  const pxPerDegYaw = LK_W / VI_FOV_DEG;
  const visualYawDeg = -fit.tx / pxPerDegYaw;
  visualYawState.cumYawDeg += visualYawDeg;
  visualYawState.cumVisualDegSinceAnchor += visualYawDeg;
  visualYawState.rollRate = Math.abs(fit.rollDeg);
  visualYawState.lastInlierCount = fit.inlierCount;
  visualYawState.lastVisualYawDeg = visualYawDeg;
  visualYawState.lastResidualPx = fit.residualPx;
  visualYawState.lastTotalCount = fit.totalCount;
  const nOk = Math.min(1, fit.inlierCount / 16);
  const rOk = Math.max(0, 1 - fit.residualPx / 3);
  visualYawState.weight = nOk * rOk;
}

function lkTick() {
  const gray = lkDrawAndGetGray();
  if (gray == null) return;
  const pyr = buildPyramid(gray, LK_W, LK_H);
  if (lkPrevPyr === null || lkFeatures.length < 6 || lkFramesSinceDetect >= LK_REDETECT_EVERY) {
    lkFeatures = detectFeatures(gray, LK_W, LK_H, {
      x0: 0, y0: Math.round(LK_H * 0.18),
      x1: LK_W, y1: Math.round(LK_H * 0.82),
    });
    lkFramesSinceDetect = 0;
  } else {
    const tracks = trackFeatures(lkPrevPyr, pyr, lkFeatures);
    const fit = fitSimilarity(tracks, LK_W / 2, LK_H / 2);
    lkApplyFit(fit);
    lkFeatures = tracks.filter((t) => t.ok).map((t) => ({ x: t.x1, y: t.y1 }));
    lkFramesSinceDetect += 1;
    if (lkFeatures.length < 6) lkFeatures = [];
  }
  lkPrevPyr = pyr;
}

// OpenCV variant. lkCvModule is declared near top of file (see cv-preload block).
// The cv-load module no longer exports loadOpenCV (it returned a Promise that
// iPhone Chrome breaks). We use onCvReady callback instead, set at module init.
let lkCvPrevGray: Uint8Array | null = null;
let lkCvTickN = 0;
let lkCvLastDiagAt = 0;
let lkCvNullModuleLogged = false;
let lkCvNullGrayLogged = false;
let lkCvFirstFitLogged = false;
let lkCvErrorLogged = false;

function lkTickCv() {
  lkCvTickN++;
  if (lkCvModule == null) {
    if (!lkCvNullModuleLogged) { diag('lk-cv', `tick ${lkCvTickN}: lkCvModule is null — skipping (this should resolve when cv-preload completes)`); lkCvNullModuleLogged = true; }
    return;
  }
  const gray = lkDrawAndGetGray();
  if (gray == null) {
    if (!lkCvNullGrayLogged) { diag('lk-cv', `tick ${lkCvTickN}: gray=null — video.videoWidth=${els.video.videoWidth} videoHeight=${els.video.videoHeight}`); lkCvNullGrayLogged = true; }
    return;
  }
  if (lkCvPrevGray !== null) {
    try {
      const fit = cvLib.estimateFlowCv(lkCvModule, lkCvPrevGray, gray, LK_W, LK_H, {
        x0: 0, y0: Math.round(LK_H * 0.18), x1: LK_W, y1: Math.round(LK_H * 0.82),
      });
      lkApplyFit(fit);
      // First fit ever: log full details + a sample of gray pixel values so we
      // can tell if the image is actually useful (high contrast vs uniform).
      if (!lkCvFirstFitLogged) {
        lkCvFirstFitLogged = true;
        const min = Math.min(...gray.slice(0, 1000));
        const max = Math.max(...gray.slice(0, 1000));
        const mean = gray.slice(0, 1000).reduce((a, b) => a + b, 0) / 1000;
        // Also dump available cv module functions so we can see what's actually exported.
        const cvKeys = lkCvModule ? Object.keys(lkCvModule).filter((k) => /(estimate|features|optical|flow|Affine|Similar)/i.test(k)).sort() : [];
        diag('lk-cv', `FIRST FIT tick=${lkCvTickN} gray.len=${gray.length} sample[0..1000] min=${min} max=${max} mean=${mean.toFixed(1)} | fit: tx=${fit.tx.toFixed(2)} rollDeg=${fit.rollDeg.toFixed(2)} totalCount=${fit.totalCount} inlierCount=${fit.inlierCount} residualPx=${fit.residualPx.toFixed(1)}`);
        diag('lk-cv', `cv exports (estimate/affine/etc): ${cvKeys.join(', ')}`);
      }
      // Throttled ongoing diag: every ~1.5s. Lets us see the distribution of
      // totalCount/inlierCount over the capture.
      const now = performance.now();
      if (now - lkCvLastDiagAt > 1500) {
        lkCvLastDiagAt = now;
        diag('lk-cv', `tick=${lkCvTickN} fit: tx=${fit.tx.toFixed(2)} totalCount=${fit.totalCount} inlierCount=${fit.inlierCount} residualPx=${fit.residualPx.toFixed(1)}`);
      }
    } catch (e) {
      console.warn('[calibrator] OpenCV LK error', e);
      if (!lkCvErrorLogged) {
        lkCvErrorLogged = true;
        diag('lk-cv', `THREW tick=${lkCvTickN}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  lkCvPrevGray = gray;
}

let lkRaf: number | null = null;
function startLk() {
  diag('lk', `startLk algoId=${algoId}`);
  if (lkRaf != null) { diag('lk', 'already running'); return; }
  let lastTick = 0;
  const TICK_INTERVAL_MS = 66;  // ~15 Hz
  const useCv = algoId === 'visual-inertial-cv';
  const loop = (t: number) => {
    if (t - lastTick >= TICK_INTERVAL_MS) {
      try { if (useCv) lkTickCv(); else lkTick(); } catch (e) { console.warn('[calibrator] LK tick error', e); }
      lastTick = t;
    }
    lkRaf = requestAnimationFrame(loop);
  };
  lkRaf = requestAnimationFrame(loop);
}

function computeCameraQuatVisualInertial(out: Q): boolean {
  const g = state.gravity;
  const r = state.rotationRate;
  if (g == null || r == null || state.webkitCompassHeading == null) return false;
  const gmag = Math.hypot(g.x, g.y, g.z);
  if (gmag < 0.1) return false;
  const ux = -g.x / gmag, uy = -g.y / gmag, uz = -g.z / gmag;

  const now = performance.now() / 1000;
  let dt: number;
  if (visualYawState.lastT == null) dt = 1 / 60;
  else dt = Math.max(1e-3, Math.min(0.1, now - visualYawState.lastT));
  visualYawState.lastT = now;

  // Phone +Y projected onto horizontal plane, with -Z fallback (same as the
  // gravity-compass algorithm — gravity gives us roll/pitch perfectly).
  const pyDotU = uy;
  let px = -pyDotU * ux;
  let py = 1 - pyDotU * uy;
  let pz = -pyDotU * uz;
  let pmag = Math.hypot(px, py, pz);
  let perpX: number, perpY: number, perpZ: number;
  if (pmag < 0.05) {
    const pzDotU = -uz;
    const qx_ = 0 - pzDotU * ux;
    const qy_ = 0 - pzDotU * uy;
    const qz_ = -1 - pzDotU * uz;
    const qmag = Math.hypot(qx_, qy_, qz_);
    if (qmag < 0.05) return false;
    perpX = qx_ / qmag; perpY = qy_ / qmag; perpZ = qz_ / qmag;
  } else {
    perpX = px / pmag; perpY = py / pmag; perpZ = pz / pmag;
  }

  // Yaw integration via gyro (always).
  const compassYaw = state.webkitCompassHeading * Math.PI / 180;
  if (visualYawState.yaw == null) {
    visualYawState.yaw = compassYaw;
  } else {
    // Shared camera-validated device axis assignment (ωx=alpha,ωy=beta,ωz=gamma); the old
    // inline W3C assignment scored ~0 vs camera-truth. See lib/gyro-yaw.ts.
    const yawDelta = worldUpYawRateCompassCW(r, g) * dt;
    visualYawState.yaw += yawDelta;
    visualYawState.cumGyroDegSinceAnchor += yawDelta * 180 / Math.PI;
  }

  // Compass anchor: if compass is reliable, pull yaw toward it strongly. Resets
  // accumulators.
  const accuracy = state.webkitCompassAccuracy ?? -1;
  const motionRate = r.magDegps;
  const compassOk = accuracy >= 0 && accuracy < 25
    && state.gamma != null && Math.abs(state.gamma) < 15
    && motionRate < 100;
  if (compassOk) {
    let delta = compassYaw - visualYawState.yaw;
    delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    visualYawState.yaw += 0.25 * delta;
    visualYawState.cumVisualDegSinceAnchor = 0;
    visualYawState.cumGyroDegSinceAnchor = 0;
  } else if (visualYawState.weight > 0.4 && visualYawState.rollRate < 8 && visualYawState.lastInlierCount > 12) {
    // Visual anchor when compass dead: pull yaw toward the visual cumulative
    // estimate (i.e., correct the gyro drift detected via visual flow).
    const driftDeg = visualYawState.cumVisualDegSinceAnchor - visualYawState.cumGyroDegSinceAnchor;
    visualYawState.yaw += (driftDeg * Math.PI / 180) * 0.15;
    visualYawState.cumVisualDegSinceAnchor = 0;
    visualYawState.cumGyroDegSinceAnchor = 0;
  }

  // Build attitude from (up, perp, yaw).
  const cRad = visualYawState.yaw;
  const cosC = Math.cos(cRad), sinC = Math.sin(cRad);
  const kDotV = ux * perpX + uy * perpY + uz * perpZ;
  const kxvX = uy * perpZ - uz * perpY;
  const kxvY = uz * perpX - ux * perpZ;
  const kxvZ = ux * perpY - uy * perpX;
  const nx = perpX * cosC + kxvX * sinC + ux * kDotV * (1 - cosC);
  const ny = perpY * cosC + kxvY * sinC + uy * kDotV * (1 - cosC);
  const nz = perpZ * cosC + kxvZ * sinC + uz * kDotV * (1 - cosC);
  const ex = ny * uz - nz * uy;
  const ey = nz * ux - nx * uz;
  const ez = nx * uy - ny * ux;

  const m00 = ex,  m01 = ey,  m02 = ez;
  const m10 = ux,  m11 = uy,  m12 = uz;
  const m20 = -nx, m21 = -ny, m22 = -nz;

  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  out.x = qx; out.y = qy; out.z = qz; out.w = qw;

  const orientRad = (state.screenOrientation ?? 0) * Math.PI / 180;
  if (orientRad !== 0) {
    setAxisAngle(qScratchA, 0, 0, 1, -orientRad);
    qMul(qScratchD, out, qScratchA);
    qCopy(out, qScratchD);
  }
  return true;
}

// gyro-locar: the AD-shipped pose path, via the shared golden-tested module. Gyro-only yaw
// (no compass), gravity-stable pitch/roll, LocAR composition. Needs no camera/FOV — so the
// `?fov=` vs DEFAULT_FOV_DEG discrepancy that affects the visual-inertial algos is irrelevant
// here (that fov wiring is a separate, filed bug, intentionally untouched during extraction).
const gyroLocarYawState: YawState = { yaw: null, lastT: null };
function computeCameraQuatGyroLocar(out: Q): boolean {
  // Calibrator-specific guard (NOT in the shared module — AD must stay compass-optional):
  // defer the first rendered frame until we have a real compass seed AND live tilt, so the
  // cardinal rose starts at true north with real pitch/roll instead of a fabricated level
  // pose at heading 0. Once yaw is seeded, integrate gyro-only regardless (the point of
  // gyro-locar). Without this, a motion-before-orientation race permanently mis-seeds north.
  if (state.gravity == null || state.rotationRate == null) return false;
  if (gyroLocarYawState.yaw == null &&
      (state.webkitCompassHeading == null || state.beta == null || state.gamma == null)) {
    return false; // not yet safe to seed; keep showing "Waiting for sensors…"
  }
  return gyroLocarPose(out, {
    gravity: state.gravity,
    rotationRate: state.rotationRate,
    betaDeg: state.beta,
    gammaDeg: state.gamma,
    screenOrientationDeg: state.screenOrientation,
    compassHeadingDeg: state.webkitCompassHeading, // seeds initial heading only
  }, gyroLocarYawState, performance.now() / 1000);
}

function computeCameraQuat(out: Q): boolean {
  if (algoId === 'euler-gamma') return computeCameraQuatEulerGamma(out);
  if (algoId === 'gravity-compass') return computeCameraQuatGravityCompass(out);
  if (algoId === 'compass-gated') return computeCameraQuatCompassGated(out);
  if (algoId === 'gyro-locar') return computeCameraQuatGyroLocar(out);
  // Both visual-inertial and visual-inertial-cv use the same fusion math.
  return computeCameraQuatVisualInertial(out);
}

// World-space cardinal direction unit vectors.
// three.js convention: Y up, camera looks down -Z. After the LocAR.js composition,
// the world frame is: -Z = North, +X = East, +Y = Up.
const CARDINALS = [
  { label: 'N',  color: '#f87171', vec: [ 0, 0, -1] as const, weight: 'major' as const },
  { label: 'E',  color: '#60a5fa', vec: [ 1, 0,  0] as const, weight: 'major' as const },
  { label: 'S',  color: '#a3a3a3', vec: [ 0, 0,  1] as const, weight: 'major' as const },
  { label: 'W',  color: '#60a5fa', vec: [-1, 0,  0] as const, weight: 'major' as const },
  { label: 'NE', color: '#fbbf24', vec: [ 0.7071, 0, -0.7071] as const, weight: 'minor' as const },
  { label: 'SE', color: '#fbbf24', vec: [ 0.7071, 0,  0.7071] as const, weight: 'minor' as const },
  { label: 'SW', color: '#fbbf24', vec: [-0.7071, 0,  0.7071] as const, weight: 'minor' as const },
  { label: 'NW', color: '#fbbf24', vec: [-0.7071, 0, -0.7071] as const, weight: 'minor' as const },
  { label: '↑',  color: '#a3e635', vec: [ 0, 1,  0] as const, weight: 'minor' as const }, // up (sky)
  { label: '↓',  color: '#a3e635', vec: [ 0,-1,  0] as const, weight: 'minor' as const }, // down (ground)
];

// Project a camera-local direction onto the screen via pinhole model.
// cameraDir: unit vector in camera-local frame (camera looks down -Z).
// Returns null if behind camera (z >= 0 in camera-local).
function projectCameraDir(cameraDir: { x: number; y: number; z: number }, w: number, h: number, fovHorizontalDeg: number): { x: number; y: number; behind: boolean } {
  // Camera looks down -Z. In front = z < 0. Behind = z >= 0.
  const halfFovH = (fovHorizontalDeg * Math.PI / 180) / 2;
  const tanH = Math.tan(halfFovH);
  const aspect = h / w;
  const tanV = tanH * aspect;
  const behind = cameraDir.z >= 0;
  // If behind, use edge projection from the opposite-sign vector.
  const useZ = behind ? cameraDir.z : -cameraDir.z;
  const ndcX = cameraDir.x / (useZ * tanH);
  const ndcY = cameraDir.y / (useZ * tanV);
  // ndcX: -1 = left edge, +1 = right edge. ndcY: -1 = bottom (canvas y increases downward), +1 = top.
  const screenX = w / 2 + ndcX * (w / 2);
  const screenY = h / 2 - ndcY * (h / 2);
  return { x: screenX, y: screenY, behind };
}

const _cameraDir = { x: 0, y: 0, z: 0 };
const _cameraQuat: Q = { x: 0, y: 0, z: 0, w: 1 };

function drawOverlay() {
  const ctx = els.overlay.getContext('2d');
  if (!ctx) return;
  const w = els.overlay.clientWidth;
  const h = els.overlay.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const compass = state.webkitCompassHeading;
  const accuracy = state.webkitCompassAccuracy;

  // --- Compass accuracy badge ---
  const accColor = accuracy == null ? '#f87171'
    : accuracy < 15 ? '#4ade80'
    : accuracy < 30 ? '#facc15'
    : '#f87171';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(w - 130, 56, 120, 22);
  ctx.fillStyle = accColor;
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`compass ±${accuracy == null ? '??' : Math.round(accuracy)}°`, w - 124, 71);

  // --- Forward crosshair (always shown) ---
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 12, 0, Math.PI * 2);
  ctx.moveTo(w / 2 - 18, h / 2); ctx.lineTo(w / 2 - 6, h / 2);
  ctx.moveTo(w / 2 + 6,  h / 2); ctx.lineTo(w / 2 + 18, h / 2);
  ctx.moveTo(w / 2, h / 2 - 18); ctx.lineTo(w / 2, h / 2 - 6);
  ctx.moveTo(w / 2, h / 2 + 6);  ctx.lineTo(w / 2, h / 2 + 18);
  ctx.stroke();

  if (!computeCameraQuat(_cameraQuat)) {
    ctx.fillStyle = '#fca5a5';
    ctx.font = '14px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for sensors…', w / 2, h - 36);
    return;
  }

  // --- Horizon line: world up vector (0,1,0) projected through camera quaternion ---
  // The horizon is the great circle perpendicular to world up. Draw it as the line
  // where the world XZ plane intersects the view. Sample horizon points at several
  // bearings, project, draw connecting line if both endpoints in front.
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  let horizonPrev: { x: number; y: number; behind: boolean } | null = null;
  const horizonSegments = 120;
  let horizonStarted = false;
  for (let i = 0; i <= horizonSegments; i++) {
    const theta = (i / horizonSegments) * 2 * Math.PI;
    rotateByQuatInverse(_cameraDir, _cameraQuat, Math.sin(theta), 0, -Math.cos(theta));
    const p = projectCameraDir(_cameraDir, w, h, fov);
    if (!p.behind && horizonPrev && !horizonPrev.behind) {
      if (horizonStarted) ctx.lineTo(p.x, p.y);
      else { ctx.moveTo(horizonPrev.x, horizonPrev.y); ctx.lineTo(p.x, p.y); horizonStarted = true; }
    } else {
      horizonStarted = false;
    }
    horizonPrev = p;
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // --- Cardinal direction labels ---
  for (const c of CARDINALS) {
    rotateByQuatInverse(_cameraDir, _cameraQuat, c.vec[0], c.vec[1], c.vec[2]);
    const p = projectCameraDir(_cameraDir, w, h, fov);
    const isMajor = c.weight === 'major';
    // Off-screen: clamp to edge, draw arrow indicator.
    const margin = 28;
    const onScreen = !p.behind && p.x >= -margin && p.x <= w + margin && p.y >= -margin && p.y <= h + margin;
    let drawX = p.x;
    let drawY = p.y;
    if (!onScreen) {
      // Clamp to viewport with margin.
      if (p.behind) {
        // Mirror to back of screen indicator
        drawX = w / 2 - (p.x - w / 2);
        drawY = h - 60;
      }
      drawX = Math.max(margin, Math.min(w - margin, drawX));
      drawY = Math.max(margin, Math.min(h - margin, drawY));
    }
    const labelSize = isMajor ? 36 : 22;
    ctx.fillStyle = c.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = isMajor ? 4 : 3;
    ctx.font = `bold ${labelSize}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = onScreen ? 1.0 : 0.55;
    ctx.strokeText(c.label, drawX, drawY);
    ctx.fillText(c.label, drawX, drawY);
    if (isMajor && onScreen) {
      // Tick line below label
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(drawX, drawY + labelSize / 2 + 4);
      ctx.lineTo(drawX, drawY + labelSize / 2 + 18);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }

  // --- Readout (bottom center) ---
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(w / 2 - 110, h - 32, 220, 22);
  ctx.fillStyle = '#e5e5e5';
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  const compassStr = compass == null ? '?' : Math.round(compass).toString();
  const betaStr = state.beta == null ? '?' : Math.round(state.beta).toString();
  const gammaStr = state.gamma == null ? '?' : Math.round(state.gamma).toString();
  ctx.fillText(`cmp ${compassStr}°  β ${betaStr}°  γ ${gammaStr}°  fov ${fov}°`, w / 2, h - 17);
}

function loop() {
  drawOverlay();
  requestAnimationFrame(loop);
}

// ---- Capture button: 30s capture of sensor + camera frames → POST /api/recording → clipboard ----

const CHOREO_DURATION_MS = choreography ? choreography.phases.reduce((s, p) => s + p.durationMs, 0) : 0;
const DURATION_MS = choreography ? CHOREO_DURATION_MS : 30_000;
const KEYFRAME_INTERVAL_MS = 2_000;
const KEYFRAME_MAX_DIM = 640;
const KEYFRAME_JPEG_QUALITY = 0.7;
// Continuous composite-video recording — camera frame with overlay drawn on top,
// at ~24 fps to a small canvas, encoded via MediaRecorder. Lets the agent see
// the actual marker motion at full temporal resolution, not just keyframes.
const COMPVIDEO_W = 360;
const COMPVIDEO_H = 640;
const COMPVIDEO_FPS = 24;
const COMPVIDEO_BITRATE = 900_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function showToast(
  payload: { id?: string; size_bytes?: number; duration_s?: number; error?: string },
  ok: boolean,
  downloads?: LocalDownload[],
) {
  let toast = document.querySelector('.capture-toast') as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'capture-toast';
    document.body.appendChild(toast);
  }
  toast.hidden = false;
  toast.classList.toggle('error', !ok);
  // Build via textContent + createElement (never innerHTML) — the values are ours,
  // but routing text through textContent and links through DOM nodes is the habit
  // worth copying.
  toast.textContent = '';
  const msg = document.createElement('div');
  const hasDownloads = !!downloads && downloads.length > 0;
  if (payload.error) {
    msg.textContent = `Capture failed: ${payload.error}`;
  } else if (hasDownloads) {
    msg.textContent = `Captured ${payload.id} (${payload.duration_s}s, ${formatBytes(payload.size_bytes ?? 0)}) — saved locally. Tap to download:`;
  } else {
    msg.textContent = `Captured ${payload.id} (${payload.duration_s}s, ${formatBytes(payload.size_bytes ?? 0)}) — copied. Paste into Claude.`;
  }
  toast.appendChild(msg);
  if (downloads) {
    for (const d of downloads) {
      const a = document.createElement('a');
      a.className = 'capture-download';
      a.href = d.url;
      a.download = d.filename;
      a.textContent = `⬇ ${d.filename}`;
      toast.appendChild(a);
    }
  }
  // Auto-hide only when there's nothing to tap; keep download links on screen.
  if (!hasDownloads) setTimeout(() => { if (toast) toast.hidden = true; }, 8000);
}

function mountCaptureBtn() {
  const btn = document.createElement('button');
  btn.className = 'capture-btn';
  btn.textContent = '📷';
  btn.title = 'Capture 30s of sensor + camera for Claude';
  els.captureHost.appendChild(btn);

  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.classList.add('recording');
    diag('capture', `tapped — starting ${(DURATION_MS / 1000).toFixed(0)}s capture${choreography ? ` (choreography=${choreography.name})` : ''}`);

    const samples: Array<Record<string, unknown>> = [];
    const keyframes: Array<{ t: number; dataUrl: string; w: number; h: number }> = [];
    const overlayStates: Array<{ t: number; state: SensorState }> = [];
    const marks: Array<{ t: number; label: string }> = [];
    const phasesRecorded: Array<{ label: string; hint: string; startMs: number; endMs: number }> = [];
    const start = performance.now();

    // === Choreography driver ===
    // Steps through phases at their declared durations. Updates the HUD and
    // records phase start/end so offline analysis can align per-phase signals.
    let phaseIdx = 0;
    let phaseStartMs = 0;
    let choreoTimer: number | null = null;
    const choreoHud = document.getElementById('choreo-hud') as HTMLDivElement | null;
    const choreoLabel = document.getElementById('choreo-label') as HTMLDivElement | null;
    const choreoHint = document.getElementById('choreo-hint') as HTMLDivElement | null;
    const choreoCountdown = document.getElementById('choreo-countdown') as HTMLDivElement | null;
    function tickChoreo() {
      if (!choreography || phaseIdx >= choreography.phases.length) return;
      const p = choreography.phases[phaseIdx];
      const elapsed = (performance.now() - start) - phaseStartMs;
      const remaining = Math.max(0, p.durationMs - elapsed);
      if (choreoCountdown) choreoCountdown.textContent = `${Math.ceil(remaining / 1000)}s`;
      if (remaining <= 0) {
        phasesRecorded.push({ label: p.label, hint: p.hint, startMs: phaseStartMs, endMs: phaseStartMs + p.durationMs });
        diag('choreo', `phase ${phaseIdx + 1}/${choreography.phases.length} done: ${p.label}`);
        phaseIdx++;
        if (phaseIdx >= choreography.phases.length) {
          if (choreoHud) choreoHud.classList.add('done');
          if (choreoLabel) choreoLabel.textContent = 'Done';
          if (choreoHint) choreoHint.textContent = 'You can stop moving now.';
          if (choreoCountdown) choreoCountdown.textContent = '';
          return;
        }
        phaseStartMs = performance.now() - start;
        const next = choreography.phases[phaseIdx];
        if (choreoLabel) choreoLabel.textContent = `${phaseIdx + 1}/${choreography.phases.length}: ${next.label}`;
        if (choreoHint) choreoHint.textContent = next.hint;
      }
      choreoTimer = window.setTimeout(tickChoreo, 100);
    }
    if (choreography && choreoHud) {
      choreoHud.style.display = '';
      const p0 = choreography.phases[0];
      if (choreoLabel) choreoLabel.textContent = `1/${choreography.phases.length}: ${p0.label}`;
      if (choreoHint) choreoHint.textContent = p0.hint;
      if (choreoCountdown) choreoCountdown.textContent = `${Math.ceil(p0.durationMs / 1000)}s`;
      choreoTimer = window.setTimeout(tickChoreo, 100);
      diag('choreo', `start: ${choreography.name} — ${choreography.phases.length} phases, total ${(DURATION_MS / 1000).toFixed(0)}s`);
    }

    // === Mark-moment button ===
    // Tappable during capture to drop annotations into the recording.
    const markBtn = document.createElement('button');
    markBtn.className = 'mark-btn';
    markBtn.textContent = '🚩';
    markBtn.title = 'Mark this moment';
    els.captureHost.appendChild(markBtn);
    markBtn.onclick = (e) => {
      e.stopPropagation();
      const t = performance.now() - start;
      marks.push({ t, label: 'mark' });
      diag('mark', `at ${(t / 1000).toFixed(2)}s`);
      markBtn.classList.add('flash');
      setTimeout(() => markBtn.classList.remove('flash'), 300);
    };

    const onMotionCapture = (e: DeviceMotionEvent) => {
      samples.push({
        t: performance.now() - start,
        kind: 'm',
        accG: e.accelerationIncludingGravity && { x: e.accelerationIncludingGravity.x, y: e.accelerationIncludingGravity.y, z: e.accelerationIncludingGravity.z },
        acc: e.acceleration && { x: e.acceleration.x, y: e.acceleration.y, z: e.acceleration.z },
        rot: e.rotationRate && { a: e.rotationRate.alpha, b: e.rotationRate.beta, g: e.rotationRate.gamma },
        interval: e.interval,
      });
    };
    const onOrientationCapture = (e: DeviceOrientationEvent) => {
      const anyE = e as unknown as { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
      samples.push({
        t: performance.now() - start,
        kind: 'o',
        alpha: e.alpha,
        beta: e.beta,
        gamma: e.gamma,
        absolute: e.absolute,
        webkitCompassHeading: anyE.webkitCompassHeading,
        webkitCompassAccuracy: anyE.webkitCompassAccuracy,
      });
    };
    window.addEventListener('devicemotion', onMotionCapture);
    window.addEventListener('deviceorientation', onOrientationCapture);

    // ---- Continuous composite-video recording ----
    // Compose camera + overlay onto a small canvas every animation frame and
    // record the resulting stream via MediaRecorder. The agent uses this to see
    // exactly what the user saw at ~24fps, which keyframes-every-2s cannot show.
    const compCanvas = document.createElement('canvas');
    compCanvas.width = COMPVIDEO_W;
    compCanvas.height = COMPVIDEO_H;
    const compCtx = compCanvas.getContext('2d');
    let composeRaf: number | null = null;
    let mediaRecorder: MediaRecorder | null = null;
    let mediaChunks: Blob[] = [];
    let mediaMimeType = 'video/webm';
    const compose = () => {
      if (compCtx && els.video.videoWidth && els.video.videoHeight) {
        // Mirror the on-screen object-fit:cover behavior — crop the video to
        // composite-canvas aspect ratio, scale to fill.
        const vw = els.video.videoWidth, vh = els.video.videoHeight;
        const targetAspect = COMPVIDEO_W / COMPVIDEO_H;
        const videoAspect = vw / vh;
        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (videoAspect > targetAspect) {
          sw = vh * targetAspect; sx = (vw - sw) / 2;
        } else {
          sh = vw / targetAspect; sy = (vh - sh) / 2;
        }
        compCtx.drawImage(els.video, sx, sy, sw, sh, 0, 0, COMPVIDEO_W, COMPVIDEO_H);
        try { compCtx.drawImage(els.overlay, 0, 0, COMPVIDEO_W, COMPVIDEO_H); } catch {}
      }
      composeRaf = requestAnimationFrame(compose);
    };
    composeRaf = requestAnimationFrame(compose);
    try {
      // canvas.captureStream is non-standard but supported on iOS 14.5+. Pick the
      // best mime type available on this device. iOS Safari prefers mp4/avc1;
      // other browsers usually give us webm/vp9 or webm/vp8.
      const candidates = [
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const supported = candidates.find((mt) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mt));
      if (supported) mediaMimeType = supported;
      diag('capture', `MediaRecorder mime=${mediaMimeType} (supported=${supported ?? 'NONE — using fallback'})`);
      const stream = (compCanvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(COMPVIDEO_FPS);
      mediaRecorder = new MediaRecorder(stream, { mimeType: mediaMimeType, videoBitsPerSecond: COMPVIDEO_BITRATE });
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) mediaChunks.push(e.data); };
      mediaRecorder.onerror = (e) => diag('capture', `MediaRecorder ERROR: ${(e as unknown as { error?: { message?: string } }).error?.message ?? String(e)}`);
      mediaRecorder.start(1000);
      diag('capture', `MediaRecorder started (${COMPVIDEO_W}x${COMPVIDEO_H}@${COMPVIDEO_FPS}fps, ${COMPVIDEO_BITRATE}bps)`);
    } catch (e) {
      console.warn('[calibrator] MediaRecorder unavailable; capture will be sensor-only:', e);
      diag('capture', `MediaRecorder unavailable: ${e instanceof Error ? e.message : String(e)}`);
      mediaRecorder = null;
    }

    // Snapshot of current overlay/state every 250ms. Includes visualYawState
    // diagnostics so the agent can verify the live LK pipeline behaves like the
    // offline OpenCV reference.
    const stateTimer = window.setInterval(() => {
      const snap: Record<string, unknown> = { ...state, gravity: state.gravity ? { ...state.gravity } : null };
      if (algoId === 'visual-inertial' || algoId === 'visual-inertial-cv') {
        snap.visualInertial = {
          yawDeg: visualYawState.yaw == null ? null : (visualYawState.yaw * 180 / Math.PI + 360) % 360,
          cumYawDeg: visualYawState.cumYawDeg,
          cumGyroSinceAnchor: visualYawState.cumGyroDegSinceAnchor,
          cumVisualSinceAnchor: visualYawState.cumVisualDegSinceAnchor,
          lastVisualYawDeg: visualYawState.lastVisualYawDeg,
          rollRate: visualYawState.rollRate,
          weight: visualYawState.weight,
          inlierCount: visualYawState.lastInlierCount,
          totalCount: visualYawState.lastTotalCount,
          residualPx: visualYawState.lastResidualPx,
        };
      }
      if (algoId === 'gyro-locar') {
        snap.gyroLocar = {
          yawDeg: gyroLocarYawState.yaw == null ? null : (gyroLocarYawState.yaw * 180 / Math.PI + 360) % 360,
          seeded: gyroLocarYawState.yaw != null,
        };
      }
      overlayStates.push({ t: performance.now() - start, state: snap as unknown as SensorState });
    }, 250);

    // Camera keyframes. We composite the canvas overlay onto the video frame so
    // the agent sees exactly what the user saw on-screen (overlay + camera, not
    // just raw camera). Match the video's "object-fit: cover" by computing the
    // crop and target geometry the same way the browser does.
    const keyCanvas = document.createElement('canvas');
    const captureKey = () => {
      const vw = els.video.videoWidth;
      const vh = els.video.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.min(1, KEYFRAME_MAX_DIM / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      keyCanvas.width = w;
      keyCanvas.height = h;
      const ctx = keyCanvas.getContext('2d');
      if (!ctx) return;
      // 1) draw video
      ctx.drawImage(els.video, 0, 0, w, h);
      // 2) composite the overlay canvas on top, stretched to fill the keyframe.
      //    drawImage(canvas, dx, dy, dw, dh) reads the FULL backing-store of the
      //    source canvas (not CSS pixel coords). The backing is dpr*clientWidth
      //    wide; using clientWidth as a source rect would extract only the top-
      //    left 1/dpr corner. Use the 5-arg form to draw the whole source.
      try {
        ctx.drawImage(els.overlay, 0, 0, w, h);
      } catch (e) { /* tainted canvas etc — fall back to video-only */ }
      keyframes.push({ t: performance.now() - start, dataUrl: keyCanvas.toDataURL('image/jpeg', KEYFRAME_JPEG_QUALITY), w, h });
    };
    setTimeout(captureKey, 100);
    const kfTimer = window.setInterval(captureKey, KEYFRAME_INTERVAL_MS);

    const labelTimer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((DURATION_MS - (performance.now() - start)) / 1000));
      btn.textContent = `${remaining}s`;
    }, 500);

    // Pause-on-background: if the page goes hidden, the JS timer keeps running
    // but sensor events stop firing → recording silently has gaps + an inflated
    // duration. Abort the capture cleanly using the moment-of-hide as the true
    // end time, so the saved duration matches what was actually captured.
    let abortedAt = 0;
    const onHide = () => {
      if (document.visibilityState === 'hidden' && abortedAt === 0) abortedAt = performance.now();
    };
    document.addEventListener('visibilitychange', onHide);

    await new Promise<void>((resolve) => {
      const tick = () => {
        if (abortedAt > 0 || performance.now() - start >= DURATION_MS) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
    document.removeEventListener('visibilitychange', onHide);
    const trueEnd = abortedAt > 0 ? abortedAt : performance.now();
    const trueDurationMs = trueEnd - start;

    window.removeEventListener('devicemotion', onMotionCapture);
    window.removeEventListener('deviceorientation', onOrientationCapture);
    window.clearInterval(stateTimer);
    window.clearInterval(kfTimer);
    window.clearInterval(labelTimer);
    if (choreoTimer != null) clearTimeout(choreoTimer);
    if (composeRaf != null) cancelAnimationFrame(composeRaf);
    if (markBtn.parentElement) markBtn.parentElement.removeChild(markBtn);
    if (choreography && choreoHud) choreoHud.style.display = 'none';
    // If choreography ended mid-phase (aborted), record the partial phase.
    if (choreography && phaseIdx < choreography.phases.length) {
      const p = choreography.phases[phaseIdx];
      phasesRecorded.push({ label: p.label + ' (partial)', hint: p.hint, startMs: phaseStartMs, endMs: trueDurationMs });
    }
    btn.textContent = 'UPL';
    diag('capture', `recording ended: durationMs=${trueDurationMs.toFixed(0)} samples=${samples.length} states=${overlayStates.length} kfs=${keyframes.length} mediaChunks=${mediaChunks.length} marks=${marks.length} phases=${phasesRecorded.length} aborted=${abortedAt > 0}`);

    // Finalize video blob (if any) before serializing the JSON.
    let videoBlob: Blob | null = null;
    let videoExt = 'webm';
    if (mediaRecorder) {
      diag('capture', `stopping MediaRecorder (state=${mediaRecorder.state})`);
      await new Promise<void>((resolve) => {
        mediaRecorder!.onstop = () => resolve();
        try { mediaRecorder!.stop(); } catch (e) { diag('capture', `MediaRecorder.stop() threw: ${e instanceof Error ? e.message : String(e)}`); resolve(); }
      });
      diag('capture', `MediaRecorder stopped (final chunks=${mediaChunks.length})`);
      if (mediaChunks.length > 0) {
        videoBlob = new Blob(mediaChunks, { type: mediaMimeType });
        videoExt = mediaMimeType.includes('mp4') ? 'mp4' : 'webm';
        diag('capture', `videoBlob ready: ${videoBlob.size} bytes, mime=${mediaMimeType}, ext=${videoExt}`);
      } else {
        diag('capture', 'NO video chunks produced — videoBlob will be null');
      }
    } else {
      diag('capture', 'no MediaRecorder — videoBlob will be null (sensor-only)');
    }

    // Trim samples/states/keyframes recorded after the abort moment (they would
    // be from after the page became visible again, not part of this capture).
    const trimmedSamples = abortedAt > 0 ? samples.filter((s) => (s.t as number) <= trueDurationMs + 50) : samples;
    const trimmedStates  = abortedAt > 0 ? overlayStates.filter((s) => s.t <= trueDurationMs + 50) : overlayStates;
    const trimmedKfs     = abortedAt > 0 ? keyframes.filter((k) => k.t <= trueDurationMs + 50) : keyframes;

    const file = {
      schemaVersion: '0.2' as const,
      source: 'calibrator',
      buildId: __BUILD_ID__,
      startedAt: new Date(Date.now() - (performance.now() - start)).toISOString(),
      durationMs: trueDurationMs,
      url: location.href,
      userAgent: navigator.userAgent,
      screenOrientation: screen.orientation ? { angle: screen.orientation.angle, type: screen.orientation.type } : null,
      fovHorizontalDeg: fov,
      compVideo: videoBlob ? {
        mimeType: mediaMimeType,
        ext: videoExt,
        fps: COMPVIDEO_FPS,
        width: COMPVIDEO_W,
        height: COMPVIDEO_H,
        sizeBytes: videoBlob.size,
        // Video frame t=0 corresponds to sensor sample t=0 within ~1 frame.
        syncOffsetMs: 0,
      } : null,
      samples: trimmedSamples,
      overlayStates: trimmedStates,
      keyframes: trimmedKfs,
      marks,
      choreography: choreography ? { name: choreography.name, description: choreography.description, phases: phasesRecorded } : null,
      notes: abortedAt > 0 ? 'aborted on visibilitychange (page backgrounded)' : '',
    };

    // Stringify upfront so we can log size + detect serialization errors separately
    // from network errors. JSON.stringify on a huge object can throw on iOS if memory tight.
    let jsonBody: string;
    try {
      jsonBody = JSON.stringify(file);
      diag('capture', `JSON serialized: ${jsonBody.length} bytes`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diag('capture', `JSON.stringify FAILED: ${msg}`);
      showToast({ error: `JSON.stringify: ${msg}` }, false);
      busy = false; btn.disabled = false; btn.classList.remove('recording'); btn.textContent = '📷';
      return;
    }

    try {
      let result: { id: string; size_bytes: number; duration_s: number; ts: string };
      let videoSizeBytes = 0;
      let videoUploadError: string | null = null;
      let localDownloads: LocalDownload[] | undefined;

      if (hasBackend()) {
        diag('capture', `POST ${BACKEND_BASE}/api/recording starting (body=${jsonBody.length} bytes)`);
        const uploadStart = performance.now();
        const res = await fetch(`${BACKEND_BASE}/api/recording`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: jsonBody,
        });
        diag('capture', `POST /api/recording responded: status=${res.status} ok=${res.ok} in ${((performance.now() - uploadStart) / 1000).toFixed(2)}s`);
        if (!res.ok) {
          const text = await res.text().catch((err) => `<response body read failed: ${err}>`);
          diag('capture', `JSON upload FAILED body: ${text.slice(0, 500)}`);
          throw new Error(`upload ${res.status}: ${text.slice(0, 200)}`);
        }
        result = (await res.json()) as { id: string; size_bytes: number; duration_s: number; ts: string };
        diag('capture', `JSON upload OK: id=${result.id} size=${result.size_bytes} duration=${result.duration_s}s`);
        // Upload the composite video (if any) keyed to the same recording id.
        if (videoBlob) {
          btn.textContent = 'VID';
          const vUrl = `${BACKEND_BASE}/api/recording?video=${encodeURIComponent(result.id)}`;
          diag('capture', `POST ${vUrl} starting (videoBlob=${videoBlob.size} bytes, mime=${mediaMimeType})`);
          const vStart = performance.now();
          try {
            const vres = await fetch(vUrl, {
              method: 'POST',
              headers: { 'Content-Type': mediaMimeType },
              body: videoBlob,
            });
            diag('capture', `POST video responded: status=${vres.status} ok=${vres.ok} in ${((performance.now() - vStart) / 1000).toFixed(2)}s`);
            if (vres.ok) {
              const vjson = (await vres.json()) as { video_size_bytes?: number };
              videoSizeBytes = vjson.video_size_bytes ?? videoBlob.size;
              diag('capture', `video upload OK: ${videoSizeBytes} bytes`);
            } else {
              const vtext = await vres.text().catch((err) => `<response body read failed: ${err}>`);
              videoUploadError = `${vres.status}: ${vtext.slice(0, 200)}`;
              diag('capture', `video upload FAILED body: ${vtext.slice(0, 500)}`);
              console.warn('[calibrator] video upload failed:', vres.status, vtext);
            }
          } catch (e) {
            videoUploadError = e instanceof Error ? e.message : String(e);
            diag('capture', `video upload THREW: ${videoUploadError}`);
            console.warn('[calibrator] video upload error:', e);
          }
        } else {
          diag('capture', 'no videoBlob — skipping video upload');
        }
      } else {
        // BYO-backend default: no endpoint configured → save locally, touch no storage.
        const local = saveRecordingLocally(jsonBody, file.durationMs, videoBlob, videoExt);
        result = local.result;
        localDownloads = local.downloads;
        if (videoBlob) videoSizeBytes = videoBlob.size;
        diag('capture', `LOCAL save (no backend): id=${result.id} json=${formatBytes(result.size_bytes)}${videoBlob ? ` + ${formatBytes(videoBlob.size)} video` : ''}`);
      }

      diagFlush();  // when a backend exists, ensure the above lands before clipboard/toast
      const sizeStr = videoSizeBytes > 0
        ? `${formatBytes(result.size_bytes)} sensors + ${formatBytes(videoSizeBytes)} video`
        : formatBytes(result.size_bytes);
      const clipText =
        `Recording ${result.id} — ${result.duration_s}s, ${sizeStr}, captured ${result.ts}.\n` +
        `Source: AR calibrator (fov=${fov}°).\nURL: ${location.href}\n` +
        (hasBackend() ? 'Send to Claude to analyze.' : 'Saved to your device (no backend configured).');
      try {
        await navigator.clipboard.writeText(clipText);
        diag('capture', `clipboard write OK (${clipText.length} chars)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        diag('capture', `clipboard write FAILED: ${msg}`);
        console.warn('[calibrator] clipboard write failed:', e);
      }
      diag('capture', `DONE: id=${result.id}${videoUploadError ? ` (video upload failed: ${videoUploadError})` : ''}`);
      diagFlush();
      showToast({ ...result, size_bytes: result.size_bytes + videoSizeBytes }, true, localDownloads);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error && e.stack ? e.stack.slice(0, 500) : '';
      diag('capture', `UPLOAD FAILED — msg: ${msg}`);
      if (stack) diag('capture', `stack: ${stack}`);
      diagFlush();
      showToast({ error: msg }, false);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.classList.remove('recording');
      btn.textContent = '📷';
      diagFlush();
    }
  };
}

els.proceed.onclick = async () => {
  diag('gate', 'proceed tapped');
  els.proceed.disabled = true;
  els.proceed.textContent = 'Starting…';
  try {
    // STAGED CHAIN — each step posts to diag so we can see exactly which one
    // hangs/breaks. Designed for bisecting OpenCV.js's "hangs in calibrator"
    // failure: load OpenCV first (in quiet context), then add components one
    // at a time, confirming each before starting the next.
    if (algoId === 'visual-inertial-cv' && lkCvModule == null) {
      // Preload was started at module init. If lkCvModule is STILL null at
      // gate-tap, the user tapped before cv finished loading (rare — cv is
      // typically ready in ~2s). We can't await: iPhone Chrome's setTimeout/
      // Promise-resolution dies at the WASM-init moment (stages 28/30 hung).
      // Instead, show status and let onCvReady write lkCvModule when ready;
      // proceed with the rest of the chain immediately. The LK-CV loop checks
      // lkCvModule != null per-frame, so it'll start tracking once cv arrives.
      diag('chain', '1a/cv: cv not yet ready at tap; proceeding (LK-CV will start when cv arrives)');
      setStatus('OpenCV loading in background…');
    }

    diag('chain', '2: requesting motion permission…');
    const motionOk = await requestSensorPermission();
    diag('chain', `2: motionOk=${motionOk}`);
    if (!motionOk) setStatus('Motion permission denied; overlay will be static.');

    diag('chain', '3: starting camera…');
    await startCamera();
    diag('chain', '3: camera started');

    diag('chain', '4: showing canvas…');
    els.gate.hidden = true;
    sizeCanvas();
    diag('chain', '4: canvas sized');

    diag('chain', '5: attaching sensor listeners…');
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('orientationchange', onOrientationChange);
    window.addEventListener('resize', sizeCanvas);
    screen.orientation?.addEventListener?.('change', onOrientationChange);
    diag('chain', '5: sensors attached');

    diag('chain', '6: mounting capture button…');
    mountCaptureBtn();
    diag('chain', '6: capture mounted');

    if (algoId === 'visual-inertial' || algoId === 'visual-inertial-cv') {
      diag('chain', '7: starting LK loop…');
      startLk();
      diag('chain', '7: LK started');
    }

    diag('chain', '8: starting overlay rAF loop');
    requestAnimationFrame(loop);
    diag('chain', '8: rAF scheduled');
  } catch (e) {
    setStatus(`Could not start camera: ${e instanceof Error ? e.message : String(e)}`);
    els.proceed.disabled = false;
    els.proceed.textContent = 'Tap to begin';
  }
};
