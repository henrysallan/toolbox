// Guards Trim Path combined vs per-subpath domains, attribute/driver
// sources, metadata carry, and save-compat (missing mode = combined).
//
// Since 2026-10-16 also the `measure` param (spline-trim.ts header):
//   - arc length cuts at the exact arc-length point: exact on lines (handle-
//     less, or with uneven in-line handles), and on curves within the stated
//     tolerance of cubic-arc-length.ts against a dense reference (random
//     cubics, a loop, an exact cusp), both ways (length, and t at a length);
//   - segment is the original mapping, bit for bit: every case recorded in
//     scripts/fixtures/trim-path-legacy.json (HEAD b11e4d6's compute) comes
//     back byte-identical from a node with no `measure` key, from an
//     explicit measure=segment, and through the real loader + evaluator;
//   - compat without a schema bump: deserializeGraph leaves an old save's
//     absent `measure` absent (it reads as segment), a re-save keeps it
//     absent, and a new node (makeInstanceNode, the recipe builder) is born
//     with measure=arc length;
//   - Trim Path (Skia) refuses measure=segment with a reason.
//
//   npx tsx scripts/check-trim-path.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bezier } from "bezier-js";
import type {
  NodeOutput,
  RenderContext,
  SplineSubpath,
  SplineValue,
} from "../src/engine/types.ts";
import { coerceValue } from "../src/engine/coerce.ts";
import {
  makeTrimSourceFn,
  readSubpathAttrScalar,
  trimSubpaths,
  trimSubpathsEach,
} from "../src/engine/spline-trim.ts";
import {
  cubicArcLength,
  cubicParamAtLength,
  cubicSpeed,
} from "../src/engine/cubic-arc-length.ts";
import { trimPathNode } from "../src/nodes/effect/trim-path.ts";
import { sameUpToFloatNoise } from "./skia/snapshot-diff.ts";

// Minimal DOM stubs — the loader / graph-ops / evaluator pull the registry
// and the whole engine in (dynamic imports below, after the stubs).
const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function close(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) < eps;
}

function line(y: number, extra?: Partial<SplineSubpath>): SplineSubpath {
  // Handles make this a linear cubic (B(t) = t), so an arc-length
  // trim at fraction f lands at x = f — a collapsed-handle line does not.
  return {
    anchors: [
      { pos: [0, y], outHandle: [1 / 3, 0] },
      { pos: [1, y], inHandle: [-1 / 3, 0] },
    ],
    closed: false,
    ...extra,
  };
}

function endX(sub: SplineSubpath | undefined): number | undefined {
  return sub?.anchors[sub.anchors.length - 1]?.pos[0];
}

function startX(sub: SplineSubpath | undefined): number | undefined {
  return sub?.anchors[0]?.pos[0];
}

function makeCtx(): RenderContext {
  return {
    time: 0,
    playing: true,
    state: {},
    width: 1920,
    height: 1080,
  } as unknown as RenderContext;
}

function evalTrim(
  subpaths: SplineSubpath[],
  params: Record<string, unknown>
): SplineValue {
  const ctx = makeCtx();
  const path: SplineValue = { kind: "spline", subpaths };
  const coerced = coerceValue(path, "spline", ctx);
  const out = trimPathNode.compute({
    inputs: { path: coerced },
    auxIn: {},
    params,
    ctx,
    nodeId: "trim",
  }) as NodeOutput;
  if (out.primary?.kind !== "spline") {
    throw new Error("trim-path did not emit a spline");
  }
  return out.primary;
}

const A = line(0);
const B = line(0.5);
const PAIR = [A, B];

{
  const out = trimSubpaths(PAIR, 0, 0.5, 0);
  check(
    "combined: end 0.5 keeps only the first of two equal-length subpaths",
    out.length === 1 &&
      close(startX(out[0]) ?? -1, 0) &&
      close(endX(out[0]) ?? -1, 1)
  );
}

{
  const startAt = makeTrimSourceFn(PAIR, "value", 0);
  const endAt = makeTrimSourceFn(PAIR, "value", 0.5);
  const offsetAt = makeTrimSourceFn(PAIR, "value", 0);
  const out = trimSubpathsEach(PAIR, startAt, endAt, offsetAt);
  check(
    "per-subpath: end 0.5 keeps both, each half",
    out.length === 2 &&
      close(startX(out[0]) ?? -1, 0) &&
      close(endX(out[0]) ?? -1, 0.5) &&
      close(startX(out[1]) ?? -1, 0) &&
      close(endX(out[1]) ?? -1, 0.5)
  );
}

