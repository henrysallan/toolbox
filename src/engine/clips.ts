// Per-node timeline clips.
//
// A clip turns a *source* node (Video / Image / Text / Spline Draw / spline
// primitives) into a Track-Editor clip with an in/out window. A node may hold
// MULTIPLE disjoint windows (`clips: ClipBlock[]`) — that's how splitting
// works: a razor cut replaces one window with two adjacent ones. Because the
// windows never overlap, the node still produces a single output per frame
// (the active window's, or empty between windows), so no node duplication or
// graph rewiring is needed.
//
// Two things a clip window can do:
//
//   1. GATE  — the node emits its normal output only while the global
//      playhead is inside some [inTick, outTick); outside every window it
//      emits an empty value of its output type. This is all most clippable
//      nodes need (their content is a function of params, not time).
//
//   2. LOCAL TIME — for time-driven sources (Video) the active window also
//      remaps the clock: the node sees `globalTick - inTick + sourceInTick`
//      instead of the global tick, so dragging a window retimes the footage
//      and `sourceInTick` slips which part of the source plays. Only types in
//      TIME_DRIVEN_CLIP_TYPES are remapped; everything else is a pure gate
//      (their keyframes stay on the global clock for now).

import { pointsFromArray } from "./points";
import type { NodeOutput, RenderContext, SocketType } from "./types";

export interface ClipBlock {
  // Visibility window on the GLOBAL timeline, in ticks. Active while
  // inTick <= globalTick < outTick.
  inTick: number;
  outTick: number;
  // Content offset in ticks for time-driven sources: what point in the
  // source's own timeline maps to inTick. Lets you slip the footage inside
  // the window without moving it. Ignored by static sources.
  sourceInTick: number;
  // When false the window is inert — it neither gates nor remaps. If a node's
  // every window is disabled the node behaves as if unclipped.
  enabled: boolean;
}

// The node `type`s that may carry clips. Edit this set to add/remove
// clippable node kinds. All of these are graph sources (generators) with no
// required data input, which is what makes clips belong on them.
export const CLIPPABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  "video-source",
  "image-source",
  "text",
  "spline-draw",
  "rectangle",
  "circle",
  "svg-source",
  // A layer's clip windows are its in/out bars: outside them the layer
  // passes its stack through and its interior leaves the needed set.
  // The window also sets the interior's local clock (AE-style:
  // localTick = globalTick − inTick + sourceInTick), so sliding the
  // bar slides everything inside. Not time-driven — the layer node's
  // own params (opacity keyframes) stay on the global clock; the
  // evaluator applies the offset to interior nodes directly.
  "layer",
]);

// Of the clippable set, only these remap their clock to clip-local time.
// Everything else is a pure visibility gate.
export const TIME_DRIVEN_CLIP_TYPES: ReadonlySet<string> = new Set([
  "video-source",
]);

export function isClippable(nodeType: string): boolean {
  return CLIPPABLE_NODE_TYPES.has(nodeType);
}

export function isTimeDrivenClip(nodeType: string): boolean {
  return TIME_DRIVEN_CLIP_TYPES.has(nodeType);
}

export function defaultClip(inTick: number, outTick: number): ClipBlock {
  return { inTick, outTick, sourceInTick: 0, enabled: true };
}

export interface ClipResolution {
  // True ⇒ the node has enforced windows but the playhead is in none of them,
  // so the node emits an empty value.
  gated: boolean;
  // The window containing the playhead, if any.
  active?: ClipBlock;
}

// Resolve which window (if any) is active at a global tick. No enabled windows
// ⇒ ungated (the node behaves as if unclipped).
export function resolveClipAt(
  clips: ClipBlock[] | undefined,
  globalTick: number
): ClipResolution {
  if (!clips || clips.length === 0) return { gated: false };
  let hasEnforced = false;
  for (const c of clips) {
    if (!c.enabled) continue;
    hasEnforced = true;
    if (globalTick >= c.inTick && globalTick < c.outTick) {
      return { gated: false, active: c };
    }
  }
  return { gated: hasEnforced };
}

// Map a global tick to local time for the given (time-driven) window.
export function clipLocalTick(clip: ClipBlock, globalTick: number): number {
  return globalTick - clip.inTick + clip.sourceInTick;
}

// Split the window strictly containing `tick` into two adjacent windows.
// Returns a new array; if no window contains `tick`, returns a copy of the
// original. The second piece inherits a slipped sourceInTick so a Video cut
// is seamless (the same source frame plays on both sides of the cut).
export function splitClipsAt(clips: ClipBlock[], tick: number): ClipBlock[] {
  const out: ClipBlock[] = [];
  let didSplit = false;
  for (const c of clips) {
    if (!didSplit && tick > c.inTick && tick < c.outTick) {
      out.push({ ...c, outTick: tick });
      out.push({
        ...c,
        inTick: tick,
        sourceInTick: c.sourceInTick + (tick - c.inTick),
      });
      didSplit = true;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

// Empty value of the given output type, emitted by a gated node. Image-like
// types allocate a transparent texture (caller owns it, same lifecycle as a
// normal computed output); CPU types return cheap empty payloads.
export function emptyClipOutput(
  ctx: RenderContext,
  type: SocketType | null
): NodeOutput {
  switch (type) {
    case "image": {
      const img = ctx.allocImage();
      ctx.clearTarget(img, [0, 0, 0, 0]);
      return { primary: img };
    }
    case "mask": {
      const m = ctx.allocMask();
      ctx.clearTarget(m, [0, 0, 0, 0]);
      return { primary: m };
    }
    case "uv": {
      const uv = ctx.allocUv();
      ctx.clearTarget(uv, [0, 0, 0, 0]);
      return { primary: uv };
    }
    case "spline":
      return { primary: { kind: "spline", subpaths: [] } };
    case "points":
      return { primary: pointsFromArray([]) };
    case "image_group":
      return { primary: { kind: "image_group", items: [] } };
    default:
      // No representable empty (or a non-data output) — emit nothing.
      return {};
  }
}
