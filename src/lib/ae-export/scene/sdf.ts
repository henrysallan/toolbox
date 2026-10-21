// Hard SDF chains → one shape layer (spec §10 M4; which trees qualify:
// ../sdf-chain.ts; results specdocs/ae-m4/sdf.md).
//
// The tree is lowered from the graph (not the evaluated AST, so a keyed
// param keeps its keys) into a boolean of offset leaves:
//
//   leaf        circle → Ellipse · rectangle → Rect (roundness) · line
//               segment → a rotated capsule Rect · polygon / star → Polystar
//               · triangle → a Path; a star / triangle offset → Offset Paths
//               (Round join) on it
//   offset      round(r) and onion(t) land on the leaves: an offset
//               distributes over min / max and flips sign under the
//               subtracted side; onion(X) = round_t(X) − round_−t(X)
//   booleans    one group per operand, then Merge Paths Add / Intersect /
//               Subtract, in tree order
//   position    nearest the leaf = innermost group. translate / rotate /
//               scale → a group transform; mirror → the kept half (an
//               Intersect with the half-plane) plus its reflection; repeat →
//               a Repeater per axis over the clipped cell; polar → a
//               rotating Repeater over the clipped wedge
//
// SDF space is Y-UP and width-relative (the compiled shader samples
// p = v_uv with y rescaled about 0.5 — measured: a circle at y = 0.3 renders
// 0.2·W below the centre): X = x·W, Y = H/2 − (y − 0.5)·W, lengths ·W, and a
// positive SDF rotation is counter-clockwise on screen (AE rotation −deg).
//
// Consumers:
//   sdf-rasterize   Fill (foreground, fg_alpha) under a centred Stroke of
//                   2·contour_width px (contour, contour_alpha) over a
//                   comp-sized background Rect (background, bg_alpha)
//   sdf-to-mask     white on black (swapped by invert); threshold offsets
//   sdf-to-spline   its consumers' geometry (shape.ts), iso offsets; toolbox
//                   traces the contour on a resolution² grid of [0, 1]²
//
// A value is a Num: toolbox's value at any layer-local tick, plus — when it
// is ONE animated param mapped affinely — that param, so the AE property
// converts its keys exactly (context.ts scalarProp / pairProp). Anything else
// animated is sampled per frame. Structure (counts, copies, clip need) is
// fixed over the layer's window, or the chain bakes.

import { getNodeDef } from "@/engine/registry";
import type { AeAffine } from "../convert";
import { sdfChainVerdict, sdfSlotsOf, type SdfChainGraph } from "../sdf-chain";
import type { AeEffect, AeLayer, AePath, AePlanNode, AeProp, AeShapeItem, AeShapeTransform } from "../types";
import { colorProp, driverOf, evalBlock, keyCtx, pairProp, scalarProp, staticNumber, windowFrames } from "./context";
import { numbersOf, parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { animatedUpstream, localTick, type Geom } from "./shape";
import { sampledTrackToAe } from "../convert";

// ---- values -----------------------------------------------------------------------

interface Lin {
  node: string;
  param: string;
  fallback: number;
  k: number;
  c: number;
}

interface Num {
  at(tick: number): number;
  animated: boolean;
  lin?: Lin;
}

const K = (c: number): Num => ({ at: () => c, animated: false });
const isK = (n: Num) => !n.animated;

function addN(a: Num, b: Num): Num {
  if (isK(a) && isK(b)) return K(a.at(0) + b.at(0));
  const lin = isK(b) && a.lin ? { ...a.lin, c: a.lin.c + b.at(0) } : isK(a) && b.lin ? { ...b.lin, c: b.lin.c + a.at(0) } : undefined;
  return { at: (t) => a.at(t) + b.at(t), animated: true, ...(lin ? { lin } : {}) };
}
function mulN(a: Num, k: number): Num {
  if (isK(a)) return K(a.at(0) * k);
  return { at: (t) => a.at(t) * k, animated: true, ...(a.lin ? { lin: { ...a.lin, k: a.lin.k * k, c: a.lin.c * k } } : {}) };
}
function fnN(args: Num[], f: (...x: number[]) => number): Num {
  if (args.every(isK)) return K(f(...args.map((a) => a.at(0))));
  return { at: (t) => f(...args.map((a) => a.at(t))), animated: true };
}
const negN = (a: Num) => mulN(a, -1);

type Pt = [Num, Num];
type Box = [number, number, number, number]; // x0, y0, x1, y1 (SDF units)
const EMPTY_BOX: Box = [Infinity, Infinity, -Infinity, -Infinity];
const boxUnion = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const boxOf = (pts: [number, number][]): Box => pts.reduce<Box>((b, p) => boxUnion(b, [p[0], p[1], p[0], p[1]]), EMPTY_BOX);
const boxEmpty = (b: Box) => !(b[0] <= b[2] && b[1] <= b[3]);
const corners = (b: Box): [number, number][] => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[2], b[3]],
  [b[0], b[3]],
];
const rot = (p: [number, number], c: [number, number], a: number): [number, number] => {
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + ca * x - sa * y, c[1] + sa * x + ca * y];
};

// ---- IR -----------------------------------------------------------------------------

type LeafGeom =
  | { kind: "circle"; c: Pt; r: Num }
  | { kind: "rect"; c: Pt; half: Pt; corner: Num }
  | { kind: "capsule"; a: Pt; b: Pt; r: Num }
  | { kind: "polygon"; c: Pt; r: Num; n: number }
  | { kind: "star"; c: Pt; r: Num; n: number; m: Num }
  | { kind: "triangle"; v: [Pt, Pt, Pt] };

type ChainOp =
  | { kind: "translate"; id: string; t: Pt }
  | { kind: "rotate"; id: string; deg: Num; c: Pt }
  | { kind: "scale"; id: string; s: Pt; c: Pt }
  | { kind: "mirror"; id: string; axis: 1 | 2 | 3; c: Pt }
  | { kind: "repeat"; id: string; s: Pt; c: Pt; bounded: boolean; lim: [number, number] }
  | { kind: "polar"; id: string; c: Pt; n: number; rot: Num };

type Ir =
  | { kind: "empty" }
  | { kind: "leaf"; id: string; geom: LeafGeom; delta: Num; chain: ChainOp[] }
  | { kind: "bool"; id: string; op: "add" | "intersect"; parts: Ir[] }
  | { kind: "sub"; id: string; a: Ir; b: Ir };

const EMPTY: Ir = { kind: "empty" };

// ---- the walk's context ------------------------------------------------------------

interface SdfCtx {
  scope: Scope;
  W: number;
  H: number;
  // Layer-local ticks every structural decision holds over: the window's
  // frames when anything upstream is animated, else its first frame.
  ticks: number[];
  tick0: number;
  // SDF-space box the consumer shows (padded): the canvas, or [0, 1]² for
  // sdf-to-spline's tracing grid.
  view: Box;
  consumer: string;
}

function chainGraph(scope: Scope): SdfChainGraph {
  const { ctx } = scope;
  return {
    type: (id) => ctx.graph.node(id)?.type,
    values: (id) => ctx.graph.params(id),
    input(id, socket) {
      const w = ctx.graph.wireInto(id, `in:${socket}`);
      if (!w) return undefined;
      return { id: w.source, handle: w.sourceHandle === "out:primary" ? "out" : w.sourceHandle.replace(/^out:/, "") };
    },
    animated(id) {
      const n = ctx.graph.node(id);
      const def = n ? getNodeDef(n.type) : undefined;
      const out = new Set<string>();
      for (const p of def?.params ?? []) if (driverOf(ctx, id, p.name) || (ctx.graph.block(id, p.name)?.keyframes.length ?? 0) > 1) out.add(p.name);
      return out;
    },
  };
}

// A param (wire > keys > constant), or the wired socket that overrides it.
function paramN(s: SdfCtx, node: string, param: string, fallback: number): Num {
  const { ctx } = s.scope;
  const drv = driverOf(ctx, node, param);
  const lin: Lin = { node, param, fallback, k: 1, c: 0 };
  if (drv) return { at: (t) => numbersOf(ctx.graph.valueAt(drv, t))?.[0] ?? fallback, animated: true, lin };
  const b = ctx.graph.block(node, param);
  if (b && b.keyframes.length > 1) return { at: (t) => evalBlock(b, t, fallback), animated: true, lin };
  return K(staticNumber(ctx, node, param, fallback));
}

