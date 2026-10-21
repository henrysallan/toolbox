// Vector segments → shape-layer contents (spec §3 rung 1, §4.1).
//
// A segment is spline producer → modifiers → transforms → style. The walk
// starts at the style end (a Fill / Stroke / Rasterize Spline, or a
// primitive's bundled raster on `aux:image`) and builds the geometry
// upstream, innermost first:
//
//   circle, rectangle, polygon, star   parametric Ellipse / Rect / Polystar
//                                       while their params map (keys too)
//   any other spline                   Path items: static → the evaluated
//                                       geometry (live corners → Round
//                                       Corners when AE's fillet lands
//                                       within 0.25 px, else baked in);
//                                       a keyed Spline Draw → path keys
//                                       (splineTrackToAe); anything else
//                                       animated → path keys per frame when
//                                       the vertex count holds, else bake
//   trim-path / round-corners /        Trim Paths / Round Corners / Offset
//   spline-offset / spline-boolean     Paths / Merge Paths in a group with
//                                       what they modify
//   transform, a Gizmo wire             a group transform; the outermost one
//                                       moves to the LAYER transform when a
//                                       group cannot carry it (an easing
//                                       that overshoots needs separated X/Y)
//
// AE modifiers act on every path above them in their group, which is why
// each modifier wraps its input in a group of its own.

import { evaluateKeyframesAt, type KeyframeAnimationBlock } from "@/engine/keyframes";
import { getNodeDef } from "@/engine/registry";
import { splineAABB, type AABB } from "@/engine/transform-pivot";
import { roundCornersPerAnchor } from "@/engine/spline-math";
import type { RenderContext, SplineValue } from "@/engine/types";
import { dataOnlyContext } from "@/lib/skia-export/scene-sample";
import { canvasAxisAffine, planCorners, splineToAePaths, splineTrackToAe } from "../convert";
import type { AeLayer, AeLayerTransform, AePath, AePlanNode, AeProp, AeShapeItem, AeShapeTransform } from "../types";
import {
  isAnimatedParam,
  keyCtx,
  pairProp,
  scalarProp,
  staticNumber,
  windowFrames,
  type WalkCtx,
} from "./context";
import { parseOut, sourceEndpoint } from "./graph";
import { BakeSignal, newLayer, rendered, type Rendered, type Scope } from "./layers";
import { repeaterGeom } from "./instances";
import { emitSdfLayer, sdfContourGeometry } from "./sdf";
import { applyImageMask } from "./masks";
import { nodeTransform, nodeTrs, sampledTransform } from "./trs";
import { styleGroups, STYLE_TYPES } from "./style";

export const PRIMITIVES = new Set(["circle", "rectangle", "polygon", "star"]);

export interface Geom {
  items: AeShapeItem[];
  // Path-like leaves (one per subpath where known) — Fill's stacking.
  leaves: number;
  // The outermost transform, when it had to become the layer transform.
  hoist?: AeLayerTransform;
}

// --- time ---------------------------------------------------------------------------

export const localTick = (scope: Scope, compFrame: number) => compFrame * scope.ctx.tpf - scope.clock.offsetTicks;

// Is anything upstream of `id` (itself included) time-dependent?
const animatedMemo = new WeakMap<WalkCtx, Map<string, boolean>>();
export function animatedUpstream(ctx: WalkCtx, id: string): boolean {
  let memo = animatedMemo.get(ctx);
  if (!memo) animatedMemo.set(ctx, (memo = new Map()));
  const visit = (x: string, seen: Set<string>): boolean => {
    if (memo!.has(x)) return memo!.get(x)!;
    if (seen.has(x)) return false;
    seen.add(x);
    const n = ctx.graph.node(x);
    if (!n) return false;
    const def = getNodeDef(n.type);
    const own =
      Object.values(n.animation ?? {}).some((b) => b?.animated && (b.keyframes?.length ?? 0) > 1) ||
      !!def?.facts?.reads?.includes("time") ||
      !!def?.simulation;
    const r = own || ctx.graph.into(x).some((w) => visit(w.source, seen));
    memo!.set(x, r);
    return r;
  };
  return visit(id, new Set());
}

export function splineAt(scope: Scope, endpoint: string, compFrame: number): SplineValue {
  const v = scope.ctx.graph.valueAt(endpoint, localTick(scope, compFrame));
  if (!v || v.kind !== "spline") {
    const err = scope.ctx.graph.errorAt(parseOut(endpoint).id);
    throw new BakeSignal(`${endpoint} evaluated to ${v ? v.kind : "nothing"}${err ? ` (${err})` : ""} — no path to export`);
  }
  return v;
}

