// Multigrid Poisson / Laplace solver over pool textures.
//
// Solves ∆I = rhs with Dirichlet constraints (I = color where mask says
// so) and Neumann (clamped-fetch) boundaries at the grid edges, per
// channel on RGBA — the steady-state "diffusion" of the constraint
// colors. Built for the Diffusion Curves node (072726_diffusion-curves.md,
// Orzan et al. 2008) but deliberately generic: any node that wants
// harmonic interpolation of sparse constraints (Poisson image editing,
// gradient-domain tricks, blur-map diffusion) can call it.
//
// Method: cascadic multigrid, the paper's schedule. Constraints are
// restricted down a pyramid (mask-weighted 2×2 average for color, plain
// average for mask coverage, 2×2 SUM for the rhs — the h² scaling of the
// 5-point-stencil right-hand side when the grid coarsens), then the
// solution runs coarsest → finest with `5·(k+1)·quality` Jacobi
// iterations at level k (fine = 0), bilinear-prolongating each level's
// result as the next finer level's initial guess. Low frequencies
// converge on the cheap coarse grids; the fine grids only sharpen.
//
// The rhs convention: values are h²·f at the PROBLEM's grid spacing
// (h = 1 in problem pixels), i.e. exactly what a backward-difference
// divergence of a rasterized gradient field produces. Jacobi update:
// I = (ΣI_neighbors − rhs) / 4, matching the fluid sim's pressure solve.
//
// All pyramid intermediates are pool allocs released before return. The
// caller keeps ownership of the three input textures and RECEIVES
// ownership of the returned image (same size as `color`) — release it
// via ctx.releaseTexture when done.

import type { ImageValue, RenderContext } from "./types";

export interface PoissonProblem {
  // Dirichlet constraint values (any subset of RGBA channels).
  color: ImageValue;
  // .r = constraint coverage: 1 on constrained pixels, 0 elsewhere
  // (fractional at coarse levels; a texel is treated as constrained
  // when coverage ≥ 0.25).
  mask: ImageValue;
  // Optional right-hand side, h²·∆I per channel at the problem grid
  // (e.g. div of a rasterized gradient field). Omitted → Laplace.
  rhs?: ImageValue;
}

export interface PoissonOptions {
  // Jacobi iteration multiplier. 1 is the paper's realtime schedule;
  // default 2. Clamped to [0.25, 8].
  quality?: number;
  // Stop coarsening when min(w, h) reaches this (default 16).
  minSize?: number;
}

const RESTRICT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_color;
uniform sampler2D u_mask;
uniform sampler2D u_rhs;
uniform ivec2 u_fineSize;
uniform int u_mode; // 0 = color (mask-weighted avg), 1 = mask (avg), 2 = rhs (sum)
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) * 2;
  vec4 acc = vec4(0.0);
  float w = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    ivec2 f = clamp(c + ivec2(i, j), ivec2(0), u_fineSize - 1);
    if (u_mode == 0) {
      float m = texelFetch(u_mask, f, 0).r;
      acc += texelFetch(u_color, f, 0) * m;
      w += m;
    } else if (u_mode == 1) {
      w += texelFetch(u_mask, f, 0).r;
    } else {
      acc += texelFetch(u_rhs, f, 0);
    }
  }
  if (u_mode == 0) outColor = w > 1e-4 ? acc / w : vec4(0.0);
  else if (u_mode == 1) outColor = vec4(w * 0.25, 0.0, 0.0, 1.0);
  else outColor = acc;
}`;

const JACOBI_FS = `#version 300 es
precision highp float;
uniform sampler2D u_sol;
uniform sampler2D u_color;
uniform sampler2D u_mask;
uniform sampler2D u_rhs;
uniform ivec2 u_size;
uniform int u_hasRhs;
out vec4 outColor;
ivec2 cc(ivec2 c) { return clamp(c, ivec2(0), u_size - 1); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (texelFetch(u_mask, c, 0).r >= 0.25) {
    outColor = texelFetch(u_color, c, 0);
    return;
  }
  vec4 s = texelFetch(u_sol, cc(c + ivec2(1, 0)), 0)
         + texelFetch(u_sol, cc(c - ivec2(1, 0)), 0)
         + texelFetch(u_sol, cc(c + ivec2(0, 1)), 0)
         + texelFetch(u_sol, cc(c - ivec2(0, 1)), 0);
  vec4 r = u_hasRhs == 1 ? texelFetch(u_rhs, c, 0) : vec4(0.0);
  outColor = (s - r) * 0.25;
}`;

// Plain LINEAR resample — prolongation between levels AND the exact
// same-size copy (texel centers map to texel centers at equal sizes).
const RESAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texture(u_src, v_uv); }`;