function socketN(s: SdfCtx, node: string, socket: string, comp: number): Num | undefined {
  const { ctx } = s.scope;
  const w = ctx.graph.wireInto(node, `in:${socket}`);
  if (!w) return undefined;
  const ep = sourceEndpoint(w);
  const at = (t: number) => {
    const v = numbersOf(ctx.graph.valueAt(ep, t));
    if (!v || v[comp] === undefined) throw new BakeSignal(`${node}'s ${socket} input (${ep}) has no numeric value`);
    return v[comp];
  };
  if (!animatedUpstream(ctx, w.source)) return K(at(s.tick0));
  ctx.report.sampled(node, `${socket}: driven by ${ep} → per-frame keys`);
  return { at, animated: true };
}

const valueN = (s: SdfCtx, node: string, socket: string, comp: number, param: string, fallback: number) => socketN(s, node, socket, comp) ?? paramN(s, node, param, fallback);
const pairN = (s: SdfCtx, node: string, socket: string, px: string, py: string, fx: number, fy: number): Pt => [valueN(s, node, socket, 0, px, fx), valueN(s, node, socket, 1, py, fy)];

const samples = (s: SdfCtx, n: Num) => (n.animated ? s.ticks.map((t) => n.at(t)) : [n.at(s.tick0)]);
const P = (s: SdfCtx, p: Pt, t: number): [number, number] => [p[0].at(t), p[1].at(t)];

// ---- lowering (graph → IR) ------------------------------------------------------------

function lower(s: SdfCtx, endpoint: string | undefined, delta: Num): Ir {
  if (!endpoint) return EMPTY;
  const { ctx } = s.scope;
  const { id } = parseOut(endpoint);
  const n = ctx.graph.node(id);
  if (!n) return EMPTY;
  const v = ctx.graph.params(id);
  const input = (socket: string) => {
    const w = ctx.graph.wireInto(id, `in:${socket}`);
    return w ? sourceEndpoint(w) : undefined;
  };
  const leaf = (geom: LeafGeom): Ir => ({ kind: "leaf", id, geom, delta, chain: chainOf(s, id) });
  const two = (op: "intersect" | "sub", subtractFlip: boolean): Ir => {
    const a = lower(s, input("a"), delta);
    const b = lower(s, input("b"), subtractFlip ? negN(delta) : delta);
    if (a.kind === "empty") return EMPTY;
    if (b.kind === "empty") return op === "sub" ? a : EMPTY;
    return op === "sub" ? { kind: "sub", id, a, b } : { kind: "bool", id, op: "intersect", parts: [a, b] };
  };
  switch (n.type) {
    case "sdf-circle":
      return leaf({ kind: "circle", c: pairN(s, id, "center", "x", "y", 0.5, 0.5), r: valueN(s, id, "radius", 0, "radius", 0.2) });
    case "sdf-rectangle": {
      const w = valueN(s, id, "size", 0, "width", 0.4);
      const h = valueN(s, id, "size", 1, "height", 0.4);
      const half: Pt = [fnN([w], (x) => Math.max(0, x / 2)), fnN([h], (x) => Math.max(0, x / 2))];
      // rectangle.ts clamps the radius into [0, min(half)].
      const corner = fnN([paramN(s, id, "corner_radius", 0), half[0], half[1]], (r, a, b) => Math.max(0, Math.min(Math.min(a, b), r)));
      return leaf({ kind: "rect", c: pairN(s, id, "center", "x", "y", 0.5, 0.5), half, corner });
    }
    case "sdf-line-segment":
      return leaf({
        kind: "capsule",
        a: pairN(s, id, "a", "ax", "ay", 0.25, 0.5),
        b: pairN(s, id, "b", "bx", "by", 0.75, 0.5),
        r: fnN([valueN(s, id, "thickness", 0, "thickness", 0.04)], (x) => Math.max(0, x)),
      });
    case "sdf-polygon":
      return leaf({ kind: "polygon", c: pairN(s, id, "center", "x", "y", 0.5, 0.5), r: valueN(s, id, "radius", 0, "radius", 0.25), n: Math.round(Math.max(3, staticNumber(ctx, id, "sides", 6))) });
    case "sdf-star": {
      const pts = Math.round(Math.max(3, staticNumber(ctx, id, "points", 5)));
      const m = fnN([paramN(s, id, "sharpness", 2.5)], (x) => Math.max(2, Math.min(pts, x)));
      return leaf({ kind: "star", c: pairN(s, id, "center", "x", "y", 0.5, 0.5), r: valueN(s, id, "radius", 0, "radius", 0.25), n: pts, m });
    }
    case "sdf-triangle":
      return leaf({ kind: "triangle", v: [pairN(s, id, "a", "ax", "ay", 0.5, 0.25), pairN(s, id, "b", "bx", "by", 0.25, 0.75), pairN(s, id, "c", "cx", "cy", 0.75, 0.75)] });
    case "sdf-union":
    case "sdf-smooth-union": {
      const parts = sdfSlotsOf(v)
        .map((slot) => lower(s, input(slot), delta))
        .filter((x) => x.kind !== "empty");
      if (!parts.length) return EMPTY;
      return parts.length === 1 ? parts[0] : { kind: "bool", id, op: "add", parts };
    }
    case "sdf-intersection":
    case "sdf-smooth-intersection":
      return two("intersect", false);
    case "sdf-subtraction":
    case "sdf-smooth-subtraction":
      return two("sub", true);
    case "sdf-round":
      return lower(s, input("sdf"), addN(delta, valueN(s, id, "radius", 0, "radius", 0.02)));
    case "sdf-onion": {
      // |d| − t ≤ δ' ⇔ −T ≤ d ≤ T with T = t + δ: the shape offset out by T
      // minus the shape offset in by T.
      const T = addN(fnN([valueN(s, id, "thickness", 0, "thickness", 0.01)], (x) => Math.max(0, x)), delta);
      const ts = samples(s, T);
      if (ts.every((x) => x <= 0)) return EMPTY;
      if (ts.some((x) => x <= 0)) throw new BakeSignal(`${ctx.graph.name(id)}: its ring thickness (+ offsets) crosses zero inside the window — the ring appears / vanishes`);
      const src = input("sdf");
      const outer = lower(s, src, T);
      const inner = lower(s, src, negN(T));
      if (outer.kind === "empty") return EMPTY;
      return inner.kind === "empty" ? outer : { kind: "sub", id, a: outer, b: inner };
    }
    case "sdf-material":
      return lower(s, input("sdf"), delta);
    default:
      throw new BakeSignal(`${n.type} (${id}) has no shape-layer form`);
  }
}

// The leaf's position chain, nearest the leaf first.
function chainOf(s: SdfCtx, leafId: string): ChainOp[] {
  const { ctx } = s.scope;
  const out: ChainOp[] = [];
  let w = ctx.graph.wireInto(leafId, "in:position");
  const seen = new Set<string>();
  while (w) {
    const id = w.source;
    if (seen.has(id)) break;
    seen.add(id);
    const n = ctx.graph.node(id);
    const v = ctx.graph.params(id);
    if (!n) break;
    switch (n.type) {
      case "sdf-translate":
        out.push({ kind: "translate", id, t: pairN(s, id, "offset", "tx", "ty", 0, 0) });
        break;
      case "sdf-rotate": {
        // The param is degrees; the `angle` socket is radians.
        const sock = socketN(s, id, "angle", 0);
        const deg = sock ? mulN(sock, 180 / Math.PI) : paramN(s, id, "rotation", 0);
        out.push({ kind: "rotate", id, deg, c: pairN(s, id, "pivot", "cx", "cy", 0.5, 0.5) });
        break;
      }
      case "sdf-scale": {
        const sc: Pt = [valueN(s, id, "scale", 0, "sx", 1), valueN(s, id, "scale", 1, "sy", 1)];
        if ([...samples(s, sc[0]), ...samples(s, sc[1])].some((x) => !(x > 1e-4))) throw new BakeSignal(`${ctx.graph.name(id)}: a scale ≤ 0 (toolbox clamps it to 1e-4)`);
        out.push({ kind: "scale", id, s: sc, c: [paramN(s, id, "cx", 0.5), paramN(s, id, "cy", 0.5)] });
        break;
      }
      case "sdf-mirror": {
        const axis = v.axis === "y" ? 2 : v.axis === "both" ? 3 : 1;
        out.push({ kind: "mirror", id, axis, c: pairN(s, id, "center", "center_x", "center_y", 0.5, 0.5) });
        break;
      }
      case "sdf-repeat": {
        const sp: Pt = [fnN([valueN(s, id, "spacing", 0, "spacing_x", 0.25)], (x) => Math.max(0.001, x)), fnN([valueN(s, id, "spacing", 1, "spacing_y", 0.25)], (x) => Math.max(0.001, x))];
        out.push({
          kind: "repeat",
          id,
          s: sp,
          c: pairN(s, id, "center", "center_x", "center_y", 0.5, 0.5),
          bounded: v.bounded === true,
          lim: [Math.round(Math.max(0, staticNumber(ctx, id, "limit_x", 3))), Math.round(Math.max(0, staticNumber(ctx, id, "limit_y", 3)))],
        });
        break;
      }
      case "sdf-polar":
        out.push({ kind: "polar", id, c: pairN(s, id, "center", "center_x", "center_y", 0.5, 0.5), n: Math.round(Math.max(1, staticNumber(ctx, id, "segments", 6))), rot: paramN(s, id, "rotation", 0) });
        break;
      default:
        throw new BakeSignal(`${n.type} (${id}) in a position chain has no shape-layer form`);
    }
    w = ctx.graph.wireInto(id, "in:position");
  }
  return out;
}

