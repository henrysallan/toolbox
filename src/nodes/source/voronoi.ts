import type { ImageValue, NodeDefinition, UvValue } from "@/engine/types";
import {
  disposePlaceholderTex,
  getPlaceholderTex,
} from "@/engine/placeholder-tex";

// Worley/Voronoi noise. Computes the distance to the nearest (F1) and
// second-nearest (F2) feature point on a hashed 2D lattice and exposes
// several output modes:
//
//   f1            — distance to nearest, classic "cell" gradient
//   f2-f1         — Voronoi edges (the "fence" between cells)
//   f2            — distance to second-nearest
//   cells         — random color per cell (cell-id colorization)
//   position      — feature-point UV packed into RG (compatible with Displace)
//
// Distance metrics: euclidean, manhattan (L1), chebyshev (L∞), and a
// general Minkowski-N (interpolates smoothly between L1, L2, L∞ as the
// N exponent varies).
//
// W (4D evolution) uses the same slice-blend trick as the noise node:
// hash W to far-away XY offsets per integer slice and smoothstep-blend
// between adjacent slices — visually equivalent to true 4D Voronoi but
// works on the existing 2D function unchanged.
//
// Optional warp-field input (image): sampled per-pixel and mapped
// through `warp_lo` / `warp_hi` to scale the local sample position.
// This *warps* the lattice — neighboring pixels read into different
// cell positions — rather than placing more feature points in bright
// regions. For true variable-density (more cells in bright areas)
// see the Fracture node, which generates a non-uniform point set.

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;

uniform int   u_mode;            // 0=f1, 1=f2-f1, 2=f2, 3=cells, 4=position
uniform int   u_metric;          // 0=euclidean, 1=manhattan, 2=chebyshev, 3=minkowski
uniform float u_minkowskiN;
uniform float u_scale;
uniform float u_jitter;
uniform vec2  u_offset;
uniform float u_seed;
uniform float u_contrast;
uniform float u_falloff;         // shapes the f1 distance curve
uniform float u_w;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform float u_alpha;
uniform float u_invert;          // 0 or 1

uniform int       u_hasWarp;
uniform sampler2D u_warpTex;
uniform float     u_warpLo;
uniform float     u_warpHi;

uniform int       u_hasUvIn;
uniform sampler2D u_uvIn;
uniform vec2      u_uvConst;

out vec4 outColor;

// ---- hashing ---------------------------------------------------------
// 2D-to-2D hash for feature-point jitter. Spectral properties matter
// less here than for gradient noise; simple sin-based hash is fine.
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

vec3 hash23(vec2 p) {
  // Three independent channels for cell-id colorization. Independent
  // dot products keep the channels uncorrelated.
  return fract(sin(vec3(
    dot(p, vec2(127.1, 311.7)),
    dot(p, vec2(269.5, 183.3)),
    dot(p, vec2(419.2, 371.9))
  )) * 43758.5453123);
}

vec2 hashOffset(float wi) {
  if (wi == 0.0) return vec2(0.0);
  return vec2(
    fract(sin(wi * 12.9898) * 43758.5453),
    fract(sin(wi * 78.2330) * 43758.5453)
  ) * 1000.0;
}

// ---- distance metrics -----------------------------------------------
float dist(vec2 a, vec2 b) {
  vec2 d = abs(a - b);
  if (u_metric == 0) return length(d);
  if (u_metric == 1) return d.x + d.y;
  if (u_metric == 2) return max(d.x, d.y);
  // Minkowski with exponent N. Clamp to avoid pow(0, *) edge cases.
  float n = max(u_minkowskiN, 0.1);
  return pow(pow(d.x, n) + pow(d.y, n), 1.0 / n);
}

// ---- core voronoi ----------------------------------------------------
// Returns f1, f2, and the integer cell of the nearest feature point.
// Searches a 3×3 neighborhood — sufficient for jitter ≤ 1.0.
struct Voro {
  float f1;
  float f2;
  vec2  cell;       // integer cell of nearest feature
  vec2  pos;        // world-space position of nearest feature
};

