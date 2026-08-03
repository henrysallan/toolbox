// The shared convolution core: N separable passes, weighted recombine.
//
// Every blur mode in the app compiles down to a `SeparablePlan` and runs
// through `runSeparable`. That is the whole point of the design — complex
// separable bokeh and low-rank SVD (M2) and the Gaussian are not three
// features, they are three plan builders over one execution shape:
//
//   boundary-in → for each component { H(real), H(imag), V+accumulate }
//                                                            → boundary-out
//
// Pass structure notes:
//
// * The horizontal pass runs TWICE per complex component (once for the
//   real weight, once for the imaginary) because `drawFullscreen` targets
//   a single attachment — no MRT. Each of those passes is a plain real
//   convolution, since the source is real, so the cost is 2 cheap passes
//   rather than 1 expensive complex one. Folding them into one MRT draw
//   is the obvious later optimization and needs a gl.ts change.
//
// * The vertical pass emits the component's FINAL real contribution and
//   adds the running accumulator, rather than carrying a complex result
//   forward — see the w1/w2 derivation in complex.ts. So it is one pass
//   per component, not two.
//
// * `blitToCanvas` disables GL blending and nothing here re-enables it,
//   so accumulation is explicit: the vertical pass reads the previous
//   accumulator and writes the sum into a fresh target (ping-pong).

import type { ImageValue, RenderContext } from "@/engine/types";
import { boundaryIn, boundaryOut } from "./boundary";
import {
  buildComplexWeights,
  buildGaussianWeights,
  fitComplexComponents,
  type BokehShape,
} from "./complex";

export type { BokehShape } from "./complex";
export { MAX_BOKEH_COMPONENTS } from "./complex";

// GLSL loop bounds must be compile-time constants.
const MAX_HALF_TAPS = 128;

/**
 * Where each pixel's blur radius comes from.
 *
 * The `map` arm is not constructed yet (M4 — spatially varying blur), but
 * the discriminant is in the plan from M1 deliberately: retrofitting
 * per-pixel radius through the core later would touch every plan builder
 * and both shaders at once.
 */
export type RadiusSource =
  | { kind: "uniform"; radius: number }
  | { kind: "map"; tex: WebGLTexture; min: number; max: number };

export type ComponentPass = {
  /** RGBA half-tap table — see buildComplexWeights for the layout. */
  weights: Float32Array;
  halfTaps: number;
  /** Imaginary part is identically zero (the Gaussian): skip a pass. */
  realOnly: boolean;
};

export type SeparablePlan = {
  components: ComponentPass[];
  /** Pixel distance between adjacent taps. */
  stride: number;
  radiusSource: RadiusSource;
  linearize: boolean;
};

const H_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_w;
uniform vec2 u_dir;
uniform vec2 u_texel;
uniform vec2 u_wsel;      // (1,0) = real weight, (0,1) = imaginary
uniform int u_halfTaps;
uniform float u_stride;
out vec4 outColor;
void main() {
  // The kernel is even in t, so only taps 0..halfTaps are stored and the
  // pairs are mirrored here.
  float w0 = dot(texelFetch(u_w, ivec2(0, 0), 0).xy, u_wsel);
  vec4 acc = texture(u_src, v_uv) * w0;
  for (int i = 1; i <= ${MAX_HALF_TAPS}; i++) {
    if (i > u_halfTaps) break;
    float wi = dot(texelFetch(u_w, ivec2(i, 0), 0).xy, u_wsel);
    vec2 off = u_dir * u_texel * (float(i) * u_stride);
    acc += (texture(u_src, v_uv + off) + texture(u_src, v_uv - off)) * wi;
  }
  outColor = acc;
}`;

const V_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_re;
uniform sampler2D u_im;
uniform sampler2D u_prev;
uniform sampler2D u_w;
uniform vec2 u_dir;
uniform vec2 u_texel;
uniform int u_halfTaps;
uniform float u_stride;
uniform int u_hasIm;
uniform int u_hasPrev;
out vec4 outColor;
void main() {
  // w.z / w.w already carry the A·Re + B·Im recombination, so this pass
  // emits the component's real contribution directly.
  vec4 w0 = texelFetch(u_w, ivec2(0, 0), 0);
  vec4 acc = texture(u_re, v_uv) * w0.z;
  if (u_hasIm == 1) acc += texture(u_im, v_uv) * w0.w;
  for (int i = 1; i <= ${MAX_HALF_TAPS}; i++) {
    if (i > u_halfTaps) break;
    vec4 wi = texelFetch(u_w, ivec2(i, 0), 0);
    vec2 off = u_dir * u_texel * (float(i) * u_stride);
    acc += (texture(u_re, v_uv + off) + texture(u_re, v_uv - off)) * wi.z;
    if (u_hasIm == 1) {
      acc += (texture(u_im, v_uv + off) + texture(u_im, v_uv - off)) * wi.w;
    }
  }
  if (u_hasPrev == 1) acc += texture(u_prev, v_uv);
  outColor = acc;
}`;

