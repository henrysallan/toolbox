// Sub-path Select (direct selection) tool — every subpath's anchors are
// selectable (marquee / shift-click span them). The last-clicked subpath
// becomes active for pen-extend / handles / width. Group-drag a selection,
// or work a curve segment.
//
// Segment grammar (revised 2026-08-02): a PLAIN press on a segment selects
// its two adjacent anchors and drags them together (the segment translates
// rigidly, handles riding along); a DOUBLE-click selects the whole subpath
// (the component wires that to ops.selectAllAnchors); ALT+press bends the
// curve — the minimum-norm handle solve that used to sit on the plain drag,
// which made every attempt to grab a path reshape it.
// Split out of the monolith in M0 of
// specdocs/archive/071926_spline-draw-authoring-upgrade.md.

import { DRAG_THRESHOLD } from "../constants";
import { nearestTOnCubic, parseSelKey, selKey, subpathsOf } from "../geometry";
import type { DragState, PointerLike, SplineEditorEnv } from "../types";
import type { SplineOps } from "../ops";
import type { SelKey } from "../geometry";

// Background drag in sub-path mode → marquee. Plain click without movement
// clears the selection (resolved in resolveMarquee on pointerup).
export function beginMarquee(env: SplineEditorEnv, e: PointerLike) {
  env.setDrag({
    kind: "marquee",
    startClient: { x: e.clientX, y: e.clientY },
    currentClient: { x: e.clientX, y: e.clientY },
    additive: e.shiftKey,
    baseSelection: new Set(env.selectedRef.current),
  });
}

// Pointerup for a marquee drag: resolve which anchors lie inside the rect and
// either replace the selection or extend it (shift-marquee). A plain click
// (below the drag threshold) with no shift clears the selection instead.
export function resolveMarquee(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: Extract<DragState, { kind: "marquee" }>
) {
  const x0 = Math.min(drag.startClient.x, drag.currentClient.x);
  const x1 = Math.max(drag.startClient.x, drag.currentClient.x);
  const y0 = Math.min(drag.startClient.y, drag.currentClient.y);
  const y1 = Math.max(drag.startClient.y, drag.currentClient.y);
  const moved = Math.hypot(x1 - x0, y1 - y0) >= DRAG_THRESHOLD;
  if (moved) {
    const subs = subpathsOf(env.valueRef.current);
    const next = drag.additive
      ? new Set(drag.baseSelection)
      : new Set<SelKey>();
    for (let s = 0; s < subs.length; s++) {
      const anchors = subs[s]?.anchors ?? [];
      for (let i = 0; i < anchors.length; i++) {
        const p = env.normToPx(anchors[i].pos);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
          next.add(selKey(s, i));
        }
      }
    }
    env.setSelected(next);
  } else if (!drag.additive) {
    // Plain click on empty space with no drag clears selection.
    env.setSelected(new Set());
  }
}

// Sub-path-mode anchor pointerdown: resolve the selection up-front so a drag
// of a freshly-clicked anchor moves the right group (shift toggles membership;
// plain click on an unselected anchor makes it the sole selection). Returns
// the gesture-start position snapshot for every selected anchor.
export function subpathAnchorSelection(
  ops: SplineOps,
  env: SplineEditorEnv,
  sub: number,
  index: number,
  e: PointerLike
): Map<SelKey, [number, number]> {
  const k = selKey(sub, index);
  const cur = new Set(env.selectedRef.current);
  if (e.shiftKey) {
    if (cur.has(k)) cur.delete(k);
    else cur.add(k);
  } else if (!cur.has(k)) {
    cur.clear();
    cur.add(k);
  }
  env.setSelected(cur);
  const subs = subpathsOf(env.valueRef.current);
  const groupStarts = new Map<SelKey, [number, number]>();
  for (const key of cur) {
    const p = parseSelKey(key);
    const ai = subs[p.sub]?.anchors[p.index];
    if (ai) groupStarts.set(key, [ai.pos[0], ai.pos[1]]);
  }
  return groupStarts;
}

