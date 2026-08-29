import type {
  ParamDef,
  PointsValue,
  SocketValue,
  SplineValue,
  TransformOp,
  TransformValue,
} from "./types";
import { copyPointsWith, getRotation, getScaleX, getScaleY } from "./points";
import {
  isIdentityTransform,
  transformSpline,
  type SplineTransformParams,
} from "./spline-transform";

// Shared placement math for the Gizmo node and its consumers.
// Spec: specdocs/082826_gizmo-node.md.

export const IDENTITY_TRANSFORM_VALUE: TransformValue = {
  kind: "transform",
  ops: [],
};

// On-canvas rest box for a Gizmo with no geometry — a 0.3×0.3 square
// about the canvas center, like an AE null. Not the unit canvas (handles
// would sit on the frame corners) and not any consumer's bounds.
export const GIZMO_REST_AABB = {
  minX: 0.35,
  minY: 0.35,
  maxX: 0.65,
  maxY: 0.65,
} as const;

export const TRANSFORM_TRS_PARAMS: ParamDef[] = [
  {
    name: "translateX",
    label: "Translate X",
    type: "scalar",
    min: -1,
    max: 1,
    step: 0.001,
    default: 0,
  },
  {
    name: "translateY",
    label: "Translate Y",
    type: "scalar",
    min: -1,
    max: 1,
    step: 0.001,
    default: 0,
  },
  {
    name: "scaleX",
    label: "Scale X",
    type: "scalar",
    min: 0.01,
    max: 10,
    softMax: 4,
    step: 0.01,
    default: 1,
  },
  {
    name: "scaleY",
    label: "Scale Y",
    type: "scalar",
    min: 0.01,
    max: 10,
    softMax: 4,
    step: 0.01,
    default: 1,
  },
  {
    name: "rotate",
    label: "Rotate (°)",
    type: "scalar",
    min: -360,
    max: 360,
    step: 0.5,
    default: 0,
  },
  {
    name: "pivotX",
    label: "Pivot X",
    type: "scalar",
    min: 0,
    max: 1,
    step: 0.001,
    default: 0.5,
  },
  {
    name: "pivotY",
    label: "Pivot Y",
    type: "scalar",
    min: 0,
    max: 1,
    step: 0.001,
    default: 0.5,
  },
];

// Hide TRS rows when a `transform` input is wired. Degrades to visible
// when `meta` is missing (docs / export).
export function transformTrsVisible(
  _p: Record<string, unknown>,
  meta?: { wired?: Record<string, boolean> }
): boolean {
  return !meta?.wired?.transform;
}

export function asTransform(
  v: SocketValue | undefined
): TransformValue | undefined {
  return v?.kind === "transform" ? v : undefined;
}

export function opFromParams(params: Record<string, unknown>): TransformOp {
  return {
    translateX: (params.translateX as number) ?? 0,
    translateY: (params.translateY as number) ?? 0,
    scaleX: Math.max(0.0001, (params.scaleX as number) ?? 1),
    scaleY: Math.max(0.0001, (params.scaleY as number) ?? 1),
    rotateDeg: (params.rotate as number) ?? 0,
    pivotX: (params.pivotX as number) ?? 0.5,
    pivotY: (params.pivotY as number) ?? 0.5,
  };
}

export function isIdentityOp(op: TransformOp): boolean {
  return isIdentityTransform(op);
}

// Parent after local (local first). Identity local is dropped so a default
// Gizmo with a parent passes the parent through.
export function composeTransform(
  parent: TransformValue | undefined,
  local: TransformOp
): TransformValue {
  const ops = parent ? parent.ops.slice() : [];
  if (!isIdentityOp(local)) ops.push(local);
  return { kind: "transform", ops };
}

export function applyTransformToSpline(
  spline: SplineValue,
  t: TransformValue
): SplineValue {
  let out = spline;
  for (const op of t.ops) {
    out = transformSpline(out, op);
  }
  return out;
}

