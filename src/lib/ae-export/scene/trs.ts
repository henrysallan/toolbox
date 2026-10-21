// A node's TRS params (Transform, Gizmo, Image Source, a toolbox layer…) →
// an AE transform. Keyed / static params go through convert/'s
// transformTracksToAe (eases kept, verified per frame). When any of them is
// WIRED, there is no keyed track to convert: the whole op is evaluated at
// every frame of the window (the driver through the scene sampler) and
// written as per-frame keys — exact at frames, reported "sampled". An AE
// expression compiler would keep these live (next wave).

import { localPivot, type AABB } from "@/engine/transform-pivot";
import type { TransformOp } from "@/engine/types";
import { opToAeStatic, sampledTrackToAe, transformTracksToAe, type AeTransformTracks } from "../convert";
import type { AeLayerTransform, AeProp } from "../types";
import { driverOf, keyCtx, markDriven, trackSource, valueOfSource, windowFrames, type WalkClock, type WalkCtx } from "./context";
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

// The whole transform per frame (some param is wired).
export function sampledTransform(ctx: WalkCtx, clock: WalkClock, id: string, aabbAt?: (tick: number) => AABB | null): AeLayerTransform {
  const frames = windowFrames(clock);
  const kc = keyCtx(ctx, clock);
  const at = (tick: number) => opToAeStatic(opAt(ctx, id, tick, aabbAt), ctx.canvas);
  const prop = (f: (s: ReturnType<typeof at>) => number[]) => sampledTrackToAe(frames, (tick) => f(at(tick)), kc, "driven transform").prop;
  const what = `wired transform params → per-frame anchor / position / scale / rotation keys (frames ${frames[0]}–${frames[1]})`;
  ctx.report.sampled(id, what);
  for (const p of TRS_PARAMS) {
    const d = driverOf(ctx, id, p);
    if (d) markDriven(ctx, id, p, d, what);
  }
  return {
    anchor: prop((s) => s.anchor),
    position: prop((s) => s.position),
    scale: prop((s) => s.scale),
    rotation: one(prop((s) => [s.rotation])),
    opacity: { v: 100 },
  };
}

// Keyed / static → transformTracksToAe; driven → sampled.
export function nodeTransform(
  ctx: WalkCtx,
  clock: WalkClock,
  id: string,
  t: NodeTrs,
  opts: { space: "local" | "global"; aabb?: AABB | null; aabbAt?: (tick: number) => AABB | null; label?: string }
): { transform: AeLayerTransform; sampled: boolean } {
  if (t.driven) {
    const aabbAt = opts.space === "local" ? (opts.aabbAt ?? (() => opts.aabb ?? null)) : undefined;
    return { transform: sampledTransform(ctx, clock, id, aabbAt), sampled: true };
  }
  const r = transformTracksToAe(t.tracks, {
    ...keyCtx(ctx, clock),
    canvas: ctx.canvas,
    space: opts.space,
    ...(opts.space === "local" ? (opts.aabbAt ? { aabbAt: opts.aabbAt } : { aabb: opts.aabb ?? null }) : {}),
    frames: windowFrames(clock),
  });
  for (const [k, rep] of Object.entries(r.reports)) ctx.report.track(id, `${opts.label ?? ""}${k}`, rep);
  for (const n of r.notes) ctx.report.note(id, n);
  // TRS knobs → expressions reading their controls (knobs.ts).
  const box = opts.space === "local" ? (opts.aabbAt ? opts.aabbAt(windowFrames(clock)[0] * ctx.tpf - clock.offsetTicks) : opts.aabb) : null;
  ctx.knobs.trs(ctx, clock, id, t, r, box, opts.space);
  return { transform: r.transform, sampled: false };
}
