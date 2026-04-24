import type { NodeDefinition } from "@/engine/types";

const THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_threshold;
out vec4 outColor;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float m = smoothstep(u_threshold, u_threshold + 0.05, l);
  outColor = vec4(m, 0.0, 0.0, 1.0);
}`;

const THRESHOLD_COLOR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_mask;
out vec4 outColor;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float m = texture(u_mask, v_uv).r;
  outColor = vec4(c * m, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform float u_radius;
out vec4 outColor;
void main() {
  // 9-tap gaussian, offsets scaled by radius.
  float w[5];
  w[0] = 0.227027;
  w[1] = 0.1945946;
  w[2] = 0.1216216;
  w[3] = 0.054054;
  w[4] = 0.016216;

  vec3 col = texture(u_src, v_uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = u_dir * u_texel * float(i) * u_radius;
    col += texture(u_src, v_uv + off).rgb * w[i];
    col += texture(u_src, v_uv - off).rgb * w[i];
  }
  outColor = vec4(col, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_base;
uniform sampler2D u_bloom;
uniform float u_intensity;
out vec4 outColor;
void main() {
  vec4 b = texture(u_base, v_uv);
  vec3 g = texture(u_bloom, v_uv).rgb;
  outColor = vec4(b.rgb + g * u_intensity, b.a);
}`;

export const bloomNode: NodeDefinition = {
  type: "bloom",
  name: "Bloom",
  category: "image",
  subcategory: "modifier",
  description: "Extracts bright regions and blurs them into a glow.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
    {
      name: "intensity",
      label: "Intensity",
      type: "scalar",
      min: 0,
      max: 3,
      step: 0.01,
      default: 1.0,
    },
    {
      name: "radius",
      label: "Radius (px)",
      type: "scalar",
      min: 0,
      max: 32,
      step: 0.5,
      default: 6,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [
    {
      name: "threshold_mask",
      type: "mask",
      description: "Single-channel luminance threshold mask.",
    },
    {
      name: "bloom_only",
      type: "image",
      description: "Glow without the original image composited underneath.",
    },
  ],

  compute({ inputs, params, ctx }) {
    const src = inputs["image"];
    const output = ctx.allocImage();
    const maskOut = ctx.allocMask();
    const bloomOnly = ctx.allocImage();

    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 1]);
      ctx.clearTarget(maskOut, [0, 0, 0, 1]);
      ctx.clearTarget(bloomOnly, [0, 0, 0, 1]);
      return {
        primary: output,
        aux: { threshold_mask: maskOut, bloom_only: bloomOnly },
      };
    }

    const threshold = (params.threshold as number) ?? 0.7;
    const intensity = (params.intensity as number) ?? 1.0;
    const radius = (params.radius as number) ?? 6;

    const thresholdProg = ctx.getShader("bloom/threshold", THRESHOLD_FS);
    ctx.drawFullscreen(thresholdProg, maskOut, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(thresholdProg, "u_src"), 0);
      gl.uniform1f(
        gl.getUniformLocation(thresholdProg, "u_threshold"),
        threshold
      );
    });

    const bright = ctx.allocImage();
    const thresholdColorProg = ctx.getShader(
      "bloom/thresholdColor",
      THRESHOLD_COLOR_FS
    );
    ctx.drawFullscreen(thresholdColorProg, bright, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(thresholdColorProg, "u_src"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskOut.texture);
      gl.uniform1i(gl.getUniformLocation(thresholdColorProg, "u_mask"), 1);
    });

    const blurProg = ctx.getShader("bloom/blur", BLUR_FS);
    const tmp = ctx.allocImage();

    ctx.drawFullscreen(blurProg, tmp, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bright.texture);
      gl.uniform1i(gl.getUniformLocation(blurProg, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(blurProg, "u_texel"),
        1 / bright.width,
        1 / bright.height
      );
      gl.uniform2f(gl.getUniformLocation(blurProg, "u_dir"), 1, 0);
      gl.uniform1f(gl.getUniformLocation(blurProg, "u_radius"), radius);
    });

    ctx.drawFullscreen(blurProg, bloomOnly, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
      gl.uniform1i(gl.getUniformLocation(blurProg, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(blurProg, "u_texel"),
        1 / tmp.width,
        1 / tmp.height
      );
      gl.uniform2f(gl.getUniformLocation(blurProg, "u_dir"), 0, 1);
      gl.uniform1f(gl.getUniformLocation(blurProg, "u_radius"), radius);
    });

    ctx.releaseTexture(bright.texture);
    ctx.releaseTexture(tmp.texture);

    const compProg = ctx.getShader("bloom/composite", COMPOSITE_FS);
    ctx.drawFullscreen(compProg, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(compProg, "u_base"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomOnly.texture);
      gl.uniform1i(gl.getUniformLocation(compProg, "u_bloom"), 1);
      gl.uniform1f(gl.getUniformLocation(compProg, "u_intensity"), intensity);
    });

    return {
      primary: output,
      aux: { threshold_mask: maskOut, bloom_only: bloomOnly },
    };
  },
};
