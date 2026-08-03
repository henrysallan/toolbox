// Tunni tension widget (spec 080226_font-precision-toolkit.md M3 —
// FontLab's Tunni point). For a segment whose BOTH handles exist and whose
// handle rays properly intersect, the intersection T is a one-grab tension
// control: dragging T re-aims both handles at the new point while each
// preserves its FRACTION of the way to T (its tension), and double-click
// balances the two fractions to their average (a curve-side "even
// handles"). Shown for segments whose two adjacent anchors are both
// selected — the pair-select segment grammar makes that one click.
//
// The ray intersection is affine-invariant, so solving in client px (for
// display) and in normalized space (for writes) names the same point.

import type { SplineAnchor } from "@/engine/types";
import type { DragState, PointerLike, SplineEditorEnv } from "../types";
import type { CornerView } from "./corner";
import type { SplineOps } from "../ops";

// Solve P0 + s·d1 = P3 + t·d2 (Cramer). Null when near-parallel.
function raySolve(
  P0: [number, number],
  d1: [number, number],
  P3: [number, number],
  d2: [number, number]
): { s: number; t: number } | null {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  const scale = Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]);
  if (scale < 1e-12 || Math.abs(den) < 1e-4 * scale) return null;
  const bx = P3[0] - P0[0];
  const by = P3[1] - P0[1];
  const s = (bx * d2[1] - by * d2[0]) / den;
  const t = (bx * d1[1] - by * d1[0]) / den;
  return { s, t };
}

export interface TunniPoint {
  seg: number;
  i: number;
  j: number;
  // Widget position + the two handle TIPS, client px (for the Tunni line).
  x: number;
  y: number;
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
  // Tension fractions (handle length / distance to T along each ray).
  f1: number;
  f2: number;
}

// The Tunni point for one segment, or null when ineligible (missing
// handles, near-parallel rays, or an intersection behind either anchor).
export function tunniForSegment(
  view: CornerView,
  anchors: SplineAnchor[],
  seg: { seg: number; i: number; j: number }
): TunniPoint | null {
  if (!view.rect) return null;
  const A = anchors[seg.i];
  const B = anchors[seg.j];
  if (!A?.outHandle || !B?.inHandle) return null;
  const P0 = view.normToPx(A.pos);
  const p1 = view.normToPx([
    A.pos[0] + A.outHandle[0],
    A.pos[1] + A.outHandle[1],
  ]);
  const P3 = view.normToPx(B.pos);
  const p2 = view.normToPx([
    B.pos[0] + B.inHandle[0],
    B.pos[1] + B.inHandle[1],
  ]);
  const d1: [number, number] = [p1.x - P0.x, p1.y - P0.y];
  const d2: [number, number] = [p2.x - P3.x, p2.y - P3.y];
  const sol = raySolve([P0.x, P0.y], d1, [P3.x, P3.y], d2);
  if (!sol) return null;
  // T must sit in FRONT of both anchors (s, t in units of the handle
  // length: 1 = at the handle tip). Below ~5% the geometry is degenerate.
  if (sol.s < 0.05 || sol.t < 0.05) return null;
  return {
    seg: seg.seg,
    i: seg.i,
    j: seg.j,
    x: P0.x + sol.s * d1[0],
    y: P0.y + sol.s * d1[1],
    p1x: p1.x,
    p1y: p1.y,
    p2x: p2.x,
    p2y: p2.y,
    f1: 1 / sol.s,
    f2: 1 / sol.t,
  };
}

export function beginTunniDrag(
  env: SplineEditorEnv,
  tp: TunniPoint,
  e: PointerLike
) {
  env.lastAnchorRef.current = tp.i;
  env.setDrag({
    kind: "tunni",
    seg: tp.seg,
    i: tp.i,
    j: tp.j,
    f1: tp.f1,
    f2: tp.f2,
    startClient: { x: e.clientX, y: e.clientY },
  });
}

// Drag move: the cursor IS the new Tunni point (normalized space — the
// fractions are unit-free). Both handles re-aim at it, keeping their
// captured tensions; both anchors mark broken, matching the segment-bend
// convention (the drag reshapes this segment only). Returns the fractions
// for the HUD.
export function tunniDragMove(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: Extract<DragState, { kind: "tunni" }>,
  e: PointerEvent
): { f1: number; f2: number } | null {
  const anchors = ops.readAnchors(env.valueRef.current);
  const A = anchors[drag.i];
  const B = anchors[drag.j];
  if (!A || !B) return null;
  const [tx, ty] = env.clientToNorm(e.clientX, e.clientY);
  const patch = new Map<number, Partial<SplineAnchor>>();
  patch.set(drag.i, {
    outHandle: [
      (tx - A.pos[0]) * drag.f1,
      (ty - A.pos[1]) * drag.f1,
    ],
    broken: true,
  });
  patch.set(drag.j, {
    inHandle: [(tx - B.pos[0]) * drag.f2, (ty - B.pos[1]) * drag.f2],
    broken: true,
  });
  ops.patchAnchors(patch);
  return { f1: drag.f1, f2: drag.f2 };
}

// Double-click: balance — set both tensions to their average, T unchanged
// (directions untouched, so anchor smoothness is preserved).
export function tunniBalance(
  ops: SplineOps,
  env: SplineEditorEnv,
  seg: { seg: number; i: number; j: number }
) {
  const anchors = ops.readAnchors(env.valueRef.current);
  const A = anchors[seg.i];
  const B = anchors[seg.j];
  if (!A?.outHandle || !B?.inHandle) return;
  // Solve in NORMALIZED space (same point as px — affine invariance).
  const sol = raySolve(
    A.pos,
    A.outHandle,
    B.pos,
    B.inHandle
  );
  if (!sol || sol.s < 0.05 || sol.t < 0.05) return;
  const T: [number, number] = [
    A.pos[0] + sol.s * A.outHandle[0],
    A.pos[1] + sol.s * A.outHandle[1],
  ];
  const f = (1 / sol.s + 1 / sol.t) / 2;
  const patch = new Map<number, Partial<SplineAnchor>>();
  patch.set(seg.i, {
    outHandle: [(T[0] - A.pos[0]) * f, (T[1] - A.pos[1]) * f],
  });
  patch.set(seg.j, {
    inHandle: [(T[0] - B.pos[0]) * f, (T[1] - B.pos[1]) * f],
  });
  ops.patchAnchors(patch);
}
