// The walk's core: an endpoint → AE layers that render it (top first), and a
// toolbox layer → its AE layer(s) in the main comp.
//
// A `Rendered` is what an endpoint looks like in AE. With one visible layer
// (`main`; matte sources and layer-param references ride along hidden) an
// effect or a blend mode can go on that layer. Several visible layers (a
// Merge, an effect masked over its own input) composite only as a group, so
// anything that needs ONE layer collapses them into a precomp first — the
// precomp shares its container's clock (startTime 0, same duration), so keys
// inside keep their times.
//
// Toolbox layer → AE (spec §4.6, layer transforms initiative):
//   clips      layerTimings: one AE layer per run of windows on one clock;
//              a single run emits straight into the main comp on that clock
//              (offsetTicks), several runs build the content once in a
//              precomp on the layer's local clock and place it once per run
//              (startTime = the run's offset).
//   TRS        transformTracksToAe(space global) on the main layer when its
//              transform is still the comp's identity frame, else on a null
//              every other layer of the unit is parented to.
//   parent     the parent toolbox layer's transform layer (main or null).
//   blend      aeBlendModeOf on the main layer; opacity × the layer opacity.

import { aeBlendModeOf } from "../classes";
import { layerTimings, transformTracksToAe } from "../convert";
import type { AePlanLayerInput } from "../plan";
import type { AeComp, AeLayer, AeLayerKind, AeLayerTransform, AePlanLayer, AePlanNode, AeProp } from "../types";
import { keyCtx, scaleProp, trackSource, type WalkClock, type WalkCtx } from "./context";
import { parseOut, sourceEndpoint } from "./graph";
import { nodeTransform, nodeTrs } from "./trs";

export interface Rendered {
  // Top first, as AeComp.layers.
  layers: AeLayer[];
  // The one visible layer whose pixels are the endpoint; absent when several
  // visible layers composite it.
  main?: AeLayer;
}

export interface Scope {
  ctx: WalkCtx;
  layer: AePlanLayer;
  input: AePlanLayerInput;
  clock: WalkClock;
  // Plan node by id (this toolbox layer's).
  nodes: Map<string, AePlanNode>;
  // Endpoint → the AE layers that render it (a fresh copy per call: AE has
  // no instancing, and a matte source cannot also be a visible layer).
  render(endpoint: string): Rendered;
  // The same toolbox layer on another clock (a Time Offset branch).
  at(clock: WalkClock): Scope;
}

// Emitters, registered by index.ts (keeps this module free of import cycles).
export type Emitter = (scope: Scope, endpoint: string, pn: AePlanNode) => Rendered | null;
export interface Emitters {
  vector: Emitter;
  source: Emitter;
  raster: Emitter;
  composite: Emitter;
  text: Emitter;
  instances: Emitter;
  shader: Emitter;
  bake: (scope: Scope, endpoint: string, reason: string, nodes?: string[]) => Rendered;
}

export const IDENTITY_SCALE: AeProp<number[]> = { v: [100, 100] };

// A comp-sized layer's transform at the comp's identity frame.
export function identityTransform(ctx: WalkCtx): AeLayerTransform {
  const c: [number, number] = [ctx.canvas.width / 2, ctx.canvas.height / 2];
  return { anchor: { v: c }, position: { v: c }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } };
}

// A shape / text / null layer whose layer space is comp space.
export function originTransform(): AeLayerTransform {
  return { anchor: { v: [0, 0] }, position: { v: [0, 0] }, scale: { v: [100, 100] }, rotation: { v: 0 }, opacity: { v: 100 } };
}

export function newLayer(scope: Scope, kind: AeLayerKind, name: string, origin: string[], extra: Partial<AeLayer> = {}): AeLayer {
  const { ctx, clock } = scope;
  const L: AeLayer = {
    id: ctx.uid(origin[0] ?? kind),
    name,
    kind,
    inPoint: clock.inFrame / ctx.fps,
    outPoint: Math.max(clock.inFrame + 1, clock.outFrame) / ctx.fps,
    startTime: 0,
    blendingMode: "normal",
    transform: kind === "shape" || kind === "text" || kind === "null" ? originTransform() : identityTransform(ctx),
    origin: [...origin],
    ...extra,
  };
  if (!extra.transform) ctx.free.add(L);
  return L;
}

