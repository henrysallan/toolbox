import type { NodeDefinition } from "@/engine/types";

// Separable gaussian. Sigma is derived from the user-facing `radius` (px)
// matching the visual weight of a canvas2D `blur(Npx)` filter. The loop is
// bounded by MAX_TAPS so we can support large radii at a predictable cost.
const MAX_TAPS = 64;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_taps;
out vec4 outColor;
void main() {
  if (u_sigma <= 0.0001) {
    outColor = texture(u_src, v_uv);
    return;
  }
  float twoSigmaSq = 2.0 * u_sigma * u_sigma;
  vec4 acc = texture(u_src, v_uv);
  float weightSum = 1.0;
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > u_taps) break;
    float w = exp(-float(i * i) / twoSigmaSq);
    vec2 off = u_dir * u_texel * float(i);
    acc += texture(u_src, v_uv + off) * w;
    acc += texture(u_src, v_uv - off) * w;
    weightSum += 2.0 * w;
  }
  outColor = acc / weightSum;
}`;

export const gaussianBlurNode: NodeDefinition = {
  type: "gaussian-blur",
  name: "Gaussian Blur",
  category: "effect",
  description: "Separable gaussian blur with adjustable radius.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "radius",
      label: "Radius (px)",
      type: "scalar",
      min: 0,
      max: 20,
      step: 0.5,
      default: 0,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs["image"];
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      return { primary: output };
    }

    const radius = Math.max(0, (params.radius as number) ?? 0);
    const prog = ctx.getShader("gaussian-blur/blur", BLUR_FS);

    if (radius <= 0.0001) {
      ctx.drawFullscreen(prog, output, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
        gl.uniform2f(
          gl.getUniformLocation(prog, "u_texel"),
          1 / src.width,
          1 / src.height
        );
        gl.uniform2f(gl.getUniformLocation(prog, "u_dir"), 1, 0);
        gl.uniform1f(gl.getUniformLocation(prog, "u_sigma"), 0);
        gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), 0);
      });
      return { primary: output };
    }

    // sigma ≈ radius/2 gives a visual weight close to canvas2D's blur filter.
    const sigma = radius * 0.5;
    const taps = Math.min(MAX_TAPS, Math.max(1, Math.ceil(sigma * 3)));

    const tmp = ctx.allocImage();
    ctx.drawFullscreen(prog, tmp, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_texel"),
        1 / src.width,
        1 / src.height
      );
      gl.uniform2f(gl.getUniformLocation(prog, "u_dir"), 1, 0);
      gl.uniform1f(gl.getUniformLocation(prog, "u_sigma"), sigma);
      gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), taps);
    });

    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_texel"),
        1 / tmp.width,
        1 / tmp.height
      );
      gl.uniform2f(gl.getUniformLocation(prog, "u_dir"), 0, 1);
      gl.uniform1f(gl.getUniformLocation(prog, "u_sigma"), sigma);
      gl.uniform1i(gl.getUniformLocation(prog, "u_taps"), taps);
    });

    ctx.releaseTexture(tmp.texture);
    return { primary: output };
  },
};