Voro voronoiAt(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;

  Voro v;
  v.f1 = 1e9;
  v.f2 = 1e9;
  v.cell = i;
  v.pos = i;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = i + vec2(float(x), float(y));
      // Seed-shift the hash so changing seed completely re-rolls the
      // feature point pattern.
      vec2 h = hash22(cell + vec2(u_seed * 13.7, u_seed * 91.3));
      vec2 fp = cell + 0.5 + (h - 0.5) * u_jitter;
      float d = dist(p, fp);
      if (d < v.f1) {
        v.f2 = v.f1;
        v.f1 = d;
        v.cell = cell;
        v.pos = fp;
      } else if (d < v.f2) {
        v.f2 = d;
      }
    }
  }
  return v;
}

// W-blended sampler. Adds a hashed XY offset per integer slice and
// smoothstep-blends to the next slice. The cell field becomes a
// smooth "morph through 4D" rather than a static lattice.
Voro voronoi(vec2 p) {
  float wi = floor(u_w);
  float wf = u_w - wi;
  wf = wf * wf * (3.0 - 2.0 * wf);
  vec2 o0 = hashOffset(wi);
  Voro a = voronoiAt(p + o0);
  if (wf == 0.0) return a;
  vec2 o1 = hashOffset(wi + 1.0);
  Voro b = voronoiAt(p + o1);
  // Blending two distance values is well-defined; cell ids cross
  // discontinuously at wf=0.5, which matches what real 4D Voronoi
  // would do at slice transitions anyway.
  Voro v;
  v.f1 = mix(a.f1, b.f1, wf);
  v.f2 = mix(a.f2, b.f2, wf);
  v.cell = (wf < 0.5) ? a.cell : b.cell;
  v.pos = mix(a.pos, b.pos, wf);
  return v;
}

