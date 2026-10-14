// SkSL helpers shared by the color family's Skia ports (specdocs/101326_skia-target.md
// §7 Wave 2, family 2). Same registry and rules as helpers.ts; everything
// here is named `tbx_cf_*` (helper ids `tbx.cf.*`) so another family's
// helpers can never collide with it.
//
//   tbx.cf.hsv     Color Correction's branchless rgb2hsv / hsv2rgb, verbatim
//   tbx.cf.curve   engine/float-curve.ts evalMonotoneCubic over packed
//                  points, plus the 256-entry RGBA8 LUT the GL Color
//                  Correction / RGB Curves nodes sample (emulated exactly:
//                  8-bit entries, LINEAR filtering, CLAMP_TO_EDGE)
//
// Imported for its side effect by the nodes that `uses` these ids.

import { registerSkslHelper } from "./registry";

// Points per curve channel in the packed uniform arrays (float4 x, y,
// tangent, 0 each). The GL nodes take any number; the ports report more as
// unsupported.
export const SKSL_CURVE_MAX_POINTS = 16;

registerSkslHelper({
  id: "tbx.cf.hsv",
  source: `float3 tbx_cf_rgb2hsv(float3 c) {
  float4 K = float4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  float4 p = mix(float4(c.bg, K.wz), float4(c.gb, K.xy), step(c.b, c.g));
  float4 q = mix(float4(p.xyw, c.r), float4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return float3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
float3 tbx_cf_hsv2rgb(float3 c) {
  float4 K = float4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  float3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}`,
});

const N = SKSL_CURVE_MAX_POINTS;

registerSkslHelper({
  id: "tbx.cf.curve",
  source: `float tbx_cf_curve_eval(float4 pts[${N}], float n, float x) {
  // evalMonotoneCubic: clamp to the end points, bracket, cubic Hermite with
  // the precomputed Fritsch-Carlson tangents (pts[i].z).
  float4 first = pts[0];
  if (n < 1.5 || x <= first.x) return first.y;
  float4 a = first;
  float4 b = first;
  float4 last = first;
  bool found = false;
  for (int i = 1; i < ${N}; i++) {
    if (float(i) >= n) break;
    last = pts[i];
    if (!found) {
      b = last;
      if (x <= b.x) found = true;
      else a = b;
    }
  }
  if (x >= last.x) return last.y;
  float h = b.x - a.x;
  if (h == 0.0) return a.y;
  float t = (x - a.x) / h;
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * a.y + (t3 - 2.0 * t2 + t) * h * a.z
       + (-2.0 * t3 + 3.0 * t2) * b.y + (t3 - t2) * h * b.z;
}
// One LUT entry: the curve at i / 255, rounded to 8 bits (buildLut256).
float tbx_cf_curve_byte(float4 pts[${N}], float n, float i) {
  return floor(clamp(tbx_cf_curve_eval(pts, n, i / 255.0), 0.0, 1.0) * 255.0 + 0.5) / 255.0;
}
// texture(lut, vec2(clamp(v, 0, 1), 0.5)) on the 256×1 LINEAR, CLAMP_TO_EDGE
// LUT: texel centres at (i + 0.5) / 256, so v lands between entries
// floor(256 v − 0.5) and the next.
float tbx_cf_curve_lut(float4 pts[${N}], float n, float v) {
  float f = clamp(v, 0.0, 1.0) * 256.0 - 0.5;
  float i0 = floor(f);
  float w = f - i0;
  float y0 = tbx_cf_curve_byte(pts, n, clamp(i0, 0.0, 255.0));
  float y1 = tbx_cf_curve_byte(pts, n, clamp(i0 + 1.0, 0.0, 255.0));
  return mix(y0, y1, w);
}
// Master curve on every channel, then each channel's own (the GL nodes'
// order). count = (master, r, g, b) point counts.
float3 tbx_cf_curves_apply(float3 c, float4 m[${N}], float4 r[${N}], float4 g[${N}], float4 b[${N}], float4 count) {
  c = float3(tbx_cf_curve_lut(m, count.x, c.r), tbx_cf_curve_lut(m, count.x, c.g), tbx_cf_curve_lut(m, count.x, c.b));
  return float3(tbx_cf_curve_lut(r, count.y, c.r), tbx_cf_curve_lut(g, count.z, c.g), tbx_cf_curve_lut(b, count.w, c.b));
}`,
});
