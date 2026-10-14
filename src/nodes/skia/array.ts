import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { bindDegrees } from "@/engine/skia/library/helpers-warp";
import { arrayNode } from "../effect/array";

// Array (Skia) — the Skia-layer port of Array's IMAGE mode
// (specdocs/101326_skia-target.md §3.2, Wave 2 warps). The GL node's FS line
// for line as a gather: each pixel finds its grid cell (fit: 1/count, step:
// sizeW/H, shifted by the pattern offset), applies the inverse per-copy
// offset / rotation / scale about the cell center, and re-evaluates the
// instance once there — transparent outside the grid and outside the copy's
// own [0,1]² (copies are clipped to their cell). That is ONE instance tap
// per pixel whatever countX × countY is, as the GL node's O(1) pass: no
// copy loop, so no cap on the counts.
//
// The modulators (mod_scale / mod_pos / mod_rot) are gathers too, read once
// at the cell center. Unwired they read mid-grey, which makes every
// `(m − 0.5) · 2 · amount` term exactly 0 — the GL node's has-modulator = 0.
// localRotate and modRotAmount stay degrees in the panel and are bound in
// radians (ref scale π/180), as the GL node's uniforms are.
//
// Not ported: mode=spline / point (native Skia geometry), the `index` aux,
// and `direction`, which only orders that aux and the geometry copies.

const ARRAY_SKSL = `float4 tbx_array(float2 uv, float2 res, float countX, float countY, int sizeMode,
                float sizeW, float sizeH, float patternOffsetX, float patternOffsetY,
                float localX, float localY, float localRotate, float localScaleX, float localScaleY,
                float modScaleAmount, float modPosAmount, float modRotAmount) {
  float2 count = float2(max(floor(countX), 1.0), max(floor(countY), 1.0));
  float2 stepSize = sizeMode == 1 ? float2(sizeW, sizeH) : 1.0 / count;
  float2 patternOffset = float2(patternOffsetX, patternOffsetY);
  float2 gridUv = uv - patternOffset;
  float2 idxF = floor(gridUv / stepSize);
  float2 localUv = fract(gridUv / stepSize);
  if (idxF.x < 0.0 || idxF.x >= count.x || idxF.y < 0.0 || idxF.y >= count.y) return float4(0.0);
  float2 cellCenter = (idxF + 0.5) * stepSize + patternOffset;

  // The JS clamps the copy scale >= 0.0001 before the modulator scales it.
  float2 effScale = max(float2(localScaleX, localScaleY), float2(0.0001));
  float2 cc = tbx_warp_texel(cellCenter, res);
  float m = $mod_scale(cc).r;
  effScale *= (1.0 + (m - 0.5) * 2.0 * modScaleAmount);
  float4 mp = $mod_pos(cc);
  float2 effOffset = float2(localX, localY) + float2(mp.r - 0.5, mp.g - 0.5) * 2.0 * modPosAmount;
  float effAngle = localRotate + ($mod_rot(cc).r - 0.5) * 2.0 * modRotAmount;

  float2 p = localUv - float2(0.5);
  p -= effOffset;
  p = tbx_warp_rotate(p, cos(-effAngle), sin(-effAngle));
  p /= max(effScale, float2(0.0001));
  float2 srcUv = p + float2(0.5);
  if (tbx_warp_outside(srcUv, float2(0.0), float2(1.0))) return float4(0.0);
  return $instance(tbx_warp_texel(srcUv, res));
}`;

const MID_GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

export const skiaArrayNode = defineSkslNode({
  type: "skia-array",
  name: "Array (Skia)",
  mirrors: "array",
  category: "utility",
  description:
    "Skia-layer Array: tiles the upstream shader into a countX × countY grid with a per-copy offset, rotation and scale, and optional scale / position / rotation modulators read at each cell's center; fused into the layer's one runtime shader. Same params as Array's image mode. The `preview` output renders it through CanvasKit.",
  searchAliases: ["array", "grid", "tile", "repeat", "copies", "skia", "sksl"],
  facts: {
    space: {
      "in:instance": "raster",
      "param:sizeW": "uv01",
      "param:sizeH": "uv01",
      "param:patternOffsetX": "uv01",
      "param:patternOffsetY": "uv01",
      "param:localX": "uv01",
      "param:localY": "uv01",
    },
    gotchas: [
      "Image mode only: mode=spline/point is refused, and there is no index aux (direction only ordered that aux and geometry copies).",
      "One instance evaluation per pixel at any count: each pixel reads only its own cell, and a copy is clipped to its cell.",
      "Grid and copy offsets are per-axis uv fractions with Y up (cell row 0 at the bottom), as Array's image mode.",
      "Modulators are read once at each cell center; unwired they act as mid-grey, i.e. no change. modRotAmount and localRotate are degrees.",
      "sizeMode=fit steps by 1/count; sizeMode=step uses sizeW/H, and cells past countX/Y stay transparent.",
    ],
  },
  fn: {
    id: "tbx.array@1",
    entry: "tbx_array",
    source: ARRAY_SKSL,
    params: [
      { name: "countX", type: "float" },
      { name: "countY", type: "float" },
      { name: "sizeMode", type: "int" },
      { name: "sizeW", type: "float" },
      { name: "sizeH", type: "float" },
      { name: "patternOffsetX", type: "float" },
      { name: "patternOffsetY", type: "float" },
      { name: "localX", type: "float" },
      { name: "localY", type: "float" },
      { name: "localRotate", type: "float" },
      { name: "localScaleX", type: "float" },
      { name: "localScaleY", type: "float" },
      { name: "modScaleAmount", type: "float" },
      { name: "modPosAmount", type: "float" },
      { name: "modRotAmount", type: "float" },
    ],
    inputs: [
      { name: "instance", mode: "gather", taps: 1 },
      { name: "mod_scale", mode: "gather", taps: 1 },
      { name: "mod_pos", mode: "gather", taps: 1 },
      { name: "mod_rot", mode: "gather", taps: 1 },
    ],
    uses: ["tbx.warp.rotate", "tbx.warp.outside", "tbx.warp.texel"],
    cost: 0.15,
  },
  params: mirrorParams(arrayNode, [
    "mode",
    "distribution",
    "countX",
    "countY",
    "sizeMode",
    "sizeW",
    "sizeH",
    "patternOffsetX",
    "patternOffsetY",
    "localX",
    "localY",
    "localRotate",
    "localScaleX",
    "localScaleY",
    "modScaleAmount",
    "modPosAmount",
    "modRotAmount",
  ]),
  inputs: [
    { name: "instance", label: "instance" },
    { name: "mod_scale", label: "scale mod", unwired: MID_GREY },
    { name: "mod_pos", label: "pos mod", unwired: MID_GREY },
    { name: "mod_rot", label: "rot mod", unwired: MID_GREY },
  ],
  binds: ({ params, nodeId }) => ({
    localRotate: bindDegrees(params, nodeId, "localRotate"),
    modRotAmount: bindDegrees(params, nodeId, "modRotAmount", 90),
  }),
  // Array's modeOf: anything but spline / point is image mode.
  unsupported(params) {
    const mode = params.mode;
    return mode === "spline" || mode === "point"
      ? [`Array (Skia) tiles shaders only (mode=image); mode=${mode} copies geometry, which a Skia layer draws with native paths.`]
      : [];
  },
});
