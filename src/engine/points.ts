// Helpers for the typed-array PointsValue shape. See specdocs/typed-
// array-points-refactor.md for the migration plan.
//
// Authoritative storage is typed arrays (positions/scales/rotations/
// groupIndices). The `points: Point[]` field on PointsValue is a lazy
// compatibility view — call `ensurePointArray()` before iterating it
// in code that hasn't been migrated to read typed arrays directly.

import type { Point, PointsValue } from "./types";

// Sentinel cached on PointsValue to memoize ensurePointArray() output.
// We use a WeakMap keyed by the value so we can attach internal state
// without polluting the public type. The key is the PointsValue itself
// (which is unique per producer eval), the value is the count we last
// built `points` for.
const builtFor = new WeakMap<PointsValue, number>();

export const EMPTY_POINTS: PointsValue = Object.freeze({
  kind: "points",
  count: 0,
  positions: new Float32Array(0),
  points: [],
}) as PointsValue;

// Allocate a points value with reserved capacity. Caller fills the
// returned typed arrays in place. `points` starts empty (lazy).
export function makePoints(
  count: number,
  opts: {
    withScales?: boolean;
    withRotations?: boolean;
    withGroupIndices?: boolean;
  } = {}
): PointsValue {
  return {
    kind: "points",
    count,
    positions: new Float32Array(count * 2),
    scales: opts.withScales ? new Float32Array(count * 2) : undefined,
    rotations: opts.withRotations ? new Float32Array(count) : undefined,
    groupIndices: opts.withGroupIndices ? new Int32Array(count) : undefined,
    points: [],
  };
}

// Convert a legacy `Point[]` into the typed-array shape. Use this in
// any producer that hasn't been ported yet to write the typed shape
// directly — one-line drop-in.
export function pointsFromArray(pts: Point[]): PointsValue {
  const count = pts.length;
  if (count === 0) {
    return {
      kind: "points",
      count: 0,
      positions: new Float32Array(0),
      points: [],
    };
  }
  const positions = new Float32Array(count * 2);
  let hasScale = false;
  let hasRot = false;
  let hasGroup = false;
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    positions[i * 2] = p.pos[0];
    positions[i * 2 + 1] = p.pos[1];
    if (p.scale !== undefined) hasScale = true;
    if (p.rotation !== undefined) hasRot = true;
    if (p.groupIndex !== undefined) hasGroup = true;
  }
  let scales: Float32Array | undefined;
  let rotations: Float32Array | undefined;
  let groupIndices: Int32Array | undefined;
  if (hasScale) {
    scales = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const s = pts[i].scale;
      scales[i * 2] = s ? s[0] : 1;
      scales[i * 2 + 1] = s ? s[1] : 1;
    }
  }
  if (hasRot) {
    rotations = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      rotations[i] = pts[i].rotation ?? 0;
    }
  }
  if (hasGroup) {
    groupIndices = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      groupIndices[i] = pts[i].groupIndex ?? 0;
    }
  }
  return {
    kind: "points",
    count,
    positions,
    scales,
    rotations,
    groupIndices,
    // Reuse the input array as the lazy view — the source-of-truth has
    // already been copied into typed arrays so subsequent edits to
    // `points` would be incorrect; in practice producers hand off and
    // forget. If a caller wants to keep mutating its array, it should
    // pass a copy.
    points: pts,
  };
}

// Build (and memoize) the legacy `Point[]` view from the typed arrays.
// Idempotent and cheap on re-call. Call this in any UI/inspector path
// that iterates `value.points` directly.
export function ensurePointArray(p: PointsValue): Point[] {
  // Empty value: the view is already `[]`. Return it WITHOUT the
  // `p.points = out` rebuild below — that assignment would throw on the
  // frozen shared `EMPTY_POINTS` sentinel (emitted by e.g. an empty
  // simulation zone). Behaviour-identical to the rebuild for count 0.
  if (p.count === 0) return p.points;
  if (builtFor.get(p) === p.count && p.points.length === p.count) {
    return p.points;
  }
  const { count, positions, scales, rotations, groupIndices } = p;
  const out: Point[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const pt: Point = {
      pos: [positions[i * 2], positions[i * 2 + 1]],
    };
    if (scales) pt.scale = [scales[i * 2], scales[i * 2 + 1]];
    if (rotations) pt.rotation = rotations[i];
    if (groupIndices) pt.groupIndex = groupIndices[i];
    out[i] = pt;
  }
  // Mutating the field is fine — `points` is a view, not a separate
  // identity. Future calls hit the memo.
  p.points = out;
  builtFor.set(p, count);
  return out;
}

// Deep copy a points value (typed arrays are cloned). Use when you
// need a value you'll mutate without disturbing the upstream cache.
export function clonePoints(p: PointsValue): PointsValue {
  return {
    kind: "points",
    count: p.count,
    positions: new Float32Array(p.positions),
    scales: p.scales ? new Float32Array(p.scales) : undefined,
    rotations: p.rotations ? new Float32Array(p.rotations) : undefined,
    groupIndices: p.groupIndices ? new Int32Array(p.groupIndices) : undefined,
    points: [],
  };
}

// Read helpers for typed-array consumers. Kept tiny and inlinable.
export function getPos(
  p: PointsValue,
  i: number,
  out: [number, number]
): [number, number] {
  out[0] = p.positions[i * 2];
  out[1] = p.positions[i * 2 + 1];
  return out;
}

export function getScaleX(p: PointsValue, i: number): number {
  return p.scales ? p.scales[i * 2] : 1;
}
export function getScaleY(p: PointsValue, i: number): number {
  return p.scales ? p.scales[i * 2 + 1] : 1;
}
export function getRotation(p: PointsValue, i: number): number {
  return p.rotations ? p.rotations[i] : 0;
}
export function getGroupIndex(p: PointsValue, i: number): number {
  return p.groupIndices ? p.groupIndices[i] : 0;
}
