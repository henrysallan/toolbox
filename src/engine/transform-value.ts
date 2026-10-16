import type {
  ParamDef,
  PointsValue,
  SocketValue,
  SplineValue,
  TransformOp,
  TransformValue,
} from "./types";
import { aspectCorrectY } from "./aspect";
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

// ── Aspect-rigid image TRS (specdocs/101526_aspect-rigid-rotation.md) ──
//
// Transform's image path, Image / Video Source and Text inverse-sample a
// canvas-sized texture in canvas01 (per-axis: 1 x unit = W px, 1 y unit =
// H px). Rotating there shears when W ≠ H. They now rotate in pixels: the
// shaders conjugate the rotation by the aspect (p.y /= a; R; p.y *= a), and
// Transform / Image / Video read translateY / pivotY in authored space
// (y width-relative, like shapes), so their render is exactly
// composeOpsToCanvasAffine of opFromParams. Text keeps uv01 translate /
// pivot and only gets the rigid rotation (its box is uv01).
//
// `legacySkew` (hidden unless on) keeps a ≤v12 save's per-axis render bit
// for bit: u_aspect = 1 and raw uniforms. The v13 migration sets it.
// Unticking it switches the node to rigid without rewriting translate /
// pivot, so on a non-square comp a non-default translateY / pivotY moves.
export const LEGACY_SKEW_PARAM: ParamDef = {
  name: "legacySkew",
  label: "Legacy skew",
  type: "boolean",
  default: false,
  visibleIf: (p) => p.legacySkew === true,
};

export function isLegacySkew(params: Record<string, unknown>): boolean {
  return params.legacySkew === true;
}

// The aspect a node's image TRS conjugates its rotation by: W / H, or 1 for
// a legacySkew node (and for a degenerate size).
export function trsAspect(
  params: Record<string, unknown>,
  width: number,
  height: number
): number {
  if (isLegacySkew(params)) return 1;
  const a = width / height;
  return a > 0 && Number.isFinite(a) ? a : 1;
}

// The uniforms TRANSFORM_FS / FIT_FS take, in canvas01 Y-down: translate
// and pivot converted from authored space by the aspect (C(x, y) =
// (x, aspectCorrectY(y))), plus `aspect` for the rotation conjugation.
// aspect 1 passes the params through untouched (legacy bit-exactness).
// `authoredY` false keeps translate / pivot in uv01 (Text). Scale keeps its
// sign so the Transform context-bar flip (negative scaleX/Y) actually
// mirrors; only a near-zero scale is nudged.
export interface ImageTrsUniforms {
  translate: [number, number];
  scale: [number, number];
  angle: number;
  pivot: [number, number];
  aspect: number;
}

export function imageTrsUniforms(
  params: Record<string, unknown>,
  aspect: number,
  authoredY = true
): ImageTrsUniforms {
  const tx = (params.translateX as number) ?? 0;
  const ty = (params.translateY as number) ?? 0;
  let sx = (params.scaleX as number) ?? 1;
  let sy = (params.scaleY as number) ?? 1;
  if (Math.abs(sx) < 1e-4) sx = 1e-4;
  if (Math.abs(sy) < 1e-4) sy = 1e-4;
  const angle = (((params.rotate as number) ?? 0) * Math.PI) / 180;
  const px = (params.pivotX as number) ?? 0.5;
  const py = (params.pivotY as number) ?? 0.5;
  const convert = authoredY && aspect !== 1;
  return {
    translate: [tx, convert ? ty * aspect : ty],
    scale: [sx, sy],
    angle,
    pivot: [px, convert ? aspectCorrectY(py, aspect) : py],
    aspect,
  };
}

// Bind the inverse-TRS uniforms used by Image / Video Source (and matching
// TRANSFORM_FS). `aspect` from trsAspect.
export function bindTrsUniforms(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  params: Record<string, unknown>,
  aspect: number
): void {
  const u = imageTrsUniforms(params, aspect);
  gl.uniform2f(gl.getUniformLocation(prog, "u_translate"), ...u.translate);
  gl.uniform2f(gl.getUniformLocation(prog, "u_scale"), ...u.scale);
  gl.uniform1f(gl.getUniformLocation(prog, "u_angle"), u.angle);
  gl.uniform2f(gl.getUniformLocation(prog, "u_pivot"), ...u.pivot);
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), u.aspect);
}

