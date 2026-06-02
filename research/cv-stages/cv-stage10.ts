// cv-stage10: PRELOAD OpenCV at module init (before user tap). Hypothesis:
// iOS Chrome suspends the page ~2s after a user gesture if heavy WASM compile
// is in flight. By starting cv load at page-load (no gesture), we sidestep
// the suspension and cv.Mat is ready by the time user taps.

import * as cvLib from './lib/lucas-kanade-cv';

const session = 'cv10' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;
const preloadBanner = document.getElementById('preload-banner') as HTMLDivElement;
const waitBanner = document.getElementById('wait-banner') as HTMLDivElement;
const countdown = document.getElementById('countdown') as HTMLDivElement;

const t0 = performance.now();
const diagUrl = `${location.origin}/api/diag?session=${session}`;

// Worker code: posts diag entries reliably.
const workerCode = `
  const DIAG_URL = ${JSON.stringify(diagUrl)};
  const buffer = [];
  setInterval(async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      await fetch(DIAG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
    } catch (e) {
      buffer.unshift(...batch);
    }
  }, 200);
  self.onmessage = (ev) => {
    if (ev.data && ev.data.type === 'log') buffer.push(ev.data.entry);
  };
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
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage10: preload OpenCV at module init (no user gesture yet)`);

// === Preload OpenCV NOW, at module init, no user gesture in flight. ===
const preloadStart = performance.now();
let preloadedCv: unknown = null;
let preloadError: string | null = null;
let preloadDoneAt: number | null = null;

const TEST_DURATION_S = 90;
function setDone(label: string) {
  waitBanner.classList.add('done');
  waitBanner.firstChild!.textContent = label;
  countdown.textContent = '— OK to close —';
}

cvLib.loadOpenCV((ev) => {
  line('tick', `preload: ${ev.message}`);
}).then((cv) => {
  preloadedCv = cv;
  preloadDoneAt = performance.now();
  const dt = ((preloadDoneAt - preloadStart) / 1000).toFixed(2);
  line('ok', `PRELOAD COMPLETE at +${dt}s (BEFORE any tap)`);
  preloadBanner.style.background = '#064e3b';
  preloadBanner.style.color = '#4ade80';
  preloadBanner.textContent = `✓ OpenCV preloaded in ${dt}s — tap when ready`;
  goBtn.disabled = false;
  goBtn.textContent = 'Tap to verify';
}).catch((e) => {
  preloadError = (e as Error).message;
  line('err', `PRELOAD FAILED: ${preloadError}`);
  preloadBanner.style.background = '#7f1d1d';
  preloadBanner.style.color = '#fca5a5';
  preloadBanner.textContent = `✗ Preload failed: ${preloadError}`;
  goBtn.disabled = false;
  goBtn.textContent = 'Tap to see error';
});

goBtn.addEventListener('click', () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Verifying…';
  verdict.style.display = '';
  waitBanner.style.display = '';

  const tapAt = performance.now();
  const cdTick = () => {
    const elapsed = (performance.now() - tapAt) / 1000;
    const remaining = Math.max(0, TEST_DURATION_S - elapsed);
    countdown.textContent = `${remaining.toFixed(0)}s remaining`;
  };
  cdTick();
  const cdInterval = setInterval(cdTick, 500);

  line('tick', `Tap received. Checking preloaded cv…`);

  if (preloadError) {
    line('err', `STAGE10 FAIL: preload had failed earlier (${preloadError})`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE10 PRELOAD FAIL`;
    setDone('✗ FAILED — OK to close');
    clearInterval(cdInterval);
    return;
  }

  if (!preloadedCv) {
    line('err', `STAGE10 FAIL: preload not done by tap time — but tap was enabled?`);
    verdict.className = 'err';
    verdict.textContent = `✗ unexpected state`;
    setDone('✗ FAILED — OK to close');
    clearInterval(cdInterval);
    return;
  }

  try {
    const m = new (preloadedCv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
    const total = ((performance.now() - tapAt) / 1000).toFixed(3);
    line('ok', `STAGE10 PASSED: cv.Mat constructible at +${total}s post-tap (preload done at +${preloadDoneAt ? ((preloadDoneAt - preloadStart) / 1000).toFixed(2) : '?'}s post-page-load). rows=${m.rows}`);
    m.delete();
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE10 PASSED — preload works`;
    setDone('✓ DONE — OK to close');
    clearInterval(cdInterval);
  } catch (e) {
    line('err', `STAGE10 FAIL: ${(e as Error).message}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE10 FAIL`;
    setDone('✗ FAILED — OK to close');
    clearInterval(cdInterval);
  }
});
