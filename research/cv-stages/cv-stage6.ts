// cv-stage6: stage 4 (passed) + ONLY cvLib.loadOpenCV wrapper call.
// No setStatus calls. No new module-level event listeners (pagehide/visibilitychange).
// Just: import cvLib, await cvLib.loadOpenCV(callback) from a sync-as-possible
// click handler (no await BEFORE the loadOpenCV call). Isolates the wrapper alone.

import * as cvLib from './lib/lucas-kanade-cv';

const session = 'cv6' + Math.random().toString(36).slice(2, 8);
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
window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`, { filename: e.filename, lineno: e.lineno }));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage6: cvLib wrapper only — no setStatus, no pagehide/visibilitychange listeners`);
for (let i = 0; i < 5; i++) line('tick', `pre-tap entry ${i + 1}/5`);

// SYNC click handler: call cvLib.loadOpenCV inside the gesture context directly.
// No await before the call; the wrapper kicks off script append synchronously.
goBtn.addEventListener('click', () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Starting…';
  verdict.style.display = '';
  line('tick', `Tap received — calling cvLib.loadOpenCV (no setStatus, no await before)`);

  const t1 = performance.now();
  // Call synchronously — Promise constructor runs script.append before returning.
  cvLib.loadOpenCV((ev) => {
    line('tick', `cv: ${ev.message}`);
  }).then((cv) => {
    const m = new (cv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
    line('ok', `STAGE6 PASSED: cv.Mat constructible at +${((performance.now() - t1) / 1000).toFixed(1)}s. rows=${m.rows}`);
    m.delete();
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE6 PASSED — cvLib wrapper alone is fine`;
    flush();
  }).catch((e) => {
    line('err', `STAGE6 FAIL: ${(e as Error).message}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE6 HUNG — cvLib wrapper IS the culprit`;
    flush();
  });
});
