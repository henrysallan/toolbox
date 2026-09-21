// check-outline: the Outline node (engine/spline-outline.ts) — sweep a
// spline with a uniform thickness and return the silhouette as a closed
// polygonal spline. Guards: butt / square / round caps, round / bevel /
// miter joins (canvas miter-limit rule), closed paths keep their hole,
// crossings union into one ring, per-anchor width tapers, aspect-corrected
// px space on a non-square canvas, the px / % units toggle, and the node's
// result cache.
//
//   npx tsx scripts/check-outline.mts

import type {
  NodeOutput,
  RenderContext,
  SplineAnchor,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import { aspectCorrectY } from "../src/engine/aspect.ts";
import {
  outlineSpline,
  type OutlineOptions,
} from "../src/engine/spline-outline.ts";
import { outlineNode } from "../src/nodes/effect/outline.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

function A(x: number, y: number, extra: Partial<SplineAnchor> = {}): SplineAnchor {
  return { pos: [x, y], ...extra };
}

function spline(...subpaths: SplineSubpath[]): SplineValue {
  return { kind: "spline", subpaths };
}

const W = 1000;
const H = 1000;
const PX = 1 / W; // one canvas px in canvas01 on the square canvas

function opts(over: Partial<OutlineOptions> = {}): OutlineOptions {
  return {
    thicknessPx: 20,
    cap: "butt",
    join: "round",
    miterLimit: 10,
    steps: 24,
    ...over,
  };
}

// Even-odd point-in-spline over every closed ring — the fill rule the
// rasterizer applies to the output.
function inside(sp: SplineValue, x: number, y: number): boolean {
  let hits = 0;
  for (const sub of sp.subpaths) {
    const pts = sub.anchors.map((a) => a.pos);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      if (y1 > y !== y2 > y) {
        const xi = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
        if (xi > x) hits++;
      }
    }
  }
  return hits % 2 === 1;
}

function bounds(sp: SplineValue) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of sp.subpaths) {
    for (const a of sub.anchors) {
      minX = Math.min(minX, a.pos[0]);
      maxX = Math.max(maxX, a.pos[0]);
      minY = Math.min(minY, a.pos[1]);
      maxY = Math.max(maxY, a.pos[1]);
    }
  }
  return { minX, minY, maxX, maxY };
}

// ── Straight line: caps ─────────────────────────────────────────────────
const line = spline({ closed: false, anchors: [A(0.2, 0.5), A(0.8, 0.5)] });

{
  const out = outlineSpline(line, W, H, opts({ cap: "butt" }));
  check("butt: one closed ring", out.subpaths.length === 1 && out.subpaths[0].closed);
  check(
    "butt: straight constant-width line is a 4-anchor quad",
    out.subpaths[0]?.anchors.length === 4,
    `got ${out.subpaths[0]?.anchors.length}`
  );
  const b = bounds(out);
  check(
    "butt: spans exactly the endpoints",
    close(b.minX, 0.2, PX * 0.1) && close(b.maxX, 0.8, PX * 0.1),
    JSON.stringify(b)
  );
  check(
    "butt: half-width 10px either side",
    close(b.minY, 0.5 - 10 * PX, PX * 0.1) && close(b.maxY, 0.5 + 10 * PX, PX * 0.1),
    JSON.stringify(b)
  );
  check("butt: centerline point is inside", inside(out, 0.5, 0.5));
  check("butt: 11px off the line is outside", !inside(out, 0.5, 0.5 + 11 * PX));
}

{
  const out = outlineSpline(line, W, H, opts({ cap: "square" }));
  const b = bounds(out);
  check(
    "square: extends half-width past each end",
    close(b.minX, 0.2 - 10 * PX, PX * 0.1) && close(b.maxX, 0.8 + 10 * PX, PX * 0.1),
    JSON.stringify(b)
  );
  check("square: still one ring", out.subpaths.length === 1);
  check(
    "square: the extension corner is filled",
    inside(out, 0.2 - 9 * PX, 0.5 - 9 * PX)
  );
}