export const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

function bindTex(
  gl: WebGL2RenderingContext,
  prog: WebGLProgram,
  name: string,
  unit: number,
  tex: WebGLTexture | null
) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, name), unit);
}

/**
 * Run a plan over `src` and return a freshly allocated image.
 *
 * Texture discipline (devguide invariant #3): every intermediate this
 * allocates is released before returning, `src` is never released, and
 * the caller owns the result.
 */
export function runSeparable(
  ctx: RenderContext,
  src: ImageValue,
  plan: SeparablePlan
): ImageValue {
  const { width, height } = src;
  const texel: [number, number] = [1 / width, 1 / height];

  const work = boundaryIn(ctx, src, plan.linearize);

  const hProg = ctx.getShader("convolve/separable-h", H_FS);
  const vProg = ctx.getShader("convolve/separable-v", V_FS);

  let accum: ImageValue | null = null;

  for (const comp of plan.components) {
    // Weight tables are small (≤129×1) and only rebuilt when params
    // change — the node is `stable`, so compute does not run per frame.
    const wTex = ctx.uploadFloat32ToImage(comp.weights, comp.halfTaps + 1, 1);

    const hRe = ctx.allocImage({ width, height });
    ctx.drawFullscreen(hProg, hRe, (gl) => {
      bindTex(gl, hProg, "u_src", 0, work.texture);
      bindTex(gl, hProg, "u_w", 1, wTex.texture);
      gl.uniform2f(gl.getUniformLocation(hProg, "u_dir"), 1, 0);
      gl.uniform2f(gl.getUniformLocation(hProg, "u_texel"), texel[0], texel[1]);
      gl.uniform2f(gl.getUniformLocation(hProg, "u_wsel"), 1, 0);
      gl.uniform1i(gl.getUniformLocation(hProg, "u_halfTaps"), comp.halfTaps);
      gl.uniform1f(gl.getUniformLocation(hProg, "u_stride"), plan.stride);
    });

    let hIm: ImageValue | null = null;
    if (!comp.realOnly) {
      hIm = ctx.allocImage({ width, height });
      ctx.drawFullscreen(hProg, hIm, (gl) => {
        bindTex(gl, hProg, "u_src", 0, work.texture);
        bindTex(gl, hProg, "u_w", 1, wTex.texture);
        gl.uniform2f(gl.getUniformLocation(hProg, "u_dir"), 1, 0);
        gl.uniform2f(
          gl.getUniformLocation(hProg, "u_texel"),
          texel[0],
          texel[1]
        );
        gl.uniform2f(gl.getUniformLocation(hProg, "u_wsel"), 0, 1);
        gl.uniform1i(gl.getUniformLocation(hProg, "u_halfTaps"), comp.halfTaps);
        gl.uniform1f(gl.getUniformLocation(hProg, "u_stride"), plan.stride);
      });
    }

    const next = ctx.allocImage({ width, height });
    const prev = accum;
    ctx.drawFullscreen(vProg, next, (gl) => {
      bindTex(gl, vProg, "u_re", 0, hRe.texture);
      // Samplers must point at a real texture even when unread — bind the
      // real pass as a harmless stand-in rather than leaving unit 1 unset.
      bindTex(gl, vProg, "u_im", 1, (hIm ?? hRe).texture);
      bindTex(gl, vProg, "u_prev", 2, (prev ?? hRe).texture);
      bindTex(gl, vProg, "u_w", 3, wTex.texture);
      gl.uniform2f(gl.getUniformLocation(vProg, "u_dir"), 0, 1);
      gl.uniform2f(gl.getUniformLocation(vProg, "u_texel"), texel[0], texel[1]);
      gl.uniform1i(gl.getUniformLocation(vProg, "u_halfTaps"), comp.halfTaps);
      gl.uniform1f(gl.getUniformLocation(vProg, "u_stride"), plan.stride);
      gl.uniform1i(gl.getUniformLocation(vProg, "u_hasIm"), hIm ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(vProg, "u_hasPrev"), prev ? 1 : 0);
    });

    ctx.releaseTexture(hRe.texture);
    if (hIm) ctx.releaseTexture(hIm.texture);
    if (prev) ctx.releaseTexture(prev.texture);
    ctx.releaseTexture(wTex.texture);
    accum = next;
  }

  ctx.releaseTexture(work.texture);

  if (!accum) {
    // Degenerate plan (no components). Return a plain copy — NOT a
    // boundary round-trip, which would un-premultiply data that was never
    // premultiplied.
    return copyImage(ctx, src);
  }

  const out = boundaryOut(ctx, accum, plan.linearize);
  ctx.releaseTexture(accum.texture);
  return out;
}

