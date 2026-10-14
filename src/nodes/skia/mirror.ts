import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import "@/engine/skia/library/helpers-warp";
import { mirrorNode } from "../effect/mirror";

// Mirror (Skia) — the Skia-layer port of Mirror's IMAGE path
// (specdocs/101326_skia-target.md §3.2, Wave 2 warps). MIRROR_FS line for
// line as a gather: each copy (source, X flip, Y flip, the 180° copy, or
// `count` radial wedges with an optional kaleidoscope flip) inverse-maps the
// pixel in the center-relative canvas frame, re-evaluates the upstream
// there, and source-overs it onto the copies before it (straight alpha,
// later copies on top). Samples outside [0,1]² contribute nothing; bisect
// drops copies whose source lands off the kept half-plane.
//
// Radial: a constant 64-iteration loop with `break`, MIRROR_FS's own cap
// (count's max is 64), two taps per wedge with kaleidoscope — up to 128
// upstream evaluations per pixel. The axis modes take at most 4.
//
// Not ported: spline / points sources (their Skia lowering is native path
// copies) and `tagGroups`, which only tags geometry.

const MIRROR_SKSL = `bool tbx_mirror_on_keep(float2 src, float2 center, int keep) {
  if (keep == 0) return src.x >= center.x;
  if (keep == 1) return src.x <= center.x;
  if (keep == 2) return src.y >= center.y;
  return src.y <= center.y;
}

// MIRROR_FS accum(): one copy, source-overed onto the copies before it.
float4 tbx_mirror_tap(float4 acc, float2 res, float2 p, float2 center, float aspect, int mode, int keep,
                      bool flipX, bool flipY, float angle) {
  float2 d = p - center;
  if (angle != 0.0) {
    // Pixel-isotropic rotation so radial copies stay rigid.
    float iy = d.y / max(aspect, 1e-6);
    float cs = cos(angle);
    float sn = sin(angle);
    float rx = cs * d.x + sn * iy;
    float ry = -sn * d.x + cs * iy;
    d = float2(rx, ry * aspect);
  }
  if (flipX) d.x = -d.x;
  if (flipY) d.y = -d.y;
  float2 src = center + d;
  if (mode == 4 && !tbx_mirror_on_keep(src, center, keep)) return acc;
  // canvas01 (Y-down, width units) → uv.
  float2 q = float2(src.x, 0.5 - (src.y - 0.5) * aspect);
  if (tbx_warp_outside(q, float2(0.0), float2(1.0))) return acc;
  return tbx_warp_over($source(tbx_warp_texel(q, res)), acc);
}

float4 tbx_mirror(float2 uv, float2 res, int mode, int keep, float centerX, float centerY,
                  float count, int kaleidoscope, int includeSource) {
  float aspect = res.x / max(res.y, 1.0);
  float2 center = float2(centerX, centerY);
  float2 p = float2(uv.x, 0.5 + (0.5 - uv.y) / max(aspect, 1e-6));
  float4 acc = float4(0.0);
  int axis = mode;
  if (mode == 4) axis = (keep == 2 || keep == 3) ? 1 : 0;
  if (mode == 3) {
    float n = max(floor(count), 1.0);
    for (int k = 0; k < 64; k++) {
      if (float(k) >= n) break;
      float ang = float(k) * 6.283185307179586 / n;
      acc = tbx_mirror_tap(acc, res, p, center, aspect, mode, keep, false, false, ang);
      if (kaleidoscope != 0) acc = tbx_mirror_tap(acc, res, p, center, aspect, mode, keep, false, true, ang);
    }
  } else {
    if (includeSource != 0) acc = tbx_mirror_tap(acc, res, p, center, aspect, mode, keep, false, false, 0.0);
    if (axis == 0 || axis == 2) acc = tbx_mirror_tap(acc, res, p, center, aspect, mode, keep, true, false, 0.0);
    if (axis == 1 || axis == 2) acc = tbx_mirror_tap(acc, res, p, center, aspect, mode, keep, false, true, 0.0);
    if (axis == 2) acc = tbx_mirror_tap(acc, res, p, center, aspect, mode, keep, true, true, 0.0);
  }
  return acc;
}`;

export const skiaMirrorNode = defineSkslNode({
  type: "skia-mirror",
  name: "Mirror (Skia)",
  mirrors: "mirror",
  category: "utility",
  description:
    "Skia-layer Mirror: reflects the upstream shader across X / Y (or both), repeats it radially around a center with an optional kaleidoscope flip per wedge, or bisects then mirrors, fused into the layer's one runtime shader. Same params as Mirror's image path. The `preview` output renders it through CanvasKit.",
  searchAliases: ["mirror", "reflect", "symmetry", "kaleidoscope", "radial", "bisect", "skia", "sksl"],
  facts: {
    space: {
      "in:source": "raster",
      "param:centerX": "canvas01",
      "param:centerY": "canvas01",
    },
    gotchas: [
      "Image path only: spline / points sources and tagGroups are not ported (they belong to native Skia paths).",
      "Every copy re-evaluates the upstream: radial costs count taps (2x with kaleidoscope, at most 128), the axis modes at most 4.",
      "Copies source-over in order (source, X, Y, 180°; or wedge by wedge), straight alpha; samples outside the canvas add nothing.",
      "Radial copies rotate in pixel-isotropic space so they stay rigid on non-square canvases; axis flips are aspect-free.",
      "mode=bisect keeps copies whose source lies on the keep side (x: x≥centerX, -x: x≤centerX, y: y≥centerY, -y: y≤centerY).",
    ],
  },
  fn: {
    id: "tbx.mirror@1",
    entry: "tbx_mirror",
    source: MIRROR_SKSL,
    params: [
      { name: "mode", type: "int" },
      { name: "keep", type: "int" },
      { name: "centerX", type: "float" },
      { name: "centerY", type: "float" },
      { name: "count", type: "float" },
      { name: "kaleidoscope", type: "int" },
      { name: "includeSource", type: "int" },
    ],
    inputs: [{ name: "source", mode: "gather", taps: "param" }],
    uses: ["tbx.warp.outside", "tbx.warp.over", "tbx.warp.texel"],
    cost: 0.15,
  },
  params: mirrorParams(mirrorNode, ["mode", "keep", "centerX", "centerY", "count", "kaleidoscope", "includeSource"]),
  inputs: [{ name: "source", label: "Image" }],
});
