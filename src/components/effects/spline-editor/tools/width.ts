// Width tool (spec 072726_spline-animation-program.md M3) — per-anchor
// stroke-width multipliers (SplineAnchor.width, absent = 1). Each anchor of
// the active subpath shows a widget PAIR offset perpendicular to the path;
// dragging either side sets the multiplier symmetrically (both widgets
// move). The scale is symbolic — WIDTH_BASE_PX per ×1 — so widgets stay
// predictable regardless of the consuming stroke's real thickness; the node
// raster previews the true envelope live. Values snap to exactly 1 near it
// and store `undefined` at 1, keeping unprofiled anchors field-free.

import type { SplineAnchor } from "@/engine/types";
import { WIDTH_BASE_PX, WIDTH_MAX } from "../constants";
import { subpathsOf } from "../geometry";
import type { DragState, PointerLike, SplineEditorEnv } from "../types";
import type { CornerView } from "./corner";
import type { SplineOps } from "../ops";

export interface WidthWidget {
  index: number;
  // Anchor + unit normal in client px.
  ax: number;
  ay: number;
  nx: number;
  ny: number;
  // The two widget dots (anchor ± normal × base×multiplier).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Unit path normal at anchor i, in client px — perpendicular to the
// neighbor-to-neighbor direction (the same tangent heuristic the auto-smooth
// handles use). Null when degenerate.
export function widthNormalPx(
  view: CornerView,
  anchors: SplineAnchor[],
  closed: boolean,
  i: number
): { ax: number; ay: number; nx: number; ny: number } | null {
  const n = anchors.length;
  if (n < 2) return null;
  const a = view.normToPx(anchors[i].pos);
  const prev = closed || i > 0 ? view.normToPx(anchors[(i - 1 + n) % n].pos) : null;
  const next =
    closed || i < n - 1 ? view.normToPx(anchors[(i + 1) % n].pos) : null;
  let tx = 0;
  let ty = 0;
  if (prev && next) {
    tx = next.x - prev.x;
    ty = next.y - prev.y;
  } else if (prev) {
    tx = a.x - prev.x;
    ty = a.y - prev.y;
  } else if (next) {
    tx = next.x - a.x;
    ty = next.y - a.y;
  }
  const m = Math.hypot(tx, ty);
  if (m < 1e-3) return null;
  return { ax: a.x, ay: a.y, nx: -ty / m, ny: tx / m };
}

export function widthWidgets(
  view: CornerView,
  anchors: SplineAnchor[],
  closed: boolean
): WidthWidget[] {
  if (!view.rect) return [];
  const out: WidthWidget[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const b = widthNormalPx(view, anchors, closed, i);
    if (!b) continue;
    const d = Math.max(4, WIDTH_BASE_PX * Math.max(0, anchors[i].width ?? 1));
    out.push({
      index: i,
      ax: b.ax,
      ay: b.ay,
      nx: b.nx,
      ny: b.ny,
      x1: b.ax + b.nx * d,
      y1: b.ay + b.ny * d,
      x2: b.ax - b.nx * d,
      y2: b.ay - b.ny * d,
    });
  }
  return out;
}

export function beginWidthDrag(
  env: SplineEditorEnv,
  index: number,
  e: PointerLike
) {
  env.lastAnchorRef.current = index;
  env.setDrag({
    kind: "width",
    index,
    startClient: { x: e.clientX, y: e.clientY },
  });
}

// Drag move: |perpendicular distance| from the anchor maps back through the
// symbolic scale to the multiplier (either side works — the profile is
// symmetric). Snaps to exactly 1 within a small band; 1 stores as undefined
// so untouched files stay clean. Returns the applied multiplier for the HUD.
export function widthDragMove(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: Extract<DragState, { kind: "width" }>,
  e: PointerEvent
): number | null {
  const rect = env.rect;
  if (!rect) return null;
  const anchors = ops.readAnchors(env.valueRef.current);
  const sub = anchors[drag.index];
  if (!sub) return null;
  const subpath =
    subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
  const b = widthNormalPx(
    { rect, normToPx: env.normToPx },
    anchors,
    subpath?.closed ?? false,
    drag.index
  );
  if (!b) return null;
  const dist = Math.abs(
    (e.clientX - b.ax) * b.nx + (e.clientY - b.ay) * b.ny
  );
  let w = Math.min(WIDTH_MAX, Math.max(0, dist / WIDTH_BASE_PX));
  if (Math.abs(w - 1) < 0.06) w = 1;
  w = Math.round(w * 1000) / 1000;
  ops.updateAnchor(drag.index, { width: w === 1 ? undefined : w });
  return w;
}
