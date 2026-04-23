import type { SplineAnchor, SplineSubpath, SplineValue } from "./types";

// Affine transform applied in normalized [0,1]² space. Mirrors the param
// layout used by the Transform node and the built-in Text / SVG Source
// transforms so the same gizmo can drive any of them.
export interface SplineTransformParams {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotateDeg: number;
  pivotX: number;
  pivotY: number;
}

export const IDENTITY_TRANSFORM: SplineTransformParams = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotateDeg: 0,
  pivotX: 0.5,
  pivotY: 0.5,
};

export function isIdentityTransform(t: SplineTransformParams): boolean {
  return (
    t.translateX === 0 &&
    t.translateY === 0 &&
    t.scaleX === 1 &&
    t.scaleY === 1 &&
    t.rotateDeg === 0
  );
}

// Transform an anchor: translate the anchor's position through the affine,
// and rotate+scale its handle offsets (handles are DELTAS, so translation
// doesn't apply). Mirrors the GL transform shader's math in CPU space.
function transformAnchor(
  a: SplineAnchor,
  t: SplineTransformParams
): SplineAnchor {
  const rad = (t.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const transformPos = (p: [number, number]): [number, number] => {
    const dx = (p[0] - t.pivotX) * t.scaleX;
    const dy = (p[1] - t.pivotY) * t.scaleY;
    const rx = cos * dx - sin * dy;
    const ry = sin * dx + cos * dy;
    return [t.translateX + t.pivotX + rx, t.translateY + t.pivotY + ry];
  };
  const transformOffset = (d: [number, number]): [number, number] => {
    const dx = d[0] * t.scaleX;
    const dy = d[1] * t.scaleY;
    return [cos * dx - sin * dy, sin * dx + cos * dy];
  };

  const out: SplineAnchor = { pos: transformPos(a.pos) };
  if (a.inHandle) out.inHandle = transformOffset(a.inHandle);
  if (a.outHandle) out.outHandle = transformOffset(a.outHandle);
  return out;
}

export function transformSubpath(
  sub: SplineSubpath,
  t: SplineTransformParams
): SplineSubpath {
  if (isIdentityTransform(t)) return sub;
  return {
    closed: sub.closed,
    anchors: sub.anchors.map((a) => transformAnchor(a, t)),
  };
}

export function transformSpline(
  spline: SplineValue,
  t: SplineTransformParams
): SplineValue {
  if (isIdentityTransform(t)) return spline;
  return {
    kind: "spline",
    subpaths: spline.subpaths.map((s) => transformSubpath(s, t)),
  };
}
