import type { SkiaDrawValue, SocketValue, SplineAnchor, SplineSubpath } from "@/engine/types";
import { bindDerived, type AssetIR, type Bind, type BindRef, type GeomIR, type PaintIR, type SkiaNode } from "@/engine/skia/scene-ir";
import { splineToSvgPathD } from "@/engine/svg-serialize";
import { makeCircleSubpath } from "../source/circle";

// Shared by the Skia paint family (stroke, spline fill, trim, round corners,
// dash, gradient fill): the drawing walk the modifiers share, an SVG path
// reader for the ones that need the geometry back as anchors, and the
// px / % unit scale the Stroke node's metrics use.
//
// Modifiers never mutate their input: the evaluator caches producer values
// and may hand the same object to several consumers, so every shape a
// modifier touches is copied (shape, paint, pathEffects array).

export type ShapeNode = Extract<SkiaNode, { k: "shape" }>;

export const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// The Stroke node's `units`: px is literal canvas pixels, % is a percent of
// the canvas width (engine/stroke-units.ts). Returned as the multiplier a
// BindRef.scale carries, so a keyframed metric exports as a scaled track.
export function unitScale(units: unknown, canvasWidth: number): number {
  return units === "%" ? canvasWidth / 100 : 1;
}

// A param read through a unit scale: `value` is param × scale (after any
// clamp the node applies), tagged so the exporter ships the param's track ×
// scale. A clamp that bites makes the track disagree with `value`; the
// exporter's per-frame check then samples it instead.
export function bindScaled(value: number, node: string, param: string, scale: number): Bind<number> {
  const ref: BindRef = scale === 1 ? { node, param } : { node, param, scale };
  return { v: value, ref };
}

// ---- drawing walk ------------------------------------------------------------------

// Every shape under `node` (through groups) replaced by `fn(shape)`; other
// drawings pass through. `fn` may return a group (a split shape).
export function mapShapes(node: SkiaNode, fn: (s: ShapeNode) => SkiaNode): SkiaNode {
  switch (node.k) {
    case "shape":
      return fn(node);
    case "group":
      return { ...node, children: node.children.map((c) => mapShapes(c, fn)) };
    default:
      return node;
  }
}

// A shape with a fresh paint (and pathEffects array) to write into.
export function copyShape(s: ShapeNode, id?: string): ShapeNode {
  const paint: PaintIR = { ...s.paint, ...(s.paint.pathEffects ? { pathEffects: [...s.paint.pathEffects] } : {}) };
  return { ...s, ...(id ? { id } : {}), paint };
}

// The modifier's output: the mapped tree with the input's assets and
// problems carried through, plus the modifier's own (`problems` is read
// after the walk, so `fn` may push to it). Nothing wired is an empty group,
// so the canvas draws nothing rather than failing.
export function modifyDrawing(
  input: SocketValue | undefined,
  nodeId: string,
  fn: (s: ShapeNode) => SkiaNode,
  problems: string[] = []
): SkiaDrawValue {
  if (!input || input.kind !== "skia_draw") {
    return { kind: "skia_draw", node: { k: "group", id: nodeId, children: [] }, ...(problems.length ? { problems } : {}) };
  }
  const d = input as SkiaDrawValue;
  const node = mapShapes(d.node, fn);
  const all = [...(d.problems ?? []), ...problems];
  return {
    kind: "skia_draw",
    node,
    ...(d.assets ? { assets: d.assets as Record<string, AssetIR> } : {}),
    ...(all.length ? { problems: [...new Set(all)] } : {}),
  };
}

// Skia starts a circle / oval contour at its right-most point; toolbox's
// Circle starts at the top and runs clockwise. Trim and dash measure from
// the contour start, so they redraw a circle or oval as toolbox's
// four-cubic circle first (the path is then derived: sampled per frame when
// the circle animates). Rects start top-left clockwise in both.
export function toolboxContour(s: ShapeNode): ShapeNode {
  const g = s.geom;
  const sub =
    g.k === "circle"
      ? makeCircleSubpath(g.cx.v, g.cy.v, g.r.v, g.r.v)
      : g.k === "oval"
        ? makeCircleSubpath(g.x.v + g.w.v / 2, g.y.v + g.h.v / 2, g.w.v / 2, g.h.v / 2)
        : null;
  return sub ? { ...s, geom: { k: "path", d: bindDerived(subpathsToD([sub]), []) } } : s;
}

