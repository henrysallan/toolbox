import type {
  InputSocketDef,
  NodeDefinition,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { transformSpline } from "@/engine/spline-transform";
import {
  copyPointsWith,
  getRotation,
  getScaleX,
  getScaleY,
} from "@/engine/points";
import {
  isLocalPivotSpace,
  localPivot,
  pointsPositionsAABB,
  splineAABB,
} from "@/engine/transform-pivot";
import {
  applyTransformToPoints,
  applyTransformToSpline,
  asTransform,
  composeOpsToAffine,
  invertAffine,
  transformTrsVisible,
} from "@/engine/transform-value";

// Scale/rotate/translate around a user-controlled pivot. All params are in
// normalized (0-1) screen space — pivot (0,0) is the top-left of the frame,
// pivot (1,1) the bottom-right — which matches how the on-canvas gizmo is
// positioned. The shader flips Y internally to talk to WebGL's Y-up UVs.
//
// Behavior is polymorphic and derived from the connected input's type (no
// mode param): an `image` applies the affine in GL through an inverse sampling
// shader; a `spline` / `points` input runs the identical math on CPU geometry
// so the same gizmo drives every kind of data. The input socket retypes itself
// (and the output) via `resolveInputs`/`resolvePrimaryOutput` + `connectedTypes`
// — same pattern as the Displace node. The legacy `mode` param is kept hidden
// for save back-compat but no longer read.
//
// Image Tile (AE RepeTile): wrap the inverse-sampled UV instead of clipping
// it, so extra copies fall out of scale/translate for free. Cost is one
// fullscreen pass regardless of tile count — no extra draws, no larger
// target. Unfold mirrors odd cells so adjacent tiles meet edge-to-edge.
export const TRANSFORM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_translate; // screen convention (Y down)
uniform vec2 u_scale;     // uniform passed as vec2 so we can do non-uniform later
uniform float u_angle;    // radians
uniform vec2 u_pivot;     // screen convention (Y down)
// Extra source-widths past each edge: (left, right, down, up). Y is UV-up
// (down expands uv.y < 0, up expands uv.y > 1). Ignored when u_tileMode is 0.
uniform vec4 u_tileExpand;
uniform int u_tileMode; // 0 off, 1 repeat, 2 unfold
out vec4 outColor;

void main() {
  // Screen → UV y-flip for pivot and translate.
  vec2 pivot = vec2(u_pivot.x, 1.0 - u_pivot.y);
  vec2 translate = vec2(u_translate.x, -u_translate.y);

  // Inverse transform: for each output pixel, find the source pixel that
  // would land here under the forward (translate · pivot-back · rotate · scale · -pivot).
  vec2 uv = v_uv - translate;
  vec2 p = uv - pivot;
  // Positive u_angle reads as clockwise on screen — matching the on-canvas
  // gizmo (atan2 in Y-down space) and the spline/point CPU paths. v_uv is
  // Y-UP while those frames are Y-down, so the inverse-sampling angle is NOT
  // negated here (negating it would invert image rotation vs every other
  // mode — the historical bug).
  float c = cos(u_angle);
  float s = sin(u_angle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p /= max(u_scale, vec2(0.0001));
  uv = p + pivot;

  vec2 lo = vec2(0.0);
  vec2 hi = vec2(1.0);
  if (u_tileMode != 0) {
    lo = vec2(-u_tileExpand.x, -u_tileExpand.z);
    hi = vec2(1.0 + u_tileExpand.y, 1.0 + u_tileExpand.w);
  }
  if (uv.x < lo.x || uv.x > hi.x || uv.y < lo.y || uv.y > hi.y) {
    outColor = vec4(0.0);
    return;
  }

  if (u_tileMode == 1) {
    uv = fract(uv);
  } else if (u_tileMode == 2) {
    // Mirror odd cells; cell 0 (the original) stays unflipped.
    vec2 t = mod(uv, 2.0);
    uv = mix(t, 2.0 - t, step(1.0, t));
  }
  outColor = texture(u_src, uv);
}`;

// Inverse-sample via a 2×3 affine (Y-down), for a wired `transform` value
// whose op list may be longer than one TRS. Converts UV-up ↔ Y-down around
// the multiply so tile wrap still happens in UV space.
export const TRANSFORM_MATRIX_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec4 u_invA; // inverse linear part: a, b, c, d
uniform vec2 u_invT; // inverse translation
uniform vec4 u_tileExpand;
uniform int u_tileMode;
out vec4 outColor;

void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 src = vec2(
    u_invA.x * p.x + u_invA.y * p.y + u_invT.x,
    u_invA.z * p.x + u_invA.w * p.y + u_invT.y
  );
  vec2 uv = vec2(src.x, 1.0 - src.y);

  vec2 lo = vec2(0.0);
  vec2 hi = vec2(1.0);
  if (u_tileMode != 0) {
    lo = vec2(-u_tileExpand.x, -u_tileExpand.z);
    hi = vec2(1.0 + u_tileExpand.y, 1.0 + u_tileExpand.w);
  }
  if (uv.x < lo.x || uv.x > hi.x || uv.y < lo.y || uv.y > hi.y) {
    outColor = vec4(0.0);
    return;
  }

  if (u_tileMode == 1) {
    uv = fract(uv);
  } else if (u_tileMode == 2) {
    vec2 t = mod(uv, 2.0);
    uv = mix(t, 2.0 - t, step(1.0, t));
  }
  outColor = texture(u_src, uv);
}`;

// Map the connected input socket type to a behavior mode. spline → spline,
// points → point, everything image-like (image / mask / element / nothing) →
// image. Drives both socket retyping and the compute branch.
function modeForType(
  t: SocketType | undefined
): "image" | "spline" | "point" {
  if (t === "spline") return "spline";
  if (t === "points") return "point";
  return "image";
}

// Tile is image-only (UV wrap in the shader). Spline/points would have to
// duplicate geometry, which is neither RepeTile nor O(1). Degrade to visible
// when `meta` is missing (docs / export) — additive visibleIf contract.
function isImageInput(
  _p: Record<string, unknown>,
  meta?: { inputTypes?: Record<string, SocketType | undefined> }
): boolean {
  const t = meta?.inputTypes?.image;
  return t !== "spline" && t !== "points";
}

function tileEnabled(
  p: Record<string, unknown>,
  meta?: { inputTypes?: Record<string, SocketType | undefined> }
): boolean {
  return isImageInput(p, meta) && p.tile === true;
}

// Pivot-from Source/Canvas is spline/points-only (images have no intrinsic
// bounds). Degrade to visible when `meta` is missing (docs / export).
function isGeometryInput(
  _p: Record<string, unknown>,
  meta?: { inputTypes?: Record<string, SocketType | undefined> }
): boolean {
  if (!meta?.inputTypes) return true;
  const t = meta.inputTypes.image;
  return t === "spline" || t === "points";
}

export const transformNode: NodeDefinition = {
  type: "transform",
  name: "Transform",
  category: "utility",
  description:
    "Scale, rotate, and translate the input around a pivot. Works on images, splines, or points. Wire a Gizmo into Transform to drive the same placement from a shared on-canvas control (that replaces this node's own TRS). Spline/points Pivot from Source (the default) follows the incoming shape's bounds so scale/rotate stay about the shape when you move it; Canvas pins the pivot to a fixed frame point. Image mode can Tile the source past its edges (AE RepeTile) with per-side extent and Unfold. For SDFs use the Position-pipeline operators (Position Translate / Scale / Rotate) — they compose with Position Repeat / Mirror / Polar for tile-local transforms.",
  backend: "webgl2",
  supportsTransformGizmo: true,
  // Input socket is named "image" for back-compat with saved projects; its
  // type (and label) retype from whatever is connected via resolveInputs +
  // connectedTypes — image / spline / points.
  inputs: [
    { name: "image", type: "image", required: true },
    { name: "transform", type: "transform", required: false, label: "Transform" },
  ],
  resolveInputs(params, ctx): InputSocketDef[] {
    const mode = modeForType(ctx?.connectedTypes?.image);
    const t: SocketType =
      mode === "spline" ? "spline" : mode === "point" ? "points" : "image";
    const label =
      mode === "spline" ? "Spline" : mode === "point" ? "Points" : "Image";
    return [
      {
        name: "image",
        label,
        type: t,
        required: true,
      },
      {
        name: "transform",
        type: "transform",
        required: false,
        label: "Transform",
      },
    ];
  },
  params: [
    {
      // Legacy: behavior is now auto-derived from the connected input type.
      // Kept (hidden) so old saved projects deserialize unchanged.
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["image", "spline", "point"],
      default: "image",
      hidden: true,
    },
    {
      name: "translateX",
      label: "Translate X",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
      visibleIf: transformTrsVisible,
    },
    {
      name: "translateY",
      label: "Translate Y",
      type: "scalar",
      min: -1,
      max: 1,
      step: 0.001,
      default: 0,
      visibleIf: transformTrsVisible,
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
      visibleIf: transformTrsVisible,
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
      visibleIf: transformTrsVisible,
    },
    {
      name: "rotate",
      label: "Rotate (°)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
      visibleIf: transformTrsVisible,
    },
    {
      name: "pivotX",
      label: "Pivot X",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: transformTrsVisible,
    },
    {
      name: "pivotY",
      label: "Pivot Y",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: transformTrsVisible,
    },
    {
      // Pivot space (splines/points only; ignored for images, which have no
      // intrinsic bounds). Canvas: pivot X/Y are absolute frame coords.
      // Source: pivot X/Y are a fraction of the INCOMING geometry's bounding
      // box (0.5,0.5 = its center), so rotate/scale happen about the shape
      // wherever you (or an upstream transform) placed it. Translate stays
      // in canvas units either way. Default Source — the usual "scale this
      // circle" case; Canvas is for scaling toward a fixed frame point.
      name: "space",
      label: "Pivot from",
      type: "enum",
      options: ["global", "local"],
      optionLabels: { global: "Canvas", local: "Source" },
      control: "segmented",
      default: "local",
      visibleIf: (p, meta) =>
        isGeometryInput(p, meta) && transformTrsVisible(p, meta),
    },
    // RepeTile-style expansion. Units are source-widths (1 = one extra copy
    // past that edge). Default 1 so enabling Tile immediately shows neighbors
    // once the image is scaled down enough to leave room.
    {
      name: "tile",
      label: "Tile",
      type: "boolean",
      default: false,
      group: "tile",
      groupHeader: true,
      visibleIf: isImageInput,
    },
    {
      name: "tileLeft",
      label: "Left",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 4,
      step: 0.01,
      default: 1,
      group: "tile",
      visibleIf: tileEnabled,
    },
    {
      name: "tileRight",
      label: "Right",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 4,
      step: 0.01,
      default: 1,
      group: "tile",
      visibleIf: tileEnabled,
    },
    {
      name: "tileUp",
      label: "Up",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 4,
      step: 0.01,
      default: 1,
      group: "tile",
      visibleIf: tileEnabled,
    },
    {
      name: "tileDown",
      label: "Down",
      type: "scalar",
      min: 0,
      max: 16,
      softMax: 4,
      step: 0.01,
      default: 1,
      group: "tile",
      visibleIf: tileEnabled,
    },
    {
      name: "tileUnfold",
      label: "Unfold",
      type: "boolean",
      default: false,
      group: "tile",
      visibleIf: tileEnabled,
    },
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params, ctx): SocketType {
    const m = modeForType(ctx?.connectedTypes?.image);
    if (m === "spline") return "spline";
    if (m === "point") return "points";
    return "image";
  },
  auxOutputs: [],
  linkedPairs: [{ a: "scaleX", b: "scaleY" }],

  compute({ inputs, params, ctx }) {
    // Behavior follows the actual input value's kind (the evaluator has
    // already coerced it to the socket type resolveInputs picked).
    const src = inputs["image"];
    const wired = asTransform(inputs.transform);

    if (wired) {
      if (src?.kind === "spline") {
        return { primary: applyTransformToSpline(src, wired) };
      }
      if (src?.kind === "points") {
        return { primary: applyTransformToPoints(src, wired) };
      }
      const output = ctx.allocImage();
      if (!src || src.kind !== "image") {
        ctx.clearTarget(output, [0, 0, 0, 0]);
        return { primary: output };
      }
      const affine = composeOpsToAffine(wired.ops);
      const inv = invertAffine(affine) ?? {
        a: 1,
        b: 0,
        tx: 0,
        c: 0,
        d: 1,
        ty: 0,
      };
      const tile = params.tile === true;
      const tileMode = !tile ? 0 : params.tileUnfold === true ? 2 : 1;
      const tileLeft = Math.max(0, (params.tileLeft as number) ?? 1);
      const tileRight = Math.max(0, (params.tileRight as number) ?? 1);
      const tileDown = Math.max(0, (params.tileDown as number) ?? 1);
      const tileUp = Math.max(0, (params.tileUp as number) ?? 1);
      const prog = ctx.getShader("transform/matrix", TRANSFORM_MATRIX_FS);
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform4f(
          gl.getUniformLocation(prog, "u_invA"),
          inv.a,
          inv.b,
          inv.c,
          inv.d
        );
        gl.uniform2f(gl.getUniformLocation(prog, "u_invT"), inv.tx, inv.ty);
        gl.uniform4f(
          gl.getUniformLocation(prog, "u_tileExpand"),
          tileLeft,
          tileRight,
          tileDown,
          tileUp
        );
        gl.uniform1i(gl.getUniformLocation(prog, "u_tileMode"), tileMode);
      });
      return { primary: output };
    }

    const translateX = (params.translateX as number) ?? 0;
    const translateY = (params.translateY as number) ?? 0;
    const scaleX = Math.max(0.0001, (params.scaleX as number) ?? 1);
    const scaleY = Math.max(0.0001, (params.scaleY as number) ?? 1);
    const rotateDeg = (params.rotate as number) ?? 0;
    const pivotXParam = (params.pivotX as number) ?? 0.5;
    const pivotYParam = (params.pivotY as number) ?? 0.5;
    // Local pivot space (splines/points): pivot is a fraction of the incoming
    // geometry's bbox, so the shape rotates/scales about itself no matter where
    // upstream transforms placed it. Image mode has no intrinsic bounds → global.
    const localSpace = isLocalPivotSpace(params.space);

    if (src?.kind === "spline") {
      const p =
        localSpace
          ? localPivot(splineAABB(src), pivotXParam, pivotYParam)
          : { x: pivotXParam, y: pivotYParam };
      const out: SplineValue = transformSpline(src, {
        translateX,
        translateY,
        scaleX,
        scaleY,
        rotateDeg,
        pivotX: p.x,
        pivotY: p.y,
      });
      return { primary: out };
    }

    if (src?.kind === "points") {
      // Same affine math as the spline/image paths, applied per
      // point. Point's own `rotation`/`scale` compose with the
      // transform's — additive for rotation, multiplicative for
      // scale — so a Copy-to-Points chain down the line sees the
      // combined effect.
      const p =
        localSpace
          ? localPivot(
              pointsPositionsAABB(src.positions, src.count),
              pivotXParam,
              pivotYParam
            )
          : { x: pivotXParam, y: pivotYParam };
      const pivotX = p.x;
      const pivotY = p.y;
      const rad = (rotateDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // SoA transform: positions/rotations/scales replaced, everything
      // else (groupIndices included — the Point[] round-trip used to drop
      // them) carries through the copy.
      const n = src.count;
      const positions = new Float32Array(n * 2);
      const rotations = new Float32Array(n);
      const outScales = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const dx = (src.positions[i * 2] - pivotX) * scaleX;
        const dy = (src.positions[i * 2 + 1] - pivotY) * scaleY;
        const rx = cos * dx - sin * dy;
        const ry = sin * dx + cos * dy;
        positions[i * 2] = translateX + pivotX + rx;
        positions[i * 2 + 1] = translateY + pivotY + ry;
        rotations[i] = getRotation(src, i) + rad;
        outScales[i * 2] = getScaleX(src, i) * Math.abs(scaleX);
        outScales[i * 2 + 1] = getScaleY(src, i) * Math.abs(scaleY);
      }
      return {
        primary: copyPointsWith(src, {
          positions,
          rotations,
          scales: outScales,
        }),
      };
    }

    const output = ctx.allocImage();
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const prog = ctx.getShader("transform/tile", TRANSFORM_FS);
    const angle = (rotateDeg * Math.PI) / 180;
    const tile = params.tile === true;
    const tileMode = !tile ? 0 : params.tileUnfold === true ? 2 : 1;
    const tileLeft = Math.max(0, (params.tileLeft as number) ?? 1);
    const tileRight = Math.max(0, (params.tileRight as number) ?? 1);
    const tileDown = Math.max(0, (params.tileDown as number) ?? 1);
    const tileUp = Math.max(0, (params.tileUp as number) ?? 1);

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_translate"),
        translateX,
        translateY
      );
      gl.uniform2f(gl.getUniformLocation(prog, "u_scale"), scaleX, scaleY);
      gl.uniform1f(gl.getUniformLocation(prog, "u_angle"), angle);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_pivot"),
        pivotXParam,
        pivotYParam
      );
      gl.uniform4f(
        gl.getUniformLocation(prog, "u_tileExpand"),
        tileLeft,
        tileRight,
        tileDown,
        tileUp
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_tileMode"), tileMode);
    });

    return { primary: output };
  },
};
