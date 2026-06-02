// cv-stage3: Vite ES module variant. Same logic as cv-stage2 inline script,
// but loaded as a bundled ES module via <script type="module">. Bisects whether
// Vite's module loading is the iOS Chrome WASM-init culprit.

const session = 'cv3' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const gate = document.getElementById('gate') as HTMLDivElement;
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
const line = (cls: string, msg: string, data: unknown = null) => {
  const tSec = (performance.now() - t0) / 1000;
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${tSec.toFixed(1)}s] ${msg}`;
  log.appendChild(div);
  buffer.push({ t: tSec, cls, msg, data });
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
};
window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`, { filename: e.filename, lineno: e.lineno }));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage3: loaded via Vite ES module (script type=module)`);

const URL_CV = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

document.getElementById('go')!.addEventListener('click', () => {
  gate.style.display = 'none';
  verdict.style.display = '';
  line('tick', `Tap received — starting OpenCV load (Vite module + calibrator DOM)`);

  const t1 = performance.now();
  (window as unknown as { Module: { onRuntimeInitialized: () => void } }).Module = {
    onRuntimeInitialized: () => line('ok', `Module.onRuntimeInitialized at +${((performance.now() - t1) / 1000).toFixed(1)}s`),
  };
  const s = document.createElement('script');
  s.src = URL_CV;
  s.onload = () => {
    const cv = (window as unknown as { cv?: { Mat?: unknown } }).cv;
    line('ok', `<script> onload at +${((performance.now() - t1) / 1000).toFixed(1)}s. cv=${typeof cv}, cv.Mat=${typeof cv?.Mat}`);
  };
  s.onerror = (e) => line('err', `<script> onerror: ${e}`);
  document.head.appendChild(s);
  const poll1 = setInterval(() => {
    const cv = (window as unknown as { cv?: { Mat?: new () => { rows: number; delete: () => void } } }).cv;
    if (cv && cv.Mat) {
      clearInterval(poll1);
      try {
        const m = new cv.Mat();
        line('ok', `STAGE3 PASSED: cv.Mat constructible at +${((performance.now() - t1) / 1000).toFixed(1)}s. rows=${m.rows}`);
        m.delete();
        verdict.className = 'ok';
        verdict.textContent = `✓ STAGE3 PASSED — Vite module NOT the culprit`;
        flush();
      } catch (e) { line('err', `STAGE3 FAIL: ${(e as Error).message}`); }
    } else {
      const keys = cv ? Object.keys(cv).length : 0;
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }
  }, 2000);
  setTimeout(() => {
    if (verdict.className !== 'ok') {
      clearInterval(poll1);
      line('err', `STAGE3 TIMEOUT at 60s`);
      verdict.className = 'err';
      verdict.textContent = `✗ STAGE3 HUNG — Vite ES module IS the culprit`;
      flush();
    }
  }, 60_000);
});
