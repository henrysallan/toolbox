import type { NodeDefinition } from "@/engine/types";

// Threshold — collapses an image into a binary (or smooth-stepped)
// black/white split based on luminance. Useful for masking, stylized
// silhouettes, or as a feeder for downstream nodes that want a
// clean binary signal (Scatter Points, Reaction-Diffusion seed,
// etc.).
//
// `softness` widens the transition into a smoothstep window — at 0
// the cut is hard; turn it up for an antialiased / feathered edge.
// `invert` swaps which side is white. `threshold` is the luminance
// pivot; values come from Rec. 709 luma weighting.

const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
uniform float u_softness;
uniform int   u_invert;
out vec4 outColor;

void main() {
  vec4 c = texture(u_src, v_uv);
  // Rec. 709 luma — matches what most "luminance" filters expect.
  float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float t;
  if (u_softness <= 0.0) {
    // Hard cut. step() gives a clean binary.
    t = step(u_threshold, luma);
  } else {
    // Symmetric window around the threshold so softness=1 doesn't
    // bias the transition off-center.
    float lo = u_threshold - u_softness * 0.5;
    float hi = u_threshold + u_softness * 0.5;
    t = smoothstep(lo, hi, luma);
  }
  if (u_invert == 1) t = 1.0 - t;
  // Preserve the source alpha so masking through downstream nodes
  // (Merge with masks, etc.) still respects pre-existing alpha.
  outColor = vec4(t, t, t, c.a);
}`;

export const thresholdNode: NodeDefinition = {
  type: "threshold",
  name: "Threshold",
  category: "image",
  subcategory: "modifier",
  description:
    "Binary luminance threshold — pixels brighter than the threshold become white, darker become black. Softness widens the transition into a feathered smoothstep edge; Invert swaps the two sides. Uses Rec. 709 luma weighting.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "softness",
      label: "Softness",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.3,
      step: 0.001,
      default: 0,
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
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
    const threshold = (params.threshold as number) ?? 0.5;
    const softness = Math.max(0, (params.softness as number) ?? 0);
    const invert = !!params.invert;

    const prog = ctx.getShader("threshold/main", THRESHOLD_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
      gl.uniform1f(gl.getUniformLocation(prog, "u_softness"), softness);
      gl.uniform1i(gl.getUniformLocation(prog, "u_invert"), invert ? 1 : 0);
    });
    return { primary: output };
  },
};