// --- geometry ----------------------------------------------------------------------------

interface GeomOpts {
  // This geometry is the whole segment's (its outermost transform may hoist).
  top: boolean;
  // The style node has a mask: a hoisted layer transform would drag a layer
  // mask along, so masks become matte layers (masks.ts) — allowed, but only
  // when the caller says so.
  canHoist: boolean;
  // Downstream asks for explicit paths (a Trim on a rectangle: AE's Rect
  // starts its path elsewhere than toolbox's).
  explicit?: boolean;
}

export function geometry(scope: Scope, endpoint: string, opts: GeomOpts): Geom {
  const { ctx } = scope;
  const { id, out } = parseOut(endpoint);
  const n = ctx.graph.node(id);
  if (!n) throw new BakeSignal(`no node ${id}`);
  const pn = scope.nodes.get(id);
  const t = n.type;
  if (out !== "out:primary") return pathGeom(scope, endpoint);
  const inputEp = (handle: string) => {
    const w = ctx.graph.wireInto(id, handle);
    return w ? sourceEndpoint(w) : undefined;
  };
  const inner = (handle: string, o: Partial<GeomOpts> = {}): Geom => {
    const ep = inputEp(handle);
    if (!ep) throw new BakeSignal(`${t} (${id}) has nothing wired into ${handle}`);
    return geometry(scope, ep, { ...opts, top: false, canHoist: false, ...o });
  };

  if (PRIMITIVES.has(t)) {
    const trimmed = ["trim_start", "trim_end", "trim_offset"].some((p) => isAnimatedParam(ctx, id, p)) || staticNumber(ctx, id, "trim_start", 0) !== 0 || staticNumber(ctx, id, "trim_end", 1) !== 1 || staticNumber(ctx, id, "trim_offset", 0) !== 0;
    let items: AeShapeItem[];
    const explicit = opts.explicit || (trimmed && t === "rectangle");
    const para = explicit ? null : parametric(scope, id, t);
    if (para) items = [para];
    else items = pathGeom(scope, endpoint, trimmed ? untrimmed : undefined).items;
    if (trimmed) {
      ctx.report.approx(id, "bundled trim → Trim Paths: toolbox's primitive trim uses the segment measure, AE trims by arc length");
      items = [{ kind: "group", name: `${ctx.graph.name(id)} trim`, contents: [...items, trimItem(scope, id, "individual")] }];
    }
    const tw = ctx.graph.wireInto(id, "in:transform");
    if (tw) items = gizmoGroups(scope, sourceEndpoint(tw), items, id);
    return { items, leaves: 1 };
  }

  if (t === "transform") {
    const g = ctx.graph.wireInto(id, "in:transform");
    const input = inner("in:image");
    if (g) return { items: gizmoGroups(scope, sourceEndpoint(g), input.items, id), leaves: input.leaves };
    return transformGeom(scope, id, input, opts);
  }

  if (t === "trim-path") {
    const p = ctx.graph.params(id);
    for (const s of ["start_source", "end_source", "offset_source"])
      if ((p[s] ?? "value") !== "value") throw new BakeSignal(`Trim Path ${s} = ${String(p[s])} (per-subpath values) has no Trim Paths form`);
    const measure = String(p.measure ?? "arc length");
    if (measure !== "arc length") ctx.report.approx(id, `measure "${measure}" — AE trims by arc length`);
    const mode = String(p.mode ?? "combined") === "per subpath" ? "simultaneous" : "individual";
    const input = inner("in:path", { explicit: true });
    return { items: [{ kind: "group", name: ctx.graph.name(id), contents: [...input.items, trimItem(scope, id, mode)] }], leaves: input.leaves };
  }

  if (t === "round-corners") {
    const input = inner("in:path");
    const radius = scalarProp(ctx, scope.clock, id, "radius", { map: { scale: ctx.canvas.width, offset: 0 }, fallback: 0.04 });
    ctx.report.approx(id, "Round Corners: AE's fillet differs from toolbox's per-corner arc");
    return { items: [{ kind: "group", name: ctx.graph.name(id), contents: [...input.items, { kind: "round-corners", radius }] }], leaves: input.leaves };
  }

  if (t === "spline-offset") {
    const input = inner("in:path");
    const amount = scalarProp(ctx, scope.clock, id, "distance", { map: { scale: ctx.canvas.width, offset: 0 }, fallback: 0.02 });
    const overlap = String(ctx.graph.params(id).overlap ?? "keep");
    const join = overlap === "smooth" ? "round" : "miter";
    ctx.report.approx(id, `Offset Paths (overlap ${overlap} ≈ Line Join ${join})`);
    return { items: [{ kind: "group", name: ctx.graph.name(id), contents: [...input.items, { kind: "offset", amount, join, miterLimit: 4 }] }], leaves: input.leaves };
  }

  if (t === "spline-boolean") {
    const p = ctx.graph.params(id);
    if ((p.treat_a ?? "shape") !== "shape") throw new BakeSignal("Spline Boolean with treat_a = line (a path cut by a shape) has no Merge Paths form");
    const a = inner("in:a");
    const bEp = inputEp("in:b");
    if (!bEp) return a;
    const b = geometry(scope, bEp, { top: false, canHoist: false });
    const op = String(p.operation ?? "subtract");
    const mode = op === "union" ? "add" : op === "intersect" ? "intersect" : op === "exclude" ? "exclude" : "subtract";
    ctx.report.approx(id, `Merge Paths ${mode}: toolbox polygonizes at its resolution, AE merges the beziers`);
    return {
      items: [{ kind: "group", name: ctx.graph.name(id), contents: [{ kind: "group", name: "A", contents: a.items }, { kind: "group", name: "B", contents: b.items }, { kind: "merge", mode }] }],
      leaves: 1,
    };
  }

  if (t === "copy-to-points") {
    const rg = repeaterGeom(scope, id);
    if (rg) return rg;
  }

  // An SDF contour is traced on the GPU: its tree's own outline instead.
  if (t === "sdf-to-spline") return sdfContourGeometry(scope, id);

  // Everything else: the evaluated geometry.
  if (pn && pn.fidelity === "sampled" && animatedUpstream(ctx, id)) ctx.report.sampled(id, "evaluated path → path keys per frame");
  return pathGeom(scope, endpoint);
}

