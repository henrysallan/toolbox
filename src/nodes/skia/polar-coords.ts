import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { TEXEL_HELPER } from "@/engine/skia/library/helpers-warp";
import { polarCoordsNode } from "../effect/polar-coords";

// Polar Coords (Skia) — the Skia-layer port of Polar Coords
// (specdocs/101326_skia-target.md §3.2, Wave 2 warps). The GL node's FS line
// for line as a gather: rect-to-polar reads the upstream at (angle / 2π,
// radius) around the center, polar-to-rect at center + r·(cos θ, sin θ);
// then the same edge rule — transparent outside [0,1]², clamp, or the GL
// node's mirror tile `abs(fract(uv/2)·2 − 1)` (which also flips inside the
// box). Center is a per-axis uv fraction and the radius has no aspect term,
// exactly as the original. Every option is ported.

const POLAR_COORDS_SKSL = `float4 tbx_polar_coords(float2 uv, float2 res, int mode, float center_x, float center_y,
                       float rotation, float scale_radius, int wrap) {
  const float TAU = 6.28318530717958647692;
  float2 center = float2(center_x, center_y);
  float2 q;
  if (mode == 0) {
    // rect-to-polar: read the source at (theta / 2π, r).
    float2 d = uv - center;
    float r = length(d) * scale_radius;
    float theta = atan(d.y, d.x) + rotation;
    float a = mod(theta, TAU) / TAU;
    if (a < 0.0) a += 1.0;
    q = float2(a, r);
  } else {
    // polar-to-rect: x is the angle (0..1 → 0..2π), y the radius.
    float theta = uv.x * TAU + rotation;
    float r = uv.y * scale_radius;
    q = center + float2(cos(theta), sin(theta)) * r;
  }
  if (wrap == 0 && tbx_warp_outside(q, float2(0.0), float2(1.0))) return float4(0.0);
  if (wrap == 1) q = clamp(q, 0.0, 1.0);
  else if (wrap == 2) q = abs(fract(q * 0.5) * 2.0 - 1.0);
  return $image(tbx_texel_clamp(q, res));
}`;

export const skiaPolarCoordsNode = defineSkslNode({
  type: "skia-polar-coords",
  name: "Polar Coords (Skia)",
  mirrors: "polar-coords",
  subcategory: "modifier",
  description:
    "Skia-layer Polar Coords: maps the upstream shader between rectangular and polar coordinates (rect-to-polar wraps it around the center, polar-to-rect unrolls it), fused into the layer's one runtime shader. Same params as Polar Coords. The `preview` output renders it through CanvasKit.",
  searchAliases: ["polar", "polar coordinates", "tunnel", "unwrap", "skia", "sksl"],
  facts: {
    space: { "param:center_x": "uv01", "param:center_y": "uv01" },
    gotchas: [
      "center_x/center_y are per-axis uv fractions and the radius has no aspect term, so circles skew into ellipses on non-square canvases (as Polar Coords).",
      "mode=rect-to-polar reads the upstream at (angle=x·2π, radius=y); mode=polar-to-rect is the inverse unroll.",
      "wrap=transparent leaves out-of-range samples at alpha 0; clamp clamps uv to [0,1]; mirror is abs(fract(uv*0.5)*2−1), which flips even inside [0,1].",
      "rotation is radians and offsets the angle axis directly; the upstream is re-evaluated at the mapped point, not read from a filtered texture.",
    ],
  },
  fn: {
    id: "tbx.polar_coords@1",
    entry: "tbx_polar_coords",
    source: POLAR_COORDS_SKSL,
    params: [
      { name: "mode", type: "int" },
      { name: "center_x", type: "float" },
      { name: "center_y", type: "float" },
      { name: "rotation", type: "float" },
      { name: "scale_radius", type: "float" },
      { name: "wrap", type: "int" },
    ],
    inputs: [{ name: "image", mode: "gather", taps: 1 }],
    uses: ["tbx.warp.outside", TEXEL_HELPER],
    cost: 0.1,
  },
  params: mirrorParams(polarCoordsNode, ["mode", "center_x", "center_y", "rotation", "scale_radius", "wrap"]),
  inputs: [{ name: "image", label: "Image" }],
});
