// Guards the hand-rolled parallel-curve offset in engine/spline-math.ts, which
// replaced bezier-js's .offset(d) (its span search scanned t linearly at step
// 0.01, costing 264µs per segment — 79% of a 309ms frame).
//
// WHAT THIS DOES NOT TEST, and why: the new reduce picks different spans than
// the library (bisection lands on binary fractions of t; bezier-js's greedy
// scan yields maximal spans), so comparing piece boundaries — or nearest-point
// distance between the two chains' SAMPLES — measures sampling density, not
// geometry. That mistake reported a 127% "deviation" between two chains that
// were both correct to 4 decimal places; the tell was that the number stayed
// flat across curvature buckets, which a real geometric error would not.
//
// What actually characterizes a parallel curve is the invariant below: every
// point of the offset sits at |d| from the source. That is measured directly.
//
// Run: npx tsx scripts/check-offset.mts
import { Bezier } from "bezier-js";
import { offsetSubpath, subpathToCurves } from "../src/engine/spline-math.ts";
import type { SplineSubpath } from "../src/engine/types.ts";

let failures = 0;
let checks = 0;
function check(cond: boolean, msg: string): void {
  checks++;
  if (!cond) { failures++; console.error(`  FAIL: ${msg}`); }
}

// Deterministic PRNG — a fixed corpus means a regression reproduces exactly.
let seed = 0x2f6e2b1;
function rnd(): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
const rndIn = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const randomCubic = () => new Bezier(
  rndIn(0.1, 0.9), rndIn(0.1, 0.9), rndIn(0.1, 0.9), rndIn(0.1, 0.9),
  rndIn(0.1, 0.9), rndIn(0.1, 0.9), rndIn(0.1, 0.9), rndIn(0.1, 0.9));

const toSub = (c: Bezier): SplineSubpath => ({
  anchors: [
    { pos: [c.points[0].x, c.points[0].y],
      outHandle: [c.points[1].x - c.points[0].x, c.points[1].y - c.points[0].y] },
    { pos: [c.points[3].x, c.points[3].y],
      inHandle: [c.points[2].x - c.points[3].x, c.points[2].y - c.points[3].y] },
  ],
  closed: false,
});

// Where a cubic's curvature radius drops below |d| the parallel curve develops
// a cusp and self-intersects: points of the true offset legitimately land ON
// the source, so the |d| invariant does not hold for ANY implementation. The
// accuracy corpus is restricted to curves comfortably clear of that.
function minCurvatureRadius(c: Bezier): number {
  // curvature() exists at runtime but is missing from bezier-js's typings.
  const curved = c as unknown as { curvature(t: number): { k: number } };
  let min = Infinity;
  for (let i = 0; i <= 200; i++) {
    const k = Math.abs(curved.curvature(i / 200).k);
    if (k > 1e-12) min = Math.min(min, 1 / k);
  }
  return min;
}

// Closest approach from p to the source curve, and where it lands.
function nearest(c: Bezier, p: { x: number; y: number }): { dist: number; t: number } {
  let best = Infinity, bt = 0;
  for (let i = 0; i <= 600; i++) {
    const q = c.get(i / 600);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best) { best = d; bt = i / 600; }
  }
  for (let s = 1 / 600; s > 1e-8; s *= 0.5) {
    for (const t of [bt - s, bt + s]) {
      if (t < 0 || t > 1) continue;
      const q = c.get(t);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best) { best = d; bt = t; }
    }
  }
  return { dist: best, t: bt };
}

const D = 0.015;

