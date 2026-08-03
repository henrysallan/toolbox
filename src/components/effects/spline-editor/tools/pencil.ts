// Pencil (freehand) tool — drag to sketch a stroke; on release the sampled
// polyline is fit to cubic béziers (Schneider, engine/spline-math.ts) and
// committed as a NEW subpath (auto-closed if ended near the start). One
// onChange / one undo per stroke. Spec: 062526_spline-pencil-tool.md; split
// out of the monolith in M0 of 071926_spline-draw-authoring-upgrade.md.

import { fitSplineToPolyline } from "@/engine/spline-math";
import type { SplineAnchor } from "@/engine/types";
import { PENCIL_CLOSE, PENCIL_FIT_ERROR } from "../constants";
import { mintAnchorId } from "../geometry";
import type { PointerLike, SplineEditorEnv } from "../types";
import type { SplineOps } from "../ops";

// Begin a freehand stroke — seed the sample buffer and let the window
// pointer handlers (drag effect) accumulate the rest until release.
export function beginPencilStroke(env: SplineEditorEnv, e: PointerLike) {
  env.pencilPtsRef.current = [[e.clientX, e.clientY]];
  env.setPencilVersion((v) => v + 1);
  env.setSelected(new Set());
  env.setDrag({ kind: "pencil" });
}

// Pencil commit: fit the captured client-px samples to a smooth bézier chain
// and hand it to ops.appendSubpath (which reuses an empty active subpath, so
// a fresh node's seed doesn't strand). The fit runs in px so the tolerance is
// isotropic; pos/handles convert to normalized after. Auto-closes when the
// stroke ends near where it started.
export function commitPencilStroke(ops: SplineOps, env: SplineEditorEnv) {
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
    const out: SplineAnchor = {
      id: mintAnchorId(),
      pos: env.clientToNorm(a.pos[0], a.pos[1]),
    };
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
  ops.appendSubpath(anchors, closed);
}