// ---- SVG path data ↔ anchors ----------------------------------------------------------

type P = [number, number];

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

// SVG path data (M L H V C S Q T Z, absolute and relative; no arcs) as
// toolbox subpaths in the data's own space — the inverse of
// splineToSvgPathD: cubic control points become handles relative to their
// anchor (zero handles are left off, as a straight segment has none), and a
// closed subpath whose closing segment ends on its first point folds that
// duplicate back into the first anchor's in-handle. `null` + a reason for
// data this reader does not take.
export function parseSvgPathD(d: string): { subpaths: SplineSubpath[] } | { problem: string } {
  const subs: SplineSubpath[] = [];
  let cur: SplineAnchor[] | null = null;
  let pos: P = [0, 0];
  let start: P = [0, 0];
  let lastCubicC2: P | null = null;
  let lastQuadC: P | null = null;
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const number = (): number | null => {
    skip();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return null;
    i = NUM.lastIndex;
    return Number(m[0]);
  };
  const handle = (from: P, to: P): P | undefined => {
    const h: P = [to[0] - from[0], to[1] - from[1]];
    return h[0] === 0 && h[1] === 0 ? undefined : h;
  };
  const begin = (p: P) => {
    if (cur && cur.length) subs.push({ anchors: cur, closed: false });
    cur = [{ pos: p }];
    start = p;
  };
  const cubic = (c1: P, c2: P, end: P) => {
    if (!cur) begin(pos);
    const a = cur!;
    const last = a[a.length - 1];
    const out = handle(last.pos, c1);
    if (out) last.outHandle = out;
    const anchor: SplineAnchor = { pos: end };
    const inH = handle(end, c2);
    if (inH) anchor.inHandle = inH;
    a.push(anchor);
    pos = end;
  };
  const line = (end: P) => cubic(pos, end, end);
  const close = () => {
    const a = cur;
    if (!a || !a.length) return;
    const first = a[0];
    const last = a[a.length - 1];
    if (a.length > 1 && last.pos[0] === first.pos[0] && last.pos[1] === first.pos[1]) {
      // The closing cubic ended on the first anchor: its in-handle is the
      // first anchor's, the duplicate goes.
      if (last.inHandle) first.inHandle = last.inHandle;
      a.pop();
    }
    subs.push({ anchors: a, closed: true });
    cur = null;
    pos = start;
  };
  let cmd = "";
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[A-Za-z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) return { problem: `path data starts with "${d.slice(i, i + 8)}", not a command` };
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const pt = (): P | null => {
      const x = number();
      const y = number();
      if (x === null || y === null) return null;
      return rel ? [pos[0] + x, pos[1] + y] : [x, y];
    };
    const bad = () => ({ problem: `bad "${cmd}" arguments near "${d.slice(i, i + 12)}"` });
    switch (C) {
      case "M": {
        const p = pt();
        if (!p) return bad();
        begin(p);
        pos = p;
        cmd = rel ? "l" : "L"; // extra pairs after M are lines
        lastCubicC2 = lastQuadC = null;
        break;
      }
      case "L": {
        const p = pt();
        if (!p) return bad();
        line(p);
        lastCubicC2 = lastQuadC = null;
        break;
      }
      case "H": {
        const x = number();
        if (x === null) return bad();
        line([rel ? pos[0] + x : x, pos[1]]);
        lastCubicC2 = lastQuadC = null;
        break;
      }
      case "V": {
        const y = number();
        if (y === null) return bad();
        line([pos[0], rel ? pos[1] + y : y]);
        lastCubicC2 = lastQuadC = null;
        break;
      }
      case "C": {
        const c1 = pt();
        const c2 = pt();
        const e = pt();
        if (!c1 || !c2 || !e) return bad();
        cubic(c1, c2, e);
        lastCubicC2 = c2;
        lastQuadC = null;
        break;
      }
      case "S": {
        const c1: P = lastCubicC2 ? [2 * pos[0] - lastCubicC2[0], 2 * pos[1] - lastCubicC2[1]] : pos;
        const c2 = pt();
        const e = pt();
        if (!c2 || !e) return bad();
        cubic(c1, c2, e);
        lastCubicC2 = c2;
        lastQuadC = null;
        break;
      }
      case "Q":
      case "T": {
        let q: P | null;
        if (C === "Q") q = pt();
        else q = lastQuadC ? [2 * pos[0] - lastQuadC[0], 2 * pos[1] - lastQuadC[1]] : pos;
        const e = pt();
        if (!q || !e) return bad();
        // The exact cubic of a quadratic.
        const p0 = pos;
        cubic(
          [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
          [e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1])],
          e
        );
        lastQuadC = q;
        lastCubicC2 = null;
        break;
      }
      case "Z":
        close();
        lastCubicC2 = lastQuadC = null;
        break;
      case "A":
        return { problem: "arcs (A) in path data are not read here — use cubic path data" };
      default:
        return { problem: `unknown path command "${cmd}"` };
    }
  }
  if (cur && (cur as SplineAnchor[]).length) subs.push({ anchors: cur, closed: false });
  return { subpaths: subs };
}

