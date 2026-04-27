import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { transformSpline } from "@/engine/spline-transform";

// Scale/rotate/translate around a user-controlled pivot. All params are in
// normalized (0-1) screen space — pivot (0,0) is the top-left of the frame,
// pivot (1,1) the bottom-right — which matches how the on-canvas gizmo is
// positioned. The shader flips Y internally to talk to WebGL's Y-up UVs.
//
// Mode is polymorphic: `image` applies the affine in GL through an inverse
// sampling shader; `spline` runs the identical math on CPU anchors so the
// same gizmo can drive both kinds of data. Mode is an explicit param
// rather than auto-detected so the socket types are stable before
// connection (matches how Math switches between scalar/uv).
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
  float c = cos(-u_angle);
  float s = sin(-u_angle);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  p /= max(u_scale, vec2(0.0001));
  uv = p + pivot;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_src, uv);
}`;

function modeOf(
  params: Record<string, unknown>
): "image" | "spline" | "point" {
  if (params.mode === "spline") return "spline";
  if (params.mode === "point") return "point";
  return "image";
}

export const transformNode: NodeDefinition = {
  type: "transform",
  name: "Transform",
  category: "utility",
  description:
    "Scale, rotate, and translate the input around a pivot. Works on images (pixels outside the frame become transparent) or splines (anchors and handles transform in place).",
  backend: "webgl2",
  supportsTransformGizmo: true,
  // Mode dropdown duplicated on the node header so switching data
  // types is one click — same pattern the Group family uses.
  headerControl: { paramName: "mode" },
  // Input socket is named "image" for back-compat with saved projects; in
  // spline / point modes the label updates and the socket type retypes
  // via resolveInputs.
  inputs: [{ name: "image", type: "image", required: true }],
  resolveInputs(params): InputSocketDef[] {
    const mode = modeOf(params);
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
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["image", "spline", "point"],
      default: "image",
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
  ],
  primaryOutput: "image",
  resolvePrimaryOutput(params): SocketType {
    const m = modeOf(params);
    if (m === "spline") return "spline";
    if (m === "point") return "points";
    return "image";
  },
  auxOutputs: [],
  linkedPairs: [{ a: "scaleX", b: "scaleY" }],

  compute({ inputs, params, ctx }) {
    const mode = modeOf(params);
    const translateX = (params.translateX as number) ?? 0;
    const translateY = (params.translateY as number) ?? 0;
    const scaleX = Math.max(0.0001, (params.scaleX as number) ?? 1);
    const scaleY = Math.max(0.0001, (params.scaleY as number) ?? 1);
    const rotateDeg = (params.rotate as number) ?? 0;
    const pivotX = (params.pivotX as number) ?? 0.5;
    const pivotY = (params.pivotY as number) ?? 0.5;

    if (mode === "spline") {
      const src = inputs["image"];
      if (!src || src.kind !== "spline") {
        // Nothing to transform — emit an empty spline so downstream nodes
        // get a well-formed value instead of undefined.
        const empty: SplineValue = { kind: "spline", subpaths: [] };
        return { primary: empty };
      }
      const out = transformSpline(src, {
        translateX,
        translateY,
        scaleX,
        scaleY,
        rotateDeg,
        pivotX,
        pivotY,
      });
      return { primary: out };
    }

    if (mode === "point") {
      const src = inputs["image"];
      if (!src || src.kind !== "points") {
        const empty: PointsValue = { kind: "points", points: [] };
        return { primary: empty };
      }
      // Same affine math as the spline/image paths, applied per
      // point. Point's own `rotation`/`scale` compose with the
      // transform's — additive for rotation, multiplicative for
      // scale — so a Copy-to-Points chain down the line sees the
      // combined effect.
      const rad = (rotateDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const transformed: Point[] = src.points.map((p) => {
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
      const out: PointsValue = { kind: "points", points: transformed };
      return { primary: out };
    }

    const output = ctx.allocImage();
    const src = inputs["image"];
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
      gl.uniform2f(gl.getUniformLocation(prog, "u_pivot"), pivotX, pivotY);
    });

    return { primary: output };
  },
};
