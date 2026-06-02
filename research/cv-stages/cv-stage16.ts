// cv-stage16: stage 15 BUT do not register cvProgressCb. So emit() in
// startCvPreload becomes a no-op. Isolates whether the onProgress callback
// chain (especially during script.onload) is what hangs WASM init.

import { toGray, buildPyramid, detectFeatures, trackFeatures, fitSimilarity } from './lib/lucas-kanade';
void [toGray, buildPyramid, detectFeatures, trackFeatures, fitSimilarity];
import * as cvLib from './lib/lucas-kanade-cv';

const sessionId = 'cv16' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = sessionId;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;

const t0 = performance.now();
const diagUrl = `${location.origin}/api/diag?session=${sessionId}`;
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
  while (log.children.length > 100) log.firstChild && log.removeChild(log.firstChild);
};
window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));
line('tick', `UA: ${navigator.userAgent}`);
line('tick', `Stage16: stage 15 MINUS cvProgressCb registration`);

// Same diag pipeline as stage 13/14/15
const diagSession = 'calib16_' + Math.random().toString(36).slice(2, 8);
const diagBuffer: Array<{ t: number; tag: string; msg: string; data?: unknown }> = [];
const diagStart = performance.now();
let diagFlushTimer: number | null = null;
function diagFlush() {
  diagFlushTimer = null;
  if (diagBuffer.length === 0) return;
  const batch = diagBuffer.splice(0);
  const body = JSON.stringify(batch);
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(`/api/diag?session=${diagSession}`, blob)) return;
    }
  } catch {}
  fetch(`/api/diag?session=${diagSession}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
  }).catch(() => {});
}
function diag(tag: string, msg: string, data?: unknown) {
  const t = (performance.now() - diagStart) / 1000;
  diagBuffer.push({ t, tag, msg, data });
  try {
    const panel = document.getElementById('gate-diag');
    if (panel) {
      const el = document.createElement('div');
      el.textContent = `[${t.toFixed(2)}s] ${tag} · ${msg}`;
      panel.appendChild(el);
      panel.scrollTop = panel.scrollHeight;
    }
  } catch {}
  if (!diagFlushTimer) diagFlushTimer = window.setTimeout(diagFlush, 1500);
}
window.addEventListener('pagehide', () => diagFlush());
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') diagFlush(); });
window.addEventListener('error', (e) => { diag('window', `ERROR ${e.message}`); diagFlush(); });
window.addEventListener('unhandledrejection', (e) => { diag('window', `UNHANDLED ${String(e.reason).slice(0, 200)}`); diagFlush(); });
diag('boot', `algo=visual-inertial-cv ua=${navigator.userAgent}`);
diagFlush();

// === Call cvLib.startCvPreload(), but DO NOT call onCvProgress. ===
// So emit() inside startCvPreload becomes a no-op (cvProgressCb stays null).
const t1 = performance.now();
cvLib.startCvPreload().then((cv) => {
  const m = new (cv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
  line('ok', `STAGE16 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(2)}s. rows=${m.rows}`);
  m.delete();
  verdict.className = 'ok';
  verdict.textContent = `✓ STAGE16 PASSED`;
}).catch((e) => {
  line('err', `STAGE16 FAIL: ${(e as Error).message}`);
  verdict.className = 'err';
  verdict.textContent = `✗ STAGE16 FAIL`;
});

setTimeout(() => {
  if (verdict.className !== 'ok') {
    line('err', `STAGE16 TIMEOUT at 30s`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE16 TIMEOUT`;
  }
}, 30_000);