export function compSolid(scope: Scope, name: string, origin: string[], color: [number, number, number] = [0, 0, 0], kind: "solid" | "adjustment" = "solid"): AeLayer {
  const { ctx } = scope;
  return newLayer(scope, kind, name, origin, { solid: { color, width: ctx.canvas.width, height: ctx.canvas.height } });
}

export const isVisible = (L: AeLayer) => L.enabled !== false;

export function rendered(main: AeLayer, helpers: AeLayer[] = []): Rendered {
  // Helpers (matte sources) sit directly above their user, as AE draws them.
  return { layers: [...helpers, main], main };
}

// Several visible layers → one precomp layer on the same clock.
export function collapse(scope: Scope, r: Rendered, name: string): Rendered {
  if (r.main && r.layers.filter(isVisible).length === 1) return r;
  const { ctx } = scope;
  const comp: AeComp = {
    id: ctx.uid(`comp:${name}`),
    name: `${ctx.name} · ${name}`,
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    fps: ctx.fps,
    duration: ctx.durationFrames / ctx.fps,
    layers: r.layers,
  };
  // The precomp's own frames cover the container's window.
  comp.duration = Math.max(comp.duration, scope.clock.outFrame / ctx.fps);
  ctx.out.comps.push(comp);
  const origin = [...new Set(r.layers.flatMap((l) => l.origin ?? []))];
  const P = newLayer(scope, "precomp", name, origin.length ? origin : [comp.id], { source: comp.id });
  P.id = ctx.uid(`pre:${name}`);
  return { layers: [P], main: P };
}

export function single(scope: Scope, r: Rendered, name: string): Rendered & { main: AeLayer } {
  const s = collapse(scope, r, name);
  return s as Rendered & { main: AeLayer };
}

// Stack b over a (b on top): several visible layers.
export function over(top: Rendered, below: Rendered): Rendered {
  return { layers: [...top.layers, ...below.layers] };
}

// The main input of a node: the first wired image-typed input in socket
// order, mask sockets excluded (plan.ts mainInput's rule, on the graph).
export function mainInputOf(scope: Scope, id: string): string | undefined {
  const { graph } = scope.ctx;
  const wires = graph.into(id).filter((w) => w.targetHandle.startsWith("in:") && !w.targetHandle.startsWith("in:param:") && w.targetHandle !== "in:mask" && !w.targetHandle.startsWith("in:mask:"));
  const imgs = wires.filter((w) => {
    const pn = scope.nodes.get(w.source);
    return pn && pn.class !== "expression" && pn.class !== "mask";
  });
  return imgs.length ? sourceEndpoint(imgs[0]) : undefined;
}

// --- the dispatcher -----------------------------------------------------------------

export function renderEndpoint(scope: Scope, endpoint: string, em: Emitters): Rendered {
  const { ctx } = scope;
  const { id } = parseOut(endpoint);
  const pn = scope.nodes.get(id);
  if (!pn) {
    ctx.out.problems.push(`${endpoint} is not in layer "${scope.layer.name}" — nothing renders it.`);
    return { layers: [] };
  }
  const ov = ctx.overrides[id];
  if (ov === "skip") {
    ctx.report.note(id, "skipped (export override) — its main input passes through");
    const up = mainInputOf(scope, id);
    return up ? scope.render(up) : { layers: [] };
  }
  if (ov === "bake") {
    ctx.report.reclass(id, "bake", "bake", "baked (export override)");
    return em.bake(scope, endpoint, "export override: bake");
  }
  if (pn.class === "bake" || pn.class === "unsupported") {
    const b = ctx.plan.bakes.find((x) => x.output === endpoint) ?? ctx.plan.bakes.find((x) => pn.notes.some((t) => t.includes(`${x.id} (`)));
    return em.bake(scope, endpoint, b?.reason ?? pn.notes[pn.notes.length - 1] ?? `${pn.type} bakes`, regionNodes(scope, endpoint));
  }
  let r: Rendered | null = null;
  try {
    switch (pn.class) {
      case "shader":
        r = em.shader(scope, endpoint, pn);
        if (!r) return em.bake(scope, endpoint, "shader region with the Toolbox Shader host off (policy.shaderHost = false)", regionNodes(scope, endpoint));
        break;
      case "vector":
      case "style":
      case "mask":
        r = em.vector(scope, endpoint, pn);
        break;
      case "text":
        r = em.text(scope, endpoint, pn);
        break;
      case "instances":
        r = em.instances(scope, endpoint, pn);
        break;
      case "layer":
        r = em.composite(scope, endpoint, pn);
        break;
      case "effect":
      case "transform":
        r = mainInputOf(scope, id) ? em.raster(scope, endpoint, pn) : em.source(scope, endpoint, pn);
        break;
      default:
        r = null;
    }
  } catch (e) {
    if (e instanceof BakeSignal) {
      ctx.report.reclass(id, "bake", "bake", e.reason);
      return em.bake(scope, endpoint, e.reason, pn.class === "shader" ? regionNodes(scope, endpoint) : undefined);
    }
    throw e;
  }
  if (r) return r;
  const why = `${pn.type} (${id}) has no native emitter for "${endpoint}" yet`;
  ctx.report.reclass(id, "bake", "bake", why);
  return em.bake(scope, endpoint, why);
}

