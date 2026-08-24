// Shared keyframe transform ops for the timeline editors: move / scale /
// stagger a multi-lane selection, rebuilt each mousemove from drag-start
// snapshots (GroupBase). Previously TrackEditor, LayersEditor and
// GraphEditor each carried a near-copy of these with drifted policies;
// the single policy now is:
//
//   • Snapping is caller-supplied per gesture (`snap` = !shiftKey), via
//     snapTickToFrame. Ticks are always rounded to integers.
//   • Results clamp to tick ≥ 0 by clamping the gesture DELTA (not each
//     key), so a selection pushed against 0 stops as a unit instead of
//     piling keys onto tick 0 where the dedup would destroy them.
//   • Tick collisions resolve "dragged keys win": a moved key replaces a
//     stationary one at the same tick regardless of drag direction.
//     (Because every mousemove rebuilds from the originals, passing over
//     a key mid-drag is non-destructive; only release commits.)
//   • Scale clamps its factor so the selection's span never drops below
//     one frame (no collapse-to-a-column data loss) and never mirrors.
//   • The block's `animated` flag is left untouched — transforming keys
//     on a disabled block keeps it disabled (non-destructive contract).

import type { Keyframe } from "@/engine/keyframes";
import { snapTickToFrame } from "@/engine/keyframes";

// A selected keyframe, identified across lanes. NUL separators so
// ids/param names containing spaces can't collide. Always the escape
// sequence, never a raw byte — a literal NUL makes grep treat the
// file as binary (see the 070326 architecture review).
export interface SelectionKey {
  nodeId: string;
  paramName: string;
  tick: number;
}

export const SEL_SEP = "\u0000";

// Monotonic gesture ids so every multi-lane gesture (delete, paste,
// easing-set, drag) coalesces into ONE undo entry — each per-lane
// onAnimationChange in the gesture shares the key — while the next
// gesture gets a fresh key so it can never merge into the previous one
// inside the history coalesce window.
let gestureSeq = 0;
/**
 * Do two keyframes hold the same value? Drives the connector's dash in
 * both lane editors: a segment where the value CHANGES is dashed, one
 * where it holds is solid, so a track's actual motion is legible at a
 * glance without reading the numbers.
 *
 * Keyframe values are `unknown` — scalars, vec2/3/4 arrays, colour
 * strings or objects, booleans — so this compares numbers with an
 * epsilon (interpolated values rarely land bit-identical), recurses
 * through arrays and plain objects, and otherwise falls back to strict
 * equality. Anything it can't compare is reported as CHANGED, which is
 * the safe default: a dashed line over a static segment is a cosmetic
 * miss, a solid line over a moving one is a lie.
 */
export function keyframeValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-9;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((v, i) => keyframeValuesEqual(v, b[i]))
    );
  }
  if (
    a != null &&
    b != null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    return (
      ak.length === bk.length &&
      ak.every(
        (k) =>
          Object.prototype.hasOwnProperty.call(bo, k) &&
          keyframeValuesEqual(ao[k], bo[k])
      )
    );
  }
  return false;
}

export function nextGestureKey(kind: string): string {
  gestureSeq += 1;
  return `kf-${kind}:${gestureSeq}`;
}

export function selKey(s: SelectionKey): string {
  return `${s.nodeId}${SEL_SEP}${s.paramName}${SEL_SEP}${s.tick}`;
}

export function laneKey(nodeId: string, paramName: string): string {
  return `${nodeId}${SEL_SEP}${paramName}`;
}

// Group selection entries by lane so callers can emit one
// onAnimationChange per affected block.
export function groupSelection(
  sel: SelectionKey[]
): Map<string, SelectionKey[]> {
  const groups = new Map<string, SelectionKey[]>();
  for (const s of sel) {
    const k = laneKey(s.nodeId, s.paramName);
    const list = groups.get(k);
    if (list) list.push(s);
    else groups.set(k, [s]);
  }
  return groups;
}

// Snapshot of a lane's keyframes at drag-start. Each mousemove
// recomputes from `originals` so the gesture has a stable baseline.
export interface GroupBase {
  nodeId: string;
  paramName: string;
  originals: Keyframe[];
  selectedOriginalTicks: Set<number>;
}

export function buildGroupBases(
  sel: SelectionKey[],
  getBlock: (
    nodeId: string,
    paramName: string
  ) => { keyframes: Keyframe[] } | undefined
): GroupBase[] {
  const bases = new Map<string, GroupBase>();
  for (const s of sel) {
    const gk = laneKey(s.nodeId, s.paramName);
    let entry = bases.get(gk);
    if (!entry) {
      const block = getBlock(s.nodeId, s.paramName);
      if (!block) continue;
      entry = {
        nodeId: s.nodeId,
        paramName: s.paramName,
        originals: block.keyframes.map((k) => ({ ...k })),
        selectedOriginalTicks: new Set<number>(),
      };
      bases.set(gk, entry);
    }
    entry.selectedOriginalTicks.add(s.tick);
  }
  return [...bases.values()];
}

export interface KeyframeOpOptions {
  snap: boolean;
  ticksPerFrame: number;
}

export interface KeyframeLaneUpdate {
  nodeId: string;
  paramName: string;
  keyframes: Keyframe[];
}

export interface KeyframeOpResult {
  updates: KeyframeLaneUpdate[];
  selection: SelectionKey[];
}

function mapTick(
  tick: number,
  delta: number,
  { snap, ticksPerFrame }: KeyframeOpOptions
): number {
  const raw = tick + delta;
  const t = snap ? snapTickToFrame(raw, ticksPerFrame) : raw;
  return Math.max(0, Math.round(t));
}

