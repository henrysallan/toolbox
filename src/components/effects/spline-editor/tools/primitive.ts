// Primitive shape tools — Rectangle (R) and Ellipse (E). Press-drag-release
// on the canvas rubber-bands a box; the release commits ONE closed subpath
// (4 corner anchors for a rect, 4 kappa-handled anchors for an ellipse), so
// it's one undo entry and the result is ordinary editable geometry — the pen
// / sub-path tools take over from there. Backlog #55; spec
// 071926_spline-draw-authoring-upgrade.md M6.
//
// Modifiers (resolved fresh on every move, so they can be pressed or released
// mid-drag):
//   - Shift            → 1:1 box (square / circle), sized by the dominant axis.
//   - Alt/Option       → the press point is the CENTRE, not a corner.
//   - Alt+Shift        → both: a square/circle centred on the press point.
//   - Cmd/Ctrl         → suppress snapping (same escape hatch as everywhere).
// The constraint math runs in client px, so "1:1" means square ON SCREEN —
// correct on a non-square canvas, where normalized space is anisotropic.

import type { SplineAnchor } from "@/engine/types";
import { mintAnchorId } from "../geometry";
import { guideSnapLines, snapPoint } from "../snapping";
import type {
  DragState,
  PointerLike,
  PrimitiveKind,
  SplineEditorEnv,
} from "../types";
import type { SplineOps } from "../ops";

type PrimitiveDrag = Extract<DragState, { kind: "primitive" }>;

// Cubic-bezier circle approximation constant: handle length = KAPPA × radius
// puts the curve within ~0.02% of a true circle.
const KAPPA = 0.5522847498307936;

// Below this (client px, both axes) a gesture reads as a click, not a draw —
// commit nothing rather than stamping a degenerate shape.
const MIN_DRAW_PX = 3;

// Press: snap the origin like a pen click, then arm the rubber band.
export function beginPrimitiveDraw(
  ops: SplineOps,
  env: SplineEditorEnv,
  prim: PrimitiveKind,
  e: PointerLike
) {
  let sx = e.clientX;
  let sy = e.clientY;
  if (env.rect && !e.metaKey && !e.ctrlKey) {
    const res = snapPoint(
      env.rect,
      ops.anchorSnapTargets(null),
      sx,
      sy,
      guideSnapLines(env.guides, env.normToPx)
    );
    if (res.guides.length > 0) {
      sx = res.x;
      sy = res.y;
      env.setSnapGuides(res.guides);
    }
  }
  env.setSelected(new Set());
  env.setDrag({
    kind: "primitive",
    prim,
    startClient: { x: sx, y: sy },
    box: null,
  });
}

// Resolve the live pointer into the box the preview draws and the commit
// consumes. Also owns the free corner's snapping (and its guides).
export function primitiveBoxAt(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: PrimitiveDrag,
  e: PointerLike
): { x: number; y: number; w: number; h: number } {
  let px = e.clientX;
  let py = e.clientY;
  // Shift owns the corner (it forces the ratio), so corner snapping stands
  // down while it's held rather than fighting it.
  if (env.rect && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    const res = snapPoint(
      env.rect,
      ops.anchorSnapTargets(null),
      px,
      py,
      guideSnapLines(env.guides, env.normToPx)
    );
    env.setSnapGuides(res.guides);
    if (res.guides.length > 0) {
      px = res.x;
      py = res.y;
    }
  } else {
    env.setSnapGuides([]);
  }
  let dx = px - drag.startClient.x;
  let dy = py - drag.startClient.y;
  if (e.shiftKey) {
    // 1:1 — the dominant axis sets the size, each axis keeps its direction
    // (Math.sign would collapse the box the moment an axis reads exactly 0).
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -m : m;
    dy = dy < 0 ? -m : m;
  }
  if (e.altKey) {
    // Press point = centre: the drag delta becomes the half-extent.
    const hw = Math.abs(dx);
    const hh = Math.abs(dy);
    return {
      x: drag.startClient.x - hw,
      y: drag.startClient.y - hh,
      w: hw * 2,
      h: hh * 2,
    };
  }
  return {
    x: Math.min(drag.startClient.x, drag.startClient.x + dx),
    y: Math.min(drag.startClient.y, drag.startClient.y + dy),
    w: Math.abs(dx),
    h: Math.abs(dy),
  };
}

// Release: convert the resolved px box to normalized anchors and append it.
export function commitPrimitive(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: PrimitiveDrag
) {
  const box = drag.box;
  if (!env.rect || !box) return;
  if (box.w < MIN_DRAW_PX && box.h < MIN_DRAW_PX) return;
  // px → normalized is affine and axis-aligned (aspect.ts corrects y about
  // 0.5), so the two opposite corners fully determine the normalized box and
  // an on-screen ellipse stays an axis-aligned ellipse in stored space.
  const [ax, ay] = env.clientToNorm(box.x, box.y);
  const [bx, by] = env.clientToNorm(box.x + box.w, box.y + box.h);
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  const anchors =
    drag.prim === "rect"
      ? rectAnchors(x0, y0, x1, y1)
      : ellipseAnchors(x0, y0, x1, y1);
  ops.appendSubpath(anchors, true);
}

// Four corner anchors, clockwise from the top-left (y-down space). No
// handles — plain corners, so Live Corners can round them afterwards.
function rectAnchors(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): SplineAnchor[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map((p) => ({
    id: mintAnchorId(),
    pos: [p[0], p[1]] as [number, number],
  }));
}

// Four smooth anchors at the quadrant points, clockwise from the top, with
// axis-aligned KAPPA handles — the standard 4-segment bezier circle.
function ellipseAnchors(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): SplineAnchor[] {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const kx = ((x1 - x0) / 2) * KAPPA;
  const ky = ((y1 - y0) / 2) * KAPPA;
  const mk = (
    pos: [number, number],
    inHandle: [number, number],
    outHandle: [number, number]
  ): SplineAnchor => ({ id: mintAnchorId(), pos, inHandle, outHandle });
  return [
    mk([cx, y0], [-kx, 0], [kx, 0]), // top
    mk([x1, cy], [0, -ky], [0, ky]), // right
    mk([cx, y1], [kx, 0], [-kx, 0]), // bottom
    mk([x0, cy], [0, ky], [0, -ky]), // left
  ];
}
