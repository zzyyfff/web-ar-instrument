// cv-stage19: same logic as lucas-kanade-cv.ts startCvPreload — but the helper
// function is LOCAL to this file. Module-level state lets too. Tests whether
// the cross-module boundary is the issue vs the code structure itself.

const session = 'cv19' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const logEl = document.getElementById('log') as HTMLDivElement | null;

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
  if (logEl) {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = `[${tSec.toFixed(2)}s] ${msg}`;
    logEl.appendChild(div);
  }
};
line('tick', `Stage19: local function w/ startCvPreload logic + module-level lets`);

// === Local module-level state — same shape as lucas-kanade-cv.ts ===
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
type CvMod = { Mat: new () => { rows: number; delete: () => void } };
type CvWindow = { Module?: { onRuntimeInitialized?: () => void }; cv?: CvMod & { Mat?: unknown } };

let setupDone = false;
let resolvedCv: CvMod | null = null;
let rejectedErr: Error | null = null;
const readyCallbacks: Array<(cv: CvMod) => void> = [];
const errorCallbacks: Array<(e: Error) => void> = [];

function notifyReady(cv: CvMod) {
  if (resolvedCv || rejectedErr) return;
  resolvedCv = cv;
  const cbs = readyCallbacks.splice(0);
  for (const cb of cbs) cb(cv);
}
function notifyError(msg: string) {
  if (resolvedCv || rejectedErr) return;
  rejectedErr = new Error(msg);
  const cbs = errorCallbacks.splice(0);
  for (const cb of cbs) cb(rejectedErr);
}

function startCvPreload(): Promise<CvMod> {
  if (!setupDone) {
    setupDone = true;
    const w = window as unknown as CvWindow;
    const tStart = performance.now();
    w.Module = { onRuntimeInitialized: () => { if (w.cv && w.cv.Mat) notifyReady(w.cv as CvMod); } };
    const s = document.createElement('script');
    s.src = OPENCV_URL;
    s.onload = () => {
      line('ok', `<script> onload at +${((performance.now() - tStart) / 1000).toFixed(2)}s. cv=${typeof w.cv}, cv.Mat=${typeof w.cv?.Mat}`);
      if (w.cv && w.cv.Mat) notifyReady(w.cv as CvMod);
    };
    s.onerror = () => notifyError('script load failed');
    document.head.appendChild(s);
    const poll = setInterval(() => {
      if (resolvedCv || rejectedErr) { clearInterval(poll); return; }
      const cv = w.cv;
      if (cv && cv.Mat) { clearInterval(poll); notifyReady(cv as CvMod); return; }
      const keys = cv ? Object.keys(cv).length : 0;
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }, 2000);
    setTimeout(() => { if (!resolvedCv && !rejectedErr) { clearInterval(poll); notifyError('timeout'); } }, 30_000);
  }
  if (resolvedCv) return Promise.resolve(resolvedCv);
  if (rejectedErr) return Promise.reject(rejectedErr);
  return new Promise<CvMod>((resolve, reject) => {
    readyCallbacks.push(resolve);
    errorCallbacks.push(reject);
  });
}

const t1 = performance.now();
startCvPreload().then((cv) => {
  const m = new cv.Mat();
  line('ok', `STAGE19 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(2)}s, rows=${m.rows}`);
  m.delete();
  verdict.className = 'ok'; verdict.textContent = `✓ STAGE19 PASSED`;
}).catch((e) => {
  line('err', `STAGE19 FAIL: ${(e as Error).message}`);
  verdict.className = 'err'; verdict.textContent = `✗ FAIL`;
});

setTimeout(() => {
  if (verdict.className !== 'ok') { verdict.className = 'err'; verdict.textContent = `✗ TIMEOUT`; line('err', 'STAGE19 TIMEOUT'); }
}, 30_000);