// ---- boxes ----------------------------------------------------------------------------

// The leaf's region (offset included) at a tick, in its own sample space.
function leafBox(g: LeafGeom, delta: number, t: number, s: SdfCtx): Box {
  const pad = (b: Box, d: number): Box => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
  switch (g.kind) {
    case "circle":
      return pad(boxOf([P(s, g.c, t)]), g.r.at(t) + delta);
    case "rect": {
      const c = P(s, g.c, t);
      return [c[0] - g.half[0].at(t) - delta, c[1] - g.half[1].at(t) - delta, c[0] + g.half[0].at(t) + delta, c[1] + g.half[1].at(t) + delta];
    }
    case "capsule":
      return pad(boxOf([P(s, g.a, t), P(s, g.b, t)]), g.r.at(t) + delta);
    case "polygon":
      return pad(boxOf([P(s, g.c, t)]), g.r.at(t) + delta / Math.cos(Math.PI / g.n));
    case "star":
      return pad(boxOf([P(s, g.c, t)]), g.r.at(t) + Math.max(0, delta));
    case "triangle":
      return pad(boxOf(g.v.map((p) => P(s, p, t))), Math.max(0, delta));
  }
}

// The region of an op's input space a region `b` of its output space maps to
// (geometry under the op's inverse), at a tick.
function opRegionBox(op: ChainOp, b: Box, t: number, s: SdfCtx): Box {
  if (boxEmpty(b)) return b;
  switch (op.kind) {
    case "translate": {
      const d = P(s, op.t, t);
      return [b[0] + d[0], b[1] + d[1], b[2] + d[0], b[3] + d[1]];
    }
    case "rotate":
      return boxOf(corners(b).map((p) => rot(p, P(s, op.c, t), (op.deg.at(t) * Math.PI) / 180)));
    case "scale": {
      const c = P(s, op.c, t);
      const k = P(s, op.s, t);
      return boxOf(corners(b).map((p) => [c[0] + (p[0] - c[0]) * k[0], c[1] + (p[1] - c[1]) * k[1]]));
    }
    case "mirror": {
      const c = P(s, op.c, t);
      let r = b;
      if (op.axis & 1) {
        const x1 = r[2];
        if (x1 < c[0]) return EMPTY_BOX;
        r = [2 * c[0] - x1, r[1], x1, r[3]];
      }
      if (op.axis & 2) {
        const y1 = r[3];
        if (y1 < c[1]) return EMPTY_BOX;
        r = [r[0], 2 * c[1] - y1, r[2], y1];
      }
      return r;
    }
    case "repeat": {
      const plan = repeatPlan(op);
      let out = EMPTY_BOX;
      const sp = P(s, op.s, t);
      for (const sx of plan.x)
        for (const sy of plan.y) {
          const clip = clipBox(op, sx, sy, s, t, b);
          const cb: Box = [Math.max(b[0], clip[0]), Math.max(b[1], clip[1]), Math.min(b[2], clip[2]), Math.min(b[3], clip[3])];
          if (boxEmpty(cb)) continue;
          out = boxUnion(out, [cb[0] + sx.k0 * sp[0], cb[1] + sy.k0 * sp[1], cb[2] + sx.k1 * sp[0], cb[3] + sy.k1 * sp[1]]);
        }
      return out;
    }
    case "polar": {
      const c = P(s, op.c, t);
      const r = Math.max(...corners(b).map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      return op.n === 1 ? b : [c[0] - r, c[1] - r, c[0] + r, c[1] + r];
    }
  }
}

// The box of an op's OUTPUT space that pixels in `v` (its input space) reach
// — the op's forward fold, conservatively.
function opViewBox(op: ChainOp, v: Box, t: number, s: SdfCtx): Box {
  switch (op.kind) {
    case "translate": {
      const d = P(s, op.t, t);
      return [v[0] - d[0], v[1] - d[1], v[2] - d[0], v[3] - d[1]];
    }
    case "rotate":
      return boxOf(corners(v).map((p) => rot(p, P(s, op.c, t), (-op.deg.at(t) * Math.PI) / 180)));
    case "scale": {
      const c = P(s, op.c, t);
      const k = P(s, op.s, t);
      return boxOf(corners(v).map((p) => [c[0] + (p[0] - c[0]) / k[0], c[1] + (p[1] - c[1]) / k[1]]));
    }
    case "mirror": {
      const c = P(s, op.c, t);
      const fold = (lo: number, hi: number, m: number): [number, number] => [lo <= m && hi >= m ? m : m + Math.min(Math.abs(lo - m), Math.abs(hi - m)), m + Math.max(Math.abs(lo - m), Math.abs(hi - m))];
      const x = op.axis & 1 ? fold(v[0], v[2], c[0]) : [v[0], v[2]];
      const y = op.axis & 2 ? fold(v[1], v[3], c[1]) : [v[1], v[3]];
      return [x[0], y[0], x[1], y[1]];
    }
    case "repeat": {
      const c = P(s, op.c, t);
      const sp = P(s, op.s, t);
      const axis = (lo: number, hi: number, cc: number, ss: number, lim: number): [number, number] => {
        if (!op.bounded) return [cc - ss / 2, cc + ss / 2];
        if (lim === 0) return [lo, hi];
        const kLo = Math.max(-lim, Math.round((lo - cc) / ss));
        const kHi = Math.min(lim, Math.round((hi - cc) / ss));
        const a = kLo <= -lim ? lo - kLo * ss : cc - ss / 2;
        const b = kHi >= lim ? hi - kHi * ss : cc + ss / 2;
        return [Math.min(a, cc - ss / 2), Math.max(b, cc + ss / 2)];
      };
      const x = axis(v[0], v[2], c[0], sp[0], op.lim[0]);
      const y = axis(v[1], v[3], c[1], sp[1], op.lim[1]);
      return [x[0], y[0], x[1], y[1]];
    }
    case "polar": {
      const c = P(s, op.c, t);
      const r = Math.max(...corners(v).map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      return [c[0] - r, c[1] - r, c[0] + r, c[1] + r];
    }
  }
}

// ---- repeat structure -------------------------------------------------------------------

// One run of copies along an axis: copy indices k0..k1, the cell clip
// relative to the cell centre (±Infinity = unclipped side).
interface Run {
  k0: number;
  k1: number;
  lo: number; // in spacing units: −0.5, or −Infinity
  hi: number;
}

interface RepeatPlan {
  x: Run[];
  y: Run[];
}

const repeatPlans = new WeakMap<ChainOp, RepeatPlan>();
function repeatPlan(op: Extract<ChainOp, { kind: "repeat" }>): RepeatPlan {
  const p = repeatPlans.get(op);
  if (!p) throw new Error("repeat plan read before it was made");
  return p;
}

// The cell clip of a run pair as an SDF box at a tick (relative to the cell
// the run starts at, i.e. in the repeat's output space).
function clipBox(op: Extract<ChainOp, { kind: "repeat" }>, rx: Run, ry: Run, s: SdfCtx, t: number, around: Box): Box {
  const c = P(s, op.c, t);
  const sp = P(s, op.s, t);
  const BIG = 1e3;
  const side = (cc: number, ss: number, u: number, edge: number) => (Number.isFinite(u) ? cc + u * ss : edge);
  return [
    side(c[0], sp[0], rx.lo, Math.min(around[0], c[0]) - BIG),
    side(c[1], sp[1], ry.lo, Math.min(around[1], c[1]) - BIG),
    side(c[0], sp[0], rx.hi, Math.max(around[2], c[0]) + BIG),
    side(c[1], sp[1], ry.hi, Math.max(around[3], c[1]) + BIG),
  ];
}

// ---- emission (IR → shape items) ------------------------------------------------------------

const deep = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

interface Emit {
  s: SdfCtx;
  // px affines of SDF x, y and lengths.
  X: AeAffine;
  Y: AeAffine;
  L: AeAffine;
  copies: number;
}

function prop1(e: Emit, n: Num, m: AeAffine, label: string, owner: string): AeProp<number> {
  const { ctx, clock } = e.s.scope;
  const ap = (x: number) => m.scale * x + m.offset;
  if (!n.animated) return { v: ap(n.at(e.s.tick0)) };
  if (n.lin) return scalarProp(ctx, clock, n.lin.node, n.lin.param, { map: { scale: m.scale * n.lin.k, offset: m.scale * n.lin.c + m.offset }, fallback: n.lin.fallback, label });
  ctx.report.sampled(owner, `${label}: a combination of animated values → per-frame keys`);
  const r = sampledTrackToAe(windowFrames(clock), (t) => [ap(n.at(t))], keyCtx(ctx, clock), label);
  return "v" in r.prop ? { v: r.prop.v[0] } : { keys: r.prop.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 };
}

function prop2(e: Emit, p: Pt, m: [AeAffine, AeAffine], opts: { spatial?: boolean; label: string; owner: string }): AeProp<[number, number]> {
  const { ctx, clock } = e.s.scope;
  const ap = (i: number, x: number) => m[i].scale * x + m[i].offset;
  if (!p[0].animated && !p[1].animated) return { v: [ap(0, p[0].at(e.s.tick0)), ap(1, p[1].at(e.s.tick0))] };
  if (p.every((n) => !n.animated || n.lin)) {
    const part = (n: Num, i: number) =>
      n.lin
        ? { node: n.lin.node, param: n.lin.param, fallback: n.lin.fallback, map: { scale: m[i].scale * n.lin.k, offset: m[i].scale * n.lin.c + m[i].offset } }
        : // A constant axis: a source with no param resolves to its fallback.
          { node: "\u0000const", param: opts.label, fallback: ap(i, n.at(e.s.tick0)), map: { scale: 1, offset: 0 } };
    return pairProp(ctx, clock, [part(p[0], 0), part(p[1], 1)], { spatial: opts.spatial, label: opts.label, owner: opts.owner });
  }
  ctx.report.sampled(opts.owner, `${opts.label}: a combination of animated values → per-frame keys`);
  const r = sampledTrackToAe(windowFrames(clock), (t) => [ap(0, p[0].at(t)), ap(1, p[1].at(t))], keyCtx(ctx, clock), opts.label);
  return r.prop as AeProp<[number, number]>;
}

// A path that may change per frame (vertex count fixed).
function pathProp(e: Emit, nums: Num[], at: (t: number) => AePath, label: string, owner: string): AeProp<AePath> {
  const { ctx, clock } = e.s.scope;
  if (nums.every(isK)) return { v: at(e.s.tick0) };
  ctx.report.sampled(owner, `${label}: animated vertices → path keys every frame`);
  const [f0, f1] = windowFrames(clock);
  const keys = [];
  for (let f = f0; f <= f1; f++) keys.push({ t: f / ctx.fps, v: at(localTick(e.s.scope, f)), inInterp: "linear" as const, outInterp: "linear" as const });
  return keys.length < 2 ? { v: keys[0].v } : { keys, dims: 1 };
}

const pxOf = (e: Emit, p: [number, number]): [number, number] => [e.X.scale * p[0] + e.X.offset, e.Y.scale * p[1] + e.Y.offset];
const polyPath = (e: Emit, pts: [number, number][]): AePath => ({ vertices: pts.map((p) => pxOf(e, p)), inTangents: pts.map(() => [0, 0]), outTangents: pts.map(() => [0, 0]), closed: true });

// Every sampled value of `n` must be > 0 (else the shape vanishes mid-window).
function positive(e: Emit, n: Num, what: string, owner: string): "all" | "none" {
  const xs = samples(e.s, n);
  if (xs.every((x) => x > 1e-9)) return "all";
  if (xs.every((x) => x <= 1e-9)) return "none";
  throw new BakeSignal(`${e.s.scope.ctx.graph.name(owner)}: its ${what} reaches zero inside the window — the shape appears / vanishes`);
}

function emitLeaf(e: Emit, ir: Extract<Ir, { kind: "leaf" }>): AeShapeItem | null {
  const { s } = e;
  const { ctx } = s.scope;
  const g = ir.geom;
  const d = ir.delta;
  const name = ctx.graph.name(ir.id);
  const owner = ir.id;
  const center = (c: Pt) => prop2(e, c, [e.X, e.Y], { spatial: true, label: "center", owner });
  switch (g.kind) {
    case "circle": {
      const R = addN(g.r, d);
      if (positive(e, R, "radius", owner) === "none") return null;
      return { kind: "ellipse", name, size: prop2(e, [R, R], [{ scale: 2 * e.L.scale, offset: 0 }, { scale: 2 * e.L.scale, offset: 0 }], { label: "size", owner }), position: center(g.c) };
    }
    case "rect": {
      const hx = addN(g.half[0], d);
      const hy = addN(g.half[1], d);
      if (positive(e, fnN([hx, hy], Math.min), "size", owner) === "none") return null;
      // Growing rounds every corner by δ; shrinking keeps max(r + δ, 0).
      const corner = isK(d) && d.at(0) >= 0 ? addN(g.corner, d) : fnN([g.corner, d], (r, dd) => Math.max(0, r + dd));
      return {
        kind: "rect",
        name,
        size: prop2(e, [hx, hy], [{ scale: 2 * e.L.scale, offset: 0 }, { scale: 2 * e.L.scale, offset: 0 }], { label: "size", owner }),
        position: center(g.c),
        roundness: prop1(e, corner, e.L, "roundness", owner),
      };
    }
    case "capsule": {
      // segSdf − r: a stadium — a Rect of length |b − a| + 2r, height 2r,
      // roundness r, turned to the segment's angle about its midpoint.
      const R = addN(g.r, d);
      if (positive(e, R, "thickness", owner) === "none") return null;
      const len = fnN([g.a[0], g.a[1], g.b[0], g.b[1]], (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay));
      const mid: Pt = [mulN(addN(g.a[0], g.b[0]), 0.5), mulN(addN(g.a[1], g.b[1]), 0.5)];
      // atan2 in SDF (Y-up) space; AE turns clockwise on Y-down pixels.
      const deg = fnN([g.a[0], g.a[1], g.b[0], g.b[1]], (ax, ay, bx, by) => (-Math.atan2(by - ay, bx - ax) * 180) / Math.PI);
      const rect: AeShapeItem = {
        kind: "rect",
        name,
        size: prop2(e, [addN(len, mulN(R, 2)), mulN(R, 2)], [e.L, e.L], { label: "size", owner }),
        position: { v: [0, 0] },
        roundness: prop1(e, R, e.L, "roundness", owner),
      };
      return { kind: "group", name: `${name} segment`, contents: [rect], transform: { position: center(mid), rotation: prop1(e, deg, { scale: 1, offset: 0 }, "angle", owner) } };
    }
    case "polygon": {
      // polySdf is the distance to the edge LINES: an offset keeps the
      // corners sharp and moves the inradius, so the circumradius grows by
      // δ / cos(π/n) — still a Polystar.
      const R = addN(g.r, mulN(d, 1 / Math.cos(Math.PI / g.n)));
      if (positive(e, R, "radius", owner) === "none") return null;
      return { kind: "polystar", name, type: "polygon", points: { v: g.n }, position: center(g.c), rotation: { v: 0 }, outerRadius: prop1(e, R, e.L, "radius", owner), outerRoundness: { v: 0 } };
    }
    case "star": {
      if (positive(e, g.r, "radius", owner) === "none") return null;
      const an = Math.PI / g.n;
      // Eroded past its inscribed radius (centre → edge line) a star is gone.
      const inscribed = fnN([g.r, g.m], (r, m) => {
        const ri = (r * Math.sin(Math.PI / m - an)) / Math.sin(Math.PI / m);
        return (ri * r * Math.sin(an)) / Math.hypot(r * Math.cos(an) - ri, r * Math.sin(an));
      });
      if (positive(e, addN(inscribed, d), "inscribed radius", owner) === "none") return null;
      // starSdf's inner vertex: r·sin(π/m − π/n) / sin(π/m).
      const inner = isK(g.m) ? mulN(g.r, Math.sin(Math.PI / g.m.at(0) - an) / Math.sin(Math.PI / g.m.at(0))) : fnN([g.r, g.m], (r, m) => (r * Math.sin(Math.PI / m - an)) / Math.sin(Math.PI / m));
      const star: AeShapeItem = {
        kind: "polystar",
        name,
        type: "star",
        points: { v: g.n },
        position: center(g.c),
        rotation: { v: 0 },
        outerRadius: prop1(e, g.r, e.L, "outer radius", owner),
        innerRadius: prop1(e, inner, e.L, "inner radius", owner),
        outerRoundness: { v: 0 },
        innerRoundness: { v: 0 },
      };
      return offsetted(e, star, d, name, owner);
    }
    case "triangle": {
      const nums = g.v.flat();
      const inradius = fnN(nums, (ax, ay, bx, by, cx, cy) => {
        const area2 = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
        const per = Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by) + Math.hypot(ax - cx, ay - cy);
        return per > 0 ? area2 / per : 0;
      });
      if (positive(e, addN(inradius, d), "inradius", owner) === "none") return null;
      const path: AeShapeItem = { kind: "path", name, path: pathProp(e, nums, (t) => polyPath(e, g.v.map((p) => P(s, p, t))), "vertices", owner) };
      return offsetted(e, path, d, name, owner);
    }
  }
}

// An exact-SDF leaf offset by δ ≠ 0: Offset Paths with a Round join (the
// Minkowski offset: round where the boundary turns away, sharp where it
// turns in).
function offsetted(e: Emit, item: AeShapeItem, d: Num, name: string, owner: string): AeShapeItem {
  if (isK(d) && Math.abs(d.at(0)) < 1e-12) return item;
  return { kind: "group", name: `${name} offset`, contents: [item, { kind: "offset", amount: prop1(e, d, e.L, "offset", owner), join: "round", miterLimit: 4 }] };
}

// The shape region of `ir`, as ONE item whose paths are the region.
function emitIr(e: Emit, ir: Ir): AeShapeItem | null {
  const { ctx } = e.s.scope;
  switch (ir.kind) {
    case "empty":
      return null;
    case "leaf": {
      let item = emitLeaf(e, ir);
      if (!item) return null;
      // Region boxes level by level (union over the ticks), and the view each
      // level sees.
      const views = viewsOf(e.s, ir.chain);
      let boxes = e.s.ticks.map((t) => leafBox(ir.geom, ir.delta.at(t), t, e.s));
      ir.chain.forEach((op, i) => {
        if (op.kind === "repeat") planRepeat(e.s, op, boxes, views[i]);
        if (!item) return;
        item = wrapOp(e, op, item, boxes);
        boxes = boxes.map((b, j) => opRegionBox(op, b, e.s.ticks[j], e.s));
      });
      return item;
    }
    case "bool": {
      const parts = ir.parts.map((p) => emitIr(e, p)).filter((x): x is AeShapeItem => !!x);
      if (ir.op === "intersect" && parts.length < ir.parts.length) return null;
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0];
      return { kind: "group", name: ctx.graph.name(ir.id), contents: [...parts, { kind: "merge", mode: ir.op }] };
    }
    case "sub": {
      const a = emitIr(e, ir.a);
      if (!a) return null;
      const b = emitIr(e, ir.b);
      if (!b) return a;
      return { kind: "group", name: ctx.graph.name(ir.id), contents: subtractOrder(a, b) };
    }
  }
}

