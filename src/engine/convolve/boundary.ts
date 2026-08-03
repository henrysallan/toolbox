// Convolution boundary passes — the ONE place the engine's alpha and
// colour conventions are converted for filtering, and back.
//
// Two things have to be true for a convolution to be correct, and the old
// Gaussian Blur node did neither:
//
// 1. PREMULTIPLIED ALPHA. The engine is straight-alpha throughout
//    (devguide invariant #4), and filtering straight alpha mixes colour
//    from pixels that contribute no coverage — the transparent surround
//    bleeds into the visible edge and soft edges fade through a dark
//    fringe. The correct operation is premultiply → convolve →
//    unpremultiply. A Gaussian's softness disguises this; a disc kernel
//    with a bright rim does not.
//
// 2. LINEAR LIGHT. Averaging sRGB-encoded values underweights highlights,
//    so bokeh discs come out dim and grey instead of hot and blown out.
//    Optional here (`linearize`) rather than assumed, because the engine
//    has no pipeline-wide working space: a graph coming off the EXR/ACES
//    path is ALREADY scene-linear and would be double-transformed. New
//    Blur nodes default it on; legacy `gaussian-blur` nodes are migrated
//    to off so existing projects stay colour-stable.
//
// Both passes are unclamped above 1 so scene-linear HDR passes through —
// that headroom is what makes a highlight bloom into the kernel's shape
// instead of flattening to white.

import type { ImageValue, RenderContext } from "@/engine/types";

const TRANSFER_GLSL = `
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow(max((c + 0.055) / 1.055, 0.0), vec3(2.4));
  return mix(hi, lo, step(c, vec3(0.04045)));
}
vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}`;

const IN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_linearize;
out vec4 outColor;
${TRANSFER_GLSL}
void main() {
  vec4 c = texture(u_src, v_uv);
  vec3 rgb = u_linearize == 1 ? srgbToLinear(c.rgb) : c.rgb;
  outColor = vec4(rgb * c.a, c.a);
}`;

const OUT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform int u_linearize;
out vec4 outColor;
${TRANSFER_GLSL}
void main() {
  vec4 c = texture(u_src, v_uv);
  // Kernels with a hard edge undershoot — the disc's ringing dips a few
  // percent below zero just outside a sharp boundary. In colour that is
  // honest ringing, but in ALPHA it is a negative coverage, which is not
  // a meaningful value: source-over downstream would composite it as
  // anti-coverage and the divide below would flip the colour's sign.
  // Measured at 156 negative-alpha pixels on a 2-component disc before
  // this clamp. Clamp low only — HDR above 1 must pass through intact or
  // highlights stop blooming into the kernel's shape.
  float a = max(c.a, 0.0);
  // Un-premultiply. Below the epsilon there is no coverage and therefore
  // no recoverable colour; emitting black keeps the result well-defined
  // instead of amplifying filter noise by 1/tiny.
  vec3 rgb = a > 1e-5 ? max(c.rgb, 0.0) / a : vec3(0.0);
  if (u_linearize == 1) rgb = linearToSrgb(rgb);
  outColor = vec4(rgb, a);
}`;

function runBoundary(
  ctx: RenderContext,
  key: string,
  src: ImageValue,
  fragSrc: string,
  linearize: boolean
): ImageValue {
  const out = ctx.allocImage({ width: src.width, height: src.height });
  const prog = ctx.getShader(key, fragSrc);
  ctx.drawFullscreen(prog, out, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_linearize"), linearize ? 1 : 0);
  });
  return out;
}

/** Straight sRGB → premultiplied linear. Caller owns the returned image. */
export function boundaryIn(
  ctx: RenderContext,
  src: ImageValue,
  linearize: boolean
): ImageValue {
  return runBoundary(ctx, "convolve/boundary-in", src, IN_FS, linearize);
}

/** Premultiplied linear → straight sRGB. Caller owns the returned image. */
export function boundaryOut(
  ctx: RenderContext,
  src: ImageValue,
  linearize: boolean
): ImageValue {
  return runBoundary(ctx, "convolve/boundary-out", src, OUT_FS, linearize);
}
