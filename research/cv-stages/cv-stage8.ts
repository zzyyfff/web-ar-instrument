// cv-stage8: worker-posted diag. The worker buffers all log entries (from both
// itself and the main thread) and POSTs to /api/diag from the worker thread.
// This way, when the main thread is blocked by WASM compile, the worker keeps
// generating its own heartbeat AND keeps flushing — we lose nothing.
//
// The main thread sends each line via postMessage; the worker accumulates and
// flushes every 200ms. The worker also generates its own heartbeat tick.

import * as cvLib from './lib/lucas-kanade-cv';

const session = 'cv8' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;

const t0 = performance.now();

// Worker code: receives entries via postMessage, has its own heartbeat,
// flushes to /api/diag every 200ms. All in a separate thread.
// IMPORTANT: blob-URL workers resolve relative URLs against the blob: scheme,
// so the diag endpoint must be an ABSOLUTE URL captured from the document.
const diagUrl = `${location.origin}/api/diag?session=${session}`;
const workerCode = `
  const DIAG_URL = ${JSON.stringify(diagUrl)};
  const t0 = performance.now();
  const buffer = [];
  let workerN = 0;
  let lastFlushOk = 'never';
  let lastFlushErr = '';

  // Worker's own heartbeat — fires every 200ms, INDEPENDENT of main thread.
  setInterval(() => {
    workerN++;
    buffer.push({
      t: (performance.now() - t0) / 1000,
      cls: 'wk',
      msg: 'worker-tick n=' + workerN,
    });
  }, 200);

  // Flush buffer to /api/diag every 200ms from the worker thread.
  setInterval(async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      const r = await fetch(DIAG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      lastFlushOk = r.status + ' at ' + ((performance.now() - t0) / 1000).toFixed(2) + 's';
    } catch (e) {
      lastFlushErr = String(e).slice(0, 200);
      buffer.unshift(...batch);
    }
  }, 200);

  // Receive entries from main thread.
  self.onmessage = (ev) => {
    if (ev.data && ev.data.type === 'log') {
      buffer.push(ev.data.entry);
    } else if (ev.data && ev.data.type === 'status') {
      self.postMessage({ type: 'status', lastFlushOk, lastFlushErr, bufferLen: buffer.length, workerN });
    }
  };
`;

const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));

// Main-thread line() — pushes to DOM AND sends to worker for posting.
let renderEveryN = 0;
const line = (cls: string, msg: string) => {
  const tSec = (performance.now() - t0) / 1000;
  // Send to worker for reliable POSTing
  worker.postMessage({ type: 'log', entry: { t: tSec, cls, msg } });
  // Render to DOM (only every Nth to stay cheap)
  renderEveryN++;
  if (renderEveryN % 10 === 0 || cls === 'ok' || cls === 'err' || cls === 'tick') {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = `[${tSec.toFixed(2)}s] ${msg}`;
    log.appendChild(div);
    while (log.children.length > 80) log.firstChild && log.removeChild(log.firstChild);
  }
};

window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage8: worker-posted diag — survives main-thread block`);

goBtn.addEventListener('click', () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Starting…';
  verdict.style.display = '';
  line('tick', `Tap received — starting heartbeats + cvLib.loadOpenCV`);

  // Main-thread setInterval at 100ms.
  let hbN = 0;
  const hb = setInterval(() => {
    hbN++;
    if (hbN % 3 === 0) line('hb', `main-hb n=${hbN} (100ms)`);
  }, 100);

  // rAF loop.
  let rafN = 0;
  let lastRafLog = performance.now();
  const rafLoop = () => {
    rafN++;
    const now = performance.now();
    if (now - lastRafLog > 300) {
      line('raf', `raf n=${rafN}`);
      lastRafLog = now;
    }
    requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);

  line('tick', `heartbeats started, calling cvLib.loadOpenCV`);

  const t1 = performance.now();
  cvLib.loadOpenCV((ev) => {
    line('tick', `cv-progress: ${ev.message}`);
  }).then((cv) => {
    const m = new (cv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
    line('ok', `STAGE8 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(1)}s. rows=${m.rows}; hbN=${hbN}, rafN=${rafN}`);
    m.delete();
    clearInterval(hb);
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE8 PASSED`;
  }).catch((e) => {
    line('err', `STAGE8 FAIL: ${(e as Error).message}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE8 FAIL`;
  });

  // 90s hard limit.
  setTimeout(() => {
    clearInterval(hb);
    line('err', `Diagnostic ended at 90s: hbN=${hbN}, rafN=${rafN}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE8 TIMED OUT (90s)`;
  }, 90_000);
});
