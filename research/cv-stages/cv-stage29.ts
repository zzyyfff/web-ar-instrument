// cv-stage29: inline cv-load IIFE that ONLY writes to a module-level let.
// NO callback registry. NO Promise resolver connected to cv-load. An async
// caller polls the module-level let via setTimeout. If this passes on iPhone,
// this is the fix architecture.

const session = 'cv29' + Math.random().toString(36).slice(2, 8);
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
line('tick', `Stage29: cv-load writes to module let only; async caller polls`);

type CvMod = { Mat: new () => { rows: number; delete: () => void } };
let cvReady: CvMod | null = null;
let cvErr: Error | null = null;

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
  s.onerror = (e) => { line('err', `<script> onerror: ${e}`); cvErr = new Error('script onerror'); };
  document.head.appendChild(s);

  const poll = setInterval(() => {
    const cv = w.cv;
    if (cv && cv.Mat) {
      clearInterval(poll);
      cvReady = cv as CvMod;
      line('ok', `cv-load: cvReady set at +${((performance.now() - t1) / 1000).toFixed(2)}s`);
    } else {
      const keys = cv ? Object.keys(cv).length : 0;
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }
  }, 2000);

  setTimeout(() => {
    if (!cvReady) { clearInterval(poll); cvErr = new Error('cv-load timeout'); line('err', 'cv-load TIMEOUT'); }
  }, 30_000);
})();

async function pollUntilCvReady(): Promise<CvMod> {
  while (!cvReady && !cvErr) {
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  if (cvErr) throw cvErr;
  return cvReady!;
}

(async () => {
  const t2 = performance.now();
  try {
    const cv = await pollUntilCvReady();
    const m = new cv.Mat();
    line('ok', `STAGE29 PASSED: cv.Mat via poll at +${((performance.now() - t2) / 1000).toFixed(2)}s. rows=${m.rows}`);
    m.delete();
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE29 PASSED`;
  } catch (e) {
    line('err', `STAGE29 FAIL: ${(e as Error).message}`);
    verdict.className = 'err'; verdict.textContent = `✗ FAIL`;
  }
})();

setTimeout(() => {
  if (verdict.className !== 'ok') {
    verdict.className = 'err'; verdict.textContent = `✗ STAGE29 TIMEOUT`;
    line('err', 'STAGE29 outer timeout 35s');
  }
}, 35_000);
