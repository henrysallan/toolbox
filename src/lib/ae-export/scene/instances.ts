// Instances (spec §3 rung 4, owner budget §11.5; M4 results in
// specdocs/ae-m4/instances.md).
//
// Copy to Points, image mode. Every copy is evaluated the way the node draws
// it — the point × the uniform modulation (scale_mul / rotate_add) × the
// sampled fields, tint / opacity attributes, the variant pick, the draw
// order — then:
//
//   Repeaters  static copies on a lattice (Grid, an Array in point mode, any
//              points stepping regularly, row- or column-major, any step
//              vectors), one variant, the same rotation and scale on every
//              copy, no tint, and an instance that renders as ONE plain shape
//              layer → that layer's contents placed at the first copy (the
//              copy transform as a group transform) plus a Repeater per
//              lattice axis, fast axis inside, later copies on top (toolbox's
//              order). A per-copy opacity that is exactly linear along each
//              axis rides the Repeaters' Start / End Opacity — only then. AE's
//              Repeater Scale compounds per copy about a fixed point, so no
//              per-copy scale is ever a Repeater.
//   exploded   otherwise each variant collapses into ONE precomp, placed once
//              per copy: anchor = the variant's anchor, position = the point,
//              rotation / scale = the point's × the modulation, opacity =
//              opacity_attr, tint_attr = a Fill effect on a flat-coloured
//              instance (its colour × the tint) or a Channel Mixer otherwise.
//              Stacked in toolbox's order: variant-major, then draw_order. Up
//              to policy.layerBudget; past it a warning and a bake — or, with
//              the "keep procedural" override, the layers anyway.
//   time       keyed scale_mul_default / rotate_add_default over static
//              points → each copy's Scale / Rotation keys converted from the
//              track (the authored eases). Anything else animated (the points
//              — Stagger phases included — wired modulation, the attributes)
//              → every copy's values at every frame of the window, linear
//              stretches merged (exact at frames). A variant pick that changes
//              over time → one layer per variant a point ever uses, shown by
//              HOLD opacity keys. A point count or a draw order that changes
//              over time bakes (AE can't reorder layers over time).
//   fields     scale_field / rotate_field (the shader's bilinear R sample at
//              the copy) and the image pick (the node's ≤ 256 px luminance
//              readback) are sampled at each copy at export through
//              ctx.fieldPixels when the field is static; an animated field, or
//              no readback, bakes.
//
// Spline mode copies are geometry: the vector emitter writes their evaluated
// paths (shape.ts), or Repeaters (repeaterGeom). Array in spline mode →
// Repeaters (arrayGeom); in point mode its lattice reaches Copy to Points as
// points.

import type { KeyframeAnimationBlock } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import type { ImageValue, PointsValue, RenderContext, SocketValue, SplineValue } from "@/engine/types";
import { dataOnlyContext } from "@/lib/skia-export/scene-sample";
import { readCollectSlots } from "@/nodes/effect/collect";
import { buildDrawOrder, chooseVariantGroup, lumaReadbackSize, lumaSamplerOf } from "@/nodes/effect/copy-to-points";
import { canvasDeltaToPx, canvasToPx, combinedTracksToAe, numericTrackToAe, radToDeg, DEG_PER_RAD } from "../convert";
import type { AeComp, AeEffect, AeKey, AeLayer, AePlanNode, AeProp, AeRGB, AeShapeItem, AeShapeTransform } from "../types";
import { driverOf, evalBlock, keyCtx, staticNumber, windowFrames } from "./context";
import { numbersOf, parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, collapse, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { animatedUpstream, geometry, localTick, staticPathGeom, type Geom } from "./shape";

const FIELDS = ["in:scale_field", "in:rotate_field"];
// Tolerance of a lattice step and of a linear ramp, canvas01 / opacity 0–1.
const LATTICE_TOL = 1e-5;
const RAMP_TOL = 1e-6;

// --- lattices -------------------------------------------------------------------------

// Points that step regularly: `k` points per cell (an Array of a k-point
// pattern), `fast` cells along d1, then `slow` rows of those along d2
// (canvas01 deltas). Grid's row-major order is fast = columns.
export interface Lattice {
  k: number;
  fast: number;
  slow: number;
  d1: [number, number];
  d2: [number, number];
}

export function latticeOf(pos: ArrayLike<number>, n: number, k = 1, tol = LATTICE_TOL): Lattice | null {
  if (n < 1 || k < 1 || n % k) return null;
  const cells = n / k;
  const at = (i: number): [number, number] => [pos[i * 2], pos[i * 2 + 1]];
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];
  // The pattern repeats in every cell.
  for (let c = 1; c < cells; c++) for (let j = 1; j < k; j++) if (!same(sub(at(c * k + j), at(c * k)), sub(at(j), at(0)))) return null;
  const C = (c: number) => at(c * k);
  if (cells === 1) return { k, fast: 1, slow: 1, d1: [0, 0], d2: [0, 0] };
  const s1 = sub(C(1), C(0));
  let fast = 2;
  while (fast < cells && same(sub(C(fast), C(fast - 1)), s1)) fast++;
  if (cells % fast) return null;
  const slow = cells / fast;
  const span = (a: number, b: number, steps: number): [number, number] => {
    const d = sub(C(b), C(a));
    return [d[0] / steps, d[1] / steps];
  };
  const d1 = span(0, fast - 1, fast - 1);
  const d2: [number, number] = slow > 1 ? span(0, (slow - 1) * fast, slow - 1) : [0, 0];
  const c0 = C(0);
  for (let r = 0; r < slow; r++)
    for (let j = 0; j < fast; j++) if (!same(C(r * fast + j), [c0[0] + j * d1[0] + r * d2[0], c0[1] + j * d1[1] + r * d2[1]])) return null;
  return { k, fast, slow, d1, d2 };
}

// A Repeater's Start / End Opacity (0–1) along one lattice axis. Measured in
// AE 26.5: copy i of n gets Start + (End − Start) · i / n — the last copy
// never reaches End. `reversed`: the original sits at the axis's LAST copy
// and the Repeater steps back (Composite Below keeps toolbox's stacking).
export interface RampAxis {
  start: number;
  end: number;
  reversed: boolean;
}

