// cv-stage7: diagnostic — three independent timing primitives during cv load.
// Goal: determine WHY the cv-load setInterval stops firing after script.onload.
// If main-thread setInterval and rAF stop but worker heartbeat continues, the
// main thread is blocked by WASM compile. If everything stops, the page is
// suspended. If main-thread setInterval stops but rAF continues, setInterval
// is throttled (or vice versa).

import * as cvLib from './lib/lucas-kanade-cv';

const session = 'cv7' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;

const t0 = performance.now();
const buffer: Array<{ t: number; cls: string; msg: string; data: unknown }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const flush = async () => {
  flushTimer = null;
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  try {
    await fetch(`/api/diag?session=${session}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
  } catch {}
};
// Compact line — only push to buffer, only render every 10th to keep DOM cheap
let renderEveryN = 0;
const line = (cls: string, msg: string, data: unknown = null) => {
  const tSec = (performance.now() - t0) / 1000;
  buffer.push({ t: tSec, cls, msg, data });
  renderEveryN++;
  if (renderEveryN % 10 === 0 || cls === 'ok' || cls === 'err') {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = `[${tSec.toFixed(2)}s] ${msg}`;
    log.appendChild(div);
    // Cap DOM at last 80 lines
    while (log.children.length > 80) log.firstChild && log.removeChild(log.firstChild);
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 500);
};

window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`, { filename: e.filename, lineno: e.lineno }));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage7: heartbeat / rAF / worker timing during cv load`);

// === Worker that posts a heartbeat every 200ms ===
// Workers run on a separate thread, so this timer keeps ticking even if the
// main thread is blocked by WASM compile.
const workerCode = `
  let n = 0;
  const t0 = performance.now();
  setInterval(() => {
    n++;
    self.postMessage({ n, t: (performance.now() - t0) / 1000 });
  }, 200);
`;
const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));
let workerLastN = 0;
worker.onmessage = (ev) => {
  workerLastN = ev.data.n;
};
// Drain worker counts on the main thread — only logs every 5th to keep noise down.
// If main thread is blocked, this onmessage queue backs up; when main thread
// resumes, we see a burst.
let mainSawWorker = 0;
const drainInterval = setInterval(() => {
  if (workerLastN !== mainSawWorker) {
    line('wk', `worker n=${workerLastN} (delta=${workerLastN - mainSawWorker})`);
    mainSawWorker = workerLastN;
  }
}, 200);

goBtn.addEventListener('click', () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Starting…';
  verdict.style.display = '';
  line('tick', `Tap received — starting heartbeat / rAF / cv-load`);

  // === Main-thread setInterval heartbeat at 100ms ===
  let hbN = 0;
  const hb = setInterval(() => {
    hbN++;
    if (hbN % 5 === 0) line('hb', `hb n=${hbN} (interval=100ms)`);
  }, 100);

  // === requestAnimationFrame loop ===
  let rafN = 0;
  let rafFirstLog = performance.now();
  const rafLoop = () => {
    rafN++;
    const now = performance.now();
    if (now - rafFirstLog > 500) {
      line('raf', `raf n=${rafN}`);
      rafFirstLog = now;
    }
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);

  line('tick', `heartbeat + rAF started; now calling cvLib.loadOpenCV…`);

  const t1 = performance.now();
  cvLib.loadOpenCV((ev) => {
    line('tick', `cv: ${ev.message}`);
  }).then((cv) => {
    const m = new (cv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
    line('ok', `STAGE7 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(1)}s. rows=${m.rows}; final hbN=${hbN}, rafN=${rafN}, workerN=${workerLastN}`);
    m.delete();
    clearInterval(hb);
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE7 PASSED`;
    flush();
  }).catch((e) => {
    line('err', `STAGE7 FAIL: ${(e as Error).message}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE7 FAIL`;
    flush();
  });

  // Hard stop diagnostic after 90s
  setTimeout(() => {
    clearInterval(hb);
    clearInterval(drainInterval);
    line('err', `Diagnostic ended at 90s: hbN=${hbN}, rafN=${rafN}, workerN=${workerLastN}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE7 TIMED OUT (90s)`;
    flush();
  }, 90_000);
});
