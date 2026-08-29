// Snapping service for the Spline Draw editor (spec
// 071926_spline-draw-authoring-upgrade.md M2). Pure px-space geometry — no
// React, no refs — so drag handlers and (future) gizmos can share it.
//
// Three snap families, in priority order per gesture point:
//   - COINCIDENT point targets (other anchors): within SNAP_R of BOTH axes,
//     the nearest one takes the point outright (ring guide).
//   - ALIGNMENT with point targets: each axis independently locks onto an
//     anchor that shares that coordinate within SNAP_R — the Figma/Illustrator
//     smart guide. The matched guide spans from the dragged point to the
//     farthest aligned anchor and marks each participant.
//   - LINE guides (canvas edges / center / thirds) snap each axis
//     independently within SNAP_R. Alignment wins ties, since aligning to
//     the user's own geometry is the stronger intent.
// Plus a 45°-increment ANGLE LOCK for handle drags (Shift), which is a
// separate helper because it constrains direction, not position.
//
// Modifier vocabulary (documented in the overlay header): snapping is ON by
// default for pen-click placement, anchor drags, and primitive (rect /
// ellipse) draws; the viewport-bar lock turns it off, and Cmd/Ctrl
// suppresses it mid-drag while it's on. Shift during a handle (or new-
// anchor) drag locks the handle angle to 45° increments — Shift is free
// there (its pen-mode insert-on-path meaning applies only to background
// clicks).

import { SNAP_R } from "./constants";

export type SnapGuide =
  | { kind: "point"; x: number; y: number } // snapped onto a point target
  | { kind: "vline"; x: number } // snapped onto a vertical canvas guide
  | { kind: "hline"; y: number } // snapped onto a horizontal canvas guide
  | {
      // Aligned with one or more anchors on one axis. `axis: "x"` = a VERTICAL
      // guide at x = `at`, spanning `from`..`to` in y (the dragged point plus
      // every aligned anchor); `marks` are the aligned anchors' other-axis
      // coordinates, drawn as small ticks. Mirrored for `axis: "y"`.
      kind: "align";
      axis: "x" | "y";
      at: number;
      from: number;
      to: number;
      marks: number[];
    };

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

// Nearest candidate coordinate within SNAP_R of `v`, or null.
function nearestWithin(
  v: number,
  candidates: number[]
): { at: number; d: number } | null {
  let best: { at: number; d: number } | null = null;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d <= SNAP_R && (!best || d < best.d)) best = { at: c, d };
  }
  return best;
}

// px slop for "shares this coordinate" when collecting the anchors an
// alignment guide should span + tick. The snapped coordinate came straight
// off one target, so co-aligned ones land within a hair of it.
const ALIGN_EPS = 0.5;

// Build the alignment guide for one axis: `at` is the locked coordinate,
// `other` the point's coordinate on the free axis. The guide spans every
// participant so it reads as "these are lined up".
function alignGuide(
  axis: "x" | "y",
  at: number,
  other: number,
  pointTargets: Array<{ x: number; y: number }>
): SnapGuide {
  const marks: number[] = [];
  let from = other;
  let to = other;
  for (const t of pointTargets) {
    if (Math.abs((axis === "x" ? t.x : t.y) - at) > ALIGN_EPS) continue;
    const m = axis === "x" ? t.y : t.x;
    marks.push(m);
    if (m < from) from = m;
    if (m > to) to = m;
  }
  return { kind: "align", axis, at, from, to, marks };
}

// User guidelines (spec 080226 M5) as snap-line candidates, in client px.
// Inline-typed so snapping.ts stays dependency-free.
export function guideSnapLines(
  guides: Array<{ axis: "x" | "y"; pos: number }>,
  normToPx: (p: [number, number]) => { x: number; y: number }
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of guides) {
    if (g.axis === "x") xs.push(normToPx([g.pos, 0]).x);
    else ys.push(normToPx([0, g.pos]).y);
  }
  return { xs, ys };
}

// Snap a client-px point against point targets (coincidence + per-axis
// alignment) and the canvas guide lines (+ optional extra lines — user
// guidelines join here).
export function snapPoint(
  rect: DOMRect,
  pointTargets: Array<{ x: number; y: number }>,
  x: number,
  y: number,
  extraLines?: { xs: number[]; ys: number[] }
): SnapResult {
  // Coincident point targets first — nearest within SNAP_R wins both axes.
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
  // Per axis: anchor alignment vs canvas guide line, nearest wins (alignment
  // takes ties).
  const { xs, ys } = canvasLines(rect);
  if (extraLines) {
    xs.push(...extraLines.xs);
    ys.push(...extraLines.ys);
  }
  const alignX = nearestWithin(
    x,
    pointTargets.map((t) => t.x)
  );
  const alignY = nearestWithin(
    y,
    pointTargets.map((t) => t.y)
  );
  const lineX = nearestWithin(x, xs);
  const lineY = nearestWithin(y, ys);
  const pickX = alignX && (!lineX || alignX.d <= lineX.d) ? alignX : lineX;
  const pickY = alignY && (!lineY || alignY.d <= lineY.d) ? alignY : lineY;
  const sx = pickX ? pickX.at : x;
  const sy = pickY ? pickY.at : y;
  // Guides are built after BOTH axes resolve so an alignment span reaches the
  // point's final (snapped) position on the free axis.
  const guides: SnapGuide[] = [];
  if (pickX) {
    guides.push(
      pickX === alignX
        ? alignGuide("x", sx, sy, pointTargets)
        : { kind: "vline", x: sx }
    );
  }
  if (pickY) {
    guides.push(
      pickY === alignY
        ? alignGuide("y", sy, sx, pointTargets)
        : { kind: "hline", y: sy }
    );
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
