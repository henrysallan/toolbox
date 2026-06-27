import type { NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";

// Posterize — quantize each channel to N discrete levels (the screen-print /
// cel-shaded / gradient-banding look). Distinct from Dither (error-diffusion
// keeps perceived tones) and Threshold (1-bit cut). A `gamma` pre/de-gamma
// shifts where the bands land so steps fall where the eye wants them.
//
//   rgb  — quantize each channel independently (classic posterize).
//   luma — quantize brightness only and rescale rgb by the ratio, so hue is
//          preserved and you get flat tonal bands instead of color shifts.
//
// Alpha is passed through; universal mask + opacity are applied by the
// evaluator (this node has an `image` input → mask blends effect over source).
const POSTERIZE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_levels;
uniform float u_gamma;
uniform int u_mode; // 0 rgb, 1 luma
out vec4 outColor;

// Snap x to the nearest of L evenly spaced values in [0,1] (inclusive
// endpoints), in de-gamma'd space.
float quant(float x, float L, float g) {
  float v = pow(clamp(x, 0.0, 1.0), 1.0 / g);
  float steps = max(L - 1.0, 1.0);
  float q = floor(v * steps + 0.5) / steps;
  return pow(clamp(q, 0.0, 1.0), g);
}

void main() {
  vec4 c = texture(u_src, v_uv);
  float L = max(u_levels, 2.0);
  vec3 rgb;
  if (u_mode == 1) {
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    float ql = quant(l, L, u_gamma);
    float ratio = l > 1e-4 ? ql / l : 0.0;
    rgb = c.rgb * ratio;
  } else {
    rgb = vec3(
      quant(c.r, L, u_gamma),
      quant(c.g, L, u_gamma),
      quant(c.b, L, u_gamma)
    );
  }
  outColor = vec4(rgb, c.a);
}`;

export const posterizeNode: NodeDefinition = {
  type: "posterize",
  name: "Posterize",
  category: "image",
  subcategory: "modifier",
  description:
    "Quantize the image to a small number of tonal levels for a flat, screen-print / cel-shaded look. Per-channel (rgb) or brightness-only (luma, preserves hue).",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "levels",
      label: "Levels",
      type: "scalar",
      min: 2,
      max: 32,
      step: 1,
      default: 6,
    },
    {
      name: "channels",
      label: "Channels",
      type: "enum",
      options: ["rgb", "luma"],
      default: "rgb",
    },
    {
      name: "gamma",
      label: "Gamma",
      type: "scalar",
      min: 0.2,
      max: 4,
      step: 0.01,
      default: 1,
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const levels = (params.levels as number) ?? 6;
    const gamma = (params.gamma as number) ?? 1;
    const mode = (params.channels as string) === "luma" ? 1 : 0;

    const prog = ctx.getShader("posterize/main", POSTERIZE_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1f(gl.getUniformLocation(prog, "u_levels"), Math.max(2, levels));
      gl.uniform1f(gl.getUniformLocation(prog, "u_gamma"), Math.max(0.001, gamma));
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
    });

    return { primary: output };
  },
};
