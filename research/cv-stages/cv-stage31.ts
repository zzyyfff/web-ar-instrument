// cv-stage31: inline cv-load + synchronous callback registry. NO setTimeout
// polling, NO async/await in the cv-load completion path. When cv-load
// setInterval detects cv.Mat, it invokes registered callbacks SYNCHRONOUSLY.

const session = 'cv31' + Math.random().toString(36).slice(2, 8);
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
line('tick', `Stage31: cv-load + sync callback registry. NO setTimeout polling.`);

type CvMod = { Mat: new () => { rows: number; delete: () => void } };

// Callback registry. Callbacks are invoked SYNCHRONOUSLY from the cv-load
// setInterval when cv.Mat is detected.
const cvReadyCbs: Array<(cv: CvMod) => void> = [];
let cvReadyValue: CvMod | null = null;

// Caller-facing: register a callback. If cv already loaded, invoked synchronously
// in the next microtask via queueMicrotask? No — let's invoke SYNCHRONOUSLY here
// too to keep iPhone Chrome happy.
function onCvReady(cb: (cv: CvMod) => void) {
  if (cvReadyValue) cb(cvReadyValue);
  else cvReadyCbs.push(cb);
}

// === IIFE inline cv-load — stage 11 pattern ===
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
    line('ok', `<script> onload at +${((performance.now() - t1) / 1000).toFixed(2)}s. cv.Mat=${typeof w.cv?.Mat}`);
  };
  s.onerror = (e) => line('err', `<script> onerror: ${e}`);
  document.head.appendChild(s);

  const poll = setInterval(() => {
    const cv = w.cv;
    if (cv && cv.Mat) {
      clearInterval(poll);
      cvReadyValue = cv as CvMod;
      line('ok', `cv-load: cvReady set at +${((performance.now() - t1) / 1000).toFixed(2)}s`);
      // Drain callbacks SYNCHRONOUSLY in this same setInterval tick.
      const cbs = cvReadyCbs.splice(0);
      line('tick', `cv-load: draining ${cbs.length} callbacks`);
      for (const cb of cbs) {
        try { cb(cvReadyValue); } catch (e) { line('err', `cb threw: ${(e as Error).message}`); }
      }
    } else {
      const keys = cv ? Object.keys(cv).length : 0;
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }
  }, 2000);
})();

// === Caller: register callback at module init. Will be invoked synchronously
// from the cv-load setInterval. ===
onCvReady((cv) => {
  line('ok', `onCvReady callback fired SYNCHRONOUSLY`);
  try {
    const m = new cv.Mat();
    line('ok', `STAGE31 PASSED: cv.Mat constructed. rows=${m.rows}`);
    m.delete();
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE31 PASSED`;
  } catch (e) {
    line('err', `STAGE31 FAIL: ${(e as Error).message}`);
    verdict.className = 'err'; verdict.textContent = `✗ FAIL`;
  }
});

setTimeout(() => {
  if (verdict.className !== 'ok') {
    verdict.className = 'err'; verdict.textContent = `✗ STAGE31 TIMEOUT`;
    line('err', 'STAGE31 TIMEOUT 30s');
  }
}, 30_000);
