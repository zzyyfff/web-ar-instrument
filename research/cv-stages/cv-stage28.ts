// cv-stage28: inline cv-load + module-level callback registry + a separate
// whenCvReady() function that wraps the registry in a Promise. Tests whether
// the FINAL ARCHITECTURE (no Promise in cv-load path, Promise only at await
// time) works on iPhone Chrome.

const session = 'cv28' + Math.random().toString(36).slice(2, 8);
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
    try { await fetch(DIAG_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) }); }
    catch (e) { buffer.unshift(...batch); }
  }, 200);
  self.onmessage = (ev) => { if (ev.data && ev.data.type === 'log') buffer.push(ev.data.entry); };
`;
const workerInst = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
const line = (cls: string, msg: string) => {
  const tSec = (performance.now() - t0) / 1000;
  workerInst.postMessage({ type: 'log', entry: { t: tSec, cls, msg } });
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${tSec.toFixed(2)}s] ${msg}`;
  log.appendChild(div);
};
line('tick', `Stage28: inline + callback registry + whenCvReady() Promise`);

// === Module-level state: callback registry ===
type CvMod = { Mat: new () => { rows: number; delete: () => void } };
let cvReady: CvMod | null = null;
const cvWaitCbs: Array<(cv: CvMod) => void> = [];

// === IIFE inline cv-load — stage 11 pattern that PASSES on iPhone ===
(function setupCv() {
  const URL_CV = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
  const t1 = performance.now();
  type W = { Module?: { onRuntimeInitialized?: () => void }; cv?: CvMod & { Mat?: unknown } };
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
    if (cv && cv.Mat) {
      clearInterval(poll);
      cvReady = cv as CvMod;
      // Drain registered callbacks — these may be Promise resolvers stored
      // by whenCvReady() called from another async function.
      const cbs = cvWaitCbs.splice(0);
      for (const cb of cbs) cb(cvReady);
    } else {
      const keys = cv ? Object.keys(cv).length : 0;
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }
  }, 2000);

  setTimeout(() => {
    if (!cvReady) {
      clearInterval(poll);
      line('err', 'STAGE28 cv-load TIMEOUT 30s');
    }
  }, 30_000);
})();

// === Caller-side: whenCvReady() creates a Promise that resolves via the registry. ===
function whenCvReady(): Promise<CvMod> {
  if (cvReady) return Promise.resolve(cvReady);
  return new Promise((resolve) => {
    cvWaitCbs.push(resolve);
  });
}

// === Async caller that awaits cv. This is how the calibrator's gate handler
// would consume cv. The await happens AT MODULE INIT (immediately) — same
// timing as the cv-load — to stress-test the worst case.
(async () => {
  const t2 = performance.now();
  try {
    const cv = await whenCvReady();
    const m = new cv.Mat();
    line('ok', `STAGE28 PASSED: cv.Mat via whenCvReady at +${((performance.now() - t2) / 1000).toFixed(2)}s. rows=${m.rows}`);
    m.delete();
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE28 PASSED`;
  } catch (e) {
    line('err', `STAGE28 FAIL: ${(e as Error).message}`);
    verdict.className = 'err'; verdict.textContent = `✗ FAIL`;
  }
})();

setTimeout(() => {
  if (verdict.className !== 'ok') {
    verdict.className = 'err'; verdict.textContent = `✗ STAGE28 TIMEOUT`;
    line('err', 'STAGE28 outer timeout 35s');
  }
}, 35_000);