// The nodes a bake of `endpoint` renders (its plan region), for the report
// and for "keep procedural" refusals.
function regionNodes(scope: Scope, endpoint: string): string[] {
  const { id } = parseOut(endpoint);
  const sr = scope.ctx.plan.shaderRegions.find((r) => r.target === endpoint || r.nodes.includes(id));
  if (sr) return [id, ...sr.nodes.filter((x) => x !== id)];
  const b = scope.ctx.plan.bakes.find((x) => x.output === endpoint);
  if (b) return [id, ...scope.layer.nodes.filter((n) => n.id !== id && n.notes.some((t) => t.includes(`Baked into ${b.id} (`))).map((n) => n.id)];
  return [id];
}

// Thrown by an emitter that finds out mid-way that a node has no AE form
// (a changing vertex count, an unmapped option): the endpoint bakes instead.
export class BakeSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// --- toolbox layers ----------------------------------------------------------------------

export interface LayerUnit {
  // Top first, as they go into the main comp.
  layers: AeLayer[];
  // What a child toolbox layer parents to.
  xform?: AeLayer;
}

export function emitToolboxLayer(
  ctx: WalkCtx,
  plan: AePlanLayer,
  input: AePlanLayerInput,
  makeScope: (clock: WalkClock) => Scope,
  parentUnit: LayerUnit | undefined
): LayerUnit {
  const isRoot = plan.id === "root" || !ctx.graph.node(plan.id);
  const layerNode = isRoot ? undefined : ctx.graph.node(plan.id);
  if (layerNode) ctx.report.ensure(plan.id, "layer", "layer", plan.name);
  const durationTicks = ctx.durationFrames * ctx.tpf;
  const timings = layerTimings(layerNode?.clips, durationTicks, { fps: ctx.fps, ticksPerFrame: ctx.tpf });
  const toFrame = (s: number) => Math.round(s * ctx.fps);
  if (!input.output) return { layers: [] };

  const finish = (units: AeLayer[][], mains: AeLayer[]): LayerUnit => {
    const all: AeLayer[] = [];
    let xform: AeLayer | undefined;
    units.forEach((layers, i) => {
      const main = mains[i];
      // The main comp names AE layers after the toolbox layers.
      if (layerNode) main.name = units.length > 1 ? `${plan.name} ${i + 1}` : plan.name;
      const unit = layerNode ? decorate(ctx, plan, layerNode.id, layers, main, parentUnit) : { layers, xform: main };
      all.push(...unit.layers);
      xform ??= unit.xform;
    });
    return { layers: all, xform };
  };

  if (timings.length === 1) {
    const t = timings[0];
    const clock: WalkClock = { offsetTicks: t.offsetTicks, inFrame: toFrame(t.inPoint), outFrame: toFrame(t.outPoint) };
    const scope = makeScope(clock);
    let r = scope.render(input.output);
    if (!r.layers.length) return { layers: [] };
    if (layerNode && needsOwnLayer(ctx, layerNode.id, r)) r = collapse(scope, { layers: r.layers }, plan.name);
    if (!r.main) r = collapse(scope, r, plan.name);
    return finish([r.layers], [r.main!]);
  }

  // Several runs on different clocks: the content once, on the local clock.
  const localIn = Math.min(...timings.map((t) => toFrame(t.inPoint - t.startTime)));
  const localOut = Math.max(...timings.map((t) => toFrame(t.outPoint - t.startTime)));
  const inner = makeScope({ offsetTicks: 0, inFrame: localIn, outFrame: localOut, compOffsetFrames: Math.round(timings[0].offsetTicks / ctx.tpf) });
  if (new Set(timings.map((t) => t.offsetTicks)).size > 1) ctx.report.note(plan.id, "a bake inside this layer follows its first clip window's clock");
  const r = inner.render(input.output);
  if (!r.layers.length) return { layers: [] };
  const comp: AeComp = {
    id: ctx.uid(`comp:${plan.name}`),
    name: `${ctx.name} · ${plan.name}`,
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    fps: ctx.fps,
    duration: Math.max(ctx.durationFrames, localOut) / ctx.fps,
    layers: r.layers,
  };
  ctx.out.comps.push(comp);
  ctx.report.note(plan.id, `${timings.length} clip windows on different clocks → one precomp, placed ${timings.length}×`);
  const units: AeLayer[][] = [];
  const mains: AeLayer[] = [];
  for (const t of timings) {
    const outer = makeScope({ offsetTicks: 0, inFrame: toFrame(t.inPoint), outFrame: toFrame(t.outPoint) });
    const P = newLayer(outer, "precomp", plan.name, [plan.id], { source: comp.id, startTime: t.startTime });
    units.push([P]);
    mains.push(P);
  }
  return finish(units, mains);
}

