// A node's TRS params (Transform, Gizmo, Image Source, a toolbox layer…) →
// an AE transform. Keyed / static params go through convert/'s
// transformTracksToAe (eases kept, verified per frame). When any of them is
// WIRED, each AE property that reads a wired param becomes an AE expression
// (expressions/: the value graph compiled, checked against the sampled op at
// every frame) and the others convert as tracks. If one of those properties
// can't compile — it also reads a keyed param, a local pivot rides an
// animated bounding box, the driver graph has a node the compiler lacks —
// the whole op is evaluated at every frame of the window and written as
// per-frame keys: exact at frames, reported "sampled".

import { localPivot, type AABB } from "@/engine/transform-pivot";
import type { TransformOp } from "@/engine/types";
import { opToAeStatic, sampledTrackToAe, transformTracksToAe, type AeTransformTracks } from "../convert";
import type { AeLayerTransform, AeProp } from "../types";
import { driverOf, keyCtx, markDriven, trackSource, valueOfSource, windowFrames, type WalkClock, type WalkCtx } from "./context";
import type { PExpr } from "@/lib/skia-export/procedural/ir";
import { exprProp, ir, type ExprPropResult } from "./expressions";
import { numbersOf } from "./graph";

export const TRS_PARAMS = ["translateX", "translateY", "scaleX", "scaleY", "rotate", "pivotX", "pivotY"] as const;
export type TrsParam = (typeof TRS_PARAMS)[number];
export const TRS_DEFAULT: Record<TrsParam, number> = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotate: 0, pivotX: 0.5, pivotY: 0.5 };

export interface NodeTrs {
  tracks: AeTransformTracks;
  // Some param is wired: sample.
  driven: boolean;
  // Every param at its default (pivot aside).
  identity: boolean;
}

export function nodeTrs(ctx: WalkCtx, id: string): NodeTrs {
  const tracks: AeTransformTracks = {};
  let identity = true;
  let driven = false;
  for (const p of TRS_PARAMS) {
    if (driverOf(ctx, id, p)) {
      driven = true;
      identity = false;
      continue;
    }
    const s = trackSource(ctx, id, p, TRS_DEFAULT[p]);
    tracks[p] = s;
    if (typeof s === "object" || (typeof s === "number" && s !== TRS_DEFAULT[p] && p !== "pivotX" && p !== "pivotY")) identity = false;
  }
  return { tracks, driven, identity };
}

// The node's op at a tick of its clock (wire > keys > constant), with a
// local pivot resolved against `aabbAt` (Transform's space=local).
export function opAt(ctx: WalkCtx, id: string, tick: number, aabbAt?: (tick: number) => AABB | null): TransformOp {
  const v = (p: TrsParam) => {
    const d = driverOf(ctx, id, p);
    if (d) return numbersOf(ctx.graph.valueAt(d, tick))?.[0] ?? TRS_DEFAULT[p];
    return valueOfSource(ctx, { node: id, param: p, fallback: TRS_DEFAULT[p] }, tick);
  };
  const op: TransformOp = {
    translateX: v("translateX"),
    translateY: v("translateY"),
    scaleX: Math.max(0.0001, v("scaleX")),
    scaleY: Math.max(0.0001, v("scaleY")),
    rotateDeg: v("rotate"),
    pivotX: v("pivotX"),
    pivotY: v("pivotY"),
  };
  if (aabbAt) {
    const p = localPivot(aabbAt(tick), op.pivotX, op.pivotY);
    op.pivotX = p.x;
    op.pivotY = p.y;
  }
  return op;
}

const one = (p: AeProp<number[]>): AeProp<number> => ("v" in p ? { v: p.v[0] } : { keys: p.keys.map((k) => ({ ...k, v: k.v[0] })), dims: 1 });

// The whole transform per frame (some param is wired). `why`: what kept
// the expression compiler from it.
export function sampledTransform(ctx: WalkCtx, clock: WalkClock, id: string, aabbAt?: (tick: number) => AABB | null, why?: string): AeLayerTransform {
  const frames = windowFrames(clock);
  const kc = keyCtx(ctx, clock);
  const at = (tick: number) => opToAeStatic(opAt(ctx, id, tick, aabbAt), ctx.canvas);
  const prop = (f: (s: ReturnType<typeof at>) => number[]) => sampledTrackToAe(frames, (tick) => f(at(tick)), kc, "driven transform").prop;
  const what = `wired transform params → per-frame anchor / position / scale / rotation keys (frames ${frames[0]}–${frames[1]})${why ? ` (${why})` : ""}`;
  ctx.report.sampled(id, what);
  for (const p of TRS_PARAMS) {
    const d = driverOf(ctx, id, p);
    if (d) markDriven(ctx, id, p, d, what, why);
  }
  return {
    anchor: prop((s) => s.anchor),
    position: prop((s) => s.position),
    scale: prop((s) => s.scale),
    rotation: one(prop((s) => [s.rotation])),
    opacity: { v: 100 },
  };
}

const sameBox = (a: AABB | null, b: AABB | null) =>
  a === b || (!!a && !!b && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY);

