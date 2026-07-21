// Shape Builder tool (Illustrator's Shape Builder) — spec
// 071926_spline-draw-authoring-upgrade.md M3 (rev 3: component-precise
// picks). The paths' overlaps partition the plane into atomic faces
// (engine/spline-planar.ts — per-loop coverage signatures, narrowed to the
// connected component under the probe); hovering highlights the face under
// the cursor, click extracts it as its own subpath, dragging across faces
// merges them into one, and Alt-click/-drag deletes the area. One
// applyShapeBuilderOp (one onChange / one undo) per gesture, resolved on
// pointerup. Destructive by design — Spline Draw is the authoring node.

import {
  faceContains,
  facePickAt,
  faceRingsNormalized,
  signatureAt,
  type FaceSignature,
} from "@/engine/spline-planar";
import type { FacePick, PointerLike, SplineEditorEnv } from "../types";
import type { DragState } from "../types";
import type { SplineOps } from "../ops";

// Coverage signature under a client point — cheap (N ray casts), used by the
// hover loop to consult its pick cache before paying for a composition.
// Null outside the canvas or over background.
export function shapeSignatureAtClient(
  env: SplineEditorEnv,
  cx: number,
  cy: number
): FaceSignature | null {
  const shape = env.planarShapeRef.current;
  const rect = env.rect;
  if (!shape || !rect) return null;
  if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) {
    return null;
  }
  return signatureAt(shape, env.clientToNorm(cx, cy));
}

// Full face pick under a client point: signature + the connected component
// containing the probe + the px highlight path. The expensive half (boolean
// composition) — callers cache / dedupe by containment.
export function shapeFacePickAtClient(
  env: SplineEditorEnv,
  cx: number,
  cy: number
): FacePick | null {
  const shape = env.planarShapeRef.current;
  const rect = env.rect;
  if (!shape || !rect) return null;
  if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) {
    return null;
  }
  const pick = facePickAt(shape, env.clientToNorm(cx, cy));
  if (!pick) return null;
  let d = "";
  for (const ring of faceRingsNormalized(pick.geom)) {
    if (ring.length < 3) continue;
    const p0 = env.normToPx(ring[0]);
    d += `M ${p0.x} ${p0.y}`;
    for (let i = 1; i < ring.length; i++) {
      const pi = env.normToPx(ring[i]);
      d += ` L ${pi.x} ${pi.y}`;
    }
    d += " Z";
  }
  if (!d) return null;
  return { ref: pick.ref, geom: pick.geom, component: pick.component, d };
}

// Is this client point inside an already-picked face's component?
export function pickContainsClient(
  env: SplineEditorEnv,
  pick: FacePick,
  cx: number,
  cy: number
): boolean {
  const rect = env.rect;
  if (!rect) return false;
  if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) {
    return false;
  }
  return faceContains(pick.geom, env.clientToNorm(cx, cy));
}

// Pointerdown: seed the gesture with the face under the press (if any). Alt
// at press selects delete mode for the whole gesture.
export function beginShapeDrag(env: SplineEditorEnv, e: PointerLike) {
  const face = shapeFacePickAtClient(env, e.clientX, e.clientY);
  env.setDrag({
    kind: "shape",
    faces: face ? [face] : [],
    alt: e.altKey,
    startClient: { x: e.clientX, y: e.clientY },
  });
}

// Pointermove: accumulate each newly-entered face. Dedupe by CONTAINMENT
// against the collected components (not by signature — two disconnected
// regions can share one), so the expensive pick runs once per face entered.
export function shapeDragMove(
  env: SplineEditorEnv,
  drag: Extract<DragState, { kind: "shape" }>,
  e: PointerEvent
) {
  if (
    drag.faces.some((f) => pickContainsClient(env, f, e.clientX, e.clientY))
  ) {
    return;
  }
  const face = shapeFacePickAtClient(env, e.clientX, e.clientY);
  if (!face) return;
  env.setDrag({ ...drag, faces: [...drag.faces, face] });
}

// Pointerup: resolve the whole gesture to one op (merge, or delete when Alt
// was held at press). Restructures the subpath list, so selection and the
// active-subpath index reset (ops.applyShapeBuilder handles that).
export function shapeDragUp(
  ops: SplineOps,
  env: SplineEditorEnv,
  drag: Extract<DragState, { kind: "shape" }>
) {
  if (drag.faces.length === 0) return;
  ops.applyShapeBuilder(
    drag.faces.map((f) => f.ref),
    drag.alt ? "delete" : "merge"
  );
}