// Primitive params the untrimmed geometry needs reset (the bundled trim is
// re-applied by AE's Trim Paths).
const untrimmed = { trim_start: 0, trim_end: 1, trim_offset: 0 };

function trimItem(scope: Scope, id: string, mode: "simultaneous" | "individual"): AeShapeItem {
  const { ctx, clock } = scope;
  return {
    kind: "trim",
    start: scalarProp(ctx, clock, id, "trim_start", { map: { scale: 100, offset: 0 }, fallback: 0 }),
    end: scalarProp(ctx, clock, id, "trim_end", { map: { scale: 100, offset: 0 }, fallback: 1 }),
    offset: scalarProp(ctx, clock, id, "trim_offset", { map: { scale: 360, offset: 0 }, fallback: 0 }),
    mode,
  };
}

function parametric(scope: Scope, id: string, t: string): AeShapeItem | null {
  const { ctx, clock } = scope;
  const W = ctx.canvas.width;
  const ax = canvasAxisAffine("x", ctx.canvas);
  const ay = canvasAxisAffine("y", ctx.canvas);
  const name = ctx.graph.name(id);
  if (t === "circle") {
    return {
      kind: "ellipse",
      name,
      size: pairProp(ctx, clock, [{ node: id, param: "radiusX", fallback: 0.25, map: { scale: 2 * W, offset: 0 } }, { node: id, param: "radiusY", fallback: 0.25, map: { scale: 2 * W, offset: 0 } }], { label: "radius", owner: id }),
      position: pairProp(ctx, clock, [{ node: id, param: "centerX", fallback: 0.5, map: ax }, { node: id, param: "centerY", fallback: 0.5, map: ay }], { spatial: true, label: "center", owner: id }),
    };
  }
  if (t === "rectangle") {
    const p = ctx.graph.params(id);
    if (p.corner_style === "squircle" && (isAnimatedParam(ctx, id, "corner_radius") || staticNumber(ctx, id, "corner_radius", 0) > 0))
      ctx.report.approx(id, "squircle corners → Roundness (circular)");
    const position = pairProp(ctx, clock, [{ node: id, param: "originX", fallback: 0.5, map: ax }, { node: id, param: "originY", fallback: 0.5, map: ay }], { spatial: true, label: "origin", owner: id });
    const rect: AeShapeItem = {
      kind: "rect",
      name,
      size: pairProp(ctx, clock, [{ node: id, param: "width", fallback: 0.5, map: { scale: W, offset: 0 } }, { node: id, param: "height", fallback: 0.5, map: { scale: W, offset: 0 } }], { label: "size", owner: id }),
      position,
      roundness: scalarProp(ctx, clock, id, "corner_radius", { map: { scale: W, offset: 0 }, fallback: 0 }),
    };
    const rotated = isAnimatedParam(ctx, id, "rotate") || staticNumber(ctx, id, "rotate", 0) !== 0;
    if (!rotated) return rect;
    // Rotation about the rectangle's own center: a group whose anchor and
    // position are that center.
    return {
      kind: "group",
      name: `${name} rotate`,
      contents: [rect],
      transform: { anchor: position, position, rotation: scalarProp(ctx, clock, id, "rotate", { fallback: 0 }) },
    };
  }
  if (t === "polygon" || t === "star") {
    const countParam = t === "polygon" ? "sides" : "points";
    // Toolbox floors the count; AE draws fractional points. Keyed counts → paths.
    if (isAnimatedParam(ctx, id, countParam)) return null;
    const count = Math.max(3, Math.floor(staticNumber(ctx, id, countParam, 5)));
    const position = pairProp(ctx, clock, [{ node: id, param: "centerX", fallback: 0.5, map: ax }, { node: id, param: "centerY", fallback: 0.5, map: ay }], { spatial: true, label: "center", owner: id });
    const rotation = scalarProp(ctx, clock, id, "rotation", { fallback: 0 });
    if (t === "polygon") {
      return { kind: "polystar", name, type: "polygon", points: { v: count }, position, rotation, outerRadius: scalarProp(ctx, clock, id, "radius", { map: { scale: W, offset: 0 }, fallback: 0.3 }), outerRoundness: { v: 0 } };
    }
    return {
      kind: "polystar",
      name,
      type: "star",
      points: { v: count },
      position,
      rotation,
      outerRadius: scalarProp(ctx, clock, id, "outerRadius", { map: { scale: W, offset: 0 }, fallback: 0.3 }),
      innerRadius: scalarProp(ctx, clock, id, "innerRadius", { map: { scale: W, offset: 0 }, fallback: 0.13 }),
      outerRoundness: { v: 0 },
      innerRoundness: { v: 0 },
    };
  }
  return null;
}