// opacity (0–1, lattice order) = group · inner(j) · outer(r) with inner and
// outer linear in their index → the instance group's opacity and each
// Repeater's Start / End, else null.
export function opacityRamp(o: readonly number[], L: Lattice): { group: number; inner?: RampAxis; outer?: RampAxis } | null {
  if (L.k !== 1 || o.length !== L.fast * L.slow) return null;
  const at = (r: number, j: number) => o[r * L.fast + j];
  const linear = (v: number[]) => v.every((x, i) => Math.abs(x - (v[0] + ((v[v.length - 1] - v[0]) * i) / Math.max(1, v.length - 1))) <= RAMP_TOL);
  const base = at(0, 0);
  if (!(base > 0)) return null;
  const f = Array.from({ length: L.fast }, (_, j) => at(0, j));
  const g = Array.from({ length: L.slow }, (_, r) => at(r, 0) / base);
  for (let r = 0; r < L.slow; r++) for (let j = 0; j < L.fast; j++) if (Math.abs(at(r, j) - f[j] * g[r]) > RAMP_TOL) return null;
  if (!linear(f) || !linear(g) || f.some((x) => x < 0) || g.some((x) => x < 0)) return null;
  // toolbox's v[0] … v[n−1] as AE's Start + (End − Start)·i/n, either way
  // round; the one that stays ≥ 0 with the smaller peak.
  const axis = (v: number[]): RampAxis | null => {
    const n = v.length;
    const opts = [
      { start: v[0], end: v[0] + ((v[n - 1] - v[0]) * n) / (n - 1), reversed: false },
      { start: v[n - 1], end: v[n - 1] + ((v[0] - v[n - 1]) * n) / (n - 1), reversed: true },
    ].filter((x) => x.end >= -RAMP_TOL);
    opts.sort((a, b) => Math.max(a.start, a.end) - Math.max(b.start, b.end));
    return opts[0] ? { ...opts[0], end: Math.max(0, opts[0].end) } : null;
  };
  const inner = L.fast > 1 ? axis(f) : undefined;
  const outer = L.slow > 1 ? axis(g) : undefined;
  if (inner === null || outer === null) return null;
  // Each Repeater peaks at 1; the group carries the rest (≤ 1 or no form).
  const peak = (a?: RampAxis) => (a ? Math.max(a.start, a.end) : 1);
  const group = peak(inner) * peak(outer) * (L.fast > 1 ? 1 : f[0]);
  if (group > 1 + RAMP_TOL || !(peak(inner) > 0) || !(peak(outer) > 0)) return null;
  const norm = (a?: RampAxis) => (a ? { ...a, start: a.start / peak(a), end: a.end / peak(a) } : undefined);
  return { group: Math.min(1, group), inner: norm(inner), outer: norm(outer) };
}

// One copy of the pattern: canvas01 position, degrees, percent.
interface PatternCopy {
  pos: [number, number];
  rot: number;
  scale: [number, number];
}

// The instance's contents at each pattern copy, then a Repeater per lattice
// axis (fast inside). `anchor` is layer px (the instance's own layer space =
// comp space). A reversed ramp axis starts at its last copy and steps back.
function latticeContents(scope: Scope, name: string, items: AeShapeItem[], pattern: PatternCopy[], anchor: [number, number], L: Lattice, ramp: ReturnType<typeof opacityRamp>): AeShapeItem[] {
  const { ctx } = scope;
  const shift: [number, number] = [0, 0];
  if (ramp?.inner?.reversed) for (const d of [0, 1] as const) shift[d] += (L.fast - 1) * L.d1[d];
  if (ramp?.outer?.reversed) for (const d of [0, 1] as const) shift[d] += (L.slow - 1) * L.d2[d];
  const placed: AeShapeItem[] = pattern.map((c, j) => {
    const p = canvasToPx([c.pos[0] + shift[0], c.pos[1] + shift[1]], ctx.canvas);
    const plain = Math.abs(c.rot) < 1e-12 && Math.abs(c.scale[0] - 100) < 1e-9 && Math.abs(c.scale[1] - 100) < 1e-9;
    const transform: AeShapeTransform = plain
      ? { position: { v: [p[0] - anchor[0], p[1] - anchor[1]] } }
      : { anchor: { v: anchor }, position: { v: p }, scale: { v: c.scale }, rotation: { v: c.rot } };
    if (ramp && Math.abs(ramp.group - 1) > RAMP_TOL) transform.opacity = { v: ramp.group * 100 };
    return { kind: "group", name: `${name} instance${pattern.length > 1 ? ` ${j + 1}` : ""}`, contents: j === 0 ? items : structuredClone(items), transform };
  });
  const axis = (d: [number, number]) => (Math.abs(d[0]) >= Math.abs(d[1]) ? "columns" : "rows");
  const rep = (copies: number, d: [number, number], label: string, op: RampAxis | undefined): AeShapeItem => ({
    kind: "repeater",
    name: `${name} ${label}`,
    copies: { v: copies },
    offset: { v: 0 },
    composite: op?.reversed ? "below" : "above",
    transform: {
      anchor: { v: [0, 0] },
      position: { v: canvasDeltaToPx(op?.reversed ? [-d[0], -d[1]] : d, ctx.canvas) },
      scale: { v: [100, 100] },
      rotation: { v: 0 },
      startOpacity: { v: (op?.start ?? 1) * 100 },
      endOpacity: { v: (op?.end ?? 1) * 100 },
    },
  });
  const out: AeShapeItem[] = [...placed];
  if (L.fast > 1) out.push(rep(L.fast, L.d1, axis(L.d1), ramp?.inner));
  const inner: AeShapeItem[] = L.fast > 1 && L.slow > 1 ? [{ kind: "group", name: `${name} ${axis(L.d1) === "columns" ? "row" : "column"}`, contents: out }] : out;
  if (L.slow > 1) inner.push(rep(L.slow, L.d2, axis(L.d1) === "columns" ? "rows" : "columns", ramp?.outer));
  return [{ kind: "group", name, contents: inner }];
}

// Pattern size of a point source: an Array in point mode repeats its
// instance's points per cell.
function patternSize(scope: Scope, pointsEp: string): number {
  const { ctx } = scope;
  const { id } = parseOut(pointsEp);
  const n = ctx.graph.node(id);
  if (n?.type !== "array" || String(ctx.graph.params(id).mode ?? "image") !== "point") return 1;
  const w = ctx.graph.wireInto(id, "in:instance");
  const v = w ? ctx.graph.valueAt(sourceEndpoint(w), localTick(scope, scope.clock.inFrame)) : undefined;
  return v && v.kind === "points" && v.count > 0 ? v.count : 1;
}

// --- sources --------------------------------------------------------------------------

function pointsAt(scope: Scope, ep: string, frame: number): PointsValue {
  const v = scope.ctx.graph.valueAt(ep, localTick(scope, frame));
  if (!v || v.kind !== "points") throw new BakeSignal(`${ep} evaluated to ${v ? v.kind : "nothing"}, not points`);
  return v;
}

