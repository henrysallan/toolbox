// Keyframe clipboard shared by the Tracks / Layers editor and the Graph
// editor, plus the pure ops both paste paths ride.
//
// One clipboard, module-level: a copy in the Tracks editor is pasteable
// from the Graph editor's right-click menu and vice versa. Items are
// multi-lane aware — each remembers its source lane (nodeId, paramName)
// and its tick offset from the EARLIEST copied key, so a paste re-anchors
// the whole selection at one tick (the playhead, or the clicked tick)
// and preserves its internal timing.
//
// Pure ops:
//   • flipClipboardItems — "Paste flipped": mirror the copied keys in time
//     about the midpoint of their span (first key in time becomes last)
//     and reverse every segment's easing so the pasted curve plays the
//     original backwards.
//   • buildPasteUpdates — re-anchor items at a tick and merge them into
//     their lanes' blocks (a pasted key replaces an existing key at the
//     same tick).

import type {
  BezierEasing,
  BezierHandles,
  EasingPreset,
  Keyframe,
  KeyframeAnimationBlock,
} from "@/engine/keyframes";
import { laneKey } from "./keyframe-ops";

export interface KeyframeClipboardItem {
  nodeId: string;
  paramName: string;
  offsetTicks: number;
  keyframe: Keyframe;
}

export interface KeyframeClipboard {
  items: KeyframeClipboardItem[];
}

let clipboard: KeyframeClipboard | null = null;

/** The current clipboard, or null when nothing has been copied. */
export function getKeyframeClipboard(): KeyframeClipboard | null {
  return clipboard;
}

/** Replace the clipboard. An empty list clears it. */
export function setKeyframeClipboard(items: KeyframeClipboardItem[]): void {
  clipboard = items.length > 0 ? { items } : null;
}

/**
 * Build clipboard items from concrete keyframes (each already resolved
 * to its lane). Offsets are relative to the earliest tick across every
 * lane so a multi-lane copy keeps its cross-lane timing.
 */
export function clipboardItemsFrom(
  keys: { nodeId: string; paramName: string; keyframe: Keyframe }[]
): KeyframeClipboardItem[] {
  if (keys.length === 0) return [];
  const minTick = keys.reduce((m, k) => Math.min(m, k.keyframe.tick), Infinity);
  return keys.map((k) => ({
    nodeId: k.nodeId,
    paramName: k.paramName,
    offsetTicks: k.keyframe.tick - minTick,
    keyframe: { ...k.keyframe },
  }));
}

// ---------------------------------------------------------------------
// Time reversal
// ---------------------------------------------------------------------

// Presets that have a mirror image under time reversal. An ease-in
// played backwards is the matching ease-out; in-outs, linear and hold
// are their own mirror. easeOutBounce / easeOutElastic have no ease-in
// counterpart in the preset set, so they stay as they are (the bounce
// lands at the wrong end of the segment — a known approximation).
const EASING_MIRROR: Partial<Record<EasingPreset, EasingPreset>> = {
  easeIn: "easeOut",
  easeOut: "easeIn",
  easeInSine: "easeOutSine",
  easeOutSine: "easeInSine",
  easeInQuad: "easeOutQuad",
  easeOutQuad: "easeInQuad",
  easeInCubic: "easeOutCubic",
  easeOutCubic: "easeInCubic",
  easeInExpo: "easeOutExpo",
  easeOutExpo: "easeInExpo",
  easeInBack: "easeOutBack",
  easeOutBack: "easeInBack",
};

/** The preset that plays `p` backwards in time. */
export function reverseEasingPreset(p: EasingPreset): EasingPreset {
  return EASING_MIRROR[p] ?? p;
}

/**
 * Reverse a normalized cubic-bezier easing in time. Reflecting the curve
 * through the unit square's centre maps every point (x, y) → (1−x, 1−y),
 * which swaps the two control points: (x1, y1, x2, y2) →
 * (1−x2, 1−y2, 1−x1, 1−y1).
 */
export function reverseBezierEasing(e: BezierEasing): BezierEasing {
  return { x1: 1 - e.x2, y1: 1 - e.y2, x2: 1 - e.x1, y2: 1 - e.y1 };
}

// Under time reversal a key's incoming handle becomes its outgoing one
// (and vice versa), pointing the other way in time: dx negates, dy (a
// value offset) is unchanged.
function reverseHandles(h: BezierHandles): BezierHandles {
  return {
    rightHandle: { dx: -h.leftHandle.dx, dy: h.leftHandle.dy },
    leftHandle: { dx: -h.rightHandle.dx, dy: h.rightHandle.dy },
  };
}

/**
 * Mirror one lane's keyframes in time about the midpoint of their span:
 * the first key in time becomes the last. Ticks stay integers (the
 * midpoint reflection is `min + max − tick`).
 *
 * Easing lives on the segment START (`easingOut` of the earlier key), so
 * after reversal each new key's outgoing segment is the old INCOMING
 * segment played backwards: its easing is the mirror preset, a
 * `cubicBezier` shape reflects through the unit square, and
 * `customBezier` handles swap sides with dx negated. The last new key
 * (the old first key) has no incoming segment to inherit; it keeps the
 * old last key's dangling easing, mirrored.
 *
 * Works for any value type — values ride along untouched. Ties in tick
 * keep their relative order.
 */