{
  const full = trimSubpaths(PAIR, 0, 1, 0);
  check(
    "combined identity: full window returns the same array",
    full === PAIR
  );
}

{
  const empty = trimSubpaths(PAIR, 0.5, 0.5, 0);
  check("combined empty window is []", empty.length === 0);
}

{
  const tagged: SplineSubpath[] = [
    line(0, { groupIndex: 7, driver: 0.25, attrs: { end: 0.5 } }),
  ];
  const out = trimSubpaths(tagged, 0, 0.5, 0);
  check(
    "partial trim carries groupIndex / driver / attrs",
    out.length === 1 &&
      out[0].groupIndex === 7 &&
      out[0].driver === 0.25 &&
      out[0].attrs?.end === 0.5
  );
}

{
  check(
    "readSubpathAttrScalar: float",
    readSubpathAttrScalar(line(0, { attrs: { w: 0.3 } }), "w") === 0.3
  );
  check(
    "readSubpathAttrScalar: vec component 0",
    readSubpathAttrScalar(line(0, { attrs: { w: [0.8, 0.1] } }), "w") === 0.8
  );
  check(
    "readSubpathAttrScalar: missing is undefined",
    readSubpathAttrScalar(line(0), "w") === undefined
  );
}

{
  const subs: SplineSubpath[] = [
    line(0, { attrs: { end: 1 } }),
    line(0.5, { attrs: { end: 0 } }),
  ];
  const startAt = makeTrimSourceFn(subs, "value", 0);
  const endAt = makeTrimSourceFn(subs, "attribute", 1, { attrName: "end" });
  const offsetAt = makeTrimSourceFn(subs, "value", 0);
  const out = trimSubpathsEach(subs, startAt, endAt, offsetAt);
  check(
    "attribute end: first kept, second dropped",
    out.length === 1 && close(endX(out[0]) ?? -1, 1)
  );
}

{
  const subs: SplineSubpath[] = [line(0), line(0.5, { attrs: { end: 0.25 } })];
  const endAt = makeTrimSourceFn(subs, "attribute", 1, { attrName: "end" });
  const out = trimSubpathsEach(
    subs,
    makeTrimSourceFn(subs, "value", 0),
    endAt,
    makeTrimSourceFn(subs, "value", 0)
  );
  check(
    "attribute end: missing falls back to slider (full)",
    out.length === 2 &&
      close(endX(out[0]) ?? -1, 1) &&
      close(endX(out[1]) ?? -1, 0.25)
  );
}

{
  const startAt = makeTrimSourceFn(PAIR, "index", 0);
  const out = trimSubpathsEach(
    PAIR,
    startAt,
    makeTrimSourceFn(PAIR, "value", 1),
    makeTrimSourceFn(PAIR, "value", 0)
  );
  check(
    "index start: first full (t=0), second empty (t=1)",
    out.length === 1 && close(endX(out[0]) ?? -1, 1)
  );
}

{
  const out = evalTrim(PAIR, { trim_start: 0, trim_end: 0.5, trim_offset: 0 });
  check(
    "node: missing mode is combined (save-compat)",
    out.subpaths.length === 1 && close(endX(out.subpaths[0]) ?? -1, 1)
  );
}

{
  const out = evalTrim(PAIR, {
    mode: "combined",
    trim_start: 0,
    trim_end: 0.5,
    trim_offset: 0,
    end_source: "attribute",
    end_attr: "end",
  });
  check(
    "node: combined ignores attribute sources",
    out.subpaths.length === 1 && close(endX(out.subpaths[0]) ?? -1, 1)
  );
}

{
  const out = evalTrim(PAIR, {
    mode: "per subpath",
    trim_start: 0,
    trim_end: 0.5,
    trim_offset: 0,
  });
  check(
    "node: per subpath, uniform end 0.5 halves both",
    out.subpaths.length === 2 &&
      close(endX(out.subpaths[0]) ?? -1, 0.5) &&
      close(endX(out.subpaths[1]) ?? -1, 0.5)
  );
}