// Merge Paths Subtract keeps the FIRST operand in the group and removes the
// ones after it (measured, specdocs/ae-m4/sdf.md).
function subtractOrder(a: AeShapeItem, b: AeShapeItem): AeShapeItem[] {
  return [a, b, { kind: "merge", mode: "subtract" }];
}

// The view box (SDF units, per tick) on each op's INPUT side: what pixels
// reach there through the ops nearer the canvas (the canvas itself for the
// op nearest it).
function viewsOf(s: SdfCtx, chain: ChainOp[]): Box[][] {
  const out: Box[][] = new Array(chain.length);
  let v = s.ticks.map(() => s.view);
  for (let i = chain.length - 1; i >= 0; i--) {
    out[i] = v;
    v = v.map((b, j) => opViewBox(chain[i], b, s.ticks[j], s));
  }
  return out;
}

const within = (b: Box, lo: number, hi: number, axis: 0 | 1) => b[axis] >= lo - 1e-9 && b[axis + 2] <= hi + 1e-9;

function planRepeat(s: SdfCtx, op: Extract<ChainOp, { kind: "repeat" }>, boxes: Box[], views: Box[]): void {
  const axis = (a: 0 | 1, lim: number): Run[] => {
    const fits = boxes.every((b, j) => {
      const t = s.ticks[j];
      const c = op.c[a].at(t);
      const sp = op.s[a].at(t);
      return boxEmpty(b) || within(b, c - sp / 2, c + sp / 2, a);
    });
    if (op.bounded) {
      if (lim === 0) return [{ k0: 0, k1: 0, lo: -Infinity, hi: Infinity }];
      if (fits) return [{ k0: -lim, k1: lim, lo: -Infinity, hi: Infinity }];
      const runs: Run[] = [{ k0: -lim, k1: -lim, lo: -Infinity, hi: 0.5 }];
      if (lim > 1) runs.push({ k0: -lim + 1, k1: lim - 1, lo: -0.5, hi: 0.5 });
      runs.push({ k0: lim, k1: lim, lo: -0.5, hi: Infinity });
      return runs;
    }
    // Unbounded: the cells the view (the repeat's input side) touches.
    let k0 = Infinity;
    let k1 = -Infinity;
    views.forEach((v, j) => {
      const t = s.ticks[j];
      const c = op.c[a].at(t);
      const sp = op.s[a].at(t);
      k0 = Math.min(k0, Math.ceil((v[a] - c - sp / 2) / sp));
      k1 = Math.max(k1, Math.floor((v[a + 2] - c + sp / 2) / sp));
    });
    if (!(k1 >= k0)) return [];
    return [{ k0, k1, lo: fits ? -Infinity : -0.5, hi: fits ? Infinity : 0.5 }];
  };
  repeatPlans.set(op, { x: axis(0, op.lim[0]), y: axis(1, op.lim[1]) });
}