// A node upstream of `id` (itself included) that reads an image into CPU
// data (Scatter's density, Set Named Attribute from an image, a Point
// Expression field…): the walk's GL-less evaluator has no pixels, so its
// points would come out wrong or missing. → "<node> (<socket>)" or null.
export function imageReadUpstream(scope: Scope, id: string): string | null {
  const { ctx } = scope;
  const seen = new Set<string>();
  const visit = (x: string): string | null => {
    if (seen.has(x)) return null;
    seen.add(x);
    const n = ctx.graph.node(x);
    const def = n ? getNodeDef(n.type) : undefined;
    if (!n || !def) return null;
    const ins = def.resolveInputs?.(n.params ?? {}) ?? def.inputs;
    for (const w of ctx.graph.into(x)) {
      const name = w.targetHandle.replace(/^in:/, "");
      const t = ins.find((i) => i.name === name)?.type;
      if (t === "image" || t === "mask" || t === "image_group" || t === "uv") return `${ctx.graph.name(x)} (${x}) ${name}`;
    }
    for (const w of ctx.graph.into(x)) {
      const r = visit(w.source);
      if (r) return r;
    }
    return null;
  };
  return visit(id);
}

// A uniform modulation scalar: the socket wins over its param (compute's
// rule); the param may itself be wired or keyed.
type Uniform = { kind: "static"; v: number } | { kind: "keyed"; block: KeyframeAnimationBlock } | { kind: "driven"; ep: string };

function uniformOf(scope: Scope, id: string, socket: string, param: string, fallback: number): Uniform {
  const { ctx } = scope;
  const w = ctx.graph.wireInto(id, `in:${socket}`);
  const ep = w ? sourceEndpoint(w) : driverOf(ctx, id, param);
  const own = staticNumber(ctx, id, param, fallback);
  if (ep) {
    if (animatedUpstream(ctx, parseOut(ep).id)) return { kind: "driven", ep };
    const v = numbersOf(ctx.graph.valueAt(ep, localTick(scope, scope.clock.inFrame)))?.[0];
    return { kind: "static", v: typeof v === "number" && Number.isFinite(v) ? v : own };
  }
  const b = ctx.graph.block(id, param);
  if (b && b.keyframes.length > 1) return { kind: "keyed", block: b };
  return { kind: "static", v: own };
}