{
  const subs: SplineSubpath[] = [
    line(0, { attrs: { end: 0.25 }, groupIndex: 3 }),
    line(0.5, { attrs: { end: 0.75 }, groupIndex: 4 }),
  ];
  const out = evalTrim(subs, {
    mode: "per subpath",
    trim_start: 0,
    trim_end: 1,
    trim_offset: 0,
    end_source: "attribute",
    end_attr: "end",
  });
  check(
    "node: per-subpath attribute end + groupIndex carried",
    out.subpaths.length === 2 &&
      close(endX(out.subpaths[0]) ?? -1, 0.25) &&
      close(endX(out.subpaths[1]) ?? -1, 0.75) &&
      out.subpaths[0].groupIndex === 3 &&
      out.subpaths[1].groupIndex === 4
  );
}

{
  const out = evalTrim(PAIR, {
    mode: "per subpath",
    trim_start: 0,
    trim_end: 1,
    trim_offset: 0,
    start_source: "index",
  });
  check(
    "node: index start drops the last subpath",
    out.subpaths.length === 1
  );
}

// ---------------------------------------------------------------------
// measure = arc length: exact on lines
// ---------------------------------------------------------------------

type P2 = [number, number];
const endPos = (subs: SplineSubpath[]): P2 => {
  const last = subs[subs.length - 1];
  return last.anchors[last.anchors.length - 1].pos as P2;
};
const startPos = (subs: SplineSubpath[]): P2 => subs[0].anchors[0].pos as P2;
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// One long (0.8) and one short (0.2) handle-less segment: total length 1,
// so a fraction is a distance.
const LPATH: SplineSubpath = {
  closed: false,
  anchors: [{ pos: [0, 0] }, { pos: [0.8, 0] }, { pos: [0.8, 0.2] }],
};
const pointOnL = (d: number): P2 => (d <= 0.8 ? [d, 0] : [0.8, d - 0.8]);

{
  let worst = 0;
  for (const e of [0.05, 0.25, 0.5, 0.75, 0.79, 0.81, 0.85, 0.95]) {
    worst = Math.max(worst, dist(endPos(trimSubpaths([LPATH], 0, e, 0, "arc length")), pointOnL(e)));
  }
  for (const s of [0.1, 0.4, 0.82]) {
    worst = Math.max(worst, dist(startPos(trimSubpaths([LPATH], s, 1, 0, "arc length")), pointOnL(s)));
  }
  check("arc length: cuts on an uneven handle-less polyline land at the exact distance (≤ 1e-12)", worst <= 1e-12, `worst ${worst.toExponential(2)}`);
}
{
  // The bug, measured: the segment measure picks the long segment by
  // length, then puts the cut at t = 0.625 of it — on a handle-less line
  // that is 3t² − 2t³ = 0.68 of the way, x = 0.546875, not 0.5.
  const legacy = endPos(trimSubpaths([LPATH], 0, 0.5, 0, "segment"));
  const arc = endPos(trimSubpaths([LPATH], 0, 0.5, 0, "arc length"));
  check(
    "segment measure (the original) cuts 0..0.5 of the 0.8 + 0.2 polyline at x = 0.546875; arc length at 0.5",
    Math.abs(legacy[0] - 0.546875) < 1e-12 && Math.abs(arc[0] - 0.5) < 1e-12,
    `segment ${legacy[0]}, arc length ${arc[0]}`
  );
}
{
  // In-line handles of uneven length: still a straight line, but its
  // parameter runs fast then slow. Arc length ignores that.
  const skewed: SplineSubpath = {
    closed: false,
    anchors: [
      { pos: [0, 0.5], outHandle: [0.7, 0] },
      { pos: [1, 0.5], inHandle: [-0.05, 0] },
    ],
  };
  let worst = 0;
  for (const e of [0.1, 0.3, 0.5, 0.9]) {
    worst = Math.max(worst, dist(endPos(trimSubpaths([skewed], 0, e, 0, "arc length")), [e, 0.5]));
  }
  check("arc length: a straight cubic with uneven in-line handles cuts at the exact distance (≤ 1e-12)", worst <= 1e-12, `worst ${worst.toExponential(2)}`);
}
{
  // Closed, uneven rectangle (0.6 × 0.2, perimeter 1.6) with an offset
  // window across the seam: one stitched piece, kept length = window.
  const rect: SplineSubpath = {
    closed: true,
    anchors: [{ pos: [0.2, 0.4] }, { pos: [0.8, 0.4] }, { pos: [0.8, 0.6] }, { pos: [0.2, 0.6] }],
  };
  const out = trimSubpaths([rect], 0.3, 0.9, 0.5, "arc length");
  // Window [0.8, 1.4] of 1.6 → from distance 1.28 (0.48 along the bottom
  // edge, which runs right to left from (0.8, 0.6)) round the seam to 0.64
  // (0.04 down the right edge).
  check(
    "arc length: offset window across a closed rectangle's seam is one piece with exact ends",
    out.length === 1 && dist(startPos(out), [0.32, 0.6]) < 1e-12 && dist(endPos(out), [0.8, 0.44]) < 1e-12,
    JSON.stringify([startPos(out), endPos(out)])
  );
}