// A clip region as a Rect / polygon item in the op's output space.
function clipRect(e: Emit, x0: Num, y0: Num, x1: Num, y1: Num, name: string): AeShapeItem {
  return {
    kind: "rect",
    name,
    size: prop2(e, [fnN([x0, x1], (a, b) => b - a), fnN([y0, y1], (a, b) => b - a)], [e.L, e.L], { label: "clip size", owner: e.s.consumer }),
    position: prop2(e, [mulN(addN(x0, x1), 0.5), mulN(addN(y0, y1), 0.5)], [e.X, e.Y], { label: "clip center", owner: e.s.consumer }),
    roundness: { v: 0 },
  };
}

function clipped(name: string, item: AeShapeItem, clip: AeShapeItem): AeShapeItem {
  return { kind: "group", name: `${name} clip`, contents: [item, clip, { kind: "merge", mode: "intersect" }] };
}

const MARGIN = 0.05; // SDF units past every box a clip has to cover

function wrapOp(e: Emit, op: ChainOp, item: AeShapeItem, boxes: Box[]): AeShapeItem | null {
  const { s } = e;
  const { ctx } = s.scope;
  const name = ctx.graph.name(op.id);
  const all = boxes.reduce(boxUnion, EMPTY_BOX);
  if (boxEmpty(all)) return null;
  const tr = (t: AeShapeTransform): AeShapeItem => ({ kind: "group", name, contents: [item], transform: t });
  switch (op.kind) {
    case "translate":
      return tr({ position: prop2(e, op.t, [{ scale: e.X.scale, offset: 0 }, { scale: e.Y.scale, offset: 0 }], { spatial: true, label: "offset", owner: op.id }) });
    case "rotate": {
      const c = prop2(e, op.c, [e.X, e.Y], { spatial: true, label: "pivot", owner: op.id });
      // Counter-clockwise in SDF space = clockwise-negative in AE.
      return tr({ anchor: c, position: deep(c), rotation: prop1(e, op.deg, { scale: -1, offset: 0 }, "rotation", op.id) });
    }
    case "scale": {
      const c = prop2(e, op.c, [e.X, e.Y], { spatial: true, label: "center", owner: op.id });
      return tr({ anchor: c, position: deep(c), scale: prop2(e, op.s, [{ scale: 100, offset: 0 }, { scale: 100, offset: 0 }], { label: "scale", owner: op.id }) });
    }
    case "mirror": {
      let cur: AeShapeItem | null = item;
      for (const bit of [1, 2] as const) {
        if (!(op.axis & bit) || !cur) continue;
        const a = bit === 1 ? 0 : 1;
        // Only the half on the + side of the center is sampled.
        const kept = boxes.map((b, j) => {
          const c = op.c[a].at(s.ticks[j]);
          return boxEmpty(b) ? b : a === 0 ? ([Math.max(b[0], c), b[1], b[2], b[3]] as Box) : ([b[0], Math.max(b[1], c), b[2], b[3]] as Box);
        });
        if (kept.every(boxEmpty)) return null;
        const fits = boxes.every((b, j) => boxEmpty(b) || b[a] >= op.c[a].at(s.ticks[j]) - 1e-9);
        let half: AeShapeItem = cur;
        if (!fits) {
          const lo = op.c[a];
          const hi = K(all[a + 2] + MARGIN);
          const o0 = K(all[1 - a] - MARGIN);
          const o1 = K(all[3 - a] + MARGIN);
          const clip = a === 0 ? clipRect(e, lo, o0, hi, o1, `${name} half`) : clipRect(e, o0, lo, o1, hi, `${name} half`);
          half = clipped(name, cur, clip);
          ctx.report.note(op.id, `the shape crosses the mirror line — the kept half is an Intersect with the half-plane`);
        }
        const c = prop2(e, op.c, [e.X, e.Y], { spatial: true, label: "center", owner: op.id });
        const flip: AeShapeItem = { kind: "group", name: `${name} reflection`, contents: [deep(half)], transform: { anchor: c, position: deep(c), scale: { v: a === 0 ? [-100, 100] : [100, -100] } } };
        cur = { kind: "group", name, contents: [half, flip, { kind: "merge", mode: "add" }] };
        boxes = boxes.map((b, j) => opRegionBox({ ...op, axis: bit }, b, s.ticks[j], s));
      }
      return cur;
    }
    case "repeat": {
      const plan = repeatPlan(op);
      if (!plan.x.length || !plan.y.length) return null;
      const groups: AeShapeItem[] = [];
      let copies = 0;
      for (const rx of plan.x)
        for (const ry of plan.y) {
          const n = (rx.k1 - rx.k0 + 1) * (ry.k1 - ry.k0 + 1);
          copies += n;
          let cell: AeShapeItem = deep(item);
          if (Number.isFinite(rx.lo) || Number.isFinite(rx.hi) || Number.isFinite(ry.lo) || Number.isFinite(ry.hi)) {
            const edge = (c: Num, sp: Num, u: number, far: number) => (Number.isFinite(u) ? addN(c, mulN(sp, u)) : K(far));
            const clip = clipRect(e, edge(op.c[0], op.s[0], rx.lo, all[0] - MARGIN), edge(op.c[1], op.s[1], ry.lo, all[1] - MARGIN), edge(op.c[0], op.s[0], rx.hi, all[2] + MARGIN), edge(op.c[1], op.s[1], ry.hi, all[3] + MARGIN), `${name} cell`);
            cell = clipped(name, cell, clip);
          }
          const rep = (k0: number, k1: number, axis: 0 | 1): AeShapeItem => ({
            kind: "repeater",
            name: `${name} ${axis === 0 ? "x" : "y"}`,
            copies: { v: k1 - k0 + 1 },
            offset: { v: k0 },
            composite: "below",
            transform: {
              position: axis === 0 ? prop2(e, [op.s[0], K(0)], [{ scale: e.X.scale, offset: 0 }, { scale: 1, offset: 0 }], { label: "spacing x", owner: op.id }) : prop2(e, [K(0), op.s[1]], [{ scale: 1, offset: 0 }, { scale: e.Y.scale, offset: 0 }], { label: "spacing y", owner: op.id }),
              scale: { v: [100, 100] },
              rotation: { v: 0 },
            },
          });
          const contents: AeShapeItem[] = [cell];
          if (rx.k0 !== 0 || rx.k1 !== 0) contents.push(rep(rx.k0, rx.k1, 0));
          if (ry.k0 !== 0 || ry.k1 !== 0) contents.push(rep(ry.k0, ry.k1, 1));
          groups.push({ kind: "group", name: `${name} ${rx.k0}..${rx.k1} × ${ry.k0}..${ry.k1}`, contents });
        }
      e.copies += copies;
      if (e.copies > COPY_BUDGET) throw new BakeSignal(`${name}: ${e.copies} repeat copies — past the ${COPY_BUDGET}-copy budget for one shape layer`);
      ctx.report.note(op.id, `→ Repeater${groups.length > 1 ? "s" : ""}: ${copies} cop${copies === 1 ? "y" : "ies"}${groups.length > 1 ? ` in ${groups.length} runs (edge cells keep their overflow)` : ""}`);
      return { kind: "group", name, contents: [...groups, { kind: "merge", mode: "add" }] };
    }
    case "polar": {
      if (op.n === 1) return item;
      const sector = (2 * Math.PI) / op.n;
      const inWedge = boxes.every((b, j) => {
        if (boxEmpty(b)) return true;
        const t = s.ticks[j];
        const c = P(s, op.c, t);
        const r0 = op.rot.at(t);
        return corners(b).every((p) => {
          const a = Math.atan2(p[1] - c[1], p[0] - c[0]) - r0;
          const w = Math.atan2(Math.sin(a), Math.cos(a));
          return Math.abs(w) <= sector / 2 + 1e-9 && Math.hypot(p[0] - c[0], p[1] - c[1]) > 0;
        });
      });
      let cell = item;
      if (!inWedge) {
        const R = Math.max(...corners(all).map((p) => Math.max(...s.ticks.map((t) => Math.hypot(p[0] - op.c[0].at(t), p[1] - op.c[1].at(t)))))) + MARGIN;
        const wedge = (t: number): [number, number][] => {
          const c = P(s, op.c, t);
          const r0 = op.rot.at(t);
          const u = (a: number, r: number): [number, number] => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
          if (op.n === 2) {
            const a = u(r0 - Math.PI / 2, R);
            const b = u(r0 + Math.PI / 2, R);
            return [a, [a[0] + 2 * R * Math.cos(r0), a[1] + 2 * R * Math.sin(r0)], [b[0] + 2 * R * Math.cos(r0), b[1] + 2 * R * Math.sin(r0)], b];
          }
          return [c, u(r0 - sector / 2, R), u(r0, R / Math.cos(sector / 2)), u(r0 + sector / 2, R)];
        };
        const clip: AeShapeItem = { kind: "path", name: `${name} sector`, path: pathProp(e, [op.c[0], op.c[1], op.rot], (t) => polyPath(e, wedge(t)), "sector", op.id) };
        cell = clipped(name, item, clip);
        ctx.report.note(op.id, "the shape crosses its sector — each copy is an Intersect with the wedge");
      }
      e.copies += op.n;
      if (e.copies > COPY_BUDGET) throw new BakeSignal(`${name}: ${e.copies} copies — past the ${COPY_BUDGET}-copy budget for one shape layer`);
      const c = prop2(e, op.c, [e.X, e.Y], { spatial: true, label: "center", owner: op.id });
      ctx.report.note(op.id, `→ Repeater: ${op.n} copies turned ${(360 / op.n).toFixed(4).replace(/\.?0+$/, "")}° about the center`);
      return {
        kind: "group",
        name,
        contents: [
          cell,
          { kind: "repeater", name: `${name} copies`, copies: { v: op.n }, offset: { v: 0 }, composite: "below", transform: { anchor: c, position: { v: [0, 0] }, scale: { v: [100, 100] }, rotation: { v: 360 / op.n } } },
          { kind: "merge", mode: "add" },
        ],
      };
    }
  }
}

