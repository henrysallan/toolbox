// Pencil (freehand) tool — drag to sketch a stroke; on release the sampled
// polyline is fit to cubic béziers (Schneider, engine/spline-math.ts) and
// committed as a NEW subpath (auto-closed if ended near the start). One
// onChange / one undo per stroke. Spec: 062526_spline-pencil-tool.md; split
// out of the monolith in M0 of 071926_spline-draw-authoring-upgrade.md.

import { fitSplineToPolyline } from "@/engine/spline-math";
import type { SplineAnchor, SplineSubpath } from "@/engine/types";
import { PENCIL_CLOSE, PENCIL_FIT_ERROR } from "../constants";
import { subpathsOf } from "../geometry";
import type { PointerLike, SplineEditorEnv } from "../types";

// Begin a freehand stroke — seed the sample buffer and let the window
// pointer handlers (drag effect) accumulate the rest until release.
export function beginPencilStroke(env: SplineEditorEnv, e: PointerLike) {
  env.pencilPtsRef.current = [[e.clientX, e.clientY]];
  env.setPencilVersion((v) => v + 1);
  env.setSelected(new Set());
  env.setDrag({ kind: "pencil" });
}

// Pencil commit: fit the captured client-px samples to a smooth bézier chain
// and drop it in as a new subpath (reusing the active one if it's still
// empty — e.g. a fresh node's seed subpath — so we don't leave an orphan).
// The fit runs in px so the tolerance is isotropic; pos/handles convert to
// normalized after. Auto-closes when the stroke ends near where it started.
export function commitPencilStroke(env: SplineEditorEnv) {
  const rect = env.rect;
  const pts = env.pencilPtsRef.current;
  // A real drag, not a tap — Pen already covers single clicks.
  if (!rect || pts.length < 2) return;
  const fitted = fitSplineToPolyline(pts, PENCIL_FIT_ERROR);
  if (fitted.length < 2) return;
  // px → normalized. pos via clientToNorm; a handle is an offset, so it
  // converts with the per-axis linear scale only (the affine origin cancels);
  // aspectUncorrectY divides y by aspect, mirrored here by the /aspect on y.
  const aspect = rect.width / rect.height;
  const offToNorm = (h?: [number, number]): [number, number] | undefined =>
    h ? [h[0] / rect.width, h[1] / rect.height / aspect] : undefined;
  const anchors: SplineAnchor[] = fitted.map((a) => {
    const out: SplineAnchor = { pos: env.clientToNorm(a.pos[0], a.pos[1]) };
    const inH = offToNorm(a.inHandle);
    const outH = offToNorm(a.outHandle);
    if (inH) out.inHandle = inH;
    if (outH) out.outHandle = outH;
    return out;
  });
  const start = pts[0];
  const end = pts[pts.length - 1];
  const closed =
    Math.hypot(end[0] - start[0], end[1] - start[1]) <= PENCIL_CLOSE;

  const cur = env.valueRef.current;
  const subs = subpathsOf(cur);
  const activeIdx = env.activeSubpathRef.current;
  // Reuse the active subpath only when it actually EXISTS and is empty (a
  // fresh node's seed subpath). An out-of-range index — e.g. a stale active
  // index after undo, before the clamp effect runs — would otherwise read as
  // "empty" and the .map below would match nothing, dropping the stroke.
  const reuseEmpty =
    activeIdx >= 0 &&
    activeIdx < subs.length &&
    (subs[activeIdx]?.anchors.length ?? 0) === 0;
  let newSubs: SplineSubpath[];
  let newActive: number;
  if (reuseEmpty) {
    newSubs = subs.map((s, i) => (i === activeIdx ? { anchors, closed } : s));
    newActive = activeIdx;
  } else {
    newSubs = [...subs, { anchors, closed }];
    newActive = newSubs.length - 1;
  }
  env.onChangeRef.current({ ...cur, subpaths: newSubs });
  env.setActiveSubpath(newActive);
  env.setSelected(new Set());
  env.setPenSealed(false);
  env.lastAnchorRef.current = anchors.length - 1;
}