// ---------------------------------------------------------------------
// measure = arc length: curves against a dense reference
// ---------------------------------------------------------------------

// Reference length, independent of cubic-arc-length.ts's adaptivity:
// composite 8-point Gauss–Legendre over 4096 uniform intervals (bezier-js's
// own derivative); around a known (near-)cusp `sing`, split there and grade
// the intervals geometrically toward it (64 per octave, 50 octaves), so
// every piece is smooth at its own scale.
const GLX = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GLW = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
function glUniform(c: Bezier, a: number, b: number, n: number): number {
  let sum = 0;
  const h = (b - a) / n;
  for (let i = 0; i < n; i++) {
    const m = a + (i + 0.5) * h;
    for (let j = 0; j < 4; j++) {
      for (const sgn of [-1, 1]) {
        const d = c.derivative(m + sgn * 0.5 * h * GLX[j]);
        sum += GLW[j] * Math.hypot(d.x, d.y) * 0.5 * h;
      }
    }
  }
  return sum;
}
function refLength(c: Bezier, a: number, b: number, n = 4096, sing?: number): number {
  if (!(b > a)) return 0;
  if (sing === undefined || sing < a || sing > b) return glUniform(c, a, b, n);
  if (sing > a && sing < b) return refLength(c, a, sing, n, sing) + refLength(c, sing, b, n, sing);
  // `sing` is an end: grade toward it.
  let sum = 0;
  let far = sing === b ? a : b;
  for (let k = 1; k <= 50; k++) {
    const near = sing + (far - sing) * 2 ** -1;
    sum += glUniform(c, Math.min(far, near), Math.max(far, near), 64);
    far = near;
  }
  return sum + glUniform(c, Math.min(far, sing), Math.max(far, sing), 64);
}
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// An exact cusp at t0 = 0.3 (B′(0.3) = 0): P0 (0,0), P1 (0.2,1), P3 (1,0),
// P2 solved from (1−t0)²(P1−P0) + 2t0(1−t0)(P2−P1) + t0²(P3−P2) = 0.
const T0 = 0.3;
const cuspP2 = (() => {
  const k1 = -((1 - T0) ** 2) + 2 * T0 * (1 - T0);
  const den = 2 * T0 * (1 - T0) - T0 * T0;
  return { x: (k1 * 0.2 - T0 * T0 * 1) / den, y: (k1 * 1 - T0 * T0 * 0) / den };
})();
const curves: { name: string; c: Bezier; cusp?: number }[] = [
  { name: "cusp", c: new Bezier(0, 0, 0.2, 1, cuspP2.x, cuspP2.y, 1, 0), cusp: T0 },
  { name: "loop", c: new Bezier(0.1, 0.5, 1.2, 0.0, -0.2, 0.0, 0.9, 0.5) },
  // Speed minimum 7.5e-5 at t = 0.5, rounded over w ≈ 1.2e-5 — the case
  // plain adaptive quadrature gets wrong by ~1e-9 (and its inverse by ~1e-6).
  { name: "near-cusp", c: new Bezier(0, 0, 1, 1, 0, 1.0001, 1, 0), cusp: 0.5 },
  // Nearly collapsed handles: the same rounded corner at an end.
  { name: "tiny start handle", c: new Bezier(0, 0, 1e-4, 0, 0.3, 1, 1, 1), cusp: 0 },
  { name: "tiny end handle", c: new Bezier(0, 0, 0.7, 0, 1, 1 - 2e-4, 1, 1), cusp: 1 },
  { name: "collapsed line", c: new Bezier(0.1, 0.1, 0.1, 0.1, 0.9, 0.3, 0.9, 0.3) },
];
for (let i = 0; i < 120; i++) {
  const p = Array.from({ length: 8 }, () => rand());
  curves.push({ name: `random ${i}`, c: new Bezier(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]) });
}
{
  const REF_N = 4096;
  let worstLen = 0;
  let worstLenName = "";
  let worstInv = 0;
  let worstInvName = "";
  for (const { name, c, cusp } of curves) {
    const k = cubicSpeed(c);
    const total = cubicArcLength(k);
    const ref = refLength(c, 0, 1, REF_N, cusp);
    const e = Math.abs(total - ref) / k.scale;
    if (e > worstLen) [worstLen, worstLenName] = [e, name];
    for (const q of [0.013, 0.2, 0.31, 0.5, 0.77, 0.999]) {
      const t = cubicParamAtLength(k, q * total, total);
      const reached = refLength(c, 0, t, REF_N, cusp);
      const ei = Math.abs(reached - q * ref) / k.scale;
      if (ei > worstInv) [worstInv, worstInvName] = [ei, `${name} @${q}`];
    }
  }
  check(
    `arc length: cubic lengths match a dense reference within 1e-11 of the control polygon (${curves.length} cubics: random, a loop, an exact cusp, a near cusp, near-collapsed handles)`,
    worstLen <= 1e-11,
    `worst ${worstLen.toExponential(2)} (${worstLenName})`
  );
  check(
    "arc length: t at a length lands at that length within 1e-11 of the control polygon",
    worstInv <= 1e-11,
    `worst ${worstInv.toExponential(2)} (${worstInvName})`
  );
}
{
  // Through trimSubpaths on a curved compound path: each cut piece's own
  // length is the window's share of the whole (the pieces are re-measured
  // here by the dense reference, not the trim's integrator).
  const S: SplineSubpath = {
    closed: false,
    anchors: [
      { pos: [0.18, 0.7], outHandle: [0.12, -0.35] },
      { pos: [0.5, 0.5], inHandle: [-0.14, 0], outHandle: [0.14, 0] },
      { pos: [0.82, 0.3], inHandle: [-0.12, 0.35] },
    ],
  };
  const U: SplineSubpath = { closed: false, anchors: [{ pos: [0.1, 0.8], outHandle: [0.02, 0] }, { pos: [0.9, 0.1], inHandle: [0, 0.6] }] };
  const refSub = (sub: SplineSubpath) => {
    let L = 0;
    const a = sub.anchors;
    for (let i = 0; i + 1 < a.length; i++) {
      const p0 = a[i].pos;
      const p3 = a[i + 1].pos;
      const c1 = a[i].outHandle ?? [0, 0];
      const c2 = a[i + 1].inHandle ?? [0, 0];
      L += refLength(new Bezier(p0[0], p0[1], p0[0] + c1[0], p0[1] + c1[1], p3[0] + c2[0], p3[1] + c2[1], p3[0], p3[1]), 0, 1, 1024);
    }
    return L;
  };
  const whole = refSub(S) + refSub(U);
  let worst = 0;
  for (const [s, e, o] of [[0, 0.5, 0], [0.1, 0.35, 0], [0.2, 0.9, 0.45], [0, 0.3, 0.85]] as const) {
    const kept = trimSubpaths([S, U], s, e, o, "arc length").reduce((acc, sub) => acc + refSub(sub), 0);
    worst = Math.max(worst, Math.abs(kept / whole - (e - s)));
  }
  check("arc length: the pieces of an offset window over two curves keep exactly the window's share", worst < 1e-9, `worst ${worst.toExponential(2)}`);
}