export function flipKeyframesInTime(keys: Keyframe[]): Keyframe[] {
  if (keys.length === 0) return [];
  const sorted = keys.slice().sort((a, b) => a.tick - b.tick);
  const n = sorted.length;
  const minTick = sorted[0].tick;
  const maxTick = sorted[n - 1].tick;
  const out: Keyframe[] = [];
  for (let j = 0; j < n; j++) {
    const src = sorted[n - 1 - j];
    // The old segment that becomes this key's outgoing one: the one
    // that ended at `src`. For the new last key, fall back to the old
    // last key's dangling easing.
    const seg = j < n - 1 ? sorted[n - 2 - j] : sorted[n - 1];
    const next: Keyframe = {
      ...src,
      tick: minTick + maxTick - src.tick,
      easingOut: reverseEasingPreset(seg.easingOut),
    };
    if (seg.easingOut === "cubicBezier" && seg.bezier) {
      next.bezier = reverseBezierEasing(seg.bezier);
    } else {
      delete next.bezier;
    }
    if (src.bezierHandles) {
      next.bezierHandles = reverseHandles(src.bezierHandles);
    }
    out.push(next);
  }
  return out;
}

/**
 * "Paste flipped": mirror the whole clipboard about the midpoint of its
 * time span (across every lane, so multi-lane timing stays aligned), and
 * reverse each lane's easing as `flipKeyframesInTime` does. Offsets stay
 * relative to the earliest key, so the paste anchor still lands on the
 * first pasted key in time.
 */
export function flipClipboardItems(
  items: KeyframeClipboardItem[]
): KeyframeClipboardItem[] {
  if (items.length === 0) return [];
  const maxOffset = items.reduce((m, it) => Math.max(m, it.offsetTicks), 0);
  // Per lane: rebuild the lane's key list on the offset axis, flip it,
  // then read the flipped keys back out as items.
  const lanes = new Map<
    string,
    { nodeId: string; paramName: string; keys: Keyframe[] }
  >();
  for (const it of items) {
    const key = laneKey(it.nodeId, it.paramName);
    let lane = lanes.get(key);
    if (!lane) {
      lane = { nodeId: it.nodeId, paramName: it.paramName, keys: [] };
      lanes.set(key, lane);
    }
    lane.keys.push({ ...it.keyframe, tick: it.offsetTicks });
  }
  const out: KeyframeClipboardItem[] = [];
  for (const lane of lanes.values()) {
    // Reflect about the WHOLE clipboard's span, not the lane's own: a
    // lane whose keys sit early in the span must land late after the
    // flip. flipKeyframesInTime reflects about the lane's own span, so
    // shift its result by the difference.
    const laneMin = Math.min(...lane.keys.map((k) => k.tick));
    const laneMax = Math.max(...lane.keys.map((k) => k.tick));
    const shift = maxOffset - laneMin - laneMax;
    for (const k of flipKeyframesInTime(lane.keys)) {
      const offset = k.tick + shift;
      out.push({
        nodeId: lane.nodeId,
        paramName: lane.paramName,
        offsetTicks: offset,
        keyframe: { ...k, tick: offset },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------

export interface PasteLaneUpdate {
  nodeId: string;
  paramName: string;
  block: KeyframeAnimationBlock;
  /** Absolute ticks of the keys this paste placed in the lane. */
  pastedTicks: number[];
}

/**
 * Re-anchor clipboard items at `anchorTick` and merge them into their
 * source lanes' blocks. A pasted key replaces an existing key at the
 * same tick; the result is tick-sorted and marks the block animated.
 * Lanes whose block can't be resolved (node deleted, param renamed) are
 * skipped silently. Pure — callers commit each update.
 */
export function buildPasteUpdates(
  items: KeyframeClipboardItem[],
  anchorTick: number,
  lookupBlock: (
    nodeId: string,
    paramName: string
  ) => KeyframeAnimationBlock | undefined
): PasteLaneUpdate[] {
  const grouped = new Map<
    string,
    { nodeId: string; paramName: string; keys: Keyframe[] }
  >();
  for (const it of items) {
    const tick = Math.round(anchorTick + it.offsetTicks);
    if (tick < 0) continue;
    const key = laneKey(it.nodeId, it.paramName);
    let g = grouped.get(key);
    if (!g) {
      g = { nodeId: it.nodeId, paramName: it.paramName, keys: [] };
      grouped.set(key, g);
    }
    g.keys.push({ ...it.keyframe, tick });
  }
  const out: PasteLaneUpdate[] = [];
  for (const g of grouped.values()) {
    const block = lookupBlock(g.nodeId, g.paramName);
    if (!block) continue;
    const ticks = new Set(g.keys.map((k) => k.tick));
    const kept = block.keyframes.filter((k) => !ticks.has(k.tick));
    const merged = [...kept, ...g.keys].sort((a, b) => a.tick - b.tick);
    out.push({
      nodeId: g.nodeId,
      paramName: g.paramName,
      block: { ...block, animated: true, keyframes: merged },
      pastedTicks: Array.from(ticks),
    });
  }
  return out;
}