// Subpaths in px back to path data (1:1 — no canvas mapping).
export function subpathsToD(subpaths: SplineSubpath[]): string {
  return splineToSvgPathD(subpaths, 1, 1);
}

// A shape's geometry as px subpaths, for the modifiers that rewrite it.
// Circles, ovals, rounded rects and lone points have no corners or sharp
// joins the readers here need; they return null (pass the shape through).
export function geomSubpaths(g: GeomIR): { subpaths: SplineSubpath[]; fillType?: "winding" | "evenOdd" } | { problem: string } | null {
  switch (g.k) {
    case "path": {
      const r = parseSvgPathD(g.d.v);
      if ("problem" in r) return r;
      return { subpaths: r.subpaths, ...(g.fillType ? { fillType: g.fillType } : {}) };
    }
    case "rect": {
      if (g.r && g.r.v > 0) return null;
      const x = g.x.v;
      const y = g.y.v;
      const w = g.w.v;
      const h = g.h.v;
      // Skia's addRect order: top-left, clockwise.
      return { subpaths: [{ closed: true, anchors: [{ pos: [x, y] }, { pos: [x + w, y] }, { pos: [x + w, y + h] }, { pos: [x, y + h] }] }] };
    }
    case "line":
      return { subpaths: [{ closed: false, anchors: [{ pos: [g.p1[0].v, g.p1[1].v] }, { pos: [g.p2[0].v, g.p2[1].v] }] }] };
    case "points": {
      const v = g.pts.v;
      if (g.mode === "points") return null;
      const pts: P[] = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
      if (g.mode === "polygon") return { subpaths: [{ closed: true, anchors: pts.map((p) => ({ pos: p })) }] };
      const subs: SplineSubpath[] = [];
      for (let k = 0; k + 1 < pts.length; k += 2) subs.push({ closed: false, anchors: [{ pos: pts[k] }, { pos: pts[k + 1] }] });
      return { subpaths: subs };
    }
    default:
      return null;
  }
}

const fmt = (v: number) => v.toFixed(3).replace(/\.?0+$/, "") || "0";

// Like subpathsToD, but handle-less segments are LINES (L, and a bare Z for
// a straight closing edge) instead of degenerate cubics — Skia's
// CornerPathEffect rounds only line-to-line corners.
export function subpathsToLineD(subpaths: SplineSubpath[]): string {
  const pt = (p: [number, number]) => `${fmt(p[0])} ${fmt(p[1])}`;
  const add = (p: [number, number], h: [number, number] | undefined): [number, number] => (h ? [p[0] + h[0], p[1] + h[1]] : p);
  let d = "";
  for (const sub of subpaths) {
    const a = sub.anchors;
    if (a.length < 2) continue;
    d += `${d ? " " : ""}M ${pt(a[0].pos)}`;
    const seg = (p: SplineAnchor, q: SplineAnchor, closing: boolean) => {
      if (!p.outHandle && !q.inHandle) {
        d += closing ? "" : ` L ${pt(q.pos)}`;
        return;
      }
      d += ` C ${pt(add(p.pos, p.outHandle))}, ${pt(add(q.pos, q.inHandle))}, ${pt(q.pos)}`;
    };
    for (let i = 1; i < a.length; i++) seg(a[i - 1], a[i], false);
    if (sub.closed) {
      seg(a[a.length - 1], a[0], true);
      d += " Z";
    }
  }
  return d;
}
