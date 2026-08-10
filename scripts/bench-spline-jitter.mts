// Temporal-stability probe for contour-producing spline nodes.
//
// WHY: a change can be faster, keep the same subpath count, stay within its
// stated error tolerance, look right in a screenshot — and still be a
// regression, because it POPS in motion. That happened here: thinning the
// marching-squares polyline before the bezier fit cut Blend Intersections
// from ~24.5ms to ~18ms with identical topology and a static frame that
// looked fine, but the owner immediately saw "significantly more snapping and
// popping". This probe puts a number on that.
//
// METHOD: advance the input by one animation frame's worth of motion, and
// measure how far the OUTPUT contour moves compared to how far the INPUT
// moved. A stable node tracks its input (amplification near 1). A node whose
// output structure re-derives itself each frame — different anchor keep-set,
// different chaining, different seam — amplifies.
//
// Read the MEAN, not the max. The max is dominated by whichever contour
// happens to re-chain that frame and is noisy enough to point the wrong way:
// on the thinning change the max actually improved (15.38 -> 13.70) while the
// mean got 42% worse (7.60 -> 10.76), which is what the owner was seeing.
//
// Run: npm run bench:jitter
import { blendIntersections } from "../src/engine/spline-blend-intersections.ts";
import { subpathToCurves } from "../src/engine/spline-math.ts";
import type { SplineSubpath, SplineValue } from "../src/engine/types.ts";

const W = 1024;
const OPTS = { widthPx: 6, blendPx: 24, resolution: 288, smoothing: 0.5 };
// One frame of motion for the benchmark graph's advected wander.
const STEP = 0.004;
const FRAMES = 12;

function makeInput(n: number, phase: number): SplineValue {
  const anchors: SplineSubpath["anchors"] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    anchors.push({
      pos: [
        0.5 + 0.34 * Math.sin(3 * t + phase) + 0.06 * Math.sin(11 * t),
        0.5 + 0.34 * Math.sin(5 * t) + 0.06 * Math.cos(7 * t + phase),
      ],
    });
  }
  return { kind: "spline", subpaths: [{ anchors, closed: false }] };
}

// Flatten a spline to line segments in canvas px.
function densify(s: SplineValue, per = 6): number[][] {
  const segs: number[][] = [];
  for (const sub of s.subpaths) {
    let prev: number[] | null = null;
    for (const c of subpathToCurves(sub)) {
      for (let i = 0; i <= per; i++) {
        const p = c.get(i / per);
        const q = [p.x * W, p.y * W];
        if (prev) segs.push([prev[0], prev[1], q[0], q[1]]);
        prev = q;
      }
    }
  }
  return segs;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// One-sided Hausdorff: farthest any point of `a` sits from the curve `bSegs`.
// Point-to-SEGMENT, not point-to-point — comparing sampled point sets instead
// measures sampling density and reports large bogus deviations between two
// curves that coincide exactly.
function deviation(a: SplineValue, bSegs: number[][]): number {
  let worst = 0;
  for (const sub of a.subpaths) {
    for (const c of subpathToCurves(sub)) {
      for (let i = 0; i <= 6; i++) {
        const p = c.get(i / 6);
        let best = Infinity;
        for (const s of bSegs) {
          const d = distToSeg(p.x * W, p.y * W, s[0], s[1], s[2], s[3]);
          if (d < best) best = d;
        }
        if (best > worst) worst = best;
      }
    }
  }
  return worst;
}

let inputMotion = 0;
{
  const a = makeInput(100, 0.7).subpaths[0].anchors;
  const b = makeInput(100, 0.7 + STEP).subpaths[0].anchors;
  for (let i = 0; i < a.length; i++) {
    inputMotion = Math.max(
      inputMotion,
      Math.hypot((a[i].pos[0] - b[i].pos[0]) * W, (a[i].pos[1] - b[i].pos[1]) * W)
    );
  }
}

let worst = 0;
let sum = 0;
let n = 0;
let prev: SplineValue | null = null;
let prevSegs: number[][] = [];
const counts: number[] = [];
for (let f = 0; f < FRAMES; f++) {
  const out = blendIntersections(makeInput(100, 0.7 + f * STEP), W, W, OPTS);
  counts.push(out.subpaths.length);
  if (prev) {
    // Symmetric: a contour that VANISHES this frame is as visible as one that
    // appears, and a one-sided measure misses whichever direction lost it.
    const d = Math.max(deviation(out, prevSegs), deviation(prev, densify(out)));
    worst = Math.max(worst, d);
    sum += d;
    n++;
  }
  prev = out;
  prevSegs = densify(out);
}

console.log(`blend-intersections, ${FRAMES} frames, step ${STEP}`);
console.log(`  input motion        ${inputMotion.toFixed(2)} px / frame`);
console.log(`  output jump  MEAN   ${(sum / n).toFixed(2)} px   <-- the number that matters`);
console.log(`  output jump  max    ${worst.toFixed(2)} px   (noisy; can point the wrong way)`);
console.log(`  mean amplification  ${(sum / n / inputMotion).toFixed(2)}x`);
console.log(`  subpath count/frame ${counts.join(" ")}`);
console.log(
  `\nreference: mean 7.60 px with the current pipeline; ` +
    `10.76 px with polyline thinning before the fit (reverted — see the ` +
    `comment above fitSplineToPolyline in spline-blend-intersections.ts).`
);
