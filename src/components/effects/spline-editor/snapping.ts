// Snapping service for the Spline Draw editor (spec
// 071926_spline-draw-authoring-upgrade.md M2). Pure px-space geometry — no
// React, no refs — so drag handlers and (future) gizmos can share it.
//
// Two snap families:
//   - POINT targets (other anchors) snap both axes at once within SNAP_R and
//     win over line snaps.
//   - LINE guides (canvas edges / center / thirds) snap each axis
//     independently within SNAP_R.
// Plus a 45°-increment ANGLE LOCK for handle drags (Shift), which is a
// separate helper because it constrains direction, not position.
//
// Modifier vocabulary (documented in the overlay header): snapping is ON by
// default for pen-click placement and anchor drags; hold Cmd/Ctrl mid-drag
// to suppress it. Shift during a handle (or new-anchor) drag locks the
// handle angle to 45° increments — Shift is free there (its pen-mode
// insert-on-path meaning applies only to background clicks).

import { SNAP_R } from "./constants";

export type SnapGuide =
  | { kind: "point"; x: number; y: number } // snapped onto a point target
  | { kind: "vline"; x: number } // snapped onto a vertical canvas guide
  | { kind: "hline"; y: number }; // snapped onto a horizontal canvas guide

export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[]; // empty = nothing matched (x/y pass through)
}

// Candidate x-positions / y-positions of the canvas guide lines: edges,
// center, thirds. All in client px.
function canvasLines(rect: DOMRect): { xs: number[]; ys: number[] } {
  const xs = [
    rect.left,
    rect.left + rect.width / 3,
    rect.left + rect.width / 2,
    rect.left + (2 * rect.width) / 3,
    rect.right,
  ];
  const ys = [
    rect.top,
    rect.top + rect.height / 3,
    rect.top + rect.height / 2,
    rect.top + (2 * rect.height) / 3,
    rect.bottom,
  ];
  return { xs, ys };
}

// Snap a client-px point against point targets + canvas guide lines.
export function snapPoint(
  rect: DOMRect,
  pointTargets: Array<{ x: number; y: number }>,
  x: number,
  y: number
): SnapResult {
  // Point targets first — nearest within SNAP_R wins both axes.
  let best: { x: number; y: number; d: number } | null = null;
  for (const t of pointTargets) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d <= SNAP_R && (!best || d < best.d)) best = { x: t.x, y: t.y, d };
  }
  if (best) {
    return {
      x: best.x,
      y: best.y,
      guides: [{ kind: "point", x: best.x, y: best.y }],
    };
  }
  // Per-axis canvas guide lines.
  const { xs, ys } = canvasLines(rect);
  const guides: SnapGuide[] = [];
  let sx = x;
  let sy = y;
  let bestDx = SNAP_R + 1;
  let pickX: number | null = null;
  for (const gx of xs) {
    const d = Math.abs(gx - x);
    if (d <= SNAP_R && d < bestDx) {
      bestDx = d;
      pickX = gx;
    }
  }
  let bestDy = SNAP_R + 1;
  let pickY: number | null = null;
  for (const gy of ys) {
    const d = Math.abs(gy - y);
    if (d <= SNAP_R && d < bestDy) {
      bestDy = d;
      pickY = gy;
    }
  }
  if (pickX != null) {
    sx = pickX;
    guides.push({ kind: "vline", x: pickX });
  }
  if (pickY != null) {
    sy = pickY;
    guides.push({ kind: "hline", y: pickY });
  }
  return { x: sx, y: sy, guides };
}

// Lock the direction origin→(x, y) to the nearest 45° increment, preserving
// the distance. Degenerate (zero-length) input passes through.
export function angleLockPx(
  ox: number,
  oy: number,
  x: number,
  y: number
): { x: number; y: number } {
  const dx = x - ox;
  const dy = y - oy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return { x, y };
  const STEP = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / STEP) * STEP;
  return { x: ox + Math.cos(ang) * len, y: oy + Math.sin(ang) * len };
}
