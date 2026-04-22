import type { NodeDefinition } from "@/engine/types";

// Scale/rotate/translate around a user-controlled pivot. All params are in
// normalized (0-1) screen space — pivot (0,0) is the top-left of the frame,
// pivot (1,1) the bottom-right — which matches how the on-canvas gizmo is
// positioned. The shader flips Y internally to talk to WebGL's Y-up UVs.
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

export const transformNode: NodeDefinition = {
  type: "transform",
  name: "Transform",
  category: "effect",
  description:
    "Scale, rotate, and translate the input around a pivot. Pixels outside the frame become transparent.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
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
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }

    const prog = ctx.getShader("transform/main", TRANSFORM_FS);
    const translateX = (params.translateX as number) ?? 0;
    const translateY = (params.translateY as number) ?? 0;
    const scaleX = Math.max(0.0001, (params.scaleX as number) ?? 1);
    const scaleY = Math.max(0.0001, (params.scaleY as number) ?? 1);
    const angle = (((params.rotate as number) ?? 0) * Math.PI) / 180;
    const pivotX = (params.pivotX as number) ?? 0.5;
    const pivotY = (params.pivotY as number) ?? 0.5;

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
