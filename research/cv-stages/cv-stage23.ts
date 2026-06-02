// cv-stage23: stage 11's working pattern wrapped in IIFE. Single-variable test:
// does putting the script-tag setup inside a function break it?

const session = 'cv23' + Math.random().toString(36).slice(2, 8);
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
line('tick', `Stage23: stage 18 + idle pending Promise (never resolves)`);

// THE TEST: dangling Promise + .then() that never fires. Tests whether ANY
// pending Promise is enough to break WASM init, or whether the resolving-via-
// cv-load is what matters.
const idleP = new Promise<void>(() => { /* never resolve */ });
idleP.then(() => { line('tick', 'idle resolved'); });
void idleP;

// THE IIFE: same code as stage 11 — known to work without Promise.
(function setupCv() {
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
        line('ok', `STAGE23 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(2)}s. rows=${m.rows}, keys=${keys}`);
        m.delete();
        verdict.className = 'ok';
        verdict.textContent = `✓ STAGE23 PASSED`;
      } catch (e) {
        line('err', `STAGE23 FAIL: ${(e as Error).message}`);
        verdict.className = 'err'; verdict.textContent = `✗ FAIL`;
      }
    } else {
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }
  }, 2000);

  setTimeout(() => {
    if (verdict.className !== 'ok') {
      clearInterval(poll);
      verdict.className = 'err'; verdict.textContent = `✗ STAGE23 TIMEOUT`;
      line('err', 'STAGE23 TIMEOUT 30s');
    }
  }, 30_000);
})();
