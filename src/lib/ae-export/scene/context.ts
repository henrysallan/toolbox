// Shared state of one scene walk, and the param → AeProp helpers every
// emitter uses. A param is one of three things, in the evaluator's own
// priority (wire > keyframes > constant):
//
//   driven   a value wire lands on `in:param:<name>` → its source is
//            evaluated at every frame of the AE layer's window and written
//            as linear per-frame keys (fidelity "sampled"; an AE expression
//            compiler is the next wave);
//   keyed    the node's own track → convert/ with policy.fidelity, verified
//            per frame (keys.ts);
//   static   the stored param.
//
// Every conversion's AeTrackReport goes to the report (scene/report.ts), so
// approximations, samples and dense-key ranges are named per node.

import { evaluateKeyframesAt, type KeyframeAnimationBlock } from "@/engine/keyframes";
import type { ParamType } from "@/engine/types";
import {
  colorToRgba,
  colorTrackToAe,
  combinedTracksToAe,
  numericTrackToAe,
  sampledTrackToAe,
  spatialTrackToAe,
  type AeAffine,
  type AeCanvas,
  type AeKeyContext,
  type AeTrackReport,
  type AeTrackSource,
} from "../convert";
import type {
  AeBakeCodec,
  AeComp,
  AeExportPlan,
  AeExportPolicy,
  AeFootage,
  AeLayer,
  AeProp,
  AeRGB,
  AeShaderBundle,
} from "../types";
import type { AeAssetCopy, AeBakeRequest, AeNodeOverride } from "./types";
import { numbersOf, sourceEndpoint, type AeGraph } from "./graph";
import type { AeReport } from "./report";

// The clock an AE layer's properties are keyed on. Toolbox interior ticks
// run on the layer's local clock (local = comp tick − offsetTicks); AE keys
// are in the time of the comp that holds the layer. Inside a toolbox layer's
// precomp offsetTicks is 0 (the precomp layer's startTime carries it).
// [inFrame, outFrame) is the AE layer window in the container's frames.
export interface WalkClock {
  offsetTicks: number;
  inFrame: number;
  outFrame: number;
  // Container frame → composition frame, when the container is a precomp on
  // a toolbox layer's local clock (bake requests are in composition frames).
  compOffsetFrames?: number;
}

export interface WalkOut {
  comps: AeComp[];
  footage: AeFootage[];
  presets: { id: string; path: string; bytes: Uint8Array }[];
  files: { path: string; text: string }[];
  assets: AeAssetCopy[];
  bakes: AeBakeRequest[];
  bundles: AeShaderBundle[];
  warnings: string[];
  problems: string[];
}

export interface WalkCtx {
  canvas: AeCanvas;
  fps: number;
  tpf: number;
  durationFrames: number;
  policy: AeExportPolicy;
  graph: AeGraph;
  plan: AeExportPlan;
  overrides: Record<string, AeNodeOverride>;
  fused: Record<string, string>;
  name: string;
  report: AeReport;
  out: WalkOut;
  // Project settings an emitter's measured mapping depends on (calibration
  // maps: Gaussian Blur 2 was measured with Linearize Working Space off).
  projectNeeds: { linearizeWorkingSpace?: boolean };
  // Layers whose transform is the comp's identity frame (anchor = position,
  // scale 100, rotation 0): a toolbox layer's TRS can go straight onto them.
  free: WeakSet<AeLayer>;
  uid(base: string): string;
}

export function makeUid(): (base: string) => string {
  const used = new Map<string, number>();
  return (base) => {
    const clean = base.replace(/[^A-Za-z0-9_.:-]+/g, "-") || "x";
    const n = (used.get(clean) ?? 0) + 1;
    used.set(clean, n);
    return n === 1 ? clean : `${clean}#${n}`;
  };
}

export function keyCtx(ctx: WalkCtx, clock: WalkClock): AeKeyContext {
  return {
    fps: ctx.fps,
    ticksPerFrame: ctx.tpf,
    fidelity: ctx.policy.fidelity,
    offsetTicks: clock.offsetTicks,
    frames: [clock.inFrame, Math.max(clock.inFrame, clock.outFrame - 1)],
  };
}

export const secondsOf = (ctx: WalkCtx, frame: number) => frame / ctx.fps;

// Comp frames of the clock's window, as [first, last].
export const windowFrames = (clock: WalkClock): [number, number] => [clock.inFrame, Math.max(clock.inFrame, clock.outFrame - 1)];

const IDENTITY: AeAffine = { scale: 1, offset: 0 };
const apply = (m: AeAffine, v: number) => m.scale * v + m.offset;

// The source endpoint of a value wire into `<id>:param:<param>`, if any.
export function driverOf(ctx: WalkCtx, nodeId: string, param: string): string | undefined {
  const w = ctx.graph.wireInto(nodeId, `in:param:${param}`);
  return w ? sourceEndpoint(w) : undefined;
}