const COPY_BUDGET = 2000;

// ---- the consumers -------------------------------------------------------------------------

function makeCtx(scope: Scope, consumer: string, view: Box): SdfCtx {
  const { ctx } = scope;
  const [f0, f1] = windowFrames(scope.clock);
  const tick0 = localTick(scope, f0);
  const animated = animatedUpstream(ctx, consumer);
  const ticks: number[] = [];
  if (animated) for (let f = f0; f <= f1; f++) ticks.push(localTick(scope, f));
  else ticks.push(tick0);
  return { scope, W: ctx.canvas.width, H: ctx.canvas.height, ticks, tick0, view, consumer };
}

function verdictOrBake(scope: Scope, consumer: string) {
  const v = sdfChainVerdict(consumer, chainGraph(scope));
  if (!v.native) throw new BakeSignal(`its SDF chain has no shape-layer form at ${v.type} (${v.node}): ${v.reason}`);
  return v;
}

// The region of the tree into `consumer`'s `in:sdf`, offset by `delta`.
function region(scope: Scope, consumer: string, view: Box, delta: (s: SdfCtx) => Num): { item: AeShapeItem | null; e: Emit } {
  const { ctx } = scope;
  const s = makeCtx(scope, consumer, view);
  const W = s.W;
  const H = s.H;
  const e: Emit = { s, X: { scale: W, offset: 0 }, Y: { scale: -W, offset: H / 2 + W / 2 }, L: { scale: W, offset: 0 }, copies: 0 };
  const w = ctx.graph.wireInto(consumer, "in:sdf");
  const ir = lower(s, w ? sourceEndpoint(w) : undefined, delta(s));
  return { item: emitIr(e, ir), e };
}