function uniformAt(scope: Scope, u: Uniform, frame: number, fallback: number): number {
  if (u.kind === "static") return u.v;
  const tick = localTick(scope, frame);
  if (u.kind === "keyed") return evalBlock(u.block, tick, fallback);
  const v = numbersOf(scope.ctx.graph.valueAt(u.ep, tick))?.[0];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// A static image field sampled at authored point coords.
type FieldSampler = (u: number, v: number) => number;

function fieldOf(scope: Scope, id: string, handle: string, how: "r" | "luma"): FieldSampler | null {
  const { ctx } = scope;
  const w = ctx.graph.wireInto(id, handle);
  if (!w) return null;
  const ep = sourceEndpoint(w);
  const what = handle.slice(3);
  if (animatedUpstream(ctx, w.source)) throw new BakeSignal(`Copy to Points ${what} is an animated image field — only a static field is sampled per copy`);
  if (!ctx.fieldPixels) throw new BakeSignal(`Copy to Points ${what}: a static image field is sampled per copy from the editor's readback, which this export has none of`);
  // Pipeline images are canvas-sized (an image node is never evaluated on
  // the walk's GL-less context).
  const W0 = ctx.canvas.width;
  const H0 = ctx.canvas.height;
  const [w0, h0] = how === "luma" ? lumaReadbackSize(W0, H0) : [W0, H0];
  const data = ctx.fieldPixels(ep, w0, h0);
  if (!data || data.length < w0 * h0 * 4) throw new BakeSignal(`Copy to Points ${what}: no pixels for ${ep}`);
  const aspect = ctx.canvas.width / ctx.canvas.height;
  ctx.report.approx(id, `${what} sampled at each copy at export (8-bit readback of ${ep})`);
  if (how === "luma") return lumaSamplerOf(data, w0, h0, aspect);
  // The shader's sample: R, bilinear, clamp-to-edge, at the copy's canvas
  // position (Y-down rows: the readback's row 0 is the visual top).
  return (u, v) => {
    const x = u * w0 - 0.5;
    const y = (0.5 + (v - 0.5) * aspect) * h0 - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const r = (xx: number, yy: number) => data[(Math.max(0, Math.min(h0 - 1, yy)) * w0 + Math.max(0, Math.min(w0 - 1, xx))) * 4] / 255;
    const top = r(x0, y0) + (r(x0 + 1, y0) - r(x0, y0)) * fx;
    const bottom = r(x0, y0 + 1) + (r(x0 + 1, y0 + 1) - r(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

// The variants an image-mode instance carries: a Combine (collect) in image
// mode → its connected sockets in slot order (its image_group); anything
// else → the instance itself.
function variantsOf(scope: Scope, instanceEp: string): string[] {
  const { ctx } = scope;
  const { id } = parseOut(instanceEp);
  const n = ctx.graph.node(id);
  if (n?.type === "collect" && String(ctx.graph.params(id).mode ?? "image") === "image") {
    const eps: string[] = [];
    for (const s of readCollectSlots(ctx.graph.params(id))) {
      const w = ctx.graph.wireInto(id, `in:${s}`);
      if (w) eps.push(sourceEndpoint(w));
    }
    return eps;
  }
  const v = ctx.graph.valueAt(instanceEp, localTick(scope, scope.clock.inFrame));
  if (v?.kind === "image_group") throw new BakeSignal(`Copy to Points instance is an image group from ${n?.type ?? instanceEp} — only a Combine's items map to variants`);
  return [instanceEp];
}

// The anchor of an image-mode copy, in the canvas-sized instance's px.
function anchorPx(scope: Scope, id: string, itemEp: string): [number, number] {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const mode = String(p.anchor ?? "canvas center");
  // Image mode's custom anchor is a uv01 fraction of the instance image.
  if (mode === "custom") return [Number(p.anchor_x ?? 0.5) * W, Number(p.anchor_y ?? 0.5) * H];
  if (mode === "canvas center") return [W / 2, H / 2];
  // Content center: toolbox measures the instance image's alpha bounds; the
  // spline behind a vector instance gives the same box without a readback.
  const c = splineCenter(instanceSpline(scope, itemEp));
  if (c) {
    ctx.report.approx(id, "content-center anchor from the instance's spline bounds (toolbox reads its alpha bounds at ≤ 128 px — strokes widen them)");
    return canvasToPx(c, ctx.canvas);
  }
  ctx.report.approx(id, "content-center anchor unknown offline — canvas center used");
  return [W / 2, H / 2];
}

function splineCenter(s: SplineValue | null): [number, number] | null {
  if (!s) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of s.subpaths)
    for (const a of sub.anchors) {
      minX = Math.min(minX, a.pos[0]);
      maxX = Math.max(maxX, a.pos[0]);
      minY = Math.min(minY, a.pos[1]);
      maxY = Math.max(maxY, a.pos[1]);
    }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

function instanceSpline(scope: Scope, ep: string): SplineValue | null {
  const { ctx } = scope;
  const { id, out } = parseOut(ep);
  const n = ctx.graph.node(id);
  if (!n) return null;
  const at = (e: string) => {
    const v = ctx.graph.valueAt(e, localTick(scope, scope.clock.inFrame));
    return v && v.kind === "spline" ? v : null;
  };
  if (out === "out:aux:image") return at(`${id}:out`);
  const w = ctx.graph.wireInto(id, "in:path");
  return w ? at(sourceEndpoint(w)) : null;
}

// The one colour every visible pixel of a rendered instance has (a plain
// shape layer whose fills / strokes share a static colour, a solid), else
// null: a tint is then that colour × the tint (a Fill effect).
function flatColor(r: Rendered): AeRGB | null {
  const m = r.main;
  if (!m || r.layers.length !== 1 || m.masks?.length || m.effects?.length || m.matte || (m.source && m.kind === "shape")) return null;
  if (m.kind === "solid" && m.solid) return m.solid.color;
  if (m.kind !== "shape" || !m.contents) return null;
  let c: AeRGB | null = null;
  let ok = true;
  const visit = (xs: AeShapeItem[]) => {
    for (const it of xs) {
      if (it.kind === "group") visit(it.contents);
      else if (it.kind === "gradient-fill" || it.kind === "gradient-stroke") ok = false;
      else if (it.kind === "fill" || it.kind === "stroke") {
        if (!("v" in it.color)) ok = false;
        else if (!c) c = it.color.v;
        else if (it.color.v.some((x, i) => Math.abs(x - c![i]) > 1e-9)) ok = false;
      }
    }
  };
  visit(m.contents);
  return ok ? c : null;
}

// Paint items (fill / stroke / gradient) in a shape layer's contents.
function paintCount(items: AeShapeItem[]): number {
  let n = 0;
  for (const it of items) {
    if (it.kind === "group") n += paintCount(it.contents);
    else if (it.kind === "fill" || it.kind === "stroke" || it.kind === "gradient-fill" || it.kind === "gradient-stroke") n++;
  }
  return n;
}

// --- per-frame values ------------------------------------------------------------------

interface CopyFrame {
  pos: [number, number][]; // canvas01 per point
  rot: number[]; // degrees
  scale: [number, number][]; // percent
  opacity: number[]; // 0–100 (opacity_attr; 100 without)
  tint: AeRGB[] | null;
  assign: Int32Array | null; // variant per point; null = every variant at every point
  order: Int32Array | null;
}

const sameOrder = (a: Int32Array | null, b: Int32Array | null) => (!a || !b ? a === b : a.length === b.length && a.every((x, i) => x === b[i]));

// Per-frame AE values → a prop: static when they never change, else keys at
// every frame with linear stretches merged (exact at frames). `hold` for
// values that step (visibility).
function framesProp<T extends number | number[]>(scope: Scope, frames: number[], values: T[], hold = false): AeProp<T> {
  const fps = scope.ctx.fps;
  const vec = (v: T): number[] => (typeof v === "number" ? [v] : (v as number[]));
  const eq = (a: T, b: T) => vec(a).every((x, i) => Math.abs(x - vec(b)[i]) <= 1e-9);
  if (values.every((v) => eq(v, values[0]))) return { v: values[0] };
  const keep: number[] = [0];
  if (hold) {
    for (let i = 1; i < values.length; i++) if (!eq(values[i], values[i - 1])) keep.push(i);
  } else {
    // Greedy: extend each linear stretch while every frame inside lies on it.
    let a = 0;
    for (let e = 2; e < values.length; e++) {
      const va = vec(values[a]);
      const ve = vec(values[e]);
      let onLine = true;
      for (let j = a + 1; j < e && onLine; j++) {
        const u = (frames[j] - frames[a]) / (frames[e] - frames[a]);
        onLine = vec(values[j]).every((x, d) => Math.abs(x - (va[d] + (ve[d] - va[d]) * u)) <= 1e-6 * Math.max(1, Math.abs(x)));
      }
      if (!onLine) {
        keep.push(e - 1);
        a = e - 1;
      }
    }
    if (keep[keep.length - 1] !== values.length - 1) keep.push(values.length - 1);
    // AE holds the last key's value: a final key equal to the one before goes.
    if (keep.length > 2 && eq(values[keep[keep.length - 1]], values[keep[keep.length - 2]])) keep.pop();
  }
  const interp = hold ? "hold" : "linear";
  const keys: AeKey<T>[] = keep.map((i) => ({ t: frames[i] / fps, v: values[i], inInterp: interp, outInterp: interp }));
  const dims = vec(values[0]).length as 1 | 2 | 3;
  return { keys, dims };
}

// --- the image-mode emitter --------------------------------------------------------------

export function emitInstances(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  const n = ctx.graph.node(id);
  if (!n || n.type !== "copy-to-points") return null;
  void pn;
  const p = ctx.graph.params(id);
  if ((p.mode ?? "image") !== "image") return null;
  const pw = ctx.graph.wireInto(id, "in:points");
  const iw = ctx.graph.wireInto(id, "in:instance");
  if (!pw || !iw) return { layers: [] };
  const pointsEp = sourceEndpoint(pw);
  const instanceEp = sourceEndpoint(iw);
  const name = ctx.graph.name(id);
  const reads = imageReadUpstream(scope, pw.source);
  if (reads) throw new BakeSignal(`the points read an image at ${reads} — the export samples images only at Copy to Points' own fields`);
  if (ctx.graph.wireInto(id, "in:driver_field")) ctx.report.note(id, "driver_field does nothing in image mode (toolbox ignores it there too)");

  // --- what varies --------------------------------------------------------------------
  const items = variantsOf(scope, instanceEp);
  if (!items.length) return { layers: [] };
  const M = items.length;
  const mulU = uniformOf(scope, id, "scale_mul", "scale_mul_default", 1);
  const rotU = uniformOf(scope, id, "rotate_add", "rotate_add_default", 0);
  const scaleField = fieldOf(scope, id, "in:scale_field", "r");
  const rotField = fieldOf(scope, id, "in:rotate_field", "r");
  const lo = staticNumber(ctx, id, "scale_field_lo", 0.5);
  const hi = staticNumber(ctx, id, "scale_field_hi", 1.5);
  const amt = staticNumber(ctx, id, "rotate_field_amount", Math.PI);
  for (const k of ["scale_field_lo", "scale_field_hi", "rotate_field_amount"])
    if (scaleField || rotField) if (ctx.graph.block(id, k) || driverOf(ctx, id, k)) throw new BakeSignal(`Copy to Points ${k} is animated (a field range per frame is not mapped)`);
  const pickMode = String(p.pick_mode ?? "image");
  const pickSeed = Math.floor(Number(p.pick_seed ?? 0));
  const drawOrder = String(p.draw_order ?? "points order");
  const pickField = M > 1 && pickMode === "image" ? fieldOf(scope, id, "in:pick", "luma") : null;
  // One variant per point (else every variant at every point, item-major).
  const picks = M > 1 && pickMode !== "all" && !(pickMode === "image" && !pickField);
  const tintName = String(p.tint_attr ?? "").trim();
  const opacityName = String(p.opacity_attr ?? "").trim();
  const pickAttrName = String(p.pick_attr ?? "").trim();

  const pointsAnimated = animatedUpstream(ctx, pw.source);
  const keyedOnly = !pointsAnimated && mulU.kind !== "driven" && rotU.kind !== "driven" && (mulU.kind === "keyed" || rotU.kind === "keyed");
  const sampled = pointsAnimated || mulU.kind === "driven" || rotU.kind === "driven";
  const [f0, f1] = windowFrames(scope.clock);
  const frames: number[] = [];
  for (let f = f0; f <= (sampled ? f1 : f0); f++) frames.push(f);

  // --- every copy at every frame -------------------------------------------------------
  let N = -1;
  const evalFrame = (f: number): CopyFrame => {
    const pts = pointsAt(scope, pointsEp, f);
    if (N < 0) N = pts.count;
    else if (pts.count !== N) throw new BakeSignal(`the point count changes over time (${N} → ${pts.count} at frame ${f}) — copies need a constant count`);
    // keyedOnly: the per-copy keys come from the tracks; here the rest.
    const mul = keyedOnly && mulU.kind === "keyed" ? 1 : uniformAt(scope, mulU, f, 1);
    const radd = keyedOnly && rotU.kind === "keyed" ? 0 : uniformAt(scope, rotU, f, 0);
    const tintA = tintName ? pts.attributes?.[tintName] : undefined;
    const tint = tintA && tintA.arity >= 3 ? tintA : undefined;
    const opA = opacityName ? pts.attributes?.[opacityName] : undefined;
    const pickA = pickMode === "attribute" && pickAttrName ? pts.attributes?.[pickAttrName] : undefined;
    const out: CopyFrame = { pos: [], rot: [], scale: [], opacity: [], tint: tint ? [] : null, assign: picks ? new Int32Array(N) : null, order: buildDrawOrder(pts, drawOrder, pickSeed) };
    const distinct = items.map((_, k) => k);
    for (let i = 0; i < N; i++) {
      const x = pts.positions[i * 2];
      const y = pts.positions[i * 2 + 1];
      const fm = scaleField ? lo + (hi - lo) * scaleField(x, y) : 1;
      const fr = rotField ? (rotField(x, y) - 0.5) * 2 * amt : 0;
      out.pos.push([x, y]);
      out.scale.push([(pts.scales ? pts.scales[i * 2] : 1) * mul * fm * 100, (pts.scales ? pts.scales[i * 2 + 1] : 1) * mul * fm * 100]);
      out.rot.push(radToDeg((pts.rotations ? pts.rotations[i] : 0) + radd + fr));
      out.opacity.push(opA ? Math.min(1, Math.max(0, opA.data[i * opA.arity])) * 100 : 100);
      if (tint) out.tint!.push([tint.data[i * tint.arity], tint.data[i * tint.arity + 1], tint.data[i * tint.arity + 2]]);
      if (out.assign)
        out.assign[i] =
          chooseVariantGroup({
            pickMode,
            distinct,
            index: i,
            sampler: pickField,
            u: x,
            v: y,
            targetGroup: pts.groupIndices ? pts.groupIndices[i] : 0,
            seed: pickSeed,
            attrValue: pickA ? Math.min(1, Math.max(0, pickA.data[i * pickA.arity])) : null,
          }) ?? 0;
    }
    return out;
  };
  const evals = frames.map(evalFrame);
  const first = evals[0];
  if (N === 0) return { layers: [] };
  for (let fi = 1; fi < evals.length; fi++)
    if (!sameOrder(evals[fi].order, first.order)) throw new BakeSignal(`draw_order "${drawOrder}" reorders the copies at frame ${frames[fi]} — AE can't reorder layers over time`);

  // Slots, bottom → top: variant-major, then the draw order (compute's
  // packing); a variant a point never uses has no layer.
  const used = (k: number, i: number) => !first.assign || evals.some((e) => e.assign![i] === k);
  const slots: { k: number; i: number }[] = [];
  for (let k = 0; k < M; k++)
    for (let t = 0; t < N; t++) {
      const i = first.order ? first.order[t] : t;
      if (used(k, i)) slots.push({ k, i });
    }
  const switching = !!first.assign && evals.some((e) => e.assign!.some((x, i) => x !== first.assign![i]));

  // Each variant renders once (a render is fresh AE layers — and comps).
  const renders = new Map<number, Rendered>();
  const renderOf = (k: number) => renders.get(k) ?? renders.set(k, scope.render(items[k])).get(k)!;

  // --- a lattice of one plain shape → Repeaters -------------------------------------------
  const lattice = !sampled && !keyedOnly && !first.tint && !scaleField && !rotField ? repeaterLattice(scope, pointsEp, first, slots, N) : null;
  if (lattice) {
    const k = slots[0].k;
    const inst = renderOf(k);
    const m = inst.main;
    const ramp = first.opacity.every((o) => o === 100) ? undefined : m?.contents && paintCount(m.contents) === 1 ? opacityRamp(first.opacity.map((o) => o / 100), lattice) : null;
    if (ramp !== null && m && inst.layers.length === 1 && m.kind === "shape" && ctx.free.has(m) && !m.masks && !m.effects && !m.matte && m.contents && !m.source) {
      const L = lattice;
      const pattern = Array.from({ length: L.k }, (_, j) => ({ pos: first.pos[j], rot: first.rot[j], scale: first.scale[j] }));
      m.contents = latticeContents(scope, name, m.contents, pattern, anchorPx(scope, id, items[k]), L, ramp ?? null);
      m.name = name;
      m.origin = [...new Set([...(m.origin ?? []), id])];
      const shape = L.slow > 1 ? `${L.fast}×${L.slow}` : `${L.fast}`;
      const reps = ["no Repeater (one copy)", "one Repeater", "two Repeaters"][(L.fast > 1 ? 1 : 0) + (L.slow > 1 ? 1 : 0)];
      ctx.report.note(id, `regular ${shape} lattice${L.k > 1 ? ` of a ${L.k}-point pattern` : ""} → ${reps} on the instance's shape layer${ramp ? " (the opacity ramp → Start / End Opacity)" : ""}`);
      return inst;
    }
  }

  // --- exploded ------------------------------------------------------------------------------
  const count = slots.length;
  if (count > ctx.policy.layerBudget) {
    // The plan already warned about the budget. "Keep procedural" (the
    // modal's override) explodes past it; otherwise the copies bake.
    if (ctx.overrides[id] !== "procedural") throw new BakeSignal(`${count} copies exceed the layer budget (${ctx.policy.layerBudget})`);
    const w = `${name} (${id}): ${count} copies exploded past the ${ctx.policy.layerBudget}-layer budget ("keep procedural").`;
    ctx.report.warn(w);
    ctx.out.warnings.push(w);
  }
  // One precomp per variant used.
  const variant = new Map<number, { comp: string; anchor: [number, number]; flat: AeRGB | null }>();
  for (const k of [...new Set(slots.map((s) => s.k))].sort((a, b) => a - b)) {
    const r = renderOf(k);
    const flat = flatColor(r);
    const label = `${name} instance${M > 1 ? ` ${k + 1}` : ""}`;
    const inst = collapse(scope, r, label);
    let compId = inst.main!.source;
    if (inst.main!.kind !== "precomp" || !compId) {
      const c: AeComp = { id: ctx.uid(`comp:${label}`), name: `${ctx.name} · ${label}`, width: ctx.canvas.width, height: ctx.canvas.height, fps: ctx.fps, duration: Math.max(ctx.durationFrames, scope.clock.outFrame) / ctx.fps, layers: inst.layers };
      ctx.out.comps.push(c);
      compId = c.id;
    }
    variant.set(k, { comp: compId, anchor: anchorPx(scope, id, items[k]), flat });
  }

  const kc = keyCtx(ctx, scope.clock);
  let reportedTrack = false;
  const perPoint = new Map<number, number>();
  for (const s of slots) perPoint.set(s.i, (perPoint.get(s.i) ?? 0) + 1);
  const layers: AeLayer[] = [];
  for (const { k, i } of slots) {
    const v = variant.get(k)!;
    const position = framesProp(scope, frames, evals.map((e) => canvasToPx(e.pos[i], ctx.canvas) as [number, number]));
    let scale: AeProp<number[]>;
    let rotation: AeProp<number>;
    if (keyedOnly && mulU.kind === "keyed") {
      const [sx, sy] = first.scale[i];
      const r = combinedTracksToAe(
        [
          { src: mulU.block, paramType: "scalar" },
          { src: mulU.block, paramType: "scalar" },
        ],
        { ...kc, map: [{ scale: sx, offset: 0 }, { scale: sy, offset: 0 }] }
      );
      if (!reportedTrack) ctx.report.track(id, "scale_mul_default", r.report);
      scale = r.prop as AeProp<number[]>;
    } else scale = framesProp(scope, frames, evals.map((e) => e.scale[i]));
    if (keyedOnly && rotU.kind === "keyed") {
      const r = numericTrackToAe(rotU.block, "scalar", { ...kc, map: { scale: DEG_PER_RAD, offset: first.rot[i] } });
      if (!reportedTrack) ctx.report.track(id, "rotate_add_default", r.report);
      rotation = r.prop as AeProp<number>;
    } else rotation = framesProp(scope, frames, evals.map((e) => e.rot[i]));
    reportedTrack = true;
    const opacity = framesProp(
      scope,
      frames,
      evals.map((e) => (!e.assign || e.assign[i] === k ? e.opacity[i] : 0)),
      switching
    );
    const effects = first.tint ? [tintEffect(scope, frames, evals.map((e) => e.tint?.[i] ?? [1, 1, 1]), v.flat)] : undefined;
    const label = perPoint.get(i)! > 1 ? `${name} ${i + 1}.${k + 1}` : `${name} ${i + 1}`;
    const L = newLayer(scope, "precomp", label, [id], {
      source: v.comp,
      transform: { anchor: { v: v.anchor }, position, scale, rotation, opacity },
      ...(effects ? { effects } : {}),
    });
    layers.unshift(L);
  }
  const what = [
    first.tint ? "tint" : "",
    opacityName && first.opacity.some((o) => o !== 100) ? "opacity" : "",
    M > 1 ? `${M} variants (${picks ? `pick ${pickMode}` : "all"})` : "",
    first.order ? `draw order ${drawOrder}` : "",
  ].filter(Boolean);
  ctx.report.note(id, `${count} copies → ${count} layers of ${variant.size === 1 ? "one instance precomp" : `${variant.size} instance precomps`}${what.length ? ` (${what.join(", ")})` : ""}`);
  if (sampled) ctx.report.sampled(id, `per-copy transforms every frame ${f0}–${f1}${pointsAnimated ? " (animated points)" : ""}, linear stretches merged`);
  if (switching) ctx.report.sampled(id, "the variant pick changes over time → one layer per variant a point uses, HOLD opacity keys");
  return count === 1 ? rendered(layers[0]) : { layers };
}

// The lattice when every copy is the same but for its position, in an order
// a Repeater draws (one variant, draw order the lattice's own). A Grid's
// own params give the exact steps (the points are Float32).
function repeaterLattice(scope: Scope, pointsEp: string, f: CopyFrame, slots: { k: number; i: number }[], N: number): Lattice | null {
  if (slots.length !== N || slots.some((s) => s.k !== slots[0].k)) return null;
  if (f.order && f.order.some((x, t) => x !== t)) return null;
  const flat = f.pos.flat();
  for (const k of [patternSize(scope, pointsEp), 1]) {
    const L = latticeOf(flat, N, k);
    if (!L) continue;
    const same = (i: number, j: number) => Math.abs(f.rot[i] - f.rot[j]) <= 1e-9 && Math.abs(f.scale[i][0] - f.scale[j][0]) <= 1e-9 && Math.abs(f.scale[i][1] - f.scale[j][1]) <= 1e-9;
    let ok = true;
    for (let i = L.k; i < N && ok; i++) ok = same(i, i % L.k);
    if (!ok) continue;
    const g = gridOf(scope, pointsEp);
    if (g && L.k === 1 && g.cols * g.rows === N) {
      const exact: Lattice = { k: 1, fast: g.cols > 1 ? g.cols : g.rows, slow: g.cols > 1 ? g.rows : 1, d1: g.cols > 1 ? [g.dx, 0] : [0, g.dy], d2: [0, g.cols > 1 ? g.dy : 0] };
      const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= LATTICE_TOL);
      if (exact.fast === L.fast && exact.slow === L.slow && near(exact.d1, L.d1) && near(exact.d2, L.d2) && near([g.x0, g.y0], f.pos[0])) {
        f.pos[0] = [g.x0, g.y0];
        return exact;
      }
    }
    return L;
  }
  return null;
}

// A Grid node's points, from its params (canvas01, float64).
function gridOf(scope: Scope, pointsEp: string): { cols: number; rows: number; x0: number; y0: number; dx: number; dy: number } | null {
  const { ctx } = scope;
  const { id, out } = parseOut(pointsEp);
  if (ctx.graph.node(id)?.type !== "grid" || out !== "out:primary" || ctx.graph.into(id).length) return null;
  const p = ctx.graph.params(id);
  const cols = Math.max(1, Math.floor(Number(p.countX ?? 5)));
  const rows = Math.max(1, Math.floor(Number(p.countY ?? 5)));
  const step = p.spacingMode === "step";
  const dx = step ? Number(p.spacingX ?? 0.1) : cols > 1 ? Number(p.width ?? 0.8) / (cols - 1) : 0;
  const dy = step ? Number(p.spacingY ?? 0.1) : rows > 1 ? Number(p.height ?? 0.8) / (rows - 1) : 0;
  const cx = Number(p.x ?? 0.5);
  const cy = Number(p.y ?? 0.5);
  return { cols, rows, dx, dy, x0: cx - (dx * (cols - 1)) / 2, y0: cy - (dy * (rows - 1)) / 2 };
}

// tint_attr → a Fill effect (the instance's one colour × the tint) or a
// Channel Mixer (each channel × the tint) — static, or per-frame keys.
function tintEffect(scope: Scope, frames: number[], tints: AeRGB[], flat: AeRGB | null): AeEffect {
  if (flat) {
    const color = framesProp(scope, frames, tints.map((t) => t.map((x, c) => Math.min(1, Math.max(0, x * flat[c]))) as number[]));
    return { match: "ADBE Fill", name: "Tint", props: { "ADBE Fill-0002": color } };
  }
  const ch = (c: number) => framesProp(scope, frames, tints.map((t) => Math.max(-200, Math.min(200, t[c] * 100))));
  return { match: "ADBE CHANNEL MIXER", name: "Tint", props: { "ADBE CHANNEL MIXER-0001": ch(0), "ADBE CHANNEL MIXER-0006": ch(1), "ADBE CHANNEL MIXER-0011": ch(2) } };
}

// --- spline mode ---------------------------------------------------------------------------

// Spline-mode Copy to Points on a static lattice with one variant and the same
// copy transform everywhere → Repeaters around the instance geometry
// (shape.ts calls this before falling back to the evaluated copies). Throws
// for a wired image field: the evaluated copies would need its pixels.
export function repeaterGeom(scope: Scope, id: string): Geom | null {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  if ((p.mode ?? "image") !== "spline") return null;
  const pw = ctx.graph.wireInto(id, "in:points");
  const iw = ctx.graph.wireInto(id, "in:instance");
  if (pw) {
    const reads = imageReadUpstream(scope, pw.source);
    if (reads) throw new BakeSignal(`the points read an image at ${reads} — the export samples images only at Copy to Points' own fields`);
  }
  if (ctx.graph.wireInto(id, "in:driver_field")) throw new BakeSignal("Copy to Points driver_field (a per-copy driver for downstream ramps) is not mapped");
  const pickImage = String(p.pick_mode ?? "image") === "image" && !!ctx.graph.wireInto(id, "in:pick");
  if (FIELDS.some((h) => ctx.graph.wireInto(id, h)) || pickImage) return fieldCopiesGeom(scope, id);
  if (!pw || !iw || animatedUpstream(ctx, pw.source) || animatedUpstream(ctx, id)) return null;
  if ((p.output_tag ?? "instance groups") !== "instance groups" || String(p.driver_attr ?? "").trim()) return null;
  if ((p.draw_order ?? "points order") !== "points order" && String(p.draw_order) !== "by y") return null;
  const instEp = sourceEndpoint(iw);
  const s = ctx.graph.valueAt(instEp, localTick(scope, scope.clock.inFrame));
  if (!s || s.kind !== "spline") return null;
  const groups = new Set(s.subpaths.map((x) => x.groupIndex ?? 0));
  const pickMode = String(p.pick_mode ?? "image");
  if (groups.size > 1 && pickMode !== "all" && !(pickMode === "image" && !ctx.graph.wireInto(id, "in:pick"))) return null;
  const pointsEp = sourceEndpoint(pw);
  const pts = pointsAt(scope, pointsEp, scope.clock.inFrame);
  if (!pts.count) return null;
  const order = buildDrawOrder(pts, String(p.draw_order ?? "points order"), Math.floor(Number(p.pick_seed ?? 0)));
  if (order && order.some((x, t) => x !== t)) return null;
  const mul = uniformOf(scope, id, "scale_mul", "scale_mul_default", 1);
  const rot = uniformOf(scope, id, "rotate_add", "rotate_add_default", 0);
  if (mul.kind !== "static" || rot.kind !== "static") return null;
  const f: CopyFrame = { pos: [], rot: [], scale: [], opacity: [], tint: null, assign: null, order: null };
  for (let i = 0; i < pts.count; i++) {
    f.pos.push([pts.positions[i * 2], pts.positions[i * 2 + 1]]);
    f.rot.push(radToDeg((pts.rotations ? pts.rotations[i] : 0) + rot.v));
    f.scale.push([(pts.scales ? pts.scales[i * 2] : 1) * mul.v * 100, (pts.scales ? pts.scales[i * 2 + 1] : 1) * mul.v * 100]);
  }
  const slots = Array.from({ length: pts.count }, (_, i) => ({ k: 0, i }));
  const L = repeaterLattice(scope, pointsEp, f, slots, pts.count);
  if (!L) return null;
  const inst = geometry(scope, instEp, { top: false, canHoist: false });
  const mode = String(p.anchor ?? "canvas center");
  // Spline mode's custom anchor is absolute canvas01.
  const a01: [number, number] = mode === "custom" ? [Number(p.anchor_x ?? 0.5), Number(p.anchor_y ?? 0.5)] : mode === "content center" ? (splineCenter(s) ?? [0.5, 0.5]) : [0.5, 0.5];
  const pattern = Array.from({ length: L.k }, (_, j) => ({ pos: f.pos[j], rot: f.rot[j], scale: f.scale[j] }));
  const shape = L.slow > 1 ? `${L.fast}×${L.slow}` : `${L.fast}`;
  ctx.report.note(id, `regular ${shape} lattice, one instance → Repeaters`);
  return { items: latticeContents(scope, ctx.graph.name(id), inst.items, pattern, canvasToPx(a01, ctx.canvas), L, null), leaves: 1 };
}

// Spline mode with static image fields (scale / rotate / the image pick):
// the node's own compute on the walk's GL-less context, its readbacks served
// from ctx.fieldPixels — the copies' geometry exactly as toolbox's CPU path
// samples it (≤ 256 px luminance), as static paths.
function fieldCopiesGeom(scope: Scope, id: string): Geom {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  const tick = localTick(scope, scope.clock.inFrame);
  const wire = (h: string) => ctx.graph.wireInto(id, h);
  for (const h of ["in:points", "in:instance", "in:scale_mul", "in:rotate_add"]) {
    const w = wire(h);
    if (w && animatedUpstream(ctx, w.source)) throw new BakeSignal(`Copy to Points (spline mode) with an image field and an animated ${h.slice(3)} — fields are sampled once`);
  }
  for (const k of ["scale_mul_default", "rotate_add_default", "scale_field_lo", "scale_field_hi", "rotate_field_amount"])
    if (ctx.graph.block(id, k) || driverOf(ctx, id, k)) throw new BakeSignal(`Copy to Points (spline mode) with an image field and an animated ${k}`);
  if (!ctx.fieldPixels) throw new BakeSignal("Copy to Points (spline mode) image field: a static field is sampled from the editor's readback, which this export has none of");
  const inputs: Record<string, SocketValue | undefined> = {};
  const fields = new Map<ImageValue, string>();
  for (const w of ctx.graph.into(id)) {
    const name = w.targetHandle.replace(/^in:/, "");
    const ep = sourceEndpoint(w);
    if (FIELDS.includes(w.targetHandle) || w.targetHandle === "in:pick") {
      if (animatedUpstream(ctx, w.source)) throw new BakeSignal(`Copy to Points ${name} is an animated image field — only a static field is sampled per copy`);
      const img = { kind: "image", texture: {} as WebGLTexture, width: ctx.canvas.width, height: ctx.canvas.height } as ImageValue;
      fields.set(img, ep);
      inputs[name] = img;
    } else if (!w.targetHandle.startsWith("in:param:")) inputs[name] = ctx.graph.valueAt(ep, tick);
  }
  const params = { ...p };
  for (const w of ctx.graph.into(id))
    if (w.targetHandle.startsWith("in:param:")) {
      const v = numbersOf(ctx.graph.valueAt(sourceEndpoint(w), tick))?.[0];
      if (typeof v === "number") params[w.targetHandle.slice(9)] = v;
    }
  const rc = dataOnlyContext(ctx.canvas, { fps: ctx.fps, ticksPerFrame: ctx.tpf }) as RenderContext & { readImagePixels: RenderContext["readImagePixels"] };
  let missing = "";
  rc.readImagePixels = ((img: ImageValue, w: number, h: number) => {
    const ep = fields.get(img);
    const px = ep ? ctx.fieldPixels!(ep, w, h) : undefined;
    if (!px) missing = ep ?? "an image";
    return px ? Uint8Array.from(px) : null;
  }) as RenderContext["readImagePixels"];
  const def = getNodeDef("copy-to-points")!;
  const out = def.compute({ inputs, auxIn: {}, params, ctx: rc, nodeId: `${id}:fields` } as never) as { primary?: SocketValue };
  if (missing) throw new BakeSignal(`Copy to Points image field: no pixels for ${missing}`);
  const s = out?.primary;
  if (!s || s.kind !== "spline") throw new BakeSignal("Copy to Points (spline mode) with image fields did not evaluate to a spline");
  for (const ep of new Set(fields.values())) ctx.report.approx(id, `${ep} sampled at each copy at export (the node's ≤ 256 px luminance readback, 8-bit)`);
  return staticPathGeom(scope, id, s);
}

// Array in spline mode → the instance at the first cell (the per-copy
// translate / rotate / scale as a group transform about the canvas centre)
// and a Repeater per axis: flow-rows steps X inside, flow-columns Y.
export function arrayGeom(scope: Scope, id: string): Geom | null {
  const { ctx } = scope;
  const p = ctx.graph.params(id);
  if (String(p.mode ?? "image") !== "spline" || String(p.distribution ?? "grid") !== "grid") return null;
  const iw = ctx.graph.wireInto(id, "in:instance");
  if (!iw) return null;
  // Keyed or wired array params → the evaluated copies.
  const n = ctx.graph.node(id)!;
  if (ctx.graph.into(id).some((w) => w !== iw) || Object.values(n.animation ?? {}).some((b) => b?.animated && (b.keyframes?.length ?? 0) > 1)) return null;
  const countX = Math.max(1, Math.floor(Number(p.countX ?? 3)));
  const countY = Math.max(1, Math.floor(Number(p.countY ?? 3)));
  const fit = String(p.sizeMode ?? "fit") === "fit";
  const stepX = fit ? 1 / countX : Number(p.sizeW ?? 0.333);
  const stepY = fit ? 1 / countY : Number(p.sizeH ?? 0.333);
  const x0 = 0.5 * stepX + Number(p.patternOffsetX ?? 0) + Number(p.localX ?? 0);
  const y0 = 0.5 * stepY + Number(p.patternOffsetY ?? 0) + Number(p.localY ?? 0);
  const sx = Math.max(0.0001, Number(p.localScaleX ?? 1)) * 100;
  const sy = Math.max(0.0001, Number(p.localScaleY ?? 1)) * 100;
  const rows = String(p.direction ?? "flow-rows") === "flow-rows";
  const L: Lattice = rows
    ? { k: 1, fast: countX, slow: countY, d1: [stepX, 0], d2: [0, stepY] }
    : { k: 1, fast: countY, slow: countX, d1: [0, stepY], d2: [stepX, 0] };
  const inst = geometry(scope, sourceEndpoint(iw), { top: false, canHoist: false });
  ctx.report.note(id, `${countX}×${countY} array → Repeaters (${rows ? "X" : "Y"} inside)`);
  const pattern = [{ pos: [x0, y0] as [number, number], rot: Number(p.localRotate ?? 0), scale: [sx, sy] as [number, number] }];
  return { items: latticeContents(scope, ctx.graph.name(id), inst.items, pattern, canvasToPx([0.5, 0.5], ctx.canvas), L, null), leaves: 1 };
}
