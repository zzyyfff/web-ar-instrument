// cv-stage17: same as stage 16 but use direct named import instead of `import * as`.
// Tests whether the namespace-access pattern affects timing.

import { startCvPreload } from './lib/lucas-kanade-cv';

const sessionId = 'cv17' + Math.random().toString(36).slice(2, 8);
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
};
line('tick', `Stage17: direct named import of startCvPreload`);

const t1 = performance.now();
startCvPreload().then((cv) => {
  line('ok', `STAGE17 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(2)}s`);
  verdict.className = 'ok'; verdict.textContent = `✓ PASSED`;
  const _m = new (cv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
  _m.delete();
}).catch((e) => {
  line('err', `STAGE17 FAIL: ${(e as Error).message}`);
  verdict.className = 'err'; verdict.textContent = `✗ FAIL`;
});

setTimeout(() => {
  if (verdict.className !== 'ok') { verdict.className = 'err'; verdict.textContent = `✗ TIMEOUT`; line('err', 'STAGE17 TIMEOUT 30s'); }
}, 30_000);