const VIEW_PAD = 0.02;

// The visible canvas in SDF units: x ∈ [0, 1]; y ∈ 0.5 ± H/2W (aspect
// corrected) or [0, 1] (aspect_correct off: p = v_uv per axis).
function canvasView(scope: Scope, aspect: boolean): Box {
  const { width: W, height: H } = scope.ctx.canvas;
  const hy = aspect ? (0.5 * H) / W : 0.5;
  return [-VIEW_PAD, 0.5 - hy - VIEW_PAD, 1 + VIEW_PAD, 0.5 + hy + VIEW_PAD];
}

// aspect_correct off squashes the SDF's y by H/W about the canvas centre.
function aspectWrap(scope: Scope, item: AeShapeItem, aspect: boolean, id: string): AeShapeItem {
  const { width: W, height: H } = scope.ctx.canvas;
  if (aspect || W === H) return item;
  scope.ctx.report.approx(id, "aspect_correct off: the shape is squashed by H/W (exact); toolbox's edge and contour widths squash with it, AE's stay round");
  return { kind: "group", name: "aspect", contents: [item], transform: { anchor: { v: [W / 2, H / 2] }, position: { v: [W / 2, H / 2] }, scale: { v: [100, (100 * H) / W] } } };
}

// Toolbox's edge is smoothstep(soft, −soft, d), soft = max(softness, 0.5)
// px: across a straight edge that is the CDF of an Epanechnikov kernel,
// σ = soft/√5. AE's coverage anti-aliasing is a 1-px box, σ = 1/√12. The
// difference is a Gaussian Blur 2 on the fill — over transparency, so its
// linear-light mixing never touches the fill / background mix — at
// σ = 0.2858·Blurriness (spec §14, measured kernel). Measured in AE:
// specdocs/ae-m4/sdf.md.
export const SDF_AA_SIGMA_PX = 1 / Math.sqrt(12);
export const SDF_BLUR_SIGMA_PER_BLURRINESS = 0.2858;
// Measured: at softness 1 px the blur moved the share of pixels off by
// > 16/255 by under 0.05 points (not worth a second layer); at 2 and 4 px it
// cut it from 1.19 % / 2.53 % to 0.03 % / 0.003 %.
export const SDF_EDGE_BLUR_MIN_SOFTNESS_PX = 1.5;

export function sdfEdgeBlurriness(softnessPx: number): number {
  if (!(softnessPx >= SDF_EDGE_BLUR_MIN_SOFTNESS_PX)) return 0;
  const sigma = softnessPx / Math.sqrt(5);
  return Math.sqrt(sigma * sigma - SDF_AA_SIGMA_PX * SDF_AA_SIGMA_PX) / SDF_BLUR_SIGMA_PER_BLURRINESS;
}

// The edge blur of a consumer (softness in px at render resolution; d is in
// width units, so a portrait canvas scales it by W / H).
function edgeBlur(scope: Scope, id: string): AeProp<number> | null {
  const { ctx, clock } = scope;
  const k = pxPerUnit(scope);
  const animated = !!driverOf(ctx, id, "softness") || (ctx.graph.block(id, "softness")?.keyframes.length ?? 0) > 1;
  const s0 = staticNumber(ctx, id, "softness", 1);
  if (!animated) {
    const b = sdfEdgeBlurriness(s0 * k);
    const soft = Math.max(0.5, s0);
    if (!b) {
      ctx.report.approx(id, `edge: AE's coverage anti-aliasing (a 1-px box) stands in for toolbox's smoothstep over ±${soft} px of the distance — edge pixels only (measured: ≤ 1.5 % of pixels off by > 16/255 at 1 px, geometry within 0.05 px)`);
      return null;
    }
    ctx.report.approx(id, `edge softness ${soft} px → Gaussian Blur 2, Blurriness ${b.toFixed(3)} on the fill (toolbox's smoothstep is an Epanechnikov edge; AE's blur a Gaussian over its 1-px coverage)`);
    if (staticNumber(ctx, id, "contour_alpha", 0) > 0 && staticNumber(ctx, id, "contour_width", 0) > 0 && soft > staticNumber(ctx, id, "contour_width", 0))
      ctx.report.approx(id, "softness past contour_width: toolbox's contour becomes one peaked band (smoothstep from 0 to width + softness), AE's a blurred stroke");
    return { v: b };
  }
  const r = sampledTrackToAe(windowFrames(clock), (t) => [sdfEdgeBlurriness(trackSoftness(scope, id, t) * k)], keyCtx(ctx, clock), "softness → Blurriness");
  ctx.report.sampled(id, "animated softness → Gaussian Blur 2 Blurriness keys every frame");
  return "v" in r.prop ? (r.prop.v[0] ? { v: r.prop.v[0] } : null) : { keys: r.prop.keys.map((x) => ({ ...x, v: x.v[0] })), dims: 1 };
}

function trackSoftness(scope: Scope, id: string, tick: number): number {
  const { ctx } = scope;
  const drv = driverOf(ctx, id, "softness");
  if (drv) return numbersOf(ctx.graph.valueAt(drv, tick))?.[0] ?? 1;
  const b = ctx.graph.block(id, "softness");
  return b ? evalBlock(b, tick, 1) : staticNumber(ctx, id, "softness", 1);
}

const pxPerUnit = (scope: Scope) => scope.ctx.canvas.width / Math.max(scope.ctx.canvas.width, scope.ctx.canvas.height);