// Evaluated geometry as Path items. `paramOverride` re-evaluates a
// primitive with some params pinned (its untrimmed outline).
function pathGeom(scope: Scope, endpoint: string, paramOverride?: Record<string, unknown>): Geom {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  const [f0, f1] = windowFrames(scope.clock);
  const evalAt = (f: number): SplineValue => (paramOverride ? primitiveAt(scope, id, f, paramOverride) : splineAt(scope, endpoint, f));
  const animated = animatedUpstream(ctx, id);
  if (!animated) {
    const s = evalAt(f0);
    const plan = planCorners(s, ctx.canvas);
    const items: AeShapeItem[] = plan.paths.map((p, i) => ({ kind: "path", name: `${ctx.graph.name(id)} ${i + 1}`, path: { v: p } }));
    if (plan.kind === "uniform") {
      ctx.report.note(id, `live corners → Round Corners ${plan.radius.toFixed(2)} px (within ${plan.maxDeviationPx.toFixed(2)} px of toolbox's fillet)`);
      return { items: [{ kind: "group", name: ctx.graph.name(id), contents: [...items, { kind: "round-corners", radius: { v: plan.radius } }] }], leaves: items.length };
    }
    if (plan.kind === "baked") ctx.report.note(id, `live corners baked into the vertices (${plan.reason})`);
    return { items, leaves: items.length };
  }
  // A Spline Draw whose only motion is its own Path Animation: real keys.
  const n = ctx.graph.node(id)!;
  const sblock = ctx.graph.block(id, "spline");
  const otherMotion = Object.entries(n.animation ?? {}).some(([k, b]) => k !== "spline" && b?.animated && (b.keyframes?.length ?? 0) > 1) || ctx.graph.into(id).length > 0;
  if (!paramOverride && n.type === "spline-draw" && sblock && sblock.keyframes.length > 1 && !otherMotion) {
    const r = splineTrackToAe(sblock, ctx.canvas, keyCtx(ctx, scope.clock));
    if ("error" in r) throw new BakeSignal(`Spline Draw path animation: ${r.error}`);
    ctx.report.track(id, "path", r.report);
    const items: AeShapeItem[] = r.paths.map((p, i) => ({ kind: "path", name: `${ctx.graph.name(id)} ${i + 1}`, path: p }));
    if (r.roundCorners) return { items: [{ kind: "group", name: ctx.graph.name(id), contents: [...items, { kind: "round-corners", radius: r.roundCorners }] }], leaves: items.length };
    return { items, leaves: items.length };
  }
  // Sampled: every frame of the window, vertex counts held.
  const frames: AePath[][] = [];
  for (let f = f0; f <= f1; f++) {
    const s = evalAt(f);
    frames.push(splineToAePaths({ subpaths: roundCornersPerAnchor(s.subpaths) }, ctx.canvas));
  }
  const counts = frames[0].map((p) => p.vertices.length);
  frames.forEach((fr, k) => {
    if (fr.length !== counts.length || fr.some((p, i) => p.vertices.length !== counts[i] || p.closed !== frames[0][i].closed))
      throw new BakeSignal(`animated path changes its subpath / vertex count at frame ${f0 + k} — path keys need a constant count (add a Spline Resample, or it bakes)`);
  });
  ctx.report.sampled(id, `animated path → path keys every frame ${f0}–${f1}`);
  const items: AeShapeItem[] = counts.map((_, i) => {
    const keys = frames.map((fr, k) => ({ t: (f0 + k) / ctx.fps, v: fr[i], inInterp: "linear" as const, outInterp: "linear" as const }));
    const same = keys.every((k) => JSON.stringify(k.v) === JSON.stringify(keys[0].v));
    const path: AeProp<AePath> = same || keys.length < 2 ? { v: keys[0].v } : { keys, dims: 1 };
    return { kind: "path", name: `${ctx.graph.name(id)} ${i + 1}`, path };
  });
  return { items, leaves: items.length };
}

