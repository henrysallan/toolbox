import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { transformSpline } from "@/engine/spline-transform";
import { ensurePointArray, pointsFromArray } from "@/engine/points";

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
const TRANSFORM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_translate; // screen convention (Y down)
uniform vec2 u_scale;     // uniform passed as vec2 so we can do non-uniform later
uniform float u_angle;    // radians
uniform vec2 u_pivot;     // screen convention (Y down)
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

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
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

type AABB = { minX: number; minY: number; maxX: number; maxY: number };

// Local-pivot remap: reinterpret a [0,1] pivot fraction against the geometry's
// own bounding box so rotate/scale happen about the shape itself. Returns the
// pivot unchanged when the bbox is degenerate/empty (falls back to global).
function localPivot(
  bbox: AABB | null,
  pivotX: number,
  pivotY: number
): { x: number; y: number } {
  if (!bbox || bbox.maxX <= bbox.minX || bbox.maxY <= bbox.minY) {
    return { x: pivotX, y: pivotY };
  }
  return {
    x: bbox.minX + pivotX * (bbox.maxX - bbox.minX),
    y: bbox.minY + pivotY * (bbox.maxY - bbox.minY),
  };
}

function splineAABB(s: SplineValue): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of s.subpaths) {
    for (const a of sub.anchors) {
      if (a.pos[0] < minX) minX = a.pos[0];
      if (a.pos[0] > maxX) maxX = a.pos[0];
      if (a.pos[1] < minY) minY = a.pos[1];
      if (a.pos[1] > maxY) maxY = a.pos[1];
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function pointsAABB(pts: Point[]): AABB | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.pos[0] < minX) minX = p.pos[0];
    if (p.pos[0] > maxX) maxX = p.pos[0];
    if (p.pos[1] < minY) minY = p.pos[1];
    if (p.pos[1] > maxY) maxY = p.pos[1];
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export const transformNode: NodeDefinition = {
  type: "transform",
  name: "Transform",
  category: "utility",
  description:
    "Scale, rotate, and translate the input around a pivot. Works on images, splines, or points. For SDFs use the Position-pipeline operators (Position Translate / Scale / Rotate) — they compose with Position Repeat / Mirror / Polar for tile-local transforms.",
  backend: "webgl2",
  supportsTransformGizmo: true,
  // Input socket is named "image" for back-compat with saved projects; its
  // type (and label) retype from whatever is connected via resolveInputs +
  // connectedTypes — image / spline / points.
  inputs: [{ name: "image", type: "image", required: true }],
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
    {
      // Pivot space (splines/points only; ignored for images, which have no
      // intrinsic bounds). Global: pivot X/Y are absolute canvas coords.
      // Local: pivot X/Y are a fraction of the INCOMING geometry's bounding
      // box (0.5,0.5 = its center), so rotate/scale happen about the shape
      // wherever an upstream transform placed it — the anchor "follows" the
      // previous transforms. Translate stays in canvas units either way.
      name: "space",
      label: "Pivot space",
      type: "enum",
      options: ["global", "local"],
      control: "segmented",
      default: "global",
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
    const localSpace = params.space === "local";

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
      const pts = ensurePointArray(src);
      const p =
        localSpace
          ? localPivot(pointsAABB(pts), pivotXParam, pivotYParam)
          : { x: pivotXParam, y: pivotYParam };
      const pivotX = p.x;
      const pivotY = p.y;
      const rad = (rotateDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const transformed: Point[] = pts.map((p) => {
        const dx = (p.pos[0] - pivotX) * scaleX;
        const dy = (p.pos[1] - pivotY) * scaleY;
        const rx = cos * dx - sin * dy;
        const ry = sin * dx + cos * dy;
        const baseScale = p.scale ?? [1, 1];
        return {
          pos: [translateX + pivotX + rx, translateY + pivotY + ry],
          rotation: (p.rotation ?? 0) + rad,
          scale: [
            baseScale[0] * Math.abs(scaleX),
            baseScale[1] * Math.abs(scaleY),
          ],
        };
      });
      const out: PointsValue = pointsFromArray(transformed);
      return { primary: out };
    }

    const output = ctx.allocImage();
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const prog = ctx.getShader("transform/main", TRANSFORM_FS);
    const angle = (rotateDeg * Math.PI) / 180;

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
    });

    return { primary: output };
  },
};