export function emitSdfLayer(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx } = scope;
  const { id, out } = parseOut(endpoint);
  const n = ctx.graph.node(id);
  if (!n || out !== "out:primary" || (n.type !== "sdf-rasterize" && n.type !== "sdf-to-mask")) return null;
  const verdict = verdictOrBake(scope, id);
  const p = ctx.graph.params(id);
  const aspect = p.aspect_correct !== false;
  const { width: W, height: H } = ctx.canvas;
  const name = ctx.graph.name(id);
  const isMask = n.type === "sdf-to-mask";
  const th = (s: SdfCtx) => (isMask ? paramN(s, id, "threshold", 0) : K(0));
  const { item, e } = region(scope, id, canvasView(scope, aspect), th);
  const shape = item ? aspectWrap(scope, item, aspect, id) : null;
  const comp: AeShapeItem = { kind: "rect", name: "frame", size: { v: [W, H] }, position: { v: [W / 2, H / 2] }, roundness: { v: 0 } };
  let fg: AeShapeItem | null = null;
  let bg: AeShapeItem | null = null;
  let knockout = false;

  if (isMask) {
    const inv = p.invert === true;
    const on: [number, number, number] = inv ? [0, 0, 0] : [1, 1, 1];
    const off: [number, number, number] = inv ? [1, 1, 1] : [0, 0, 0];
    if (shape) fg = { kind: "group", name, contents: [shape, { kind: "fill", color: { v: on }, opacity: { v: 100 }, rule: "nonzero" }] };
    bg = { kind: "group", name: "background", contents: [comp, { kind: "fill", color: { v: off }, opacity: { v: 100 }, rule: "nonzero" }] };
    ctx.report.note(id, `→ ${inv ? "black on white" : "white on black"} shape layer (a luma matte where it masks)${staticNumber(ctx, id, "threshold", 0) !== 0 ? "; threshold → an outward offset of every leaf" : ""}`);
  } else {
    const fill = verdict.fill ?? { node: id, param: "foreground" };
    const fgA = staticNumber(ctx, id, "fg_alpha", 1);
    const fgAlpha = scalarProp(ctx, scope.clock, id, "fg_alpha", { map: { scale: 100, offset: 0 }, fallback: 1 });
    const fgColor = colorProp(ctx, scope.clock, fill.node, fill.param, { shapeOrSolid: true, fallback: "#ffffff" }).color;
    if (shape) {
      const parts: AeShapeItem[] = [shape];
      const cw = staticNumber(ctx, id, "contour_width", 0);
      const ca = staticNumber(ctx, id, "contour_alpha", 0);
      if ((cw > 0 || ctx.graph.block(id, "contour_width")) && (ca > 0 || ctx.graph.block(id, "contour_alpha"))) {
        // The band |d| < contour_width·pixel (pixel = 1/max(W, H)): a centred
        // stroke 2·contour_width px wide on a landscape canvas.
        const k = 2 * pxPerUnit(scope);
        parts.push({
          kind: "stroke",
          name: "contour",
          color: colorProp(ctx, scope.clock, id, "contour", { shapeOrSolid: true, fallback: "#000000" }).color,
          opacity: scalarProp(ctx, scope.clock, id, "contour_alpha", { map: { scale: 100, offset: 0 }, fallback: 0 }),
          width: scalarProp(ctx, scope.clock, id, "contour_width", { map: { scale: k, offset: 0 }, fallback: 0 }),
          cap: "round",
          join: "round",
          miterLimit: 4,
        });
        if (ca < 1) ctx.report.approx(id, "contour_alpha < 1: AE composites the stroke over the fill, toolbox replaces the fill's colour and alpha under the band");
        ctx.report.approx(id, "contour → a centred Stroke: the band around concave joins of booleans is the stroke's (true distance), toolbox's follows its min / max distance");
      }
      parts.push({ kind: "fill", color: fgColor, opacity: fgAlpha, rule: "nonzero" });
      fg = { kind: "group", name, contents: parts };
    }
    const bgA = staticNumber(ctx, id, "bg_alpha", 1);
    if (bgA > 0 || ctx.graph.block(id, "bg_alpha")) {
      let bgContents: AeShapeItem[] = [comp];
      // Toolbox REPLACES the background under the shape (mix, not over): a
      // translucent fill keeps the background out.
      if (shape && (fgA < 1 || ctx.graph.block(id, "fg_alpha"))) {
        bgContents = subtractOrder(comp, deep(shape));
        knockout = true;
        ctx.report.approx(id, "fg_alpha < 1: the background is knocked out under the shape (toolbox mixes, AE composites) — the two anti-aliased edges seam slightly");
      }
      bgContents.push({
        kind: "fill",
        color: colorProp(ctx, scope.clock, id, "background", { shapeOrSolid: true, fallback: "#000000" }).color,
        opacity: scalarProp(ctx, scope.clock, id, "bg_alpha", { map: { scale: 100, offset: 0 }, fallback: 1 }),
        rule: "nonzero",
      });
      bg = { kind: "group", name: "background", contents: bgContents };
    } else if (shape) {
      ctx.report.approx(id, "bg_alpha 0: toolbox mixes an edge pixel's colour toward the background colour (a fringe of it), AE keeps the fill colour on its edge");
    }
  }
  for (const x of verdict.notes) ctx.report.note(id, x);
  if (e.copies) ctx.report.note(id, `${e.copies} repeated cop${e.copies === 1 ? "y" : "ies"} in one shape layer`);
  if (!item) ctx.report.note(id, "the SDF tree is empty in this window — only the background draws");
  const seg = pn.segment >= 0 ? scope.layer.segments[pn.segment] : undefined;
  const origin = [id, ...verdict.nodes.filter((x) => x !== id), ...(seg?.nodes ?? []).filter((x) => x !== id && !verdict.nodes.includes(x))];
  const blur = fg ? edgeBlur(scope, id) : null;
  if (!blur || !bg) {
    const L: AeLayer = newLayer(scope, "shape", name, origin, { contents: [...(fg ? [fg] : []), ...(bg ? [bg] : [])] });
    if (blur) L.effects = [gaussian(blur)];
    return rendered(L);
  }
  // The blurred fill over its own background layer (AE composites the two in
  // the working space, as toolbox mixes them).
  if (knockout) ctx.report.approx(id, "the knocked-out background keeps a sharp hole under the blurred fill");
  const F: AeLayer = newLayer(scope, "shape", name, origin, { contents: [fg!], effects: [gaussian(blur)] });
  const B: AeLayer = newLayer(scope, "shape", `${name} background`, [id], { contents: [bg] });
  return { layers: [F, B] };
}

function gaussian(blurriness: AeProp<number>): AeEffect {
  return {
    match: "ADBE Gaussian Blur 2",
    name: "edge softness",
    props: {
      "ADBE Gaussian Blur 2-0001": blurriness,
      "ADBE Gaussian Blur 2-0002": { v: 1 }, // horizontal and vertical
      "ADBE Gaussian Blur 2-0003": { v: 0 }, // Repeat Edge Pixels off: the fill blurs into transparency
    },
  };
}

// sdf-to-spline as geometry for its style / mask consumers (shape.ts).
export function sdfContourGeometry(scope: Scope, id: string): Geom {
  const { ctx } = scope;
  verdictOrBake(scope, id);
  // The contour is traced on the [0, 1]² square of SDF space (a square
  // target, so aspect_correct has no effect) and lands in canvas01 with y
  // flipped — the same px mapping as an aspect-corrected rasterize.
  const view: Box = [0, 0, 1, 1];
  const { item, e } = region(scope, id, view, (s) => paramN(s, id, "iso", 0));
  if (!item) {
    ctx.report.note(id, "the SDF tree is empty in this window — an empty path");
    return { items: [], leaves: 0 };
  }
  // Past the tracing square toolbox has no contour: clip to it.
  const bounds = regionBounds(scope, id);
  let geom = item;
  if (!boxEmpty(bounds) && !(bounds[0] >= 0 && bounds[1] >= 0 && bounds[2] <= 1 && bounds[3] <= 1)) {
    geom = clipped(ctx.graph.name(id), item, clipRect(e, K(0), K(0), K(1), K(1), "tracing square"));
    ctx.report.note(id, "the shape leaves the [0, 1]² square toolbox traces in — clipped to it");
  }
  const res = Math.round(Math.max(32, Math.min(1024, staticNumber(ctx, id, "resolution", 256))));
  ctx.report.approx(id, `toolbox traces the contour on a ${res}² grid of the [0, 1]² square (straight segments ${(ctx.canvas.width / res).toFixed(2)} px long; measured ~0.7 px right of the zero set at 512); AE gets the exact outline`);
  return { items: [geom], leaves: 1 };
}

// Conservative SDF-space bounds of the tree into `consumer` (union over the
// window), for the tracing-square clip.
function regionBounds(scope: Scope, consumer: string): Box {
  const s = makeCtx(scope, consumer, [0, 0, 1, 1]);
  const { ctx } = scope;
  const w = ctx.graph.wireInto(consumer, "in:sdf");
  const ir = lower(s, w ? sourceEndpoint(w) : undefined, paramN(s, consumer, "iso", 0));
  const box = (x: Ir): Box => {
    switch (x.kind) {
      case "empty":
        return EMPTY_BOX;
      case "leaf": {
        const views = viewsOf(s, x.chain);
        let boxes = s.ticks.map((t) => leafBox(x.geom, x.delta.at(t), t, s));
        x.chain.forEach((op, i) => {
          if (op.kind === "repeat") planRepeat(s, op, boxes, views[i]);
          boxes = boxes.map((b, j) => opRegionBox(op, b, s.ticks[j], s));
        });
        return boxes.reduce(boxUnion, EMPTY_BOX);
      }
      case "bool":
        return x.parts.map(box).reduce(x.op === "add" ? boxUnion : (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
      case "sub":
        return box(x.a);
    }
  };
  return box(ir);
}

// Is `endpoint` an sdf-to-spline output (its geometry needs this module, not
// an evaluated spline — the contour is traced on the GPU)?
export function isSdfContour(scope: Scope, endpoint: string): boolean {
  const { id, out } = parseOut(endpoint);
  return out === "out:primary" && scope.ctx.graph.node(id)?.type === "sdf-to-spline";
}