/** Straight passthrough copy. Caller owns the result. */
export function copyImage(ctx: RenderContext, src: ImageValue): ImageValue {
  const out = ctx.allocImage({ width: src.width, height: src.height });
  const prog = ctx.getShader("convolve/copy", COPY_FS);
  ctx.drawFullscreen(prog, out, (gl) => {
    bindTex(gl, prog, "u_src", 0, src.texture);
  });
  return out;
}

// ---------------------------------------------------------------------
// Plan builders
// ---------------------------------------------------------------------

// The legacy `gaussian-blur` node capped at 64 half-taps with a unit
// pixel stride. Reproduced exactly so `mode: gaussian` matches it.
const GAUSSIAN_MAX_HALF_TAPS = 64;

/**
 * Separable Gaussian, tap-for-tap compatible with the legacy node:
 * sigma = radius/2, unit stride, ceil(3σ) half-taps capped at 64.
 */
export function gaussianPlan(radius: number, linearize: boolean): SeparablePlan {
  const sigma = radius * 0.5;
  const halfTaps = Math.min(
    GAUSSIAN_MAX_HALF_TAPS,
    Math.max(1, Math.ceil(sigma * 3))
  );
  return {
    components: [
      {
        weights: buildGaussianWeights(sigma, halfTaps),
        halfTaps,
        realOnly: true,
      },
    ],
    stride: 1,
    radiusSource: { kind: "uniform", radius },
    linearize,
  };
}

/**
 * Complex separable circular bokeh.
 *
 * Taps span the full radius rather than a fixed pixel stride, because the
 * kernel has hard support at r = radius (unlike a Gaussian's tail). Above
 * MAX_HALF_TAPS the stride exceeds 1px and the taps start to undersample;
 * bilinear filtering covers the mild case, but very large radii would be
 * better served by pre-downsampling the source — see the known
 * limitations in the spec.
 */
export function bokehPlan(
  radius: number,
  shape: BokehShape,
  components: number,
  ring: number,
  linearize: boolean
): SeparablePlan {
  const halfTaps = Math.min(MAX_HALF_TAPS, Math.max(1, Math.ceil(radius)));
  const comps = fitComplexComponents(shape, components, ring);
  const tables = buildComplexWeights(comps, halfTaps);
  return {
    components: tables.map((weights) => ({
      weights,
      halfTaps,
      realOnly: false,
    })),
    stride: radius / halfTaps,
    radiusSource: { kind: "uniform", radius },
    linearize,
  };
}
