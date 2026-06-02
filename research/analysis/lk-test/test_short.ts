// Validate JS LK on short-interval (100ms) frame pairs — the cadence the live
// pipeline actually sees.
import { readFileSync, writeFileSync } from 'fs';
import { buildPyramid, detectFeatures, trackFeatures, fitSimilarity } from '../../../src/lib/lucas-kanade';

const W = 180, H = 320;
const load = (p: string) => new Uint8Array(readFileSync(p));

const results = [];
for (let i = 0; i < 9; i++) {
  const ga = load(`/tmp/gizmo-analysis/lk-test/short-${i}.raw`);
  const gb = load(`/tmp/gizmo-analysis/lk-test/short-${i + 1}.raw`);
  const pyrA = buildPyramid(ga, W, H);
  const pyrB = buildPyramid(gb, W, H);
  const features = detectFeatures(ga, W, H, {
    x0: 0, y0: Math.round(H * 0.18),
    x1: W, y1: Math.round(H * 0.82),
  });
  const tracks = trackFeatures(pyrA, pyrB, features);
  const fit = fitSimilarity(tracks, W / 2, H / 2);
  const dt_ms = 100;
  results.push({ pair: `${i}→${i+1}`, t_start: 3.0 + i * 0.1, n_features: features.length, ...fit });
  console.log(`  t=${(3.0 + i * 0.1).toFixed(1)}s → ${(3.0 + (i+1) * 0.1).toFixed(1)}s: feat=${String(features.length).padStart(3)} in=${String(fit.inlierCount).padStart(3)} tx=${fit.tx.toFixed(2).padStart(7)} ty=${fit.ty.toFixed(2).padStart(7)} roll=${fit.rollDeg.toFixed(2).padStart(7)}° resid=${fit.residualPx.toFixed(2)}`);
}
writeFileSync('/tmp/gizmo-analysis/lk-test/js-lk-short.json', JSON.stringify(results, null, 2));
