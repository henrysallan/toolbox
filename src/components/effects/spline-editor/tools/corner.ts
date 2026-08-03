// Live Corners — the per-anchor corner-radius widget (Illustrator "live
// corners"). Eligible anchors (handle-less corners with two incident
// segments) show a small circular widget along the interior angle bisector
// in Sub-path Select mode; dragging it toward the shape interior writes
// `anchor.cornerRadius` (normalized units — the fillet itself is applied at
// emit by roundCornersPerAnchor, engine/spline-math.ts). Dragging with a
// multi-selection applies the radius to every selected eligible anchor in
// one patch. Spec: 071926_spline-draw-authoring-upgrade.md M1.

import type { SplineAnchor } from "@/engine/types";
import { CORNER_WIDGET_OFFSET } from "../constants";
import { subpathsOf } from "../geometry";
import type { DragState, PointerLike, SplineEditorEnv } from "../types";
import type { SplineOps } from "../ops";

export interface CornerWidget {
  index: number;
  // Widget center in client px (base offset + current radius along the
  // interior bisector).
  x: number;
  y: number;
}

// The render-safe slice of the editor context the widget geometry needs —
// plain values only (no refs), so the component may call these during render
// without tripping the react-hooks/refs rule.
export interface CornerView {
  rect: DOMRect | null;
  normToPx: (p: [number, number]) => { x: number; y: number };
}

// Is this anchor a live-corner candidate? Handle-less (a corner — matches the
// overlay's square-mark test), with a neighbor on both sides (interior of an
// open subpath; every anchor of a closed one with ≥3 anchors).
export function cornerEligible(
  anchors: SplineAnchor[],
  closed: boolean,
  i: number
): boolean {
  if (anchors.length < 3) return false;
  const a = anchors[i];
  if (!a || a.inHandle || a.outHandle) return false;
  if (!closed && (i === 0 || i === anchors.length - 1)) return false;
  return true;
}

// Unit interior-bisector of the corner at anchor i, in CLIENT PX space (so
// the widget sits visually centered in the on-screen angle on non-square
// canvases). Null when degenerate (zero-length edge or a straight/spike
// angle where the bisector is undefined).
export function cornerBisectorPx(
  view: CornerView,
  anchors: SplineAnchor[],
  i: number
): { anchor: { x: number; y: number }; bis: [number, number] } | null {
  const n = anchors.length;
  const P = view.normToPx(anchors[i].pos);
  const prev = view.normToPx(anchors[(i - 1 + n) % n].pos);
  const next = view.normToPx(anchors[(i + 1) % n].pos);
  const dp: [number, number] = [prev.x - P.x, prev.y - P.y];
  const dn: [number, number] = [next.x - P.x, next.y - P.y];
  const lp = Math.hypot(dp[0], dp[1]);
  const ln = Math.hypot(dn[0], dn[1]);
  if (lp < 1e-3 || ln < 1e-3) return null;
  const bx = dp[0] / lp + dn[0] / ln;
  const by = dp[1] / lp + dn[1] / ln;
  const bl = Math.hypot(bx, by);
  if (bl < 1e-3) return null; // straight line — no interior to point into
  return { anchor: P, bis: [bx / bl, by / bl] };
}

// The widgets to render for the active subpath: every eligible anchor, or
// only the selected eligible ones when a selection exists (so a crowded path
// quiets down once you're working a specific corner set).
export function cornerWidgets(
  view: CornerView,
  anchors: SplineAnchor[],
  closed: boolean,
  selected: Set<number>
): CornerWidget[] {
  if (!view.rect) return [];
  const out: CornerWidget[] = [];
  for (let i = 0; i < anchors.length; i++) {
    if (!cornerEligible(anchors, closed, i)) continue;
    if (selected.size > 0 && !selected.has(i)) continue;
    const b = cornerBisectorPx(view, anchors, i);
    if (!b) continue;
    const rPx = (anchors[i].cornerRadius ?? 0) * view.rect.width;
    const d = CORNER_WIDGET_OFFSET + rPx;
    out.push({ index: i, x: b.anchor.x + b.bis[0] * d, y: b.anchor.y + b.bis[1] * d });
  }
  return out;
}