// LINEAR-resample src into dst (sizes may differ). Exported for callers
// that need the half-res-solve → canvas upsample without their own copy
// shader.
export function resampleImage(
  ctx: RenderContext,
  src: ImageValue,
  dst: ImageValue
): void {
  const prog = ctx.getShader("poisson/resample", RESAMPLE_FS);
  ctx.drawFullscreen(prog, dst, (gl) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
  });
}

interface Level {
  w: number;
  h: number;
  color: ImageValue;
  mask: ImageValue;
  rhs: ImageValue | null;
}

export function solvePoisson(
  ctx: RenderContext,
  problem: PoissonProblem,
  opts: PoissonOptions = {}
): ImageValue {
  const quality = Math.min(8, Math.max(0.25, opts.quality ?? 2));
  const minSize = Math.max(4, opts.minSize ?? 16);
  const { color, mask } = problem;
  const rhs = problem.rhs ?? null;

  const restrictProg = ctx.getShader("poisson/restrict", RESTRICT_FS);
  const jacobiProg = ctx.getShader("poisson/jacobi", JACOBI_FS);

  // Level 0 borrows the caller's textures; deeper levels are pool allocs.
  const levels: Level[] = [
    { w: color.width, h: color.height, color, mask, rhs },
  ];
  while (
    Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) >
      minSize &&
    levels.length < 12
  ) {
    const fine = levels[levels.length - 1];
    const w = Math.max(1, Math.ceil(fine.w / 2));
    const h = Math.max(1, Math.ceil(fine.h / 2));
    const lv: Level = {
      w,
      h,
      color: ctx.allocImage({ width: w, height: h }),
      mask: ctx.allocImage({ width: w, height: h }),
      rhs: rhs ? ctx.allocImage({ width: w, height: h }) : null,
    };
    const restrict = (
      target: ImageValue,
      mode: number
    ) => {
      ctx.drawFullscreen(restrictProg, target, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fine.color.texture);
        gl.uniform1i(gl.getUniformLocation(restrictProg, "u_color"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, fine.mask.texture);
        gl.uniform1i(gl.getUniformLocation(restrictProg, "u_mask"), 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, (fine.rhs ?? fine.mask).texture);
        gl.uniform1i(gl.getUniformLocation(restrictProg, "u_rhs"), 2);
        gl.uniform2i(
          gl.getUniformLocation(restrictProg, "u_fineSize"),
          fine.w,
          fine.h
        );
        gl.uniform1i(gl.getUniformLocation(restrictProg, "u_mode"), mode);
      });
    };
    restrict(lv.color, 0);
    restrict(lv.mask, 1);
    if (lv.rhs) restrict(lv.rhs, 2);
    levels.push(lv);
  }

  // Coarsest init: the restricted constraint colors themselves (colors on
  // constrained texels, 0 elsewhere) — a better start than flat black.
  const coarsest = levels[levels.length - 1];
  let sol = ctx.allocImage({ width: coarsest.w, height: coarsest.h });
  resampleImage(ctx, coarsest.color, sol);

  for (let k = levels.length - 1; k >= 0; k--) {
    const lv = levels[k];
    if (sol.width !== lv.w || sol.height !== lv.h) {
      const up = ctx.allocImage({ width: lv.w, height: lv.h });
      resampleImage(ctx, sol, up);
      ctx.releaseTexture(sol.texture);
      sol = up;
    }
    let src = sol;
    let dst = ctx.allocImage({ width: lv.w, height: lv.h });
    const iters = Math.max(1, Math.round(5 * (k + 1) * quality));
    for (let i = 0; i < iters; i++) {
      ctx.drawFullscreen(jacobiProg, dst, (gl) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        gl.uniform1i(gl.getUniformLocation(jacobiProg, "u_sol"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lv.color.texture);
        gl.uniform1i(gl.getUniformLocation(jacobiProg, "u_color"), 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, lv.mask.texture);
        gl.uniform1i(gl.getUniformLocation(jacobiProg, "u_mask"), 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, (lv.rhs ?? lv.mask).texture);
        gl.uniform1i(gl.getUniformLocation(jacobiProg, "u_rhs"), 3);
        gl.uniform2i(gl.getUniformLocation(jacobiProg, "u_size"), lv.w, lv.h);
        gl.uniform1i(
          gl.getUniformLocation(jacobiProg, "u_hasRhs"),
          lv.rhs ? 1 : 0
        );
      });
      const t = src;
      src = dst;
      dst = t;
    }
    ctx.releaseTexture(dst.texture);
    sol = src;
  }

  for (let k = 1; k < levels.length; k++) {
    const lv = levels[k];
    ctx.releaseTexture(lv.color.texture);
    ctx.releaseTexture(lv.mask.texture);
    if (lv.rhs) ctx.releaseTexture(lv.rhs.texture);
  }
  return sol;
}
