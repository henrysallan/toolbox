// Pure half of the Tracks editor's easing overlay
// (specdocs/091726_easing-editor.md): which selected keyframes form the
// pairs a drag writes to, which pair seeds the curve, how an existing
// easing reads into the unit square, and the view math the SVG uses. No
// DOM, no React — scripts/check-easing-editor.mts drives it directly.

import type {
  BezierEasing,
  EasingPreset,
  Keyframe,
} from "@/engine/keyframes";
import {
  EASING_PRESET_BEZIER,
  LINEAR_BEZIER,
  easeOf,
  isStepOnly,
  normalizedBezierOfSegment,
} from "@/engine/keyframes";
import type { ParamType } from "@/engine/types";
import { groupSelection, type SelectionKey } from "./keyframe-ops";

// ---------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------

// One segment the overlay edits: the keyframe at `aTick` owns the
// easing (its `easingOut`), `bTick` is the next key in the lane.
export interface EasingPair {
  nodeId: string;
  paramName: string;
  aTick: number;
  bTick: number;
  // Lane order top → bottom; the tie-break when two pairs start on the
  // same tick.
  rowIdx: number;
}

export interface EasingLane {
  // The lane's keyframes, sorted by tick (blocks keep them sorted).
  keyframes: Keyframe[];
  paramType: ParamType;
  rowIdx: number;
}

export interface EasingPairSet {
  pairs: EasingPair[];
  // True when a boolean / enum lane had a would-be pair. Easing is forced
  // to `hold` on those, so they are left out — the overlay says so when
  // they are all that's selected.
  skippedStepOnly: boolean;
}

// The adjacency rule: per lane, two selected keys that sit next to each
// other in the lane (no unselected key between) form a pair, owned by the
// earlier one. A skipped key breaks the chain; the last selected key of a
// lane keeps its own outgoing easing; one key per lane (or a single
// column across lanes) yields nothing.
export function easingPairsFor(
  sel: SelectionKey[],
  getLane: (nodeId: string, paramName: string) => EasingLane | undefined
): EasingPairSet {
  const pairs: EasingPair[] = [];
  let skippedStepOnly = false;
  for (const [, items] of groupSelection(sel)) {
    if (items.length < 2) continue;
    const { nodeId, paramName } = items[0];
    const lane = getLane(nodeId, paramName);
    if (!lane) continue;
    const selected = new Set(items.map((s) => s.tick));
    const ks = lane.keyframes;
    const stepOnly = isStepOnly(lane.paramType);
    for (let i = 0; i < ks.length - 1; i++) {
      if (!selected.has(ks[i].tick) || !selected.has(ks[i + 1].tick)) continue;
      if (stepOnly) {
        skippedStepOnly = true;
        continue;
      }
      pairs.push({
        nodeId,
        paramName,
        aTick: ks[i].tick,
        bTick: ks[i + 1].tick,
        rowIdx: lane.rowIdx,
      });
    }
  }
  return { pairs, skippedStepOnly };
}

