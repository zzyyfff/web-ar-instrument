// cv-stage5: stage 4 + the actual cvLib.loadOpenCV wrapper from the calibrator
// + setStatus() showing the bottom #status panel. Mirrors what the calibrator
// does at the gate-tap, minus the rest of the chain (motion permission, camera,
// sensor listeners, capture button, LK, rAF). If this passes, the culprit is
// outside the cv-load path; if it hangs, it's something in the wrapper or in
// the setStatus chain.

import * as cvLib from './lib/lucas-kanade-cv';

const session = 'cv5' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;
const gatePanel = document.getElementById('gate-diag') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLDivElement;
const loaderBar = document.getElementById('loader-bar') as HTMLDivElement;
const loaderFill = loaderBar.firstElementChild as HTMLDivElement;

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
  try {
    const pLine = document.createElement('div');
    pLine.className = cls;
    pLine.textContent = `[${tSec.toFixed(2)}s] · ${msg}`;
    gatePanel.appendChild(pLine);
    gatePanel.scrollTop = gatePanel.scrollHeight;
  } catch {}
  buffer.push({ t: tSec, cls, msg, data });
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
};

// Mirror calibrator's setStatus exactly.
function setStatus(msg: string | null, progressPct?: number) {
  line('tick', `setStatus: ${msg ?? '<hide>'}${progressPct != null ? ` (${(progressPct * 100).toFixed(0)}%)` : ''}`);
  if (!msg) { statusEl.hidden = true; loaderBar.hidden = true; return; }
  statusEl.hidden = false;
  statusText.textContent = msg;
  if (typeof progressPct === 'number') {
    loaderBar.hidden = false;
    loaderFill.style.width = `${Math.max(0, Math.min(100, progressPct * 100)).toFixed(1)}%`;
  } else {
    loaderBar.hidden = true;
  }
}

// Module-level event listeners EXACTLY like calibrator's.
window.addEventListener('pagehide', () => flush());
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`, { filename: e.filename, lineno: e.lineno }));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage5: + cvLib.loadOpenCV wrapper + setStatus + module event listeners`);
for (let i = 0; i < 5; i++) line('tick', `pre-tap entry ${i + 1}/5`);

goBtn.addEventListener('click', async () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Starting…';
  verdict.style.display = '';
  line('tick', `Tap received — calling cvLib.loadOpenCV (calibrator's actual path)`);
  setStatus('Loading OpenCV.js (~4s)…');
  await flush(); // diagFlush before WASM compile, same as calibrator

  const t1 = performance.now();
  try {
    const cv = await cvLib.loadOpenCV((ev) => {
      line('tick', `chain-cv: ${ev.message}`);
      setStatus(ev.message, ev.percent);
    });
    const m = new cv.Mat();
    line('ok', `STAGE5 PASSED: cv.Mat constructible at +${((performance.now() - t1) / 1000).toFixed(1)}s. rows=${(m as { rows: number }).rows}`);
    (m as { delete: () => void }).delete();
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE5 PASSED — cvLib wrapper NOT the culprit`;
    setStatus(null);
    flush();
  } catch (e) {
    line('err', `STAGE5 FAIL: ${(e as Error).message}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE5 HUNG — cvLib wrapper IS the culprit`;
    flush();
  }
});