// The radius drag's target set: the selected eligible corners when the
// grabbed one is part of a multi-selection, else just the grabbed corner.
function cornerTargets(
  ops: SplineOps,
  env: SplineEditorEnv,
  index: number
): number[] {
  const anchors = ops.readAnchors(env.valueRef.current);
  const sub = subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
  const closed = sub?.closed ?? false;
  const sel = env.selectedRef.current;
  return sel.has(index) && sel.size > 1
    ? [...sel].filter((i) => cornerEligible(anchors, closed, i))
    : [index];
}

// Alt-click on a Live Corners widget cycles the corner STYLE (spec 080226
// M1): round → chamfer → scoop → round, applied to the same target set the
// radius drag uses. `undefined` = round, so untouched saves stay field-free.
export function cycleCornerStyle(
  ops: SplineOps,
  env: SplineEditorEnv,
  index: number
) {
  const anchors = ops.readAnchors(env.valueRef.current);
  const cur = anchors[index]?.cornerStyle;
  const next: SplineAnchor["cornerStyle"] =
    cur === undefined ? "chamfer" : cur === "chamfer" ? "scoop" : undefined;
  const patch = new Map<number, Partial<SplineAnchor>>();
  for (const i of cornerTargets(ops, env, index)) {
    patch.set(i, { cornerStyle: next });
  }
  ops.patchAnchors(patch);
}

// Pointerdown on a widget: the drag targets the grabbed corner plus every
// other selected eligible corner (multi-select apply — one patch per move).
export function beginCornerRadiusDrag(
  ops: SplineOps,
  env: SplineEditorEnv,
  index: number,
  e: PointerLike
) {
  env.lastAnchorRef.current = index;
  env.setDrag({
    kind: "corner-radius",
    index,
    targets: cornerTargets(ops, env, index),
    startClient: { x: e.clientX, y: e.clientY },
  });
}

// Drag move: project the cursor onto the grabbed corner's interior bisector;
// distance past the widget's base offset maps to the radius (normalized by
// canvas width, matching cornerWidgets' placement so the widget tracks the
// pointer). Clamped to the fillet's own cap — half the shorter adjacent
// edge, in the normalized space the emit-time clamp uses — so the widget
// stops where the geometry does.
export function cornerRadiusDragMove(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: Extract<DragState, { kind: "corner-radius" }>,
  e: PointerEvent
): number | null {
  const rect = env.rect;
  if (!rect) return null;
  const anchors = ops.readAnchors(env.valueRef.current);
  const b = cornerBisectorPx(
    { rect, normToPx: env.normToPx },
    anchors,
    drag.index
  );
  if (!b) return null;
  const distPx =
    (e.clientX - b.anchor.x) * b.bis[0] + (e.clientY - b.anchor.y) * b.bis[1];
  let radius = Math.max(0, (distPx - CORNER_WIDGET_OFFSET) / rect.width);
  // Cap in normalized space, mirroring roundSubpath's d = min(radius,
  // |prevEdge|/2, |nextEdge|/2) for the grabbed corner.
  const n = anchors.length;
  const P = anchors[drag.index].pos;
  const prev = anchors[(drag.index - 1 + n) % n].pos;
  const next = anchors[(drag.index + 1) % n].pos;
  const lenPrev = Math.hypot(prev[0] - P[0], prev[1] - P[1]);
  const lenNext = Math.hypot(next[0] - P[0], next[1] - P[1]);
  radius = Math.min(radius, lenPrev / 2, lenNext / 2, 0.5);
  const patch = new Map<number, Partial<SplineAnchor>>();
  // Snap tiny radii back to "no field" so a drag returned to zero leaves the
  // anchor exactly as it was (undefined round-trips out of the save).
  const value = radius > 1e-4 ? radius : undefined;
  for (const i of drag.targets) patch.set(i, { cornerRadius: value });
  ops.patchAnchors(patch);
  return value ?? 0; // applied radius, for the drag HUD readout
}