// ---------------------------------------------------------------------
// measure = segment: the original output, bit for bit
// ---------------------------------------------------------------------

const legacy = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/fixtures/trim-path-legacy.json"), "utf8")
) as { cases: { name: string; subpaths: SplineSubpath[]; params: Record<string, unknown>; out: SplineSubpath[] }[] };
{
  const absentBad: string[] = [];
  const explicitBad: string[] = [];
  let arcDiffers = 0;
  for (const c of legacy.cases) {
    if ("measure" in c.params) absentBad.push(`${c.name}: fixture carries measure`);
    const want = JSON.stringify(c.out);
    if (!sameUpToFloatNoise(JSON.stringify(evalTrim(c.subpaths, c.params).subpaths), want)) absentBad.push(c.name);
    if (!sameUpToFloatNoise(JSON.stringify(evalTrim(c.subpaths, { ...c.params, measure: "segment" }).subpaths), want)) explicitBad.push(c.name);
    if (!sameUpToFloatNoise(JSON.stringify(evalTrim(c.subpaths, { ...c.params, measure: "arc length" }).subpaths), want)) arcDiffers++;
  }
  check(
    `old save (no measure key): the pre-fix output on all ${legacy.cases.length} recorded cases (to last-ulp float noise: the fixture was recorded on macOS, CI runs Linux)`,
    absentBad.length === 0,
    absentBad.join(" | ")
  );
  check("measure=segment: the pre-fix output on every recorded case (to float noise)", explicitBad.length === 0, explicitBad.join(" | "));
  check("measure=arc length changes the uneven cases (the switch does something)", arcDiffers >= legacy.cases.length - 2, `${arcDiffers} of ${legacy.cases.length} differ`);
}