{
  const out = outlineSpline(line, W, H, opts({ cap: "round" }));
  const b = bounds(out);
  check(
    "round: extends half-width past each end",
    close(b.minX, 0.2 - 10 * PX, PX * 0.3) && close(b.maxX, 0.8 + 10 * PX, PX * 0.3),
    JSON.stringify(b)
  );
  check("round: still one ring", out.subpaths.length === 1);
  check(
    "round: the square-cap corner is NOT filled",
    !inside(out, 0.2 - 9 * PX, 0.5 - 9 * PX)
  );
  check(
    "round: a point inside the semicircle is filled",
    inside(out, 0.2 - 5 * PX, 0.5 - 5 * PX)
  );
}

// ── Joins on an L corner (right, then down) ─────────────────────────────
const ell = spline({
  closed: false,
  anchors: [A(0.2, 0.3), A(0.5, 0.3), A(0.5, 0.7)],
});
// Outer corner is the +x / −y quadrant of the corner (0.5, 0.3).
const cx = 0.5;
const cy = 0.3;
const h = 10 * PX;
// A point along the outer bisector at 0.95 h: inside the round join disc,
// inside the miter square, outside the bevel (whose edge sits at h/√2).
const bis = 0.95 * h * Math.SQRT1_2;
// The miter tip corner itself (0.9 h, 0.9 h diagonal), only a miter reaches.
const tipX = cx + 0.9 * h;
const tipY = cy - 0.9 * h;

{
  const out = outlineSpline(ell, W, H, opts({ join: "round" }));
  check("round join: one ring", out.subpaths.length === 1);
  check("round join: bisector point inside", inside(out, cx + bis, cy - bis));
  check("round join: miter tip corner outside", !inside(out, tipX, tipY));
}
{
  const out = outlineSpline(ell, W, H, opts({ join: "bevel" }));
  check("bevel join: one ring", out.subpaths.length === 1);
  check("bevel join: bisector point outside", !inside(out, cx + bis, cy - bis));
  check(
    "bevel join: inner side of the corner is solid",
    inside(out, cx - 0.5 * h, cy + 0.5 * h)
  );
}
{
  const out = outlineSpline(ell, W, H, opts({ join: "miter" }));
  check("miter join: one ring", out.subpaths.length === 1);
  check("miter join: bisector point inside", inside(out, cx + bis, cy - bis));
  check("miter join: tip corner inside", inside(out, tipX, tipY));
  check(
    "miter join: nothing beyond the tip",
    !inside(out, cx + 1.1 * h, cy - 1.1 * h)
  );
}
{
  // A very acute corner (≈ 11° between the legs) exceeds miterLimit 10 →
  // bevel; a generous limit keeps the spike.
  const acute = spline({
    closed: false,
    anchors: [A(0.2, 0.3), A(0.5, 0.3), A(0.2, 0.3 + 0.3 * Math.tan((10 * Math.PI) / 180))],
  });
  const limited = outlineSpline(acute, W, H, opts({ join: "miter", miterLimit: 10 }));
  const spiky = outlineSpline(acute, W, H, opts({ join: "miter", miterLimit: 20 }));
  const bL = bounds(limited);
  const bS = bounds(spiky);
  check(
    "miter limit: over-limit corner bevels (no spike)",
    bL.maxX < 0.5 + 3 * h,
    `maxX ${bL.maxX}`
  );
  check(
    "miter limit: within-limit corner keeps the spike",
    bS.maxX > 0.5 + 5 * h,
    `maxX ${bS.maxX}`
  );
}

// ── Closed circle keeps its hole ────────────────────────────────────────
const K = 0.5522847498; // cubic circle constant
function circle(cxr: number, cyr: number, r: number): SplineSubpath {
  return {
    closed: true,
    anchors: [
      A(cxr + r, cyr, { inHandle: [0, -K * r], outHandle: [0, K * r] }),
      A(cxr, cyr + r, { inHandle: [K * r, 0], outHandle: [-K * r, 0] }),
      A(cxr - r, cyr, { inHandle: [0, K * r], outHandle: [0, -K * r] }),
      A(cxr, cyr - r, { inHandle: [-K * r, 0], outHandle: [K * r, 0] }),
    ],
  };
}