// ---- main ------------------------------------------------------------
void main() {
  vec2 uv;
  if (u_hasUvIn == 1) uv = texture(u_uvIn, v_uv).rg;
  else if (u_hasUvIn == 2) uv = u_uvConst;
  else uv = v_uv;

  // Warp modulation. The field is sampled at the current uv and
  // remapped via [lo, hi] into a per-pixel multiplier on the sample
  // position. Because the multiplier varies per pixel, this *warps*
  // the cell lattice rather than redistributing cells — for a real
  // variable-density layout reach for the Fracture node instead. We
  // sample luminance via a standard Rec.709 weighting so colored
  // fields work too.
  float warpScale = 1.0;
  if (u_hasWarp == 1) {
    vec3 dRgb = texture(u_warpTex, v_uv).rgb;
    float lum = dot(dRgb, vec3(0.2126, 0.7152, 0.0722));
    warpScale = mix(u_warpLo, u_warpHi, lum);
  }

  vec2 seedOffset = vec2(u_seed * 127.1, u_seed * 311.7);
  vec2 p = (uv - 0.5) * (u_scale * warpScale) + u_offset + seedOffset;

  Voro v = voronoi(p);

  // Output modes.
  vec3 rgb;
  if (u_mode == 4) {
    // Position mode: pack the feature-point's world position into RG
    // with the standard 0.5-centered encoding so a downstream Displace
    // (channel R/G) reads it as a signed vector relative to the center
    // of its lattice cell.
    vec2 rel = v.pos - floor(v.pos);
    rgb = vec3(rel, 0.0);
    outColor = vec4(rgb, u_alpha);
    return;
  }

  float t;
  if (u_mode == 0) {
    // Curve the F1 distance with the falloff power for finer shaping.
    // <1 sharpens (compresses near zero), >1 softens (stretches the
    // bowl out) without changing the topology.
    t = pow(clamp(v.f1, 0.0, 1.0), max(u_falloff, 0.001));
  } else if (u_mode == 1) {
    t = clamp(v.f2 - v.f1, 0.0, 1.0);
    t = pow(t, max(u_falloff, 0.001));
  } else if (u_mode == 2) {
    t = pow(clamp(v.f2, 0.0, 1.0), max(u_falloff, 0.001));
  } else {
    // Cell id mode. Colorize each cell with a random RGB triple and
    // ignore color A/B so the user can tell at a glance which mode
    // they're in.
    vec3 cellColor = hash23(v.cell + vec2(u_seed * 13.7, u_seed * 91.3));
    rgb = cellColor;
    if (u_invert > 0.5) rgb = 1.0 - rgb;
    rgb = clamp(0.5 + (rgb - 0.5) * u_contrast, 0.0, 1.0);
    outColor = vec4(rgb, u_alpha);
    return;
  }

  if (u_invert > 0.5) t = 1.0 - t;
  t = clamp(0.5 + (t - 0.5) * u_contrast, 0.0, 1.0);
  outColor = vec4(mix(u_colorA, u_colorB, t), u_alpha);
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

const VORONOI_MODES = ["f1", "f2-f1", "f2", "cells", "position"] as const;
const METRICS = ["euclidean", "manhattan", "chebyshev", "minkowski"] as const;

function modeToInt(m: string): number {
  switch (m) {
    case "f1": return 0;
    case "f2-f1": return 1;
    case "f2": return 2;
    case "cells": return 3;
    case "position": return 4;
    default: return 0;
  }
}

function metricToInt(m: string): number {
  switch (m) {
    case "euclidean": return 0;
    case "manhattan": return 1;
    case "chebyshev": return 2;
    case "minkowski": return 3;
    default: return 0;
  }
}

export const voronoiNode: NodeDefinition = {
  type: "voronoi",
  name: "Voronoi",
  category: "image",
  subcategory: "generator",
  description:
    "Worley/Voronoi cell noise with multiple output modes (F1, F2-F1, F2, cell-id, feature position) and selectable distance metric. Optional warp-field input distorts the cell lattice. For variable-density placement (more cells where an image is bright) use the Fracture node.",
  backend: "webgl2",
  inputs: [
    { name: "uv_in", label: "UV", type: "uv", required: false },
    { name: "warp", label: "Warp", type: "image", required: false },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: VORONOI_MODES as unknown as string[],
      default: "f2-f1",
    },
    {
      name: "metric",
      label: "Distance metric",
      type: "enum",
      options: METRICS as unknown as string[],
      default: "euclidean",
    },
    {
      name: "minkowski_n",
      label: "Minkowski N",
      type: "scalar",
      min: 0.1,
      max: 16,
      step: 0.05,
      default: 2,
      visibleIf: (p) => p.metric === "minkowski",
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0.5,
      max: 80,
      softMax: 30,
      step: 0.1,
      default: 8,
    },
    {
      name: "jitter",
      label: "Jitter",
      type: "scalar",
      // 0 = perfect grid, 1 = full random within the cell. >1 spills
      // into neighbors and starts breaking the 3×3 search guarantee,
      // so cap at 1.
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
    {
      name: "falloff",
      label: "Falloff",
      type: "scalar",
      // Power curve on the f1/f2 distance. <1 sharpens, >1 softens.
      min: 0.1,
      max: 8,
      softMax: 4,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "cells" && p.mode !== "position",
    },
    {
      name: "contrast",
      label: "Contrast",
      type: "scalar",
      min: 0.1,
      max: 5,
      step: 0.01,
      default: 1,
      visibleIf: (p) => p.mode !== "position",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
      visibleIf: (p) => p.mode !== "position",
    },
    {
      name: "offset_x",
      label: "Offset X",
      type: "scalar",
      min: -50,
      max: 50,
      step: 0.01,
      default: 0,
    },
    {
      name: "offset_y",
      label: "Offset Y",
      type: "scalar",
      min: -50,
      max: 50,
      step: 0.01,
      default: 0,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
    // 4D evolution. Slice-blend through hashed XY offsets for smooth
    // morphing across all modes. Connect Scene Time to animate.
    {
      name: "w",
      label: "W (Evolution)",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 10,
      step: 0.01,
      default: 0,
    },
    // Warp-field range. When the warp input is connected, the
    // per-pixel luminance is mapped through [lo, hi] and multiplied
    // into the sample scale. Because the multiplier varies per
    // pixel, this distorts the cell lattice (more like a lens than
    // a true density change).
    {
      name: "warp_lo",
      label: "Warp (dark)",
      type: "scalar",
      min: 0.1,
      max: 8,
      step: 0.01,
      default: 0.5,
    },
    {
      name: "warp_hi",
      label: "Warp (bright)",
      type: "scalar",
      min: 0.1,
      max: 8,
      step: 0.01,
      default: 2,
    },
    {
      name: "color_a",
      label: "Color A (low)",
      type: "color",
      default: "#000000",
      visibleIf: (p) => p.mode !== "cells" && p.mode !== "position",
    },
    {
      name: "color_b",
      label: "Color B (high)",
      type: "color",
      default: "#ffffff",
      visibleIf: (p) => p.mode !== "cells" && p.mode !== "position",
    },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const output = ctx.allocImage();
    const mode = modeToInt((params.mode as string) ?? "f2-f1");
    const metric = metricToInt((params.metric as string) ?? "euclidean");
    const minkowskiN = (params.minkowski_n as number) ?? 2;
    const scale = (params.scale as number) ?? 8;
    const jitter = Math.max(0, Math.min(1, (params.jitter as number) ?? 1));
    const falloff = (params.falloff as number) ?? 1;
    const contrast = (params.contrast as number) ?? 1;
    const invert = (params.invert as boolean) ? 1 : 0;
    const offX = (params.offset_x as number) ?? 0;
    const offY = (params.offset_y as number) ?? 0;
    const seed = (params.seed as number) ?? 0;
    const w = (params.w as number) ?? 0;
    const warpLo = (params.warp_lo as number) ?? 0.5;
    const warpHi = (params.warp_hi as number) ?? 2;
    const [ar, ag, ab] = hexToRgb((params.color_a as string) ?? "#000000");
    const [br, bg, bb] = hexToRgb((params.color_b as string) ?? "#ffffff");
    const alpha = (params.alpha as number) ?? 1;

    // Optional UV input — same protocol as the noise node.
    const uvIn = inputs.uv_in;
    const uvKey = `voronoi:${nodeId}:uvzero`;
    let uvInMode = 0;
    let uvInTex: WebGLTexture = getPlaceholderTex(ctx.gl, ctx.state, uvKey);
    let uvConst: [number, number] = [0, 0];
    if (uvIn) {
      if (uvIn.kind === "uv") {
        uvInMode = 1;
        uvInTex = (uvIn as UvValue).texture;
      } else if (uvIn.kind === "scalar") {
        uvInMode = 2;
        uvConst = [uvIn.value, uvIn.value];
      }
    }

    // Optional warp-field input. Only the `image` kind is honored;
    // anything else is silently ignored and warp is disabled.
    const warpIn = inputs.warp;
    const warpKey = `voronoi:${nodeId}:warpzero`;
    let hasWarp = 0;
    let warpTex: WebGLTexture = getPlaceholderTex(
      ctx.gl,
      ctx.state,
      warpKey
    );
    if (warpIn && warpIn.kind === "image") {
      hasWarp = 1;
      warpTex = (warpIn as ImageValue).texture;
    }

    const prog = ctx.getShader("voronoi/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), mode);
      gl.uniform1i(gl.getUniformLocation(prog, "u_metric"), metric);
      gl.uniform1f(gl.getUniformLocation(prog, "u_minkowskiN"), minkowskiN);
      gl.uniform1f(gl.getUniformLocation(prog, "u_scale"), scale);
      gl.uniform1f(gl.getUniformLocation(prog, "u_jitter"), jitter);
      gl.uniform2f(gl.getUniformLocation(prog, "u_offset"), offX, offY);
      gl.uniform1f(gl.getUniformLocation(prog, "u_seed"), seed);
      gl.uniform1f(gl.getUniformLocation(prog, "u_contrast"), contrast);
      gl.uniform1f(gl.getUniformLocation(prog, "u_falloff"), falloff);
      gl.uniform1f(gl.getUniformLocation(prog, "u_w"), w);
      gl.uniform1f(gl.getUniformLocation(prog, "u_invert"), invert);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorA"), ar, ag, ab);
      gl.uniform3f(gl.getUniformLocation(prog, "u_colorB"), br, bg, bb);
      gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), alpha);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, uvInTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_uvIn"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasUvIn"), uvInMode);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_uvConst"),
        uvConst[0],
        uvConst[1]
      );

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, warpTex);
      gl.uniform1i(gl.getUniformLocation(prog, "u_warpTex"), 1);
      gl.uniform1i(gl.getUniformLocation(prog, "u_hasWarp"), hasWarp);
      gl.uniform1f(gl.getUniformLocation(prog, "u_warpLo"), warpLo);
      gl.uniform1f(gl.getUniformLocation(prog, "u_warpHi"), warpHi);
    });

    return { primary: output };
  },

  dispose(ctx, nodeId) {
    disposePlaceholderTex(ctx.gl, ctx.state, `voronoi:${nodeId}:uvzero`);
    disposePlaceholderTex(ctx.gl, ctx.state, `voronoi:${nodeId}:warpzero`);
  },
};