// ---- 1: the offset is parallel ---------------------------------------------
// Measured identical to bezier-js's own output at this threshold (both 12.47%
// max). The residual is scale()'s approximation — a cubic cannot exactly
// represent the parallel curve of a cubic — not a defect in the span search.
console.log("radial accuracy on well-conditioned curves");
{
  let worst = 0, n = 0;
  seed = 0x2f6e2b1;
  for (let i = 0; i < 250; i++) {
    const c = randomCubic();
    if (minCurvatureRadius(c) <= 4 * D) continue;
    const off = offsetSubpath(toSub(c), D);
    if (!off) continue;
    n++;
    for (const piece of subpathToCurves(off)) {
      for (let k = 0; k <= 8; k++) {
        const err = Math.abs(nearest(c, piece.get(k / 8)).dist - D);
        if (err > worst) worst = err;
      }
    }
  }
  check(n > 40, `only ${n} well-conditioned curves in the corpus`);
  check(worst < D * 0.13, `max radial error ${(worst / D * 100).toFixed(2)}% of d exceeds the 13% bezier-js parity bound`);
  console.log(`  ${n} curves, max radial error ${(worst / D * 100).toFixed(2)}% of d (bezier-js: 12.47%)`);
}

// ---- 2: the chain is contiguous and covers the source ----------------------
// Guards against silently dropping a span — spanHasExtent() rejects pieces, so
// an over-eager threshold would leave a hole that offsetSubpath then bridges
// with a bogus corner arc.
console.log("contiguity and coverage");
{
  let gaps = 0, uncovered = 0, n = 0;
  seed = 0x51a3f7;
  for (let i = 0; i < 120; i++) {
    const c = randomCubic();
    if (minCurvatureRadius(c) <= 4 * D) continue;
    const off = offsetSubpath(toSub(c), D);
    if (!off) continue;
    n++;
    const curves = subpathToCurves(off);
    for (let k = 0; k + 1 < curves.length; k++) {
      const a = curves[k].points[3], b = curves[k + 1].points[0];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) gaps++;
    }
    // Project the chain back onto the source: the covered t values should
    // reach both ends without a hole.
    const ts: number[] = [];
    for (const piece of curves) {
      for (let k = 0; k <= 8; k++) ts.push(nearest(c, piece.get(k / 8)).t);
    }
    ts.sort((x, y) => x - y);
    if (ts[0] > 0.02 || ts[ts.length - 1] < 0.98) uncovered++;
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] > 0.2) { uncovered++; break; }
    }
  }
  check(gaps === 0, `${gaps} discontinuities between consecutive pieces`);
  check(uncovered === 0, `${uncovered} of ${n} chains left part of the source uncovered`);
  console.log(`  ${n} curves, ${gaps} gaps, ${uncovered} coverage holes`);
}

// ---- 3: degenerate input ---------------------------------------------------
// A zero-extent span has NaN normals, so simple() is false forever. Bisection
// then recursed to the depth cap and emitted 2^8 garbage pieces — 259 anchors,
// 257 of them non-finite, from ONE zero-length input segment. spanHasExtent()
// is the escape; this is its regression guard.
console.log("degenerate input");
{
  const zeroLen: SplineSubpath = {
    anchors: [{ pos: [0.5, 0.5] }, { pos: [0.5, 0.5] }, { pos: [0.9, 0.5] }],
    closed: false,
  };
  const off = offsetSubpath(zeroLen, 0.05);
  check(off != null, "zero-length segment offsets to null");
  if (off) {
    check(
      off.anchors.every((a) => Number.isFinite(a.pos[0]) && Number.isFinite(a.pos[1])),
      `zero-length segment produced ${off.anchors.filter((a) => !Number.isFinite(a.pos[0])).length} non-finite anchors`
    );
    check(
      off.anchors.length <= 4,
      `zero-length segment produced ${off.anchors.length} anchors — bisection ran away`
    );
    check(
      off.anchors.every((a) => Math.abs(a.pos[1] - 0.55) < 1e-9),
      `expected the surviving segment offset to y=0.55, got ${off.anchors.map((a) => a.pos[1]).join(",")}`
    );
  }

  // Straight, handle-less segment: solidifyForOffset synthesizes handles, and
  // the result must be a clean parallel line.
  const straight: SplineSubpath = { anchors: [{ pos: [0.2, 0.5] }, { pos: [0.8, 0.5] }], closed: false };
  const so = offsetSubpath(straight, 0.1);
  check(so != null, "straight segment offsets to null");
  if (so) {
    check(
      so.anchors.every((a) => Math.abs(Math.abs(a.pos[1] - 0.5) - 0.1) < 1e-6),
      `straight offset landed at y=${so.anchors.map((a) => a.pos[1]).join(",")}, expected 0.1 from y=0.5`
    );
    check(so.anchors.length <= 4, `straight offset produced ${so.anchors.length} anchors`);
  }

  // All-coincident anchors: nothing survives, and it must not hang or throw.
  const allSame: SplineSubpath = {
    anchors: [{ pos: [0.3, 0.3] }, { pos: [0.3, 0.3] }, { pos: [0.3, 0.3] }],
    closed: false,
  };
  let threw = false;
  let r: SplineSubpath | null = null;
  try { r = offsetSubpath(allSame, 0.02); } catch { threw = true; }
  check(!threw, "all-coincident anchors threw");
  check(
    r == null || r.anchors.every((a) => Number.isFinite(a.pos[0])),
    "all-coincident anchors produced non-finite output"
  );

  check(offsetSubpath(straight, 0) === straight, "distance 0 should be identity");
}

