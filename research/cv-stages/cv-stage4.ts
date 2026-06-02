// cv-stage4: stage 3 + the calibrator's diag() panel pattern that appends to
// a scrollable gate-diag panel and sets scrollTop = scrollHeight on every diag
// call. Hypothesis: that layout-forcing read+write during cv load blocks the
// main thread on iOS Chrome.

const session = 'cv4' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;
const gatePanel = document.getElementById('gate-diag') as HTMLDivElement;
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

// === Mirror calibrator's diag() function exactly: append to gate-diag panel AND
// trigger scrollTop = scrollHeight on every call. ===
const line = (cls: string, msg: string, data: unknown = null) => {
  const tSec = (performance.now() - t0) / 1000;
  // Append to the top #log for the user
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${tSec.toFixed(1)}s] ${msg}`;
  log.appendChild(div);
  // ALSO append to the scrollable gate-diag panel with scrollTop=scrollHeight
  // (this is the calibrator's pattern, line 140 of calibrator.ts)
  try {
    const pLine = document.createElement('div');
    pLine.className = cls;
    pLine.textContent = `[${tSec.toFixed(2)}s] · ${msg}`;
    gatePanel.appendChild(pLine);
    gatePanel.scrollTop = gatePanel.scrollHeight;  // ← THE SUSPECT
  } catch {}
  buffer.push({ t: tSec, cls, msg, data });
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
};
window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`, { filename: e.filename, lineno: e.lineno }));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage4: gate-diag panel with scrollTop=scrollHeight on every entry`);

// Pre-populate gate-diag with 5 entries like calibrator would have at tap time
// (boot, env, then chain steps). This is what's on screen when cv-load starts.
for (let i = 0; i < 5; i++) line('tick', `pre-tap entry ${i + 1}/5 (mimics calibrator's boot+env+chain entries)`);

const URL_CV = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

goBtn.addEventListener('click', () => {
  goBtn.style.display = 'none';
  verdict.style.display = '';
  line('tick', `Tap received — starting OpenCV load (+ gate-diag scroll pattern)`);

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
        line('ok', `STAGE4 PASSED: cv.Mat constructible at +${((performance.now() - t1) / 1000).toFixed(1)}s. rows=${m.rows}`);
        m.delete();
        verdict.className = 'ok';
        verdict.textContent = `✓ STAGE4 PASSED — gate-diag scroll NOT the culprit`;
        flush();
      } catch (e) { line('err', `STAGE4 FAIL: ${(e as Error).message}`); }
    } else {
      const keys = cv ? Object.keys(cv).length : 0;
      line('tick', `poll: cv=${typeof cv}, keys=${keys}, Mat=${typeof cv?.Mat}`);
    }
  }, 2000);
  setTimeout(() => {
    if (verdict.className !== 'ok') {
      clearInterval(poll1);
      line('err', `STAGE4 TIMEOUT at 60s`);
      verdict.className = 'err';
      verdict.textContent = `✗ STAGE4 HUNG — gate-diag scroll IS the culprit`;
      flush();
    }
  }, 60_000);
});