// A primitive's spline at a comp frame with some params pinned: its compute
// on the GL-less context with every param resolved at that tick.
function primitiveAt(scope: Scope, id: string, compFrame: number, pinned: Record<string, unknown>): SplineValue {
  const { ctx } = scope;
  const n = ctx.graph.node(id)!;
  const def = getNodeDef(n.type)!;
  const tick = localTick(scope, compFrame);
  const params: Record<string, unknown> = { ...n.params, stroke_enabled: false, fill_enabled: false, ...pinned };
  for (const p of def.params) {
    if (p.name in pinned) continue;
    const src = ctx.graph.wireInto(id, `in:param:${p.name}`);
    if (src) {
      const v = ctx.graph.valueAt(sourceEndpoint(src), tick) as { value?: unknown } | undefined;
      if (v && "value" in v) params[p.name] = v.value;
      continue;
    }
    const b = ctx.graph.block(id, p.name);
    if (b && b.keyframes.length > 1 && p.type === "scalar") params[p.name] = trackValue(b, tick);
  }
  const out = def.compute({ inputs: {}, auxIn: {}, params, ctx: dataCtxFor(ctx), nodeId: `${id}:untrimmed` } as never) as { primary?: unknown };
  const s = out?.primary as SplineValue | undefined;
  if (!s || s.kind !== "spline") throw new BakeSignal(`${n.type} (${id}) did not evaluate to a spline`);
  return s;
}

const dataCtxMemo = new WeakMap<WalkCtx, RenderContext>();
function dataCtxFor(ctx: WalkCtx): RenderContext {
  let c = dataCtxMemo.get(ctx);
  if (!c) dataCtxMemo.set(ctx, (c = dataOnlyContext(ctx.canvas, { fps: ctx.fps, ticksPerFrame: ctx.tpf })));
  return c;
}
function trackValue(b: KeyframeAnimationBlock, tick: number): number {
  const v = evaluateKeyframesAt(b, "scalar", tick);
  return typeof v === "number" ? v : 0;
}

function toShapeTransform(t: AeLayerTransform): AeShapeTransform {
  return {
    anchor: t.anchor as AeProp<[number, number]>,
    ...(t.position ? { position: t.position as AeProp<[number, number]> } : {}),
    scale: t.scale as AeProp<[number, number]>,
    rotation: t.rotation,
  };
}