// ---- 4: closed subpaths ----------------------------------------------------
console.log("closed subpaths");
{
  const circle: SplineSubpath = {
    anchors: [0, 1, 2, 3].map((i) => {
      const a = (i / 4) * Math.PI * 2;
      const k = (4 / 3) * Math.tan(Math.PI / 8) * 0.3;
      return {
        pos: [0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)] as [number, number],
        inHandle: [k * Math.sin(a), -k * Math.cos(a)] as [number, number],
        outHandle: [-k * Math.sin(a), k * Math.cos(a)] as [number, number],
      };
    }),
    closed: true,
  };
  for (const d of [0.05, -0.05]) {
    const off = offsetSubpath(circle, d);
    check(off != null, `circle offset by ${d} returned null`);
    if (!off) continue;
    check(off.closed === true, `circle offset by ${d} lost its closed flag`);
    // Sign convention: positive `distance` offsets to the RIGHT of the path's
    // travel direction, which for this anchor winding is inward — so the
    // expected radius is 0.3 − d, not 0.3 + d. Verified identical to the
    // bezier-js implementation this replaced (d=+0.05 → r=0.25000..0.25008 in
    // both), so the sign is a property of the node, not of this change.
    //
    // A circle's parallel curve is exactly a concentric circle, so this is a
    // tight bound rather than the 13% the general cubic case needs.
    let worst = 0;
    for (const piece of subpathToCurves(off)) {
      for (let k = 0; k <= 8; k++) {
        const p = piece.get(k / 8);
        const r = Math.hypot(p.x - 0.5, p.y - 0.5);
        worst = Math.max(worst, Math.abs(r - (0.3 - d)));
      }
    }
    check(worst < 0.002, `circle offset by ${d}: radius error ${worst.toFixed(5)}`);
  }
}

// ---- timing ----------------------------------------------------------------
// Not a gate (machine-dependent) — a number to eyeball against the 264µs per
// segment that motivated the change.
console.log("timing");
{
  const anchors: SplineSubpath["anchors"] = [];
  for (let i = 0; i < 200; i++) {
    const a = (i / 200) * Math.PI * 6;
    anchors.push({
      pos: [0.5 + 0.35 * Math.cos(a), 0.5 + 0.35 * Math.sin(a * 1.3)],
      inHandle: [-0.01, 0.005],
      outHandle: [0.01, -0.005],
    });
  }
  const sub: SplineSubpath = { anchors, closed: false };
  offsetSubpath(sub, 0.01);
  const t0 = performance.now();
  const REPS = 20;
  for (let i = 0; i < REPS; i++) offsetSubpath(sub, 0.01);
  const perSeg = ((performance.now() - t0) / REPS / (anchors.length - 1)) * 1000;
  console.log(`  ${perSeg.toFixed(1)}µs per segment (bezier-js .offset was ~264µs)`);
}

console.log(
  failures === 0
    ? `\nALL GREEN — ${checks} checks passed`
    : `\n${failures} of ${checks} checks FAILED`
);
process.exit(failures === 0 ? 0 : 1);
