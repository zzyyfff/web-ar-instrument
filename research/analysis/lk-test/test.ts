// Run vanilla JS LK on test frame pairs and compare to OpenCV reference.
import { readFileSync, writeFileSync } from 'fs';
import { buildPyramid, detectFeatures, trackFeatures, fitSimilarity } from '../../../src/lib/lucas-kanade';

const W = 180, H = 320;

function loadGray(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

const pairs = [
  ['t0.5.raw',  't4.0.raw',  'upright → start of roll'],
  ['t4.0.raw',  't5.5.raw',  'mid-roll'],
  ['t5.5.raw',  't8.0.raw',  'late roll → return upright'],
  ['t8.0.raw',  't15.0.raw', 'between rolls (calm)'],
  ['t15.0.raw', 't22.0.raw', 'exploration'],
];

const results = [];
for (const [a, b, desc] of pairs) {
  const ga = loadGray(`/tmp/gizmo-analysis/lk-test/${a}`);
  const gb = loadGray(`/tmp/gizmo-analysis/lk-test/${b}`);
  const pyrA = buildPyramid(ga, W, H);
  const pyrB = buildPyramid(gb, W, H);
  const features = detectFeatures(ga, W, H, {
    x0: 0, y0: Math.round(H * 0.18),
    x1: W, y1: Math.round(H * 0.82),
  });
  const tracks = trackFeatures(pyrA, pyrB, features);
  const fit = fitSimilarity(tracks, W / 2, H / 2);
  results.push({ a, b, desc, n_features: features.length, ...fit });
  console.log(`  ${a.padStart(10)} → ${b.padEnd(10)} (${desc}): ${String(features.length).padStart(3)} feat, ${String(fit.inlierCount).padStart(3)} inliers, tx=${fit.tx.toFixed(2).padStart(7)}px ty=${fit.ty.toFixed(2).padStart(7)}px roll=${fit.rollDeg.toFixed(2).padStart(7)}° resid=${fit.residualPx.toFixed(2)}px`);
}
writeFileSync('/tmp/gizmo-analysis/lk-test/js-lk.json', JSON.stringify(results, null, 2));
console.log(`\nwrote js-lk.json with ${results.length} pairs`);
