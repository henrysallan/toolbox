// Does a node's own output change with the clock? Shared by the planner
// (editor.ts nodeInfoFor → PlanNodeInfo.readsTime) and the scene walk
// (scene/shape.ts animatedUpstream), so both call the same nodes animated.
//
// A def that declares `reads: time` but has a fingerprint only changes over
// time through that fingerprint (Noise reads the clock only with Animated
// on). Spline Merge's Flow ticks its fingerprint every frame, but it only
// relaxes toward its input's outline (a seek snaps it there), so on a still
// input it holds still.

import type { RenderContext } from "@/engine/types";
import type { getNodeDef } from "@/engine/registry";

type Def = ReturnType<typeof getNodeDef>;

export const SETTLES_TO_INPUT = new Set(["spline-merge"]);

// Does a def's fingerprint change with the clock (its compute reads time)?
export function fingerprintReadsTime(def: Def, params: Record<string, unknown>): boolean {
  const fe = def?.fingerprintExtras;
  if (!fe) return false;
  const at = (s: number) => ({ time: s, frame: Math.floor(s * 30), tick: s * 30_000, fps: 30, ticksPerFrame: 1000, width: 1, height: 1, state: {} }) as unknown as RenderContext;
  try {
    return fe(params, at(0)) !== fe(params, at(1.37));
  } catch {
    return false;
  }
}

// The node itself reads the clock (declared, or through its fingerprint) —
// not counting keyframes, ticking defs or simulations, which callers check.
export function readsClock(type: string, def: Def, params: Record<string, unknown>): boolean {
  if (SETTLES_TO_INPUT.has(type)) return false;
  return (!!def?.facts?.reads?.includes("time") && !def.fingerprintExtras) || fingerprintReadsTime(def, params);
}