// A Transform node on a spline: a group transform, or the layer's.
function transformGeom(scope: Scope, id: string, input: Geom, opts: GeomOpts): Geom {
  const { ctx } = scope;
  const trs = nodeTrs(ctx, id);
  const space = String(ctx.graph.params(id).space ?? "local") === "local" ? "local" : "global";
  const inputEp = sourceEndpoint(ctx.graph.wireInto(id, "in:image")!);
  const inputAnimated = animatedUpstream(ctx, parseOut(inputEp).id);
  const aabbAt = (tick: number): AABB | null => {
    const v = ctx.graph.valueAt(inputEp, tick);
    return v && v.kind === "spline" ? splineAABB(v) : null;
  };
  const r = nodeTransform(ctx, scope.clock, id, trs, {
    space,
    ...(space === "local" ? (inputAnimated ? { aabbAt } : { aabb: aabbAt(localTick(scope, scope.clock.inFrame)) }) : {}),
  });
  const name = ctx.graph.name(id);
  if (!r.transform.separated) {
    return { items: [{ kind: "group", name, contents: input.items, transform: toShapeTransform(r.transform) }], leaves: input.leaves };
  }
  if (opts.top && opts.canHoist) {
    ctx.report.note(id, "→ the layer transform (separated X/Y position: the easing overshoots, which a group's one spatial ease cannot)");
    return { items: input.items, leaves: input.leaves, hoist: r.transform };
  }
  // A group cannot separate dimensions: the whole transform per frame.
  ctx.report.sampled(id, "overshooting position easing inside a group → per-frame transform keys");
  const sampled = sampledTransform(ctx, scope.clock, id, space === "local" ? aabbAt : undefined);
  return { items: [{ kind: "group", name, contents: input.items, transform: toShapeTransform(sampled) }], leaves: input.leaves };
}

// A Gizmo chain wired into a primitive / Transform: one group per gizmo,
// the outermost parent outside.
function gizmoGroups(scope: Scope, endpoint: string, items: AeShapeItem[], owner: string): AeShapeItem[] {
  const { ctx } = scope;
  const chain: string[] = [];
  let ep: string | undefined = endpoint;
  while (ep) {
    const { id } = parseOut(ep);
    const n = ctx.graph.node(id);
    if (!n || n.type !== "gizmo") throw new BakeSignal(`${owner}'s transform input comes from ${n?.type ?? ep}, not a Gizmo chain`);
    chain.push(id);
    const up = ctx.graph.wireInto(id, "in:transform");
    ep = up ? sourceEndpoint(up) : undefined;
  }
  let out = items;
  for (const g of chain) {
    let t = nodeTransform(ctx, scope.clock, g, nodeTrs(ctx, g), { space: "global" }).transform;
    if (t.separated) {
      ctx.report.sampled(g, "overshooting position easing in a group → per-frame transform keys");
      t = sampledTransform(ctx, scope.clock, g);
    }
    out = [{ kind: "group", name: ctx.graph.name(g), contents: out, transform: toShapeTransform(t) }];
  }
  return out;
}

// --- the vector emitter -----------------------------------------------------------------

export function emitVector(scope: Scope, endpoint: string, pn: AePlanNode): Rendered | null {
  const { ctx } = scope;
  const { id, out } = parseOut(endpoint);
  const n = ctx.graph.node(id);
  if (!n) return null;
  if (n.type === "sdf-rasterize" || n.type === "sdf-to-mask") return emitSdfLayer(scope, endpoint, pn);
  const bundled = out === "out:aux:image";
  const isStyle = STYLE_TYPES.has(n.type) && out === "out:primary";
  if (!isStyle && !bundled) return null;
  const maskWire = ctx.graph.wireInto(id, "in:mask");
  const geomEp = isStyle ? (ctx.graph.wireInto(id, "in:path") ? sourceEndpoint(ctx.graph.wireInto(id, "in:path")!) : undefined) : `${id}:out`;
  if (!geomEp) {
    ctx.report.note(id, "nothing wired into its path — an empty shape layer");
    return { layers: [] };
  }
  const geom = geometry(scope, geomEp, { top: true, canHoist: true });
  const groups = styleGroups(scope, id, n.type, isStyle ? "node" : "bundled", geom);
  // Traceability: every node of the segment this shape layer renders.
  const seg = pn.segment >= 0 ? scope.layer.segments[pn.segment] : undefined;
  const origin = seg ? [id, ...seg.nodes.filter((x) => x !== id)] : [id];
  const L: AeLayer = newLayer(scope, "shape", ctx.graph.name(id), origin, { contents: groups });
  if (geom.hoist) {
    L.transform = geom.hoist;
    ctx.free.delete(L);
  }
  if (pn.class === "mask") ctx.report.note(id, "rendered as a shape (its mask use is handled by the consumer)");
  const r = rendered(L);
  if (!maskWire) return r;
  return applyImageMask(scope, r, id, sourceEndpoint(maskWire));
}
