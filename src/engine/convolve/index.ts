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

import { rasterizeAperture, rasterizeDisc, type ApertureShape } from "./kernels";
import { decomposeKernel, type SeparableTerm } from "./svd";

export type { BokehShape } from "./complex";
export { MAX_BOKEH_COMPONENTS } from "./complex";
export type { ApertureShape } from "./kernels";

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

/**
 * A component is one pass group. Two kinds, because the two
 * decompositions genuinely have different structure and pretending
 * otherwise would cost passes:
 *
 * `complex` — the circularly-symmetric family. Its kernel is EVEN, so
 *   taps are stored as a half table and mirrored, and the recombination
 *   folds into the vertical pass: 2 horizontal + 1 vertical.
 *
 * `separable` — one rank-1 SVD term. Arbitrary kernels are not even, so
 *   taps are a full table with no mirroring, and it is a plain real
 *   convolution: 1 horizontal + 1 vertical.
 */
export type ComponentPass =
  | {
      kind: "complex";
      /** RGBA half-tap table — see buildComplexWeights for the layout. */
      weights: Float32Array;
      halfTaps: number;
      /** Imaginary part is identically zero (the Gaussian): skip a pass. */
      realOnly: boolean;
    }
  | {
      kind: "separable";
      /** Full tap table, length 2·halfTaps+1, .x = horizontal, .y = vertical. */
      weights: Float32Array;
      halfTaps: number;
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

// One shader for both axes of a rank-1 SVD term. No mirroring (arbitrary
// kernels are not even) and no complex arithmetic, so it is a plain
// weighted tap sum with an optional accumulate.
const SVD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_prev;
uniform sampler2D u_w;
uniform vec2 u_dir;
uniform vec2 u_texel;
uniform vec2 u_wsel;      // (1,0) = horizontal factor, (0,1) = vertical
uniform int u_taps;       // 2*half + 1
uniform int u_half;
uniform float u_stride;
uniform int u_hasPrev;
out vec4 outColor;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_HALF_TAPS * 2 + 1}; i++) {
    if (i >= u_taps) break;
    float w = dot(texelFetch(u_w, ivec2(i, 0), 0).xy, u_wsel);
    float off = float(i - u_half) * u_stride;
    acc += texture(u_src, v_uv + u_dir * u_texel * off) * w;
  }
  if (u_hasPrev == 1) acc += texture(u_prev, v_uv);
  outColor = acc;
}`;

// Box downsample used to turn a canvas-sized kernel IMAGE into a small
// kernel matrix. A single bilinear fetch would undersample badly — the
// kernel is being reduced by a factor of ~10, so most of the source would
// simply not be looked at.
const KERNEL_SAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_footprint;   // 1 / output size, in source UV
uniform int u_samples;
out vec4 outColor;
void main() {
  vec4 acc = vec4(0.0);
  float n = float(u_samples);
  for (int j = 0; j < 8; j++) {
    if (j >= u_samples) break;
    for (int i = 0; i < 8; i++) {
      if (i >= u_samples) break;
      vec2 o = (vec2(float(i), float(j)) + 0.5) / n - 0.5;
      acc += texture(u_src, v_uv + o * u_footprint);
    }
  }
  outColor = acc / (n * n);
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

  const svdProg = ctx.getShader("convolve/svd", SVD_FS);

  for (const comp of plan.components) {
    if (comp.kind === "separable") {
      // One rank-1 term: horizontal with the .x factor, vertical with .y,
      // accumulating into the running total. No mirroring, no complex
      // arithmetic — 2 passes instead of 3.
      const taps = comp.halfTaps * 2 + 1;
      const wTex = ctx.uploadFloat32ToImage(comp.weights, taps, 1);
      const mid = ctx.allocImage({ width, height });
      const prevS = accum;
      const setup =
        (
          srcTex: WebGLTexture,
          dir: [number, number],
          sel: [number, number],
          prevTex: WebGLTexture | null
        ) =>
        (gl: WebGL2RenderingContext) => {
          bindTex(gl, svdProg, "u_src", 0, srcTex);
          bindTex(gl, svdProg, "u_w", 1, wTex.texture);
          bindTex(gl, svdProg, "u_prev", 2, prevTex ?? srcTex);
          gl.uniform2f(gl.getUniformLocation(svdProg, "u_dir"), dir[0], dir[1]);
          gl.uniform2f(
            gl.getUniformLocation(svdProg, "u_texel"),
            texel[0],
            texel[1]
          );
          gl.uniform2f(gl.getUniformLocation(svdProg, "u_wsel"), sel[0], sel[1]);
          gl.uniform1i(gl.getUniformLocation(svdProg, "u_taps"), taps);
          gl.uniform1i(gl.getUniformLocation(svdProg, "u_half"), comp.halfTaps);
          gl.uniform1f(gl.getUniformLocation(svdProg, "u_stride"), plan.stride);
          gl.uniform1i(
            gl.getUniformLocation(svdProg, "u_hasPrev"),
            prevTex ? 1 : 0
          );
        };

      ctx.drawFullscreen(svdProg, mid, setup(work.texture, [1, 0], [1, 0], null));
      const nextS = ctx.allocImage({ width, height });
      ctx.drawFullscreen(
        svdProg,
        nextS,
        setup(mid.texture, [0, 1], [0, 1], prevS?.texture ?? null)
      );

      ctx.releaseTexture(mid.texture);
      ctx.releaseTexture(wTex.texture);
      if (prevS) ctx.releaseTexture(prevS.texture);
      accum = nextS;
      continue;
    }

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
        kind: "complex",
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
      kind: "complex" as const,
      weights,
      halfTaps,
      realOnly: false,
    })),
    stride: radius / halfTaps,
    radiusSource: { kind: "uniform", radius },
    linearize,
  };
}

// Kernel matrices are square and odd-sized. Cap well below the separable
// tap ceiling: the SVD is O(rank·n²) on the CPU and the visual return
// above ~65 flattens out.
const MAX_KERNEL_HALF = 32;

function kernelHalf(radius: number): number {
  return Math.min(MAX_KERNEL_HALF, Math.max(1, Math.ceil(radius)));
}

/** Turn a decomposed kernel into a plan. Shared by the aperture and image paths. */
function planFromTerms(
  terms: SeparableTerm[],
  half: number,
  radius: number,
  linearize: boolean
): SeparablePlan {
  return {
    components: terms.map((t) => {
      // Interleave the two factors into one RGBA table so a term needs a
      // single weights texture: .x horizontal, .y vertical.
      const packed = new Float32Array((half * 2 + 1) * 4);
      for (let i = 0; i < half * 2 + 1; i++) {
        packed[i * 4] = t.h[i];
        packed[i * 4 + 1] = t.v[i];
      }
      return { kind: "separable" as const, weights: packed, halfTaps: half };
    }),
    stride: radius / half,
    radiusSource: { kind: "uniform", radius },
    linearize,
  };
}

/**
 * Polygonal / non-circular bokeh apertures. Rasterized on the CPU and
 * decomposed — these shapes are not circularly symmetric, so the complex
 * phasor path in complex.ts cannot express them.
 */
export function aperturePlan(
  radius: number,
  shape: ApertureShape,
  rank: number,
  rotation: number,
  linearize: boolean
): SeparablePlan {
  const half = kernelHalf(radius);
  const size = half * 2 + 1;
  const key = `${shape}:${size}:${rotation.toFixed(2)}:${rank}`;
  let terms = apertureCache.get(key);
  if (!terms) {
    terms = decomposeKernel(
      rasterizeAperture(shape, size, rotation),
      size,
      rank,
      true
    );
    apertureCache.set(key, terms);
  }
  return planFromTerms(terms, half, radius, linearize);
}

const apertureCache = new Map<string, SeparableTerm[]>();

// Keyed on the kernel ImageValue OBJECT, which the devguide sanctions as
// the "upstream recomputed" signal — so a static kernel pays the GPU
// readback and the SVD exactly once, not per evaluation.
const imageKernelCache = new WeakMap<
  object,
  { key: string; terms: SeparableTerm[] }
>();

/**
 * Convolve by an arbitrary kernel image.
 *
 * The WHOLE kernel image becomes the kernel — drop in a photographed
 * aperture, an anamorphic slit, a diffraction star, and it is used as
 * framed. `radius` sets how far that kernel reaches, exactly as it does
 * for the other modes, so switching modes does not change the blur's
 * apparent size.
 */
export function convolvePlan(
  ctx: RenderContext,
  kernel: ImageValue | null,
  radius: number,
  rank: number,
  normalize: boolean,
  linearize: boolean
): SeparablePlan {
  const half = kernelHalf(radius);
  const size = half * 2 + 1;
  const key = `${size}:${rank}:${normalize}`;

  if (!kernel) {
    // No kernel wired — fall back to a plain disc so the node does
    // something legible instead of nothing.
    const fbKey = `__disc__:${key}`;
    let terms = apertureCache.get(fbKey);
    if (!terms) {
      terms = decomposeKernel(rasterizeDisc(size), size, rank, normalize);
      apertureCache.set(fbKey, terms);
    }
    return planFromTerms(terms, half, radius, linearize);
  }

  const cached = imageKernelCache.get(kernel);
  if (cached && cached.key === key) {
    return planFromTerms(cached.terms, half, radius, linearize);
  }

  const matrix = sampleKernelImage(ctx, kernel, size);
  const terms = decomposeKernel(matrix, size, rank, normalize);
  imageKernelCache.set(kernel, { key, terms });
  return planFromTerms(terms, half, radius, linearize);
}

/**
 * Reduce a canvas-sized kernel image to a `size`×`size` screen-order
 * matrix: GPU box-downsample, then one small readback.
 *
 * Weighting is luminance × alpha, matching the engine's image→mask
 * convention — so a kernel drawn on transparency contributes by its
 * silhouette rather than by whatever RGB sits in the cleared surround.
 */
function sampleKernelImage(
  ctx: RenderContext,
  kernel: ImageValue,
  size: number
): Float64Array {
  const small = ctx.allocImage({ width: size, height: size });
  const prog = ctx.getShader("convolve/kernel-sample", KERNEL_SAMPLE_FS);
  ctx.drawFullscreen(prog, small, (gl) => {
    bindTex(gl, prog, "u_src", 0, kernel.texture);
    gl.uniform2f(gl.getUniformLocation(prog, "u_footprint"), 1 / size, 1 / size);
    gl.uniform1i(gl.getUniformLocation(prog, "u_samples"), 4);
  });
  const px = ctx.readImageToFloat32(small);
  ctx.releaseTexture(small.texture);

  const out = new Float64Array(size * size);
  for (let row = 0; row < size; row++) {
    // readImageToFloat32 returns rows bottom-first (GL order); the matrix
    // is screen order, so flip. decomposeKernel's tap conversion assumes
    // row 0 = top.
    const srcRow = size - 1 - row;
    for (let col = 0; col < size; col++) {
      const i = (srcRow * size + col) * 4;
      const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      out[row * size + col] = Math.max(0, lum * px[i + 3]);
    }
  }
  return out;
}
