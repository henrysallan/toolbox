// SkSL helpers shared by the gather family (displace, chromatic aberration,
// sharpen, edge detect, bevel & emboss, vector field, flow blur, kuwahara —
// specdocs/101326_skia-target.md §3.2 `sksl-gather`). Registered when a
// gather node module loads; same naming rule as helpers.ts (every function
// starts with `tbx_`, unique across the library — these use `tbx_gather_`).
//
// The engine's GL gathers sample a TEXTURE of their upstream: canvas-sized,
// LINEAR, CLAMP_TO_EDGE (engine/gl.ts allocImage). A Skia gather re-evaluates
// the upstream FUNCTION at the offset uv instead, which is defined
// everywhere. tbx_gather_edge_uv reproduces the texture's edge rule — clamp
// the sample point to the outermost texel centres — so border pixels read
// what the GL node reads. What it cannot reproduce is bilinear filtering
// between texel centres: off-grid taps (displace, chromatic aberration,
// vector field, flow blur) see the exact function where the GL node sees a
// bilinear blend of fp16 texels. Taps on the pixel grid (sharpen, edge
// detect, emboss, kuwahara) land on texel centres, where the two agree.
//
// Ports of the wire conventions, line for line:
//   tbx.gather.velocity      engine/velocity-field.ts VELOCITY_DECODE/ENCODE_GLSL
//   tbx.gather.orientation   engine/orientation-field.ts ORIENTATION_DECODE_GLSL

import { registerSkslFunction, registerSkslHelper, type SkslLibFunctionDef } from "./registry";

registerSkslHelper({
  id: "tbx.gather.edge",
  source: `float2 tbx_gather_edge_uv(float2 uv, float2 res) {
  float2 h = 0.5 / res;
  return clamp(uv, h, 1.0 - h);
}`,
});

// R = 0.5 + vx/2, G = 0.5 + vy/2 (Y-DOWN, canvas-width units), B 0, A 1.
registerSkslHelper({
  id: "tbx.gather.velocity",
  source: `float2 tbx_gather_velocity_decode(float4 c) {
  return 2.0 * (c.rg - float2(0.5));
}
float4 tbx_gather_velocity_encode(float2 v) {
  return float4(clamp(v, float2(-1.0), float2(1.0)) * 0.5 + 0.5, 0.0, 1.0);
}`,
});

// A π-periodic tangent in RG, coherence in B.
registerSkslHelper({
  id: "tbx.gather.orientation",
  source: `float2 tbx_gather_tangent_decode(float4 c) {
  float2 t = 2.0 * (c.rg - float2(0.5));
  float len = length(t);
  return len < 1e-5 ? float2(0.0) : t / len;
}
float tbx_gather_coherence_decode(float4 c) {
  return c.b;
}
float2 tbx_gather_coherent_step(float2 t, float2 prev) {
  return dot(t, prev) < 0.0 ? -t : t;
}`,
});

// A constant DATA value (a map at midlevel, a neutral field), where
// tbx.const@1 is a COLOR. Both are plain float4 uniforms now (color
// management converts at the program's boundaries, never a uniform —
// library/color-management.ts), but data stays its own function so it can
// never be mistaken for a color.
export const TBX_GATHER_FLAT: SkslLibFunctionDef = {
  id: "tbx.gather.flat@1",
  entry: "tbx_gather_flat",
  source: `float4 tbx_gather_flat(float2 uv, float2 res, float4 value) {
  return value;
}`,
  params: [{ name: "value", type: "float4" }],
  inputs: [],
  cost: 0,
};

registerSkslFunction(TBX_GATHER_FLAT);

// The ids, for `uses` lists.
export const GATHER_EDGE = "tbx.gather.edge";
export const GATHER_VELOCITY = "tbx.gather.velocity";
export const GATHER_ORIENTATION = "tbx.gather.orientation";

// A per-pixel budget for one fused Skia program on a 3× phone, in the
// library's cost units (one simplex octave ≈ 1; shader-expr.ts `cost`).
// iPhone 12-class: 1170×2532 ≈ 3.0 M px at 60 fps ≈ 180 M px/s; an
// A14-class GPU at ~1.3 TFLOPS fp32 and ~35% of a frame for one layer
// leaves ≈ 2.5 k flops per pixel; one simplex octave is ≈ 70 flops, so
// ≈ 35 units — rounded down to 32. A program above it is a candidate for a
// filter split (§3.3: render the upstream once, gather from the image).
// Not measured on a device: an estimate to rank ports, not a guarantee.
export const PHONE_PIXEL_BUDGET = 32;