export function applyTransformInputToSpline(
  spline: SplineValue,
  v: SocketValue | undefined
): SplineValue {
  const t = asTransform(v);
  return t ? applyTransformToSpline(spline, t) : spline;
}

// Same affine as Transform's point path, applied per op. Instance rotation
// adds; instance scale multiplies.
export function applyTransformToPoints(
  src: PointsValue,
  t: TransformValue
): PointsValue {
  let out = src;
  for (const op of t.ops) {
    out = applyOpToPoints(out, op);
  }
  return out;
}

export function applyTransformInputToPoints(
  src: PointsValue,
  v: SocketValue | undefined
): PointsValue {
  const t = asTransform(v);
  return t ? applyTransformToPoints(src, t) : src;
}

function applyOpToPoints(src: PointsValue, op: TransformOp): PointsValue {
  if (isIdentityOp(op)) return src;
  const pivotX = op.pivotX;
  const pivotY = op.pivotY;
  const rad = (op.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const n = src.count;
  const positions = new Float32Array(n * 2);
  const rotations = new Float32Array(n);
  const outScales = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const dx = (src.positions[i * 2] - pivotX) * op.scaleX;
    const dy = (src.positions[i * 2 + 1] - pivotY) * op.scaleY;
    const rx = cos * dx - sin * dy;
    const ry = sin * dx + cos * dy;
    positions[i * 2] = op.translateX + pivotX + rx;
    positions[i * 2 + 1] = op.translateY + pivotY + ry;
    rotations[i] = getRotation(src, i) + rad;
    outScales[i * 2] = getScaleX(src, i) * Math.abs(op.scaleX);
    outScales[i * 2 + 1] = getScaleY(src, i) * Math.abs(op.scaleY);
  }
  return copyPointsWith(src, { positions, rotations, scales: outScales });
}

// 2×3 affine: [x'] = [a b] [x] + [tx]
//             [y']   [c d] [y]   [ty]
export type Affine2D = {
  a: number;
  b: number;
  tx: number;
  c: number;
  d: number;
  ty: number;
};

export const IDENTITY_AFFINE: Affine2D = {
  a: 1,
  b: 0,
  tx: 0,
  c: 0,
  d: 1,
  ty: 0,
};

export function trsToAffine(op: SplineTransformParams): Affine2D {
  const rad = (op.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = cos * op.scaleX;
  const b = -sin * op.scaleY;
  const c = sin * op.scaleX;
  const d = cos * op.scaleY;
  return {
    a,
    b,
    tx: op.translateX + op.pivotX - a * op.pivotX - b * op.pivotY,
    c,
    d,
    ty: op.translateY + op.pivotY - c * op.pivotX - d * op.pivotY,
  };
}

// A after B (B first).
export function multiplyAffine(A: Affine2D, B: Affine2D): Affine2D {
  return {
    a: A.a * B.a + A.b * B.c,
    b: A.a * B.b + A.b * B.d,
    tx: A.a * B.tx + A.b * B.ty + A.tx,
    c: A.c * B.a + A.d * B.c,
    d: A.c * B.b + A.d * B.d,
    ty: A.c * B.tx + A.d * B.ty + A.ty,
  };
}

export function invertAffine(m: Affine2D): Affine2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return null;
  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  return {
    a: ia,
    b: ib,
    tx: -(ia * m.tx + ib * m.ty),
    c: ic,
    d: id,
    ty: -(ic * m.tx + id * m.ty),
  };
}

export function composeOpsToAffine(ops: TransformOp[]): Affine2D {
  let m = IDENTITY_AFFINE;
  for (const op of ops) {
    if (isIdentityOp(op)) continue;
    m = multiplyAffine(trsToAffine(op), m);
  }
  return m;
}

export function isIdentityAffine(m: Affine2D, eps = 1e-9): boolean {
  return (
    Math.abs(m.a - 1) < eps &&
    Math.abs(m.b) < eps &&
    Math.abs(m.tx) < eps &&
    Math.abs(m.c) < eps &&
    Math.abs(m.d - 1) < eps &&
    Math.abs(m.ty) < eps
  );
}
