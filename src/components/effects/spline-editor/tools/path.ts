// Path Select tool — click any subpath to select the whole path; drag (body
// or bounding-box handles) moves / scales all subpaths, baked into the
// geometry. Split out of the monolith in M0 of
// specdocs/071926_spline-draw-authoring-upgrade.md. (The bbox-drag resolve
// math lives in ops.applyBBoxDrag so drag.ts can reach it without a tool
// import cycle.)

import type { BBoxHandle, PointerLike, SplineEditorEnv } from "../types";
import type { SplineOps } from "../ops";

// Path mode: click any subpath to select the whole path (make that subpath
// active) and begin a whole-path move.
export function beginPathMove(
  ops: SplineOps,
  env: SplineEditorEnv,
  index: number,
  e: PointerLike
) {
  if (index !== env.activeSubpathRef.current) ops.selectSubpath(index);
  const [nx, ny] = env.clientToNorm(e.clientX, e.clientY);
  env.setDrag({
    kind: "path-move",
    startClient: { x: e.clientX, y: e.clientY },
    startNorm: [nx, ny],
    startValue: env.valueRef.current,
  });
}

// Path mode: grab a bounding-box handle to scale the whole path.
export function beginBBoxDrag(
  env: SplineEditorEnv,
  handle: BBoxHandle,
  startBox: { minX: number; minY: number; maxX: number; maxY: number },
  e: PointerLike
) {
  env.setDrag({
    kind: "bbox",
    handle,
    startClient: { x: e.clientX, y: e.clientY },
    startBox: { ...startBox },
    startValue: env.valueRef.current,
  });
}