// Does the toolbox layer's own compositing need the content as ONE layer?
function needsOwnLayer(ctx: WalkCtx, layerId: string, r: Rendered): boolean {
  if (!r.main) return true;
  const op = trackSource(ctx, layerId, "opacity", 1);
  const mainOpacity = r.main.transform.opacity;
  // A keyed layer opacity over a keyed content opacity has no single prop.
  return typeof op === "object" && !("v" in mainOpacity && mainOpacity.v === 100);
}

function decorate(ctx: WalkCtx, plan: AePlanLayer, layerId: string, layers: AeLayer[], main: AeLayer, parentUnit: LayerUnit | undefined): LayerUnit {
  const p = ctx.graph.params(layerId);
  const mode = String(p.blendMode ?? "normal");
  const blend = aeBlendModeOf(mode);
  if (blend) main.blendingMode = blend;
  else {
    // The plan made this a shader region or a bake of the layer composite;
    // index.ts emits those. Here the content keeps Normal.
    ctx.report.approx(layerId, `layer blend "${mode}" has no AE mode — composited Normal here (see the shader / bake for this layer)`);
  }
  // Opacity: the layer's × whatever the content already carries.
  const clockTop: WalkClock = { offsetTicks: 0, inFrame: 0, outFrame: ctx.durationFrames };
  const opSrc = trackSource(ctx, layerId, "opacity", 1);
  const contentOpacity = main.transform.opacity;
  if (typeof opSrc === "object" && !Array.isArray(opSrc)) {
    const t = transformTracksToAe({ opacity: opSrc }, { ...keyCtx(ctx, clockTop), canvas: ctx.canvas, space: "global" });
    ctx.report.track(layerId, "opacity", t.reports.opacity);
    const s = "v" in contentOpacity ? contentOpacity.v / 100 : 1;
    main.transform.opacity = scaleProp(t.transform.opacity, s);
  } else {
    const o = typeof opSrc === "number" ? opSrc : 1;
    if (o !== 1) main.transform.opacity = scaleProp(contentOpacity, Math.max(0, Math.min(1, o)));
  }

  // TRS + parenting. The unit's layers must follow the toolbox layer's world
  // transform (parent ∘ own TRS) and nothing else: an interior transform on
  // the main layer must not drag the matte sources along.
  const trs = nodeTrs(ctx, layerId);
  const identity = trs.identity;
  const parent = parentUnit?.xform;
  const link = (L: AeLayer, to: AeLayer | undefined) => {
    if (to && to !== L && !L.parent) L.parent = to.id;
  };
  if (identity) {
    for (const L of layers) link(L, parent);
    return { layers, xform: parent };
  }
  const r = nodeTransform(ctx, clockTop, layerId, trs, { space: "global", label: "layer " });
  if (ctx.free.has(main)) {
    main.transform = { ...r.transform, opacity: main.transform.opacity };
    ctx.free.delete(main);
    link(main, parent);
    for (const L of layers) link(L, main);
    return { layers, xform: main };
  }
  const N: AeLayer = {
    id: ctx.uid(`${layerId}:transform`),
    name: `${plan.name} transform`,
    kind: "null",
    inPoint: main.inPoint,
    outPoint: main.outPoint,
    startTime: 0,
    blendingMode: "normal",
    transform: { ...r.transform, opacity: { v: 100 } },
    origin: [layerId],
  };
  link(N, parent);
  for (const L of layers) link(L, N);
  return { layers: [N, ...layers], xform: N };
}