// The shaders' inverse map, transcribed (TRANSFORM_FS / FIT_FS before the
// fit; Text with `negate`, whose rotate runs the other way): output v_uv
// (Y-up) → source uv (Y-up). The gate (check-layer-transform-math) holds it
// to composeOpsToCanvasAffine; keep it line for line with the GLSL.
export function imageTrsInverseUv(
  u: ImageTrsUniforms,
  uv: [number, number],
  negate = false
): [number, number] {
  const pivot = [u.pivot[0], 1 - u.pivot[1]];
  let x = uv[0] - u.translate[0] - pivot[0];
  let y = uv[1] + u.translate[1] - pivot[1];
  const c = Math.cos(negate ? -u.angle : u.angle);
  const s = Math.sin(negate ? -u.angle : u.angle);
  y /= u.aspect;
  [x, y] = [c * x - s * y, s * x + c * y];
  y *= u.aspect;
  return [x / u.scale[0] + pivot[0], y / u.scale[1] + pivot[1]];
}

export function isIdentityOp(op: TransformOp): boolean {
  return isIdentityTransform(op);
}

// Parent after local (local first): ops run first-to-last, so local goes
// in FRONT of the parent's ops. (Before 2026-10-15 this appended local
// after the parent, which only agreed for pure translations — a child's
// offset ignored its parent's rotation/scale.) Identity local is dropped
// so a default Gizmo with a parent passes the parent through.
export function composeTransform(
  parent: TransformValue | undefined,
  local: TransformOp
): TransformValue {
  const ops = isIdentityOp(local) ? [] : [local];
  if (parent) ops.push(...parent.ops);
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

// The ops' affine expressed in canvas01 (the space a canvas-sized image is
// sampled in), rigid in PIXELS on any canvas aspect. TransformOps live in
// authored space — y width-relative, the convention aspect.ts documents —
// so this is C · M · C⁻¹ with C(x, y) = (x, aspectCorrectY(y)): a layer
// image moved by it lands exactly where a shape under the same transform
// does. composeOpsToAffine on canvas01 directly (Transform / Image Source's
// image path) rotates per-axis and skews whenever W ≠ H. `aspect` = W / H;
// 1 is the identity conjugation.
export function composeOpsToCanvasAffine(
  ops: TransformOp[],
  aspect: number
): Affine2D {
  const m = composeOpsToAffine(ops);
  if (aspect === 1 || !(aspect > 0)) return m;
  const toCanvas: Affine2D = {
    a: 1,
    b: 0,
    tx: 0,
    c: 0,
    d: aspect,
    ty: 0.5 - 0.5 * aspect,
  };
  const toAuthored: Affine2D = {
    a: 1,
    b: 0,
    tx: 0,
    c: 0,
    d: 1 / aspect,
    ty: 0.5 - 0.5 / aspect,
  };
  return multiplyAffine(toCanvas, multiplyAffine(m, toAuthored));
}

// Inverse of trsToAffine for a fixed pivot: the TRS op that reproduces `m`
// about (pivotX, pivotY), or null when no TRS can — shear (the columns of
// the linear part aren't orthogonal, e.g. a rotated child under a
// non-uniformly scaled parent), a mirror (det < 0: layer/Gizmo params
// clamp scale positive), or a collapsed axis. Used by layer parenting to
// rewrite a child's TRS so its world placement holds
// (101526_layer-transforms-parenting.md §7). The rotation is picked from
// the 360° turns of the raw angle nearest `nearRotateDeg`, so a child at
// 350° re-parents to ~350°, not −10°.
export function decomposeAffineToTrs(
  m: Affine2D,
  pivotX: number,
  pivotY: number,
  nearRotateDeg = 0,
  eps = 1e-6
): TransformOp | null {
  // trsToAffine: col1 = (a, c) = sx·(cos, sin); col2 = (b, d) = sy·(−sin, cos).
  const sx = Math.hypot(m.a, m.c);
  const det = m.a * m.d - m.b * m.c;
  if (!(sx > eps) || !(det > eps * eps)) return null;
  const sy = det / sx;
  const dot = m.a * m.b + m.c * m.d;
  if (Math.abs(dot) > eps * sx * sy) return null;
  // det > 0 and orthogonal ⇒ col2 is col1 rotated +90° and scaled by sy.
  let rotateDeg = (Math.atan2(m.c, m.a) * 180) / Math.PI;
  rotateDeg += 360 * Math.round((nearRotateDeg - rotateDeg) / 360);
  return {
    translateX: m.tx - pivotX + m.a * pivotX + m.b * pivotY,
    translateY: m.ty - pivotY + m.c * pivotX + m.d * pivotY,
    scaleX: sx,
    scaleY: sy,
    rotateDeg,
    pivotX,
    pivotY,
  };
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
