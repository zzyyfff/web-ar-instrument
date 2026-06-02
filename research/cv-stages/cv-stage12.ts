// cv-stage12: stage 11 + ONE addition — import lucas-kanade.ts.
// Tests whether merely importing the LK module breaks WASM init on iOS Chrome.

// THE ADDITION: import lucas-kanade — evaluates ~300 LOC of constants + function
// declarations at module init. Nothing called; just the import side effect.
import { toGray, buildPyramid, detectFeatures, trackFeatures, fitSimilarity } from './lib/lucas-kanade';
// Reference the imports so esbuild doesn't tree-shake them away.
void [toGray, buildPyramid, detectFeatures, trackFeatures, fitSimilarity];

const session = 'cv12' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;

const t0 = performance.now();
const diagUrl = `${location.origin}/api/diag?session=${session}`;

const workerCode = `
  const DIAG_URL = ${JSON.stringify(diagUrl)};
  const buffer = [];
  setInterval(async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      await fetch(DIAG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
    } catch (e) { buffer.unshift(...batch); }
  }, 200);
  self.onmessage = (ev) => { if (ev.data && ev.data.type === 'log') buffer.push(ev.data.entry); };
`;
const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));

const line = (cls: string, msg: string) => {
  const tSec = (performance.now() - t0) / 1000;
  worker.postMessage({ type: 'log', entry: { t: tSec, cls, msg } });
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${tSec.toFixed(2)}s] ${msg}`;
  log.appendChild(div);
  while (log.children.length > 100) log.firstChild && log.removeChild(log.firstChild);
};

window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `Stage12: stage 11 + import lucas-kanade.ts (300 LOC)`);

// === INLINE cv-load — IDENTICAL to stage 11 ===
const URL_CV = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const t1 = performance.now();
type W = { Module?: { onRuntimeInitialized?: () => void }; cv?: { Mat?: new () => { rows: number; delete: () => void } } };
const w = window as unknown as W;

w.Module = {
  onRuntimeInitialized: () => {
    line('ok', `Module.onRuntimeInitialized at +${((performance.now() - t1) / 1000).toFixed(2)}s`);
  },
};

const s = document.createElement('script');
s.src = URL_CV;
s.onload = () => {
  line('ok', `<script> onload at +${((performance.now() - t1) / 1000).toFixed(2)}s. cv=${typeof w.cv}, cv.Mat=${typeof w.cv?.Mat}`);
};
s.onerror = (e) => line('err', `<script> onerror: ${e}`);
document.head.appendChild(s);

const poll = setInterval(() => {
  const cv = w.cv;
  const keys = cv ? Object.keys(cv).length : 0;
  if (cv && cv.Mat) {
    clearInterval(poll);
    try {
      const m = new cv.Mat();
      line('ok', `STAGE12 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(2)}s. rows=${m.rows}, keys=${keys}`);
      m.delete();
      verdict.className = 'ok';
      verdict.textContent = `✓ STAGE12 PASSED`;
    } catch (e) {
      line('err', `STAGE12 FAIL: ${(e as Error).message}`);
      verdict.className = 'err';
      verdict.textContent = `✗ STAGE12 FAIL`;
    }
  } else {
    line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
  }
}, 2000);

setTimeout(() => {
  if (verdict.className !== 'ok') {
    clearInterval(poll);
    line('err', `STAGE12 TIMEOUT at 30s`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE12 TIMEOUT`;
  }
}, 30_000);
