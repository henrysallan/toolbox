// Built-in SkSL helpers shared by library functions (shader-expr.ts:
// SkslHelper). Each is emitted once per fused program, dependencies first.
//
// Naming: every function a helper defines starts with `tbx_` and is unique
// across the library (check:skia-library compiles all helpers and all
// functions into one program, so a clash fails the gate). A library
// function lists the helper ids it calls in `uses`.
//
// Ports, so the Skia nodes stay line-for-line with the engine's GL nodes:
//   tbx.color.srgb / tbx.color.oklab   engine/color-space.ts (the keyframe
//                                      engine and the color-ramp sampler)
//   tbx.noise.simplex2d                NOISE_FS `snoise` (Ashima)
//   tbx.noise.slice                    NOISE_FS `hashOffset` (W slice blend)
//   tbx.hash.sin                       NOISE_FS `hashGrad` and friends
// Float-only throughout: Skia's strict ES2 has no uint or bitwise ops, so
// ports of the GL nodes' pcg/uint hashes use tbx.hash instead (and say so).

import { registerSkslHelper } from "./registry";

// Child shaders hand back premultiplied color; library functions work in
// straight alpha like every engine shader.
registerSkslHelper({
  id: "tbx.unpremul",
  source: `float4 tbx_unpremul(float4 c) {
  return c.a > 0.0 ? float4(c.rgb / c.a, c.a) : float4(0.0);
}`,
});

// Dave Hoskins, "Hash without Sine" (MIT). Constants as NOISE_FS's hash12,
// which value noise already uses. Inputs are lattice coordinates; precision
// holds to |p| ≈ 1e4 in fp32.
registerSkslHelper({
  id: "tbx.hash",
  source: `float tbx_hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float tbx_hash12(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float2 tbx_hash22(float2 p) {
  float3 p3 = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float3 tbx_hash33(float3 p3) {
  p3 = fract(p3 * float3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}`,
});

// The sin-based hashes the GL noise family uses (NOISE_FS hashGrad,
// phasorHash22). Not stable across GPUs at large inputs — kept for ports
// that must match the GL node; prefer tbx.hash in new code.
registerSkslHelper({
  id: "tbx.hash.sin",
  source: `float2 tbx_hash_sin22(float2 p) {
  p = float2(dot(p, float2(127.1, 311.7)), dot(p, float2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}
float2 tbx_hash_grad2(float2 p) {
  return normalize(-1.0 + 2.0 * tbx_hash_sin22(p));
}`,
});

// Rec. 709 luma of gamma-encoded RGB — what Color Ramp, Threshold and the
// keyers remap by.
registerSkslHelper({
  id: "tbx.color.luma",
  source: `float tbx_luma709(float3 c) {
  return dot(c, float3(0.2126, 0.7152, 0.0722));
}`,
});

// engine/color-space.ts srgbToLinear / linearToSrgb (0..1, gamma ↔ light).
registerSkslHelper({
  id: "tbx.color.srgb",
  source: `float tbx_srgb_to_linear(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
float tbx_linear_to_srgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
float3 tbx_srgb_to_linear3(float3 c) {
  return float3(tbx_srgb_to_linear(c.r), tbx_srgb_to_linear(c.g), tbx_srgb_to_linear(c.b));
}
float3 tbx_linear_to_srgb3(float3 c) {
  return float3(tbx_linear_to_srgb(c.r), tbx_linear_to_srgb(c.g), tbx_linear_to_srgb(c.b));
}`,
});

// engine/color-space.ts linearToOklab / oklabToLinear (Björn Ottosson's
// coefficients). Both directions are UNCLAMPED, like the JS: callers clip
// (the color ramp clamps linear light before re-encoding).
registerSkslHelper({
  id: "tbx.color.oklab",
  uses: ["tbx.color.srgb"],
  source: `float tbx_cbrt(float x) {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}
float3 tbx_linear_to_oklab(float3 c) {
  float l = tbx_cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = tbx_cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = tbx_cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return float3(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
float3 tbx_oklab_to_linear(float3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return float3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}
float3 tbx_srgb_to_oklab(float3 c) {
  return tbx_linear_to_oklab(tbx_srgb_to_linear3(c));
}
float3 tbx_oklab_to_srgb(float3 lab) {
  return tbx_linear_to_srgb3(tbx_oklab_to_linear(lab));
}`,
});

// Ashima's mod-289 permutation polynomial (NOISE_FS's mod289v*/permute*).
registerSkslHelper({
  id: "tbx.noise.permute",
  source: `float2 tbx_mod289_2(float2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float3 tbx_mod289_3(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float4 tbx_mod289_4(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float3 tbx_permute3(float3 x) { return tbx_mod289_3(((x * 34.0) + 1.0) * x); }
float4 tbx_permute4(float4 x) { return tbx_mod289_4(((x * 34.0) + 1.0) * x); }`,
});

// NOISE_FS `snoise` (Ashima 2D simplex), statement for statement. Roughly
// [-1, 1].
registerSkslHelper({
  id: "tbx.noise.simplex2d",
  uses: ["tbx.noise.permute"],
  source: `float tbx_snoise2(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439,
                          -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = tbx_mod289_2(i);
  float3 p = tbx_permute3(tbx_permute3(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
  float3 m = max(0.5 - float3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  float3 x = 2.0 * fract(p * C.www) - 1.0;
  float3 h = abs(x) - 0.5;
  float3 ox = floor(x + 0.5);
  float3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  float3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}`,
});

// NOISE_FS `hashOffset`: the W (evolution) slice-blend hashes each integer
// slice to a far-away XY offset; slice 0 is the unshifted field. Every noise
// algorithm shares it, so ports evolve identically.
registerSkslHelper({
  id: "tbx.noise.slice",
  source: `float2 tbx_noise_slice_offset(float wi) {
  if (wi == 0.0) return float2(0.0);
  return float2(fract(sin(wi * 12.9898) * 43758.5453),
                fract(sin(wi * 78.2330) * 43758.5453)) * 1000.0;
}`,
});
