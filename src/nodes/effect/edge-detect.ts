import type { NodeDefinition } from "@/engine/types";

// Edge-detection node with Sobel and Prewitt kernels.
//
// Both operate on the image's luminance (Rec. 601 coefficients) and
// compute a gradient magnitude via the standard 3×3 convolution, then
// sqrt(Gx² + Gy²). Differences between the two:
//
//   - Sobel:   weights the center row/column at 2× relative to the
//              outer ones. Slightly smoother output, less sensitive
//              to single-pixel noise. The classic choice for edges
//              in natural images.
//   - Prewitt: equal weights across the whole row/column. Sharper
//              response on clean-edged inputs; can feel "harsher"
//              on noisy textures. Cheaper to compute (same shader
//              path here, just different coefficients).
//
// The `threshold` param hard-clips low-magnitude responses to 0 —
// useful for turning gradient magnitude into crisp binary edges
// without stacking a Color Ramp downstream.

const EDGE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_invRes;
uniform int u_algo; // 0 = sobel, 1 = prewitt
uniform float u_strength;
uniform float u_threshold;
out vec4 outColor;

float lum(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 o = u_invRes;
  float lnw = lum(texture(u_src, v_uv + vec2(-o.x, -o.y)).rgb);
  float ln  = lum(texture(u_src, v_uv + vec2( 0.0, -o.y)).rgb);
  float lne = lum(texture(u_src, v_uv + vec2( o.x, -o.y)).rgb);
  float lw  = lum(texture(u_src, v_uv + vec2(-o.x,  0.0)).rgb);
  float le  = lum(texture(u_src, v_uv + vec2( o.x,  0.0)).rgb);
  float lsw = lum(texture(u_src, v_uv + vec2(-o.x,  o.y)).rgb);
  float ls  = lum(texture(u_src, v_uv + vec2( 0.0,  o.y)).rgb);
  float lse = lum(texture(u_src, v_uv + vec2( o.x,  o.y)).rgb);

  float gx;
  float gy;
  if (u_algo == 0) {
    // Sobel: center row/column weighted 2×.
    gx = -lnw + lne - 2.0 * lw + 2.0 * le - lsw + lse;
    gy = -lnw - 2.0 * ln - lne + lsw + 2.0 * ls + lse;
  } else {
    // Prewitt: uniform row/column weights.
    gx = -lnw + lne - lw + le - lsw + lse;
    gy = -lnw - ln - lne + lsw + ls + lse;
  }

  float mag = sqrt(gx * gx + gy * gy) * u_strength;
  if (mag < u_threshold) mag = 0.0;

  outColor = vec4(mag, mag, mag, 1.0);
}`;

export const edgeDetectNode: NodeDefinition = {
  type: "edge-detect",
  name: "Edge Detect",
  category: "image",
  subcategory: "modifier",
  description:
    "Extract edges via Sobel or Prewitt 3×3 gradient convolution. Output is grayscale gradient magnitude — brighter = stronger edge. Threshold clamps weak responses to zero for binary edge maps.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "algorithm",
      label: "Algorithm",
      type: "enum",
      options: ["sobel", "prewitt"],
      default: "sobel",
    },
    {
      name: "strength",
      label: "Strength",
      type: "scalar",
      min: 0,
      max: 10,
      softMax: 3,
      step: 0.01,
      default: 1,
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0,
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
    const algo = (params.algorithm as string) ?? "sobel";
    const strength = (params.strength as number) ?? 1;
    const threshold = (params.threshold as number) ?? 0;
    const algoIdx = algo === "prewitt" ? 1 : 0;

    const prog = ctx.getShader("edge-detect/main", EDGE_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_invRes"),
        1 / src.width,
        1 / src.height
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_algo"), algoIdx);
      gl.uniform1f(gl.getUniformLocation(prog, "u_strength"), strength);
      gl.uniform1f(gl.getUniformLocation(prog, "u_threshold"), threshold);
    });

    return { primary: output };
  },
};