// ---------------------------------------------------------------------
// compat: the real loader, graph-ops and evaluator
// ---------------------------------------------------------------------

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { makeInstanceNode } = await import("@/state/graph-ops");
const { buildRecipe } = await import("@/state/recipe-builder");
const { deserializeGraph, serializeGraph, CURRENT_SCHEMA } = await import("@/lib/project");
const { evaluateGraph } = await import("@/engine/evaluator");
type EvalCache = import("@/engine/evaluator").EvalCache;

const evalCtx = {
  gl: {},
  width: 8,
  height: 8,
  time: 0,
  frame: 0,
  tick: 0,
  ticksPerFrame: 1000,
  fps: 60,
  playing: false,
  offline: false,
  cursor: { x: 0, y: 0, active: false },
  state: {},
  allocImage: () => ({ kind: "image", texture: {}, width: 8, height: 8 }),
  allocMask: () => ({ kind: "mask", texture: {}, width: 8, height: 8 }),
  allocUv: () => ({ kind: "uv", texture: {}, width: 8, height: 8 }),
  releaseTexture: () => {},
  drawFullscreen: () => {},
  clearTarget: () => {},
  getShader: () => ({}),
} as any;

// Spline Draw (its own trim at the identity) → Trim Path, through the
// evaluator, from xyflow nodes as the editor holds them.
function evaluateTrim(nodes: any[], edges: any[], trimId: string): SplineSubpath[] | null {
  const gNodes = nodes.map((n) => ({
    id: n.id,
    type: n.data.defType,
    params: n.data.params,
    exposedParams: n.data.exposedParams,
    animation: n.data.animation,
  }));
  const gEdges = edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
  }));
  const r = evaluateGraph(gNodes as any, gEdges as any, evalCtx, new Map() as EvalCache, trimId);
  const v = r.outputs.get(trimId)?.primary;
  return v?.kind === "spline" ? v.subpaths : null;
}
function drawParams(subpaths: SplineSubpath[]): Record<string, unknown> {
  const def = getNodeDef("spline-draw")!;
  const p: Record<string, unknown> = {};
  for (const d of def.params) p[d.name] = d.default;
  return { ...p, spline: { kind: "spline", subpaths }, stroke_enabled: false, fill_enabled: false };
}
const EDGE = { id: "e1", source: "src", sourceHandle: "out:primary", target: "trim", targetHandle: "in:path" };

