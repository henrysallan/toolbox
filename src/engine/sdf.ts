import type { ImageValue, MaskValue, RenderContext } from "./types";

// Jump-flooding algorithm (Rong & Tan, 2006). Each pass propagates the
// nearest-seed coordinate using a power-of-two step size. After log2(maxDim)
// passes every texel knows the UV of the closest seed, from which we derive a
// proper signed distance.
//
// State texture channels: (seedU, seedV, valid, _).

const INIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() {
  // Any texel with appreciable alpha is a seed. 0.5 matches the threshold we
  // use when signing the distance, so outline width is stable.
  float a = texture(u_src, v_uv).a;
  if (a > 0.5) {
    outColor = vec4(v_uv, 1.0, 1.0);
  } else {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
}`;

const JUMP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_step;
out vec4 outColor;
void main() {
  vec4 best = texture(u_src, v_uv);
  float bestDist = best.b > 0.5 ? distance(v_uv, best.xy) : 1e9;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 off = u_step * vec2(float(dx), float(dy));
      vec2 p = v_uv + off;
      // Skip out-of-bounds neighbours (clamp sampler would otherwise repeat
      // the edge seed forever and seep distance inward).
      if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) continue;
      vec4 n = texture(u_src, p);
      if (n.b < 0.5) continue;
      float d = distance(v_uv, n.xy);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
  }
  outColor = best;
}`;

const FINAL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_jfa;
uniform sampler2D u_mask;
uniform float u_maxDist;      // normalization half-range (in UV units)
out vec4 outColor;
void main() {
  vec4 j = texture(u_jfa, v_uv);
  float a = texture(u_mask, v_uv).a;
  float inside = a > 0.5 ? 1.0 : 0.0;
  float dist = j.b > 0.5 ? distance(v_uv, j.xy) : 1.0;
  float signed_ = inside > 0.5 ? -dist : dist;
  // Map [-maxDist, +maxDist] → [0, 1] so the boundary sits at 0.5. Values
  // outside that range clamp, which is fine for glow/outline/dilation.
  float norm = 0.5 + 0.5 * clamp(signed_ / max(u_maxDist, 1e-5), -1.0, 1.0);
  outColor = vec4(norm, 0.0, 0.0, 1.0);
}`;

// Blit an RGBA16F jump-flood state into a MaskValue (R channel only).
//
// `maxDistPx` is the edge width (in pixels) over which the distance field
// smoothly ramps from 0 → 1. Larger values give softer glows; smaller values
// give crisp outlines. 128 px at 1024² resolution is a reasonable default.
export function computeSDF(
  ctx: RenderContext,
  source: ImageValue,
  maxDistPx = 128
): MaskValue {
  const W = source.width;
  const H = source.height;

  let a = ctx.allocImage({ width: W, height: H });
  let b = ctx.allocImage({ width: W, height: H });

  const initProg = ctx.getShader("sdf/init", INIT_FS);
  ctx.drawFullscreen(initProg, a, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(gl.getUniformLocation(initProg, "u_src"), 0);
  });

  const jumpProg = ctx.getShader("sdf/jump", JUMP_FS);
  const maxDim = Math.max(W, H);
  let step = Math.max(1, Math.floor(maxDim / 2));
  while (step >= 1) {
    ctx.drawFullscreen(jumpProg, b, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.texture);
      gl.uniform1i(gl.getUniformLocation(jumpProg, "u_src"), 0);
      gl.uniform2f(
        gl.getUniformLocation(jumpProg, "u_step"),
        step / W,
        step / H
      );
    });
    [a, b] = [b, a];
    if (step === 1) break;
    step = Math.max(1, Math.floor(step / 2));
  }

  const output = ctx.allocMask({ width: W, height: H });
  const finalProg = ctx.getShader("sdf/final", FINAL_FS);
  ctx.drawFullscreen(finalProg, output, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.texture);
    gl.uniform1i(gl.getUniformLocation(finalProg, "u_jfa"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(gl.getUniformLocation(finalProg, "u_mask"), 1);
    gl.uniform1f(
      gl.getUniformLocation(finalProg, "u_maxDist"),
      maxDistPx / maxDim
    );
  });

  ctx.releaseTexture(a.texture);
  ctx.releaseTexture(b.texture);
  return output;
}
