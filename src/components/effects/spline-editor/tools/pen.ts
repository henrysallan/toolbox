// Pen tool — background click appends an anchor to the active subpath (or
// starts a new subpath when the active one is closed/sealed); Shift-click
// inserts on the nearest segment; a quick click on an existing anchor toggles
// corner ↔ smooth or closes the loop. Split out of the monolith in M0 of
// specdocs/archive/071926_spline-draw-authoring-upgrade.md.

import { subpathsOf } from "../geometry";
import { guideSnapLines, snapPoint } from "../snapping";
import type { PointerLike, SplineEditorEnv } from "../types";
import type { SplineOps } from "../ops";

// Pen-mode background pointerdown (after the component's guard/menu-close
// boilerplate): shift-insert on the nearest segment, or extend the active
// subpath / start a fresh one, then begin the "new" drag that pulls out
// symmetric handles if the pointer moves.
export function penBackgroundDown(
  ops: SplineOps,
  env: SplineEditorEnv,
  e: PointerLike
) {
  // Shift in pen mode = insert a point on the nearest existing segment
  // (split the curve) instead of appending a new endpoint.
  if (e.shiftKey) {
    const ins = ops.findInsertOnSpline(e.clientX, e.clientY);
    if (ins) {
      ops.insertAnchorOnSegment(ins.i, ins.j, ins.t);
      return;
    }
  }
  // Snap the placement against OTHER subpaths' anchors + canvas guides
  // (never the active subpath's own anchors — a coincident neighbor is a
  // degenerate segment, and clicking ON an anchor is the hit ring's toggle
  // anyway). Cmd/Ctrl suppresses. The guides set here stay visible until
  // the "new" drag moves or the pointer lifts (drag.ts clears them).
  let cx = e.clientX;
  let cy = e.clientY;
  if (env.rect && !e.metaKey && !e.ctrlKey) {
    const activeAnchors =
      subpathsOf(env.valueRef.current)[env.activeSubpathRef.current]
        ?.anchors ?? [];
    const excludeAll = new Set(activeAnchors.map((_, i) => i));
    const res = snapPoint(
      env.rect,
      ops.anchorSnapTargets(excludeAll),
      cx,
      cy,
      guideSnapLines(env.guides, env.normToPx)
    );
    if (res.guides.length > 0) {
      cx = res.x;
      cy = res.y;
      env.setSnapGuides(res.guides);
    }
  }
  const [nx, ny] = env.clientToNorm(cx, cy);
  // Extend the active subpath, unless it's closed, sealed (Enter), or there
  // are none — then start a fresh subpath. Either way the new anchor's index
  // within its subpath is what the "new" drag tracks (0 for a fresh subpath).
  const active = subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
  let newIdx: number;
  if (active && !active.closed && !env.penSealedRef.current) {
    newIdx = ops.addAnchorAt(nx, ny);
  } else {
    ops.startNewSubpath(nx, ny);
    newIdx = 0;
  }
  env.lastAnchorRef.current = newIdx;
  env.setDrag({
    kind: "new",
    index: newIdx,
    startClient: { x: e.clientX, y: e.clientY },
    moved: false,
  });
}

// Pen-mode quick click on an existing anchor (resolved on pointerup with no
// movement): close the spline if it's the first anchor of an open path with
// ≥3 anchors, otherwise toggle corner ↔ smooth.
export function penAnchorClick(
  ops: SplineOps,
  env: SplineEditorEnv,
  index: number
) {
  const sub = subpathsOf(env.valueRef.current)[env.activeSubpathRef.current];
  const anchors = sub?.anchors ?? [];
  const isStart = index === 0;
  const closed = sub?.closed ?? false;
  if (isStart && !closed && anchors.length >= 3) {
    ops.toggleClosed();
  } else {
    ops.toggleCornerSmooth(index);
  }
}