// "First" = earliest in time, ties to the topmost lane.
export function firstEasingPair(pairs: EasingPair[]): EasingPair | null {
  let best: EasingPair | null = null;
  for (const p of pairs) {
    if (
      !best ||
      p.aTick < best.aTick ||
      (p.aTick === best.aTick && p.rowIdx < best.rowIdx)
    ) {
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------
// Seeding the curve from an existing easing
// ---------------------------------------------------------------------

export type EasingSeedSource =
  // A cubicBezier key — reads back exactly.
  | "bezier"
  // A scalar customBezier — its tick / value-unit handles normalized.
  | "custom"
  // A named preset with a cubic equivalent (EASING_PRESET_BEZIER).
  | "preset"
  // hold / expo / back / bounce / elastic: no single cubic. The handles
  // park on the diagonal and the real curve draws as a dashed ghost;
  // nothing is written until the first drag.
  | "ghost";

export interface EasingSeed {
  bezier: BezierEasing;
  source: EasingSeedSource;
  // The pair's named preset, for "preset" and "ghost" seeds (the shelf
  // highlights its tile).
  preset?: EasingPreset;
  ghost?: EasingPreset;
}

export function seedForPair(a: Keyframe, b: Keyframe): EasingSeed {
  if (a.easingOut === "cubicBezier") {
    return { bezier: a.bezier ?? LINEAR_BEZIER, source: "bezier" };
  }
  if (a.easingOut === "customBezier") {
    return {
      bezier: normalizedBezierOfSegment(a, b) ?? LINEAR_BEZIER,
      source: "custom",
    };
  }
  const preset = EASING_PRESET_BEZIER[a.easingOut];
  if (preset) return { bezier: preset, source: "preset", preset: a.easingOut };
  return {
    bezier: LINEAR_BEZIER,
    source: "ghost",
    preset: a.easingOut,
    ghost: a.easingOut,
  };
}

// One string per segment easing so pairs can be compared: normalized
// shapes compare by value (a cubicBezier equal to a preset's cubic IS that
// preset), everything else by name.
export function easingKeyOf(a: Keyframe, b: Keyframe): string {
  const shape = normalizedBezierOfSegment(a, b);
  if (shape) {
    return `bz:${[shape.x1, shape.y1, shape.x2, shape.y2]
      .map((n) => n.toFixed(6))
      .join(",")}`;
  }
  return `p:${a.easingOut}`;
}

// Do all the pairs currently carry one and the same easing? Drives the
// `mixed` status; the first drag makes them uniform.
export function pairsUniform(
  pairs: EasingPair[],
  getPairKeys: (p: EasingPair) => [Keyframe, Keyframe] | undefined
): boolean {
  let key: string | null = null;
  for (const p of pairs) {
    const kf = getPairKeys(p);
    if (!kf) continue;
    const k = easingKeyOf(kf[0], kf[1]);
    if (key === null) key = k;
    else if (k !== key) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------

// Rewrite a lane with the shape on every pair-owning key. Only those
// keys change; `bezierHandles` are left alone (a key's left handle may
// belong to the previous segment, which could still be customBezier).
export function applyBezierToLane(
  keyframes: Keyframe[],
  aTicks: ReadonlySet<number>,
  bezier: BezierEasing
): Keyframe[] {
  return keyframes.map((k) =>
    aTicks.has(k.tick)
      ? { ...k, easingOut: "cubicBezier" as const, bezier: { ...bezier } }
      : k
  );
}

// The shelf's built-in tiles write the NAMED preset (exactly what the
// easing menus do), so expo / back / bounce / elastic / hold — which no
// cubic expresses — are reachable too. A stale `bezier` is left in place;
// it is inert unless the key is cubicBezier.
export function applyPresetToLane(
  keyframes: Keyframe[],
  aTicks: ReadonlySet<number>,
  preset: EasingPreset
): Keyframe[] {
  return keyframes.map((k) =>
    aTicks.has(k.tick) ? { ...k, easingOut: preset } : k
  );
}

// ---------------------------------------------------------------------
// Overlay layout (px)
// ---------------------------------------------------------------------
//
// The overlay is header + square + readout + the preset shelf. The shelf
// wraps its tiles, so its height depends on the square's width; the fit
// below picks the largest square ≤ the preferred size whose whole overlay
// fits the Tracks editor's height, so a short dock shrinks the graph
// rather than clipping the shelf.

export const OVERLAY_HEADER_H = 22;
export const OVERLAY_READOUT_H = 20;
export const TRAY_TILE = 30;
export const TRAY_GAP = 3;
// Left pad clears the resize grip in the bottom-left corner.
export const TRAY_PAD_LEFT = 18;
export const TRAY_PAD_RIGHT = 6;
export const TRAY_PAD_Y = 6;
export const TRAY_DIVIDER = 7;

export interface TrayCounts {
  builtins: number;
  saved: number;
}

export function trayRows(count: number, width: number): number {
  if (count <= 0) return 0;
  const usable = Math.max(TRAY_TILE, width - TRAY_PAD_LEFT - TRAY_PAD_RIGHT);
  const perRow = Math.max(
    1,
    Math.floor((usable + TRAY_GAP) / (TRAY_TILE + TRAY_GAP))
  );
  return Math.ceil(count / perRow);
}

export function trayHeightFor(width: number, tray: TrayCounts | null): number {
  if (!tray) return 0;
  const block = (rows: number) =>
    rows > 0 ? rows * (TRAY_TILE + TRAY_GAP) - TRAY_GAP : 0;
  const rowsA = trayRows(tray.builtins, width);
  // Saved presets share their block with the "+" tile.
  const rowsB = trayRows(tray.saved + 1, width);
  return (
    TRAY_PAD_Y * 2 +
    block(rowsA) +
    (rowsA > 0 ? TRAY_DIVIDER : 0) +
    block(rowsB)
  );
}

export function overlayHeightFor(size: number, tray: TrayCounts | null): number {
  return (
    OVERLAY_HEADER_H + size + OVERLAY_READOUT_H + trayHeightFor(size, tray)
  );
}

// The shelf's compact form: one horizontally scrolling row.
export const SHELF_ROW_H = TRAY_PAD_Y * 2 + TRAY_TILE;
// A wrapping grid isn't worth its rows below this square size — narrowing
// the square makes the grid TALLER (fewer tiles per row), so past this
// point the shelf collapses to the single row instead.
export const GRID_MIN_SIZE = 200;

export type ShelfMode = "grid" | "row";
export interface OverlayFit {
  size: number;
  shelf: ShelfMode;
}

// Pick the square size and shelf form for the room available. Grid first:
// the largest square ≤ `preferred` (stepping down 4px) at or above
// GRID_MIN_SIZE whose whole overlay fits. Otherwise the single-row shelf,
// which costs a fixed SHELF_ROW_H, and the square takes what's left (never
// below `minSize` — then the overlay overflows and its shelf scrolls).
// No maxHeight ⇒ the preferred size with a grid.
export function fitOverlay(
  preferred: number,
  maxHeight: number | undefined,
  tray: TrayCounts | null,
  minSize: number
): OverlayFit {
  if (maxHeight == null || !Number.isFinite(maxHeight)) {
    return { size: preferred, shelf: "grid" };
  }
  if (!tray) {
    const s = Math.floor(maxHeight - OVERLAY_HEADER_H - OVERLAY_READOUT_H);
    return { size: Math.max(minSize, Math.min(preferred, s)), shelf: "grid" };
  }
  const gridFloor = Math.max(minSize, GRID_MIN_SIZE);
  let s = preferred;
  while (s > gridFloor && overlayHeightFor(s, tray) > maxHeight) s -= 4;
  s = Math.max(gridFloor, s);
  if (s <= preferred && overlayHeightFor(s, tray) <= maxHeight) {
    return { size: s, shelf: "grid" };
  }
  const rowSize = Math.floor(
    maxHeight - OVERLAY_HEADER_H - OVERLAY_READOUT_H - SHELF_ROW_H
  );
  return {
    size: Math.max(minSize, Math.min(preferred, rowSize)),
    shelf: "row",
  };
}

// ---------------------------------------------------------------------
// View math (unit square ↔ SVG px, y up)
// ---------------------------------------------------------------------

export interface EasingView {
  // px per unit
  scale: number;
  // px position of unit (0,0)
  ox: number;
  oy: number;
}

export function fitEasingView(size: number, pad: number): EasingView {
  const scale = Math.max(1, size - pad * 2);
  return { scale, ox: pad, oy: size - pad };
}

export function unitToPx(
  v: EasingView,
  x: number,
  y: number
): { x: number; y: number } {
  return { x: v.ox + x * v.scale, y: v.oy - y * v.scale };
}

export function pxToUnit(
  v: EasingView,
  px: number,
  py: number
): { x: number; y: number } {
  return { x: (px - v.ox) / v.scale, y: (v.oy - py) / v.scale };
}

export function panEasingView(v: EasingView, dx: number, dy: number): EasingView {
  return { scale: v.scale, ox: v.ox + dx, oy: v.oy + dy };
}

// Zoom about a px point: the unit coordinate under the cursor stays put.
export function zoomEasingView(
  v: EasingView,
  factor: number,
  px: number,
  py: number,
  minScale: number,
  maxScale: number
): EasingView {
  const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
  const u = pxToUnit(v, px, py);
  return { scale, ox: px - u.x * scale, oy: py + u.y * scale };
}

// Keep at least `margin` px of the unit square inside a `size` px canvas,
// so panning around an overshooting handle can never lose the curve.
export function clampEasingView(
  v: EasingView,
  size: number,
  margin = 24
): EasingView {
  const m = Math.min(margin, size / 2);
  const ox = Math.min(size - m, Math.max(m - v.scale, v.ox));
  const oy = Math.min(size - m + v.scale, Math.max(m, v.oy));
  return ox === v.ox && oy === v.oy ? v : { scale: v.scale, ox, oy };
}

// Two shapes close enough to count as the same preset (tile highlight,
// "already saved").
export function sameBezier(a: BezierEasing, b: BezierEasing, eps = 1e-3): boolean {
  return (
    Math.abs(a.x1 - b.x1) <= eps &&
    Math.abs(a.y1 - b.y1) <= eps &&
    Math.abs(a.x2 - b.x2) <= eps &&
    Math.abs(a.y2 - b.y2) <= eps
  );
}

// The tray's "+" saves under the first free "Easing N" — the store
// replaces same-name entries, so a taken name must never be reused.
export function autoEasingName(existing: { name: string }[]): string {
  const taken = new Set(existing.map((e) => e.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `Easing ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

// Handle x stays inside the segment (time must be monotonic — the clamp
// interpolate() applies at playback); y is free so a handle can overshoot.
export function clampHandle(x: number, y: number): { x: number; y: number } {
  return { x: x < 0 ? 0 : x > 1 ? 1 : x, y };
}

const f = (n: number) => n.toFixed(2);

export function bezierPathD(b: BezierEasing, v: EasingView): string {
  const p0 = unitToPx(v, 0, 0);
  const p1 = unitToPx(v, b.x1, b.y1);
  const p2 = unitToPx(v, b.x2, b.y2);
  const p3 = unitToPx(v, 1, 1);
  return `M ${f(p0.x)} ${f(p0.y)} C ${f(p1.x)} ${f(p1.y)} ${f(p2.x)} ${f(p2.y)} ${f(p3.x)} ${f(p3.y)}`;
}

// The real curve of a preset no single cubic expresses, sampled through
// easeOf() — the dashed ghost behind the linear handles.
export function ghostPathD(
  preset: EasingPreset,
  v: EasingView,
  samples = 48
): string {
  if (preset === "hold") {
    const a = unitToPx(v, 0, 0);
    const m = unitToPx(v, 1, 0);
    const b = unitToPx(v, 1, 1);
    return `M ${f(a.x)} ${f(a.y)} L ${f(m.x)} ${f(m.y)} L ${f(b.x)} ${f(b.y)}`;
  }
  let d = "";
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const p = unitToPx(v, u, easeOf(preset, u));
    d += `${i === 0 ? "M" : " L"} ${f(p.x)} ${f(p.y)}`;
  }
  return d;
}
