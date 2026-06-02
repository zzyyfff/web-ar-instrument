import { readFileSync } from 'fs';
import { buildPyramid, detectFeatures, trackFeatures, fitSimilarity } from '../../../src/lib/lucas-kanade';

const W = 180, H = 320;
const load = (p: string) => new Uint8Array(readFileSync(p));

for (const ang of ['+5', '-5']) {
  const ga = load('/tmp/gizmo-analysis/lk-test/orig.raw');
  const gb = load(`/tmp/gizmo-analysis/lk-test/rot${ang}.raw`);
  const pyrA = buildPyramid(ga, W, H);
  const pyrB = buildPyramid(gb, W, H);
  const features = detectFeatures(ga, W, H, { x0: 0, y0: 0, x1: W, y1: H });
  const tracks = trackFeatures(pyrA, pyrB, features);
  const fit = fitSimilarity(tracks, W / 2, H / 2);
  console.log(`  JS LK on (orig, rot${ang}): roll=${fit.rollDeg.toFixed(2)}°  tx=${fit.tx.toFixed(2)} ty=${fit.ty.toFixed(2)}  feat=${features.length} in=${fit.inlierCount} resid=${fit.residualPx.toFixed(2)}`);
}