// Parameter t of the point on segment (i → j) nearest a client position,
// projected in pixel space (so "nearest" matches what the user sees). Used
// by the bend drag and the segment context menu (insert / cut here).
export function segmentParamAtClient(
  ops: SplineOps,
  env: SplineEditorEnv,
  seg: { sub?: number; i: number; j: number },
  cx: number,
  cy: number
): number | null {
  const anchors = ops.anchorsOf(
    seg.sub ?? env.activeSubpathRef.current
  );
  const A = anchors[seg.i];
  const B = anchors[seg.j];
  if (!A || !B) return null;
  const p0 = env.normToPx(A.pos);
  const p1 = A.outHandle
    ? env.normToPx([A.pos[0] + A.outHandle[0], A.pos[1] + A.outHandle[1]])
    : p0;
  const p3 = env.normToPx(B.pos);
  const p2 = B.inHandle
    ? env.normToPx([B.pos[0] + B.inHandle[0], B.pos[1] + B.inHandle[1]])
    : p3;
  return nearestTOnCubic(
    [p0.x, p0.y],
    [p1.x, p1.y],
    [p2.x, p2.y],
    [p3.x, p3.y],
    [cx, cy]
  );
}

// Plain segment pointerdown (sub-path mode): select the segment's two
// adjacent anchors and arm the ordinary group-move drag, so the same gesture
// that selects also translates the segment. Shift UNIONS the pair into the
// existing selection (a pair has no sensible per-anchor toggle); a plain
// press replaces it. Dropping without moving is just the selection.
export function beginSegmentSelect(
  ops: SplineOps,
  env: SplineEditorEnv,
  seg: { seg: number; sub: number; i: number; j: number },
  e: PointerLike
) {
  const anchors = ops.anchorsOf(seg.sub);
  const A = anchors[seg.i];
  if (!A) return;
  const ki = selKey(seg.sub, seg.i);
  const kj = selKey(seg.sub, seg.j);
  const next = e.shiftKey
    ? new Set(env.selectedRef.current)
    : new Set<SelKey>();
  next.add(ki);
  next.add(kj);
  env.setSelected(next);
  env.activeSubpathRef.current = seg.sub;
  env.setActiveSubpath(seg.sub);
  env.lastAnchorRef.current = seg.i;
  const subs = subpathsOf(env.valueRef.current);
  const groupStarts = new Map<SelKey, [number, number]>();
  for (const key of next) {
    const p = parseSelKey(key);
    const ai = subs[p.sub]?.anchors[p.index];
    if (ai) groupStarts.set(key, [ai.pos[0], ai.pos[1]]);
  }
  const [nx, ny] = env.clientToNorm(e.clientX, e.clientY);
  env.setDrag({
    kind: "anchor",
    index: seg.i,
    sub: seg.sub,
    grabOffset: { x: A.pos[0] - nx, y: A.pos[1] - ny },
    startClient: { x: e.clientX, y: e.clientY },
    moved: false,
    groupStarts,
  });
}

// Alt+segment pointerdown (sub-path mode): cache the grabbed parameter t so
// the curve tracks the cursor without sliding during the bend drag.
export function beginSegmentDrag(
  ops: SplineOps,
  env: SplineEditorEnv,
  seg: { seg: number; sub: number; i: number; j: number },
  e: PointerLike
) {
  const t = segmentParamAtClient(ops, env, seg, e.clientX, e.clientY);
  if (t === null) return;
  env.setHoverSeg({ sub: seg.sub, seg: seg.seg });
  env.activeSubpathRef.current = seg.sub;
  env.setActiveSubpath(seg.sub);
  env.setDrag({
    kind: "segment",
    sub: seg.sub,
    seg: seg.seg,
    i: seg.i,
    j: seg.j,
    t,
    startClient: { x: e.clientX, y: e.clientY },
  });
}