{
  const out = outlineSpline(spline(circle(0.5, 0.5, 0.2)), W, H, opts());
  check("circle: two rings (outer + hole)", out.subpaths.length === 2, `${out.subpaths.length}`);
  check("circle: center is a hole", !inside(out, 0.5, 0.5));
  check("circle: on the stroke is filled", inside(out, 0.7, 0.5) && inside(out, 0.5, 0.3));
  check("circle: 12px outside the radius is empty", !inside(out, 0.7 + 12 * PX, 0.5));
  check("circle: 12px inside the radius is empty", !inside(out, 0.7 - 12 * PX, 0.5));
  check("circle: 8px inside the radius is filled", inside(out, 0.7 - 8 * PX, 0.5));
  check("circle: seam anchor has no notch", inside(out, 0.7 + 9 * PX, 0.5));
}

// ── Crossing strokes union into one ring ────────────────────────────────
{
  const plus = spline(
    { closed: false, anchors: [A(0.2, 0.5), A(0.8, 0.5)] },
    { closed: false, anchors: [A(0.5, 0.2), A(0.5, 0.8)] }
  );
  const out = outlineSpline(plus, W, H, opts());
  check("plus: one merged ring, no seams", out.subpaths.length === 1, `${out.subpaths.length}`);
  check("plus: crossing is filled", inside(out, 0.5, 0.5));
  check(
    "plus: crossing outline is a 12-corner polygon",
    out.subpaths[0]?.anchors.length === 12,
    `${out.subpaths[0]?.anchors.length}`
  );
  const apart = spline(
    { closed: false, anchors: [A(0.1, 0.2), A(0.4, 0.2)] },
    { closed: false, anchors: [A(0.1, 0.8), A(0.4, 0.8)] }
  );
  check(
    "disjoint strokes stay separate rings",
    outlineSpline(apart, W, H, opts()).subpaths.length === 2
  );
}

// ── Self-overlap: a tight U turn fills solid, no inner loop hole ────────
{
  const u = spline({
    closed: false,
    anchors: [A(0.3, 0.5), A(0.5, 0.5), A(0.3, 0.5 + 6 * PX)],
  });
  const out = outlineSpline(u, W, H, opts({ join: "round" }));
  check("tight fold: one ring", out.subpaths.length === 1, `${out.subpaths.length}`);
  check("tight fold: overlap region is solid", inside(out, 0.4, 0.5 + 3 * PX));
}

// ── Per-anchor width taper ──────────────────────────────────────────────
{
  const taper = spline({
    closed: false,
    anchors: [A(0.2, 0.5, { width: 1 }), A(0.8, 0.5, { width: 0 })],
  });
  const out = outlineSpline(taper, W, H, opts());
  check("taper: start keeps full half-width", inside(out, 0.21, 0.5 + 9 * PX));
  check("taper: near the end 5px off is empty", !inside(out, 0.76, 0.5 + 5 * PX));
  check("taper: near the end on the line is filled", inside(out, 0.76, 0.5));
  const b = bounds(out);
  check("taper: hits the zero-width end", close(b.maxX, 0.8, PX), `${b.maxX}`);
}