// Rebuild a lane's keyframes with the selected ones remapped. Two-pass
// dedup: stationary keys first, then moved keys overwrite — so the
// dragged key wins a collision in either direction.
function rebuildLane(
  base: GroupBase,
  remapSelected: (tick: number) => number
): { keyframes: Keyframe[]; selectedTicks: number[] } {
  const out = new Map<number, Keyframe>();
  for (const k of base.originals) {
    if (!base.selectedOriginalTicks.has(k.tick)) out.set(k.tick, { ...k });
  }
  const selectedTicks: number[] = [];
  for (const k of base.originals) {
    if (!base.selectedOriginalTicks.has(k.tick)) continue;
    const t = remapSelected(k.tick);
    out.set(t, { ...k, tick: t });
    selectedTicks.push(t);
  }
  return {
    keyframes: [...out.values()].sort((a, b) => a.tick - b.tick),
    selectedTicks,
  };
}

function collectResult(
  bases: GroupBase[],
  remapFor: (base: GroupBase) => (tick: number) => number
): KeyframeOpResult {
  const updates: KeyframeLaneUpdate[] = [];
  const selection: SelectionKey[] = [];
  for (const base of bases) {
    const { keyframes, selectedTicks } = rebuildLane(base, remapFor(base));
    updates.push({
      nodeId: base.nodeId,
      paramName: base.paramName,
      keyframes,
    });
    for (const tick of selectedTicks) {
      selection.push({ nodeId: base.nodeId, paramName: base.paramName, tick });
    }
  }
  return { updates, selection };
}

// Earliest selected tick across every lane — the ≥0 clamp anchor.
function minSelectedTick(bases: GroupBase[]): number {
  let min = Infinity;
  for (const b of bases) {
    for (const t of b.selectedOriginalTicks) if (t < min) min = t;
  }
  return isFinite(min) ? min : 0;
}

// Move the whole selection by a tick delta.
export function moveKeyframes(
  bases: GroupBase[],
  deltaTicks: number,
  opts: KeyframeOpOptions
): KeyframeOpResult {
  const delta = Math.max(deltaTicks, -minSelectedTick(bases));
  return collectResult(bases, () => (tick) => mapTick(tick, delta, opts));
}

// Stagger: `bases` arrives ordered top lane → bottom lane (the caller
// knows its row layout); the topmost lane stays put and each lane below
// offsets by one more `step`, preserving intra-lane spacing. The step is
// frame-snapped so every offset is frame-aligned; each lane's offset is
// clamped so its earliest selected key stops at 0.
export function staggerKeyframes(
  orderedBases: GroupBase[],
  stepTicks: number,
  opts: KeyframeOpOptions
): KeyframeOpResult {
  const step = Math.round(snapTickToFrame(stepTicks, opts.ticksPerFrame));
  let laneIdx = -1;
  return collectResult(orderedBases, (base) => {
    laneIdx += 1;
    let min = Infinity;
    for (const t of base.selectedOriginalTicks) if (t < min) min = t;
    const offset = Math.max(step * laneIdx, isFinite(min) ? -min : 0);
    // Stagger offsets are already frame-aligned; skip per-key snapping so
    // off-frame keys keep their sub-frame placement.
    return (tick) => Math.max(0, Math.round(tick + offset));
  });
}

// Evenly space the selection: distinct selected ticks become "columns"
// (keys sharing a tick — usually across lanes — move together), sorted
// and re-laid-out so consecutive columns sit exactly `stepTicks` apart.
// The earliest column stays put, so results never go below 0. The step
// is frame-snapped and clamped to ≥ one frame — a zero step would
// collapse every column onto one tick, where the dedup destroys keys
// (same no-data-loss policy as scale's minimum span).
export function spaceKeyframes(
  bases: GroupBase[],
  stepTicks: number,
  opts: KeyframeOpOptions
): KeyframeOpResult {
  const step = Math.max(
    opts.ticksPerFrame,
    Math.round(snapTickToFrame(stepTicks, opts.ticksPerFrame))
  );
  const columns = new Set<number>();
  for (const b of bases) {
    for (const t of b.selectedOriginalTicks) columns.add(t);
  }
  const sorted = [...columns].sort((a, b) => a - b);
  const target = new Map<number, number>();
  sorted.forEach((t, i) => target.set(t, sorted[0] + i * step));
  return collectResult(bases, () => (tick) => target.get(tick) ?? tick);
}

// Scale the selection in time about `anchorTick` (a bounding-box edge
// drag; the anchor is the opposite edge). Returns null when the gesture
// can't produce a valid result yet — the caller keeps the last applied
// state, so dragging through the anchor pins at the minimum span
// instead of collapsing or mirroring the keys.
export function scaleKeyframes(
  bases: GroupBase[],
  anchorTick: number,
  startEdgeTick: number,
  currentEdgeTick: number,
  opts: KeyframeOpOptions
): KeyframeOpResult | null {
  const span = startEdgeTick - anchorTick;
  if (Math.abs(span) < 1) return null;
  let factor = (currentEdgeTick - anchorTick) / span;
  // Never mirror, and keep the selection's span at ≥ one frame.
  const minFactor = opts.ticksPerFrame / Math.abs(span);
  factor = Math.max(factor, minFactor);
  // Keep every result at tick ≥ 0: keys earlier than the anchor move
  // further left as the factor grows past the anchor's own reach.
  const minTick = minSelectedTick(bases);
  if (anchorTick > 0 && minTick < anchorTick) {
    factor = Math.min(factor, anchorTick / (anchorTick - minTick));
    if (factor < minFactor) return null;
  }
  return collectResult(bases, () => (tick) => {
    const raw = anchorTick + (tick - anchorTick) * factor;
    const t = opts.snap ? snapTickToFrame(raw, opts.ticksPerFrame) : raw;
    return Math.max(0, Math.round(t));
  });
}