{
  // An old project: Trim Paths saved before `measure` existed.
  const picks = ["L polyline 0.1..0.85", "closed rectangle seam stitched", "per subpath random offset", "two subpaths combined 0..0.5"];
  const bad: string[] = [];
  let loadedSegment = true;
  let resavedSegment = true;
  for (const name of picks) {
    const c = legacy.cases.find((x) => x.name === name)!;
    const saved = {
      schemaVersion: CURRENT_SCHEMA,
      nodes: [
        { id: "src", defType: "spline-draw", position: { x: 0, y: 0 }, params: drawParams(c.subpaths) },
        { id: "trim", defType: "trim-path", position: { x: 300, y: 0 }, params: structuredClone(c.params) },
      ],
      edges: [EDGE],
    } as any;
    const res = await deserializeGraph(saved);
    const trim = res.nodes.find((n) => n.id === "trim")!;
    if (trim.data.params.measure !== "segment") loadedSegment = false;
    const out = evaluateTrim(res.nodes, res.edges, "trim");
    if (!out || !sameUpToFloatNoise(JSON.stringify(out), JSON.stringify(c.out))) bad.push(name);
    const resaved = await serializeGraph(res.nodes, res.edges);
    if ((resaved.nodes.find((n: any) => n.id === "trim")!.params as Record<string, unknown>).measure !== "segment") resavedSegment = false;
  }
  check("loader: an old save's Trim Path loads pinned to measure = segment (migrateLoadedParams), so the panel shows the mode it renders", loadedSegment);
  check(`loader + evaluator: those old saves render the pre-fix output (${picks.length} cases, to float noise)`, bad.length === 0, bad.join(" | "));
  check("re-saving an old project writes measure = segment (it stays on segment)", resavedSegment);
}
{
  // A new node: makeInstanceNode writes every def default.
  const trim = makeInstanceNode("trim-path", { x: 300, y: 0 });
  trim.id = "trim";
  trim.data.params = { ...trim.data.params, trim_end: 0.5 };
  check("new node: makeInstanceNode gives measure = arc length", trim.data.params.measure === "arc length", String(trim.data.params.measure));
  const src = makeInstanceNode("spline-draw", { x: 0, y: 0 });
  src.id = "src";
  src.data.params = drawParams([LPATH]);
  const out = evaluateTrim([src, trim], [EDGE], "trim");
  check(
    "new node through the evaluator: 0..0.5 of the 0.8 + 0.2 polyline ends at x = 0.5",
    !!out && dist(endPos(out), [0.5, 0]) < 1e-12,
    out ? JSON.stringify(endPos(out)) : "no output"
  );
  // …and a saved new node keeps it across save / load.
  const saved = await serializeGraph([src, trim] as any, [EDGE] as any);
  const res = await deserializeGraph(saved);
  check("a new node round-trips measure = arc length through save / load", res.nodes.find((n) => n.id === "trim")?.data.params.measure === "arc length");
}
{
  // The agent path: recipes mint nodes through makeInstanceNode too.
  const built = buildRecipe({
    name: "trim",
    nodes: [
      { id: "shape", type: "star" },
      { id: "t", type: "trim-path", params: { trim_end: 0.5 } },
    ],
    edges: [{ from: "shape:out", to: "t:in:path" }],
    outputs: [{ name: "out", from: "t:out", type: "spline" }],
  });
  const t = built.nodes.find((n) => n.data.defType === "trim-path");
  check("recipe builder: a Trim Path from a recipe gets measure = arc length", t?.data.params.measure === "arc length", String(t?.data.params.measure));
}

// ---------------------------------------------------------------------
// Trim Path (Skia): arc length only
// ---------------------------------------------------------------------
{
  const def = getNodeDef("skia-trim-path")!;
  const drawing = {
    kind: "skia_draw",
    node: { k: "shape", id: "s", geom: { k: "path", d: { v: "M 0 0 L 100 0 L 100 20" } }, paint: { style: "stroke" } },
  } as any;
  const problemsFor = (params: Record<string, unknown>): string[] => {
    const out = def.compute({ inputs: { drawing }, auxIn: {}, params: { trim_start: 0, trim_end: 0.5, trim_offset: 0, ...params }, ctx: makeCtx(), nodeId: "tx" }) as NodeOutput;
    return ((out.primary as any)?.problems ?? []) as string[];
  };
  const measureProblem = (ps: string[]) => ps.some((p) => p.includes('measure "segment"'));
  check(
    "Trim Path (Skia): default / absent / arc length trim with no measure problem",
    def.params.find((p) => p.name === "measure")?.default === "arc length" &&
      !measureProblem(problemsFor({})) &&
      !measureProblem(problemsFor({ measure: "arc length" }))
  );
  const seg = problemsFor({ measure: "segment" });
  check("Trim Path (Skia): measure = segment is refused with a reason", measureProblem(seg) && seg.some((p) => /no React Native Skia equivalent/.test(p)), seg.join(" | "));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