// Some param is wired: the AE properties that read a wired param as
// expressions of the op opAt builds (opFromParams's scale clamp, localPivot's
// box fraction, opToAeStatic's px), the rest from `tracked` (the node's
// keyed / static params). A refusal names why.
function expressionTransform(
  ctx: WalkCtx,
  clock: WalkClock,
  id: string,
  tracked: () => AeLayerTransform,
  aabbAt: ((tick: number) => AABB | null) | undefined
): { transform: AeLayerTransform } | { refused: string } {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const [f0, f1] = windowFrames(clock);
  let box: AABB | null = null;
  if (aabbAt) {
    box = aabbAt(f0 * ctx.tpf - clock.offsetTicks);
    for (let f = f0 + 1; f <= f1; f++) if (!sameBox(box, aabbAt(f * ctx.tpf - clock.offsetTicks))) return { refused: "space=local over an animated bounding box" };
  }
  const local = !!aabbAt && !!box && box.maxX > box.minX && box.maxY > box.minY;
  const at = (tick: number) => opToAeStatic(opAt(ctx, id, tick, aabbAt), ctx.canvas);
  const ref = (p: TrsParam) => ({ node: id, param: p, fallback: TRS_DEFAULT[p] });
  const pivot = (v: PExpr[]) => {
    // localPivot: minX + p·(maxX − minX); then canvasToPx.
    const px = local ? ir.add(ir.lit(box!.minX), ir.mul(v[0], ir.lit(box!.maxX - box!.minX))) : v[0];
    const py = local ? ir.add(ir.lit(box!.minY), ir.mul(v[1], ir.lit(box!.maxY - box!.minY))) : v[1];
    return [ir.mul(px, ir.lit(W)), ir.add(ir.mul(py, ir.lit(W)), ir.lit(0.5 * (H - W)))];
  };
  const wired = (ps: TrsParam[]) => ps.some((p) => driverOf(ctx, id, p));
  const props: Record<string, ExprPropResult> = {};
  const want = (key: string, label: string, ps: TrsParam[], out: (v: PExpr[]) => PExpr[], pick: (s: ReturnType<typeof at>) => number[], keyLength?: number) => {
    if (!wired(ps)) return;
    props[key] = exprProp(ctx, clock, { label, owner: id, inputs: ps.map(ref), out, oracle: (tick) => pick(at(tick)), defer: true, ...(keyLength ? { keyLength } : {}) });
  };
  want("anchor", "anchor", ["pivotX", "pivotY"], pivot, (s) => s.anchor);
  want("position", "position", ["pivotX", "pivotY", "translateX", "translateY"], (v) => {
    const p = pivot(v);
    return [ir.add(p[0], ir.mul(v[2], ir.lit(W))), ir.add(p[1], ir.mul(v[3], ir.lit(W)))];
  }, (s) => s.position);
  want("scale", "scale", ["scaleX", "scaleY"], (v) => v.map((x) => ir.mul(ir.max(ir.lit(0.0001), x), ir.lit(100))), (s) => s.scale);
  want("rotation", "rotation", ["rotate"], (v) => [v[0]], (s) => [s.rotation], 1);
  for (const r of Object.values(props)) if ("refused" in r) return { refused: r.refused };
  const t: AeLayerTransform = { ...tracked() };
  for (const [k, r] of Object.entries(props)) {
    if (!("prop" in r)) continue;
    r.commit();
    (t as unknown as Record<string, AeProp>)[k] = r.prop;
    if (k === "position") delete t.separated;
  }
  return { transform: t };
}

// Keyed / static → transformTracksToAe; driven → expressions, else sampled.
export function nodeTransform(
  ctx: WalkCtx,
  clock: WalkClock,
  id: string,
  t: NodeTrs,
  opts: { space: "local" | "global"; aabb?: AABB | null; aabbAt?: (tick: number) => AABB | null; label?: string }
): { transform: AeLayerTransform; sampled: boolean } {
  const tracked = () => {
    const r = transformTracksToAe(t.tracks, {
      ...keyCtx(ctx, clock),
      canvas: ctx.canvas,
      space: opts.space,
      ...(opts.space === "local" ? (opts.aabbAt ? { aabbAt: opts.aabbAt } : { aabb: opts.aabb ?? null }) : {}),
      frames: windowFrames(clock),
    });
    for (const [k, rep] of Object.entries(r.reports)) ctx.report.track(id, `${opts.label ?? ""}${k}`, rep);
    for (const n of r.notes) ctx.report.note(id, n);
    return r;
  };
  if (t.driven) {
    const aabbAt = opts.space === "local" ? (opts.aabbAt ?? (() => opts.aabb ?? null)) : undefined;
    const ex = expressionTransform(ctx, clock, id, () => tracked().transform, aabbAt);
    if ("transform" in ex) return { transform: ex.transform, sampled: false };
    return { transform: sampledTransform(ctx, clock, id, aabbAt, ex.refused), sampled: true };
  }
  const r = tracked();
  // TRS knobs → expressions reading their controls (knobs.ts).
  const box = opts.space === "local" ? (opts.aabbAt ? opts.aabbAt(windowFrames(clock)[0] * ctx.tpf - clock.offsetTicks) : opts.aabb) : null;
  ctx.knobs.trs(ctx, clock, id, t, r, box, opts.space);
  return { transform: r.transform, sampled: false };
}