// A param as a track source for convert/: the live block, or the constant.
export function trackSource(ctx: WalkCtx, nodeId: string, param: string, fallback: number): AeTrackSource {
  const b = ctx.graph.block(nodeId, param);
  if (b && b.keyframes.length > 1) return b;
  if (b && b.keyframes.length === 1) {
    const v = b.keyframes[0].value;
    return typeof v === "number" ? v : Array.isArray(v) ? (v as number[]) : fallback;
  }
  const v = ctx.graph.params(nodeId)[param];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function isAnimatedParam(ctx: WalkCtx, nodeId: string, param: string): boolean {
  return !!driverOf(ctx, nodeId, param) || (ctx.graph.block(nodeId, param)?.keyframes.length ?? 0) > 1;
}

export function staticNumber(ctx: WalkCtx, nodeId: string, param: string, fallback: number): number {
  const s = trackSource(ctx, nodeId, param, fallback);
  return typeof s === "number" ? s : Array.isArray(s) ? (s[0] ?? fallback) : fallback;
}

// The driver's value per frame of the window, `pick` picking the
// components wanted (AE units after the map).
function sampleDriver(ctx: WalkCtx, clock: WalkClock, src: string, pick: (v: number[]) => number[]): AeProp<number[]> {
  const r = sampledTrackToAe(
    windowFrames(clock),
    (tick) => pick(numbersOf(ctx.graph.valueAt(src, tick)) ?? [0]),
    keyCtx(ctx, clock),
    `driven by ${src}`
  );
  return r.prop;
}

// A driven param was sampled: say so on the consumer AND on the value nodes
// that drive it (the plan's expression item), which AE will not see.
export function markDriven(ctx: WalkCtx, nodeId: string, param: string, src: string, what: string): void {
  ctx.report.sampled(nodeId, what);
  const drives = `${nodeId}:param:${param}`;
  const item = ctx.plan.expressions.find((e) => e.drives === drives);
  const nodes = item?.nodes ?? [src.replace(/:(out|aux:.*)$/, "")];
  for (const n of nodes) ctx.report.sampled(n, `sampled into ${drives} as per-frame keys (an AE expression compiler is the next wave)`);
}

function noteTrack(ctx: WalkCtx, nodeId: string, what: string, r: AeTrackReport) {
  ctx.report.track(nodeId, what, r);
}

// One scalar param → AeProp<number> in AE units (`map`).
export function scalarProp(
  ctx: WalkCtx,
  clock: WalkClock,
  nodeId: string,
  param: string,
  opts: { map?: AeAffine; fallback?: number; label?: string } = {}
): AeProp<number> {
  const m = opts.map ?? IDENTITY;
  const label = opts.label ?? param;
  const src = driverOf(ctx, nodeId, param);
  if (src) {
    markDriven(ctx, nodeId, param, src, `${label}: driven by ${src} → per-frame keys`);
    const p = sampleDriver(ctx, clock, src, (v) => [apply(m, v[0] ?? 0)]);
    return "v" in p ? { v: p.v[0] } : { keys: p.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 };
  }
  const s = trackSource(ctx, nodeId, param, opts.fallback ?? 0);
  if (typeof s === "object" && !Array.isArray(s)) {
    const r = numericTrackToAe(s, "scalar", { ...keyCtx(ctx, clock), map: m });
    noteTrack(ctx, nodeId, label, r.report);
    return r.prop as AeProp<number>;
  }
  return { v: apply(m, typeof s === "number" ? s : (s?.[0] ?? opts.fallback ?? 0)) };
}

export interface PairPart {
  node: string;
  param: string;
  fallback: number;
  map?: AeAffine;
}

// Two scalar params → one 2-D AE property. `spatial` (positions): one ease
// along the path, per-frame keys when the easing overshoots (AE's spatial
// speed is a magnitude — the caller may prefer separated dimensions).
export function pairProp(ctx: WalkCtx, clock: WalkClock, parts: [PairPart, PairPart], opts: { spatial?: boolean; label: string; owner: string }): AeProp<[number, number]> {
  const maps = parts.map((p) => p.map ?? IDENTITY);
  const drivers = parts.map((p) => driverOf(ctx, p.node, p.param));
  const kc = keyCtx(ctx, clock);
  if (drivers.some(Boolean)) {
    parts.forEach((p, i) => {
      if (drivers[i]) markDriven(ctx, p.node, p.param, drivers[i]!, `${opts.label}: driven (${drivers.filter(Boolean).join(", ")}) → per-frame keys`);
    });
    const r = sampledTrackToAe(
      windowFrames(clock),
      (tick) =>
        parts.map((p, i) => {
          const d = drivers[i];
          const v = d ? (numbersOf(ctx.graph.valueAt(d, tick))?.[0] ?? p.fallback) : valueOfSource(ctx, p, tick);
          return apply(maps[i], v);
        }),
      kc,
      "driven"
    );
    return r.prop as AeProp<[number, number]>;
  }
  const srcs = parts.map((p) => ({ src: trackSource(ctx, p.node, p.param, p.fallback), paramType: "scalar" as ParamType }));
  if (opts.spatial && srcs.some((s) => typeof s.src === "object" && !Array.isArray(s.src))) {
    const sp = spatialTrackToAe(srcs, { ...kc, map: maps });
    if (sp) {
      noteTrack(ctx, opts.owner, opts.label, sp.report);
      return sp.prop as AeProp<[number, number]>;
    }
    // Overshooting / reversing easing on a spatial property: per-frame keys.
    ctx.report.sampled(opts.owner, `${opts.label}: the easing overshoots or reverses, which one spatial ease cannot — per-frame keys`);
    const r = sampledTrackToAe(windowFrames(clock), (tick) => parts.map((p, i) => apply(maps[i], valueOfSource(ctx, p, tick))), kc, "spatial overshoot");
    return r.prop as AeProp<[number, number]>;
  }
  const r = combinedTracksToAe(srcs, { ...kc, map: maps });
  noteTrack(ctx, opts.owner, opts.label, r.report);
  return r.prop as AeProp<[number, number]>;
}

// Toolbox's value of a pair part at a tick of its clock.
export function valueOfSource(ctx: WalkCtx, p: { node: string; param: string; fallback: number }, tick: number): number {
  const b = ctx.graph.block(p.node, p.param);
  if (b && b.keyframes.length > 1) return evalBlock(b, tick, p.fallback);
  return staticNumber(ctx, p.node, p.param, p.fallback);
}

// Toolbox's own interpolation of a scalar block at a tick.
export function evalBlock(b: KeyframeAnimationBlock, tick: number, fallback: number): number {
  const v = evaluateKeyframesAt(b, "scalar", tick);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// A color param → RGB prop + opacity percent (8-digit hex alpha × `alphaScale`).
// `shapeOrSolid` resolves the "auto" color policy (§11.4).
export function colorProp(
  ctx: WalkCtx,
  clock: WalkClock,
  nodeId: string,
  param: string,
  opts: { shapeOrSolid: boolean; fallback?: string; label?: string; opacity?: number }
): { color: AeProp<AeRGB>; opacity: AeProp<number> } {
  const label = opts.label ?? param;
  const opacityScale = (opts.opacity ?? 1) * 100;
  const src = driverOf(ctx, nodeId, param);
  if (src) {
    markDriven(ctx, nodeId, param, src, `${label}: driven by ${src} → per-frame color keys`);
    const rgb = sampleDriver(ctx, clock, src, (v) => [clamp01(v[0] ?? 0), clamp01(v[1] ?? 0), clamp01(v[2] ?? 0)]);
    const a = sampleDriver(ctx, clock, src, (v) => [clamp01(v[3] ?? 1) * opacityScale]);
    return {
      color: rgb as AeProp<AeRGB>,
      opacity: "v" in a ? { v: a.v[0] } : { keys: a.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 },
    };
  }
  const b = ctx.graph.block(nodeId, param);
  if (b && b.keyframes.length > 1) {
    const r = colorTrackToAe(b, {
      ...keyCtx(ctx, clock),
      policy: ctx.policy.color,
      drivesShapeOrSolid: opts.shapeOrSolid,
      tolerance255: ctx.policy.colorTolerance,
    });
    ctx.report.color(nodeId, label, r.report);
    let opacity: AeProp<number> = { v: opacityScale };
    if (r.alpha) opacity = scaleProp(r.alpha, (opts.opacity ?? 1));
    return { color: r.prop, opacity };
  }
  const raw = b?.keyframes[0]?.value ?? ctx.graph.params(nodeId)[param] ?? opts.fallback ?? "#ffffff";
  const c = colorToRgba(raw);
  return { color: { v: [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])] }, opacity: { v: clamp01(c[3]) * opacityScale } };
}

export function scaleProp(p: AeProp<number>, s: number): AeProp<number> {
  if (s === 1) return p;
  if ("v" in p) return { ...p, v: p.v * s };
  return {
    ...p,
    keys: p.keys.map((k) => ({
      ...k,
      v: k.v * s,
      ...(k.easeIn ? { easeIn: k.easeIn.map((e) => ({ ...e, speed: e.speed * s })) } : {}),
      ...(k.easeOut ? { easeOut: k.easeOut.map((e) => ({ ...e, speed: e.speed * s })) } : {}),
    })),
  };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function staticOf<T>(p: AeProp<T>): T | undefined {
  return "v" in p ? p.v : undefined;
}

export function bakeCodec(ctx: WalkCtx): AeBakeCodec {
  return ctx.policy.bakeCodec;
}