// ── Aspect: circle stays round in px on a 16:9 canvas ───────────────────
{
  const WW = 1920;
  const HH = 1080;
  const out = outlineSpline(spline(circle(0.5, 0.5, 0.2)), WW, HH, opts({ thicknessPx: 20 }));
  const aspect = WW / HH;
  const outer = out.subpaths.reduce((best, s) =>
    bounds(spline(s)).maxX > bounds(spline(best)).maxX ? s : best
  );
  const radii = outer.anchors.map((a) => {
    const px = a.pos[0] * WW;
    const py = aspectCorrectY(a.pos[1], aspect) * HH;
    return Math.hypot(px - WW / 2, py - HH / 2);
  });
  const rMin = Math.min(...radii);
  const rMax = Math.max(...radii);
  const expect = 0.2 * WW + 10;
  check(
    "aspect: outer ring is a px circle of r + half",
    close(rMin, expect, 3) && close(rMax, expect, 3),
    `min ${rMin.toFixed(1)} max ${rMax.toFixed(1)} expect ${expect}`
  );
  check("aspect: two rings", out.subpaths.length === 2);
}

// ── Degenerate inputs ───────────────────────────────────────────────────
{
  check("thickness 0 → empty", outlineSpline(line, W, H, opts({ thicknessPx: 0 })).subpaths.length === 0);
  check("empty spline → empty", outlineSpline(spline(), W, H, opts()).subpaths.length === 0);
  check(
    "single-anchor subpath → empty",
    outlineSpline(spline({ closed: false, anchors: [A(0.5, 0.5)] }), W, H, opts()).subpaths.length === 0
  );
  check(
    "output subpaths are all closed",
    outlineSpline(spline(circle(0.5, 0.5, 0.2), ...line.subpaths), W, H, opts()).subpaths.every((s) => s.closed)
  );
}

// ── Node: units, cache, coercion ────────────────────────────────────────
function makeCtx(w = W, hh = H): RenderContext {
  return { time: 0, frame: 0, tick: 0, playing: false, state: {}, width: w, height: hh } as unknown as RenderContext;
}
function run(
  ctx: RenderContext,
  input: SplineValue,
  params: Record<string, unknown>
): NodeOutput {
  const defaults: Record<string, unknown> = {};
  for (const p of outlineNode.params) defaults[p.name] = p.default;
  return outlineNode.compute({
    inputs: { path: coerceValue(input, "spline", ctx) },
    auxIn: {},
    params: { ...defaults, ...params },
    ctx,
    nodeId: "n1",
  }) as NodeOutput;
}

{
  const ctx = makeCtx();
  const r1 = run(ctx, line, { thickness: 20, cap: "butt" });
  const s1 = r1.primary as SplineValue;
  check("node: default path yields the quad", s1.kind === "spline" && s1.subpaths[0]?.anchors.length === 4);
  const r2 = run(ctx, line, { thickness: 20, cap: "butt" });
  check("node: unchanged inputs hit the cache (same object)", r2.primary === r1.primary);
  const r3 = run(ctx, line, { thickness: 20, cap: "square" });
  check("node: a param change recomputes", r3.primary !== r1.primary);

  // 2% of a 1000px canvas = 20px → identical to thickness 20 px.
  const pct = run(ctx, line, { thickness: 2, units: "%", cap: "butt" });
  const bp = bounds(pct.primary as SplineValue);
  check(
    "node: units=% resolves against canvas width",
    close(bp.minY, 0.5 - 10 * PX, PX * 0.1) && close(bp.maxY, 0.5 + 10 * PX, PX * 0.1),
    JSON.stringify(bp)
  );

  const wide = run(makeCtx(2000, 1000), line, { thickness: 20, cap: "butt" });
  const bw = bounds(wide.primary as SplineValue);
  // 20px on a 2000-wide canvas: half-width is 10px = 0.005 of width; in
  // canvas01 y (width units) that is still 0.005.
  check(
    "node: px thickness is absolute pixels, not canvas-relative",
    close(bw.maxY - bw.minY, 20 / 2000, 1e-5),
    `${bw.maxY - bw.minY}`
  );

  const none = run(ctx, undefined as unknown as SplineValue, {});
  check("node: missing input → empty spline", (none.primary as SplineValue).subpaths.length === 0);
  outlineNode.dispose?.(ctx, "n1");
  check("node: dispose clears state", !("spline-outline:n1" in ctx.state));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncheck-outline: all passed");
