import { bindDerived } from "@/engine/skia/scene-ir";
import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { ditherNode } from "../effect/dither";

// Dither (Skia) — the Skia-layer port of Dither's per-pixel algorithms
// (specdocs/101326_skia-target.md §3.2): `ordered` (8×8 Bayer) and
// `threshold`, black/white or per-channel levels, at any pixel scale. The
// GL node does it on the CPU over an 8-bit downsample; the port reproduces
// that pipeline per pixel so the two agree:
//   - the cell grid is round(canvas / pixel_scale) cells, row 0 at the
//     BOTTOM (the CPU pass reads the GL texture bottom-up), and every
//     pixel of a cell shows the cell (the nearest-filtered upscale);
//   - the cell's color is the source sampled LINEAR at the cell centre,
//     i.e. a bilinear blend of the four nearest source texels (four taps
//     of the upstream at texel centres), then rounded to 8 bits;
//   - the Bayer index is computed from the cell coordinates bit by bit
//     (Skia's ES2 has no bitwise ops or constant arrays);
//   - the BW / color quantization is ditherOrderedBW / ditherOrderedColor
//     / ditherThreshold* (nodes/effect/dither-algorithms.ts) on 0..255.
// Error diffusion (floyd-steinberg, atkinson, stucki, burkes, sierra,
// jarvis) is a serial scan over the whole image and has no per-pixel form:
// those algorithms are reported unsupported.

const ALGOS = ditherNode.params.find((p) => p.name === "algorithm")?.options ?? [];
const PER_PIXEL = new Set(["ordered", "threshold"]);

const DITHER_SKSL = `// BAYER8[y & 7][x & 7] from the bits of the cell coordinates: each level
// adds (2·(bx xor by) + bx) · 4^(2 − k), least significant bit weighted most.
float tbx_dither_bayer8(float x, float y) {
  x = mod(x, 8.0);
  y = mod(y, 8.0);
  float v = 0.0;
  float w = 16.0;
  for (int k = 0; k < 3; k++) {
    float bx = mod(x, 2.0);
    float by = mod(y, 2.0);
    v += (2.0 * abs(bx - by) + bx) * w;
    x = floor(x * 0.5);
    y = floor(y * 0.5);
    w *= 0.25;
  }
  return v;
}

// Source texel (ix, iy) — Y-up texel rows — clamped to the edge, as the GL
// sampler's CLAMP_TO_EDGE does.
float4 tbx_dither_texel(float ix, float iy, float2 res) {
  float2 t = clamp(float2(ix, iy), float2(0.0), res - 1.0);
  return $src((t + 0.5) / res);
}

float4 tbx_dither(float2 uv, float2 res, int algorithm, float pixel_scale, float threshold, float color_mode,
                  float levels, float2 cells) {
  // The nearest-filtered upscale: this pixel shows cell (cx, cy).
  float2 cell = min(floor(uv * cells), cells - 1.0);
  // The downsample pass samples the source LINEAR at the cell centre
  // (res / cells is exactly 1 at pixel_scale 1: one tap on the texel).
  float2 s = (cell + 0.5) * (res / cells) - 0.5;
  float2 i0 = floor(s);
  float2 f = s - i0;
  float4 c;
  if (f.x == 0.0 && f.y == 0.0) {
    c = tbx_dither_texel(i0.x, i0.y, res);
  } else {
    float4 a = mix(tbx_dither_texel(i0.x, i0.y, res), tbx_dither_texel(i0.x + 1.0, i0.y, res), f.x);
    float4 b = mix(tbx_dither_texel(i0.x, i0.y + 1.0, res), tbx_dither_texel(i0.x + 1.0, i0.y + 1.0, res), f.x);
    c = mix(a, b, f.y);
  }
  // The RGBA8 target the CPU pass reads back.
  float4 px = floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5);
  float L = clamp(floor(levels + 0.5), 2.0, 8.0);
  float stepv = 255.0 / (L - 1.0);
  float bayer = algorithm == ${ALGOS.indexOf("ordered")} ? tbx_dither_bayer8(cell.x, cell.y) / 64.0 - 0.5 : 0.0;
  float3 rgb;
  if (color_mode > 0.5) {
    float3 v = px.rgb + bayer * stepv;
    rgb = clamp(floor(floor(v / stepv + 0.5) * stepv + 0.5), 0.0, 255.0);
  } else {
    float gray = 0.299 * px.r + 0.587 * px.g + 0.114 * px.b;
    float v = gray + bayer * (255.0 - threshold) < threshold ? 0.0 : 255.0;
    rgb = float3(v);
  }
  return float4(rgb, px.a) / 255.0;
}`;

// round(canvas / pixel_scale) cells per axis, at least 1 — the GL node's
// downsample size (pixel_scale rounded, at least 1).
export function ditherCells(width: number, height: number, pixelScale: unknown): [number, number] {
  const ps = Math.max(1, Math.round(typeof pixelScale === "number" && Number.isFinite(pixelScale) ? pixelScale : 1));
  return [Math.max(1, Math.round(width / ps)), Math.max(1, Math.round(height / ps))];
}

export const skiaDitherNode = defineSkslNode({
  type: "skia-dither",
  name: "Dither (Skia)",
  mirrors: "dither",
  subcategory: "modifier",
  description:
    "Skia-layer Dither: ordered (8×8 Bayer) or threshold quantization to black/white or per-channel levels, at a pixel scale, fused into the layer's runtime shader. Same params as Dither; the error-diffusion algorithms have no per-pixel form and are reported unsupported.",
  searchAliases: ["dither", "bayer", "ordered dither", "1-bit", "skia", "sksl"],
  facts: {
    gotchas: [
      "Only algorithm=ordered and threshold are ported; the error-diffusion algorithms (the default floyd-steinberg included) emit transparent and report it.",
      "pixel_scale makes round(canvas/pixel_scale) blocky cells, Bayer rows counted from the bottom, each the source sampled bilinearly at its centre.",
      "color_mode=false thresholds Rec. 601 gray (0..255) against threshold; color_mode=true quantizes each channel to levels steps and ignores threshold.",
      "The source is read 1 tap per cell centre when it lands on a texel, else 4 (bilinear). Unwired, the output is opaque black like Dither's.",
    ],
  },
  fn: {
    id: "tbx.dither@1",
    entry: "tbx_dither",
    source: DITHER_SKSL,
    params: [
      { name: "algorithm", type: "int" },
      { name: "pixel_scale", type: "float" },
      { name: "threshold", type: "float" },
      { name: "color_mode", type: "float" },
      { name: "levels", type: "float" },
      { name: "cells", type: "float2" },
    ],
    inputs: [{ name: "src", mode: "gather", taps: 4 }],
    cost: 0.5,
  },
  params: mirrorParams(ditherNode, ["algorithm", "pixel_scale", "threshold", "spread", "color_mode", "levels"]),
  inputs: [{ name: "image", fnInput: "src" }],
  // The cell grid depends on the canvas size as well as pixel_scale.
  binds: ({ params, nodeId, ctx }) => ({
    cells: bindDerived(ditherCells(ctx.width, ctx.height, params.pixel_scale), [{ node: nodeId, param: "pixel_scale" }]),
  }),
  whenUnwired: () => [0, 0, 0, 1],
  unsupported(params) {
    const algo = typeof params.algorithm === "string" ? params.algorithm : "floyd-steinberg";
    return PER_PIXEL.has(algo)
      ? []
      : [`Dither (Skia) ports the per-pixel algorithms only (ordered, threshold); ${algo} is error diffusion, a serial scan with no per-pixel form.`];
  },
});
