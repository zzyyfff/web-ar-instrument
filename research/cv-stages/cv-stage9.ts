// cv-stage9: each worker tick is its OWN independent fetch (no buffering, no
// shared flush). Each fetch has a 2s timeout. If a fetch hangs, others can
// still complete. Distinguishes "page fully suspended" from "fetch hung" from
// "user reloaded".
//
// Also logs pagehide/visibilitychange/freeze/resume events from main thread so
// we can see if the user backgrounded/reloaded the page.

import * as cvLib from './lib/lucas-kanade-cv';

const session = 'cv9' + Math.random().toString(36).slice(2, 8);
document.getElementById('sid')!.textContent = session;
const verdict = document.getElementById('verdict') as HTMLDivElement;
const log = document.getElementById('log') as HTMLDivElement;
const goBtn = document.getElementById('go') as HTMLButtonElement;

const t0 = performance.now();
const diagUrl = `${location.origin}/api/diag?session=${session}`;

// Worker code: each tick is its OWN independent fetch.
const workerCode = `
  const DIAG_URL = ${JSON.stringify(diagUrl)};
  const t0 = performance.now();
  let workerN = 0;
  let fetchSucceeded = 0;
  let fetchFailed = 0;
  let fetchInFlight = 0;

  const postOne = async (entry) => {
    fetchInFlight++;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 2000);
      const r = await fetch(DIAG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([entry]),
        signal: ac.signal,
      });
      clearTimeout(to);
      if (r.ok) fetchSucceeded++; else fetchFailed++;
    } catch (e) {
      fetchFailed++;
    } finally {
      fetchInFlight--;
    }
  };

  setInterval(() => {
    workerN++;
    const tSec = (performance.now() - t0) / 1000;
    postOne({
      t: tSec,
      cls: 'wk',
      msg: 'wk n=' + workerN + ' ok=' + fetchSucceeded + ' fail=' + fetchFailed + ' inflight=' + fetchInFlight,
    });
  }, 100);

  self.onmessage = (ev) => {
    if (ev.data && ev.data.type === 'log') {
      postOne(ev.data.entry);
    }
  };
`;

const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));

const line = (cls: string, msg: string) => {
  const tSec = (performance.now() - t0) / 1000;
  worker.postMessage({ type: 'log', entry: { t: tSec, cls, msg } });
  // Render every entry to DOM so user has visual confirmation
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${tSec.toFixed(2)}s] ${msg}`;
  log.appendChild(div);
  while (log.children.length > 100) log.firstChild && log.removeChild(log.firstChild);
};

window.addEventListener('error', (e) => line('err', `WINDOW ERROR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => line('err', `UNHANDLED REJECTION: ${(e as PromiseRejectionEvent).reason}`));

// Lifecycle events — tells us if iOS Chrome backgrounds, freezes, or unloads.
window.addEventListener('visibilitychange', () => line('vis', `visibilitychange → ${document.visibilityState}`));
window.addEventListener('pagehide', () => line('vis', `pagehide`));
window.addEventListener('pageshow', () => line('vis', `pageshow`));
window.addEventListener('freeze', () => line('vis', `freeze`));
window.addEventListener('resume', () => line('vis', `resume`));
window.addEventListener('blur', () => line('vis', `window-blur`));
window.addEventListener('focus', () => line('vis', `window-focus`));

line('tick', `UA: ${navigator.userAgent}`);
line('tick', `cores: ${navigator.hardwareConcurrency}`);
line('tick', `Stage9: per-tick independent fetch + lifecycle events`);

const waitBanner = document.getElementById('wait-banner') as HTMLDivElement;
const countdown = document.getElementById('countdown') as HTMLDivElement;
const TEST_DURATION_S = 90;

function setDone(label: string) {
  waitBanner.classList.add('done');
  waitBanner.firstChild!.textContent = label;
  countdown.textContent = '— OK to close —';
}

goBtn.addEventListener('click', () => {
  goBtn.disabled = true;
  goBtn.textContent = 'Starting…';
  verdict.style.display = '';
  waitBanner.style.display = '';

  // Live countdown that updates every 500ms (worker-driven so it survives main-thread block).
  // Initial display from main thread, then keep updating via setInterval; if main blocks the
  // number freezes which itself is informative.
  const tapAt = performance.now();
  const tick = () => {
    const elapsed = (performance.now() - tapAt) / 1000;
    const remaining = Math.max(0, TEST_DURATION_S - elapsed);
    countdown.textContent = `${remaining.toFixed(0)}s remaining`;
  };
  tick();
  const cdInterval = setInterval(tick, 500);

  line('tick', `Tap received — starting heartbeats + cvLib.loadOpenCV`);

  let hbN = 0;
  const hb = setInterval(() => {
    hbN++;
    if (hbN % 3 === 0) line('hb', `main-hb n=${hbN}`);
  }, 100);

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

  line('tick', `cvLib.loadOpenCV called`);
  const t1 = performance.now();
  cvLib.loadOpenCV((ev) => {
    line('tick', `cv-progress: ${ev.message}`);
  }).then((cv) => {
    const m = new (cv as { Mat: new () => { rows: number; delete: () => void } }).Mat();
    line('ok', `STAGE9 PASSED: cv.Mat at +${((performance.now() - t1) / 1000).toFixed(1)}s. hbN=${hbN}, rafN=${rafN}`);
    m.delete();
    clearInterval(hb);
    clearInterval(cdInterval);
    verdict.className = 'ok';
    verdict.textContent = `✓ STAGE9 PASSED`;
    setDone('✓ DONE — OK to close');
  }).catch((e) => {
    line('err', `STAGE9 FAIL: ${(e as Error).message}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE9 FAIL`;
    setDone('✗ FAILED — OK to close');
  });

  setTimeout(() => {
    clearInterval(hb);
    clearInterval(cdInterval);
    line('err', `Diagnostic ended at ${TEST_DURATION_S}s: hbN=${hbN}, rafN=${rafN}`);
    verdict.className = 'err';
    verdict.textContent = `✗ STAGE9 TIMED OUT (${TEST_DURATION_S}s)`;
    setDone(`⏱ TIMED OUT — OK to close`);
  }, TEST_DURATION_S * 1000);
});
