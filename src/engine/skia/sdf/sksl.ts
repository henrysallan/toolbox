// SDF tree → one Skia runtime effect (specdocs/101326_skia-target.md §3.2,
// Wave 2 family 5). The SkSL twin of engine/sdf-compile.ts: the same
// position / distance / colour ("Surf") pipelines, ported to Skia's strict
// ES2 rules, emitted as a complete SkslProgramIR that the Skia SDF
// terminals (nodes/skia/sdf.ts) hand downstream as a `program` shader
// expression (shader-expr.ts).
//
// Determinism: the SkSL text depends only on the tree's STRUCTURE — node
// kinds, which objects are shared (a position chain wired into two shapes
// is evaluated once), structural flags (mirror axis, bounded repeat, remap
// clamp, math op, quantize sides) and the spline segment bucket — never on
// values, so animating any param keeps CanvasKit's compile cache hot.
// Values are uniforms, one float per scalar (so each binds to ONE param and
// can export as its own track; provenance.ts supplies the refs).
//
// Port notes (what differs from the GLSL compiler, and why):
//   - Coordinates: `p` is the engine's v_uv (Y-up) recovered from Skia's
//     Y-down pixel coordinate, then aspect-corrected exactly like
//     compileSdf's preamble. AA is already analytic there (1 px =
//     1 / max(width, height) in uv), so no derivative is needed.
//   - round() / trunc() / sinh() / cosh() / tanh() don't exist in SkSL's ES2
//     profile: polyfilled (round = half away from zero, as GPUs do).
//   - smoothstep with reversed edges (the native fill / contour masks) is
//     undefined behaviour in GLSL and MSL; it is spelled out here so a
//     device can't take a different branch.
//   - SDF Spline reads its segments from a uniform float4 array (bucketed
//     to 16 / 32 / 64 / 128) instead of an RGBA32F texture; the winding
//     count is a float. More than 128 segments is refused (GLES 3.0
//     guarantees 224 fragment uniform vectors).
//   - Refused (no Skia lowering — they sample engine textures): SDF
//     Displace, SDF From Image / text-derived SDFs, and SDF Material's ramp
//     mode (a LUT texture).
//   - SDF Shade's height_mode=curve samples a 256-texel 8-bit LUT of the
//     height curve; here the curve's points + monotone tangents are a
//     uniform array, and the LUT (its 8-bit texels and linear filtering) is
//     re-created in-shader from two curve evaluations per lookup. Curves
//     over SKIA_SDF_CURVE_POINTS points are refused.
//   - Clamps the SDF defs apply on the CPU (max(0, r), star sharpness ≤
//     points, …) are re-applied in-shader, so a uniform may carry the raw
//     param and bind to it as a plain ref.
//   - Color management (library/color-management.ts): colors are plain
//     float4 uniforms holding sRGB numbers and all the math is sRGB; the
//     generated body is `sdf_main`, and `main` converts its premultiplied
//     result to the destination's working space (identity on sRGB).

import type { PositionNode, ScalarFieldNode, SdfNode, SocketValue, SplineValue } from "../../types";
import type { Bind, SkslProgramIR } from "../scene-ir";
import { flattenSpline } from "../../spline-flatten";
import { colorManagementSksl } from "../library/color-management";
import { bindSdfColor, bindSdfDerived, bindSdfField, sdfProvenance } from "./provenance";

export type SkiaSdfMode = "rasterize" | "mask" | "distance" | "bevel" | "shade";

// Terminal uniforms, declared by every program of a mode: `t_<param>`.
// float = a scalar / boolean (0|1) / enum index; color = float4, straight
// sRGB RGBA (not layout(color): the math is sRGB); curve = float4[SKIA_SDF_CURVE_POINTS] of
// (x, y, monotone tangent, 0) per point, plus `t_<param>_count`. The node
// binds them (nodes/skia/sdf.ts).
export type SkiaSdfTerminalType = "float" | "color" | "curve";
export const SKIA_SDF_CURVE_POINTS = 16;
export const SKIA_SDF_TERMINAL_UNIFORMS: Record<SkiaSdfMode, readonly [string, SkiaSdfTerminalType][]> = {
  rasterize: [
    ["foreground", "color"],
    ["fg_alpha", "float"],
    ["background", "color"],
    ["bg_alpha", "float"],
    ["contour", "color"],
    ["contour_alpha", "float"],
    ["contour_width", "float"],
    ["softness", "float"],
    ["aspect_correct", "float"],
  ],
  mask: [
    ["threshold", "float"],
    ["softness", "float"],
    ["invert", "float"],
    ["aspect_correct", "float"],
  ],
  distance: [
    ["range", "float"],
    ["neg_color", "color"],
    ["zero_color", "color"],
    ["pos_color", "color"],
    ["alpha", "float"],
    ["aspect_correct", "float"],
  ],
  bevel: [
    ["style", "float"],
    ["depth", "float"],
    ["soften", "float"],
    ["foreground", "color"],
    ["fg_alpha", "float"],
    ["background", "color"],
    ["bg_alpha", "float"],
    ["l1_angle", "float"],
    ["l1_elevation", "float"],
    ["l1_hi_op", "float"],
    ["l1_sh_op", "float"],
    ["l2_angle", "float"],
    ["l2_elevation", "float"],
    ["l2_hi_op", "float"],
    ["l2_sh_op", "float"],
    ["highlight_color", "color"],
    ["shadow_color", "color"],
    ["highlight_blend", "float"],
    ["shadow_blend", "float"],
    ["aspect_correct", "float"],
  ],
  shade: [
    ["channel", "float"],
    ["fill_color", "color"],
    ["fill_alpha", "float"],
    ["background", "color"],
    ["bg_alpha", "float"],
    ["softness", "float"],
    ["bleed", "float"],
    ["bleed_mix", "float"],
    ["bleed_radius", "float"],
    ["bleed_inside", "float"],
    ["light", "float"],
    ["height_mode", "float"],
    ["height_curve", "curve"],
    ["depth", "float"],
    ["soften", "float"],
    ["l1_angle", "float"],
    ["l1_elevation", "float"],
    ["l1_hi_op", "float"],
    ["l1_sh_op", "float"],
    ["l2_angle", "float"],
    ["l2_elevation", "float"],
    ["l2_hi_op", "float"],
    ["l2_sh_op", "float"],
    ["highlight_color", "color"],
    ["shadow_color", "color"],
    ["highlight_blend", "float"],
    ["shadow_blend", "float"],
    ["glow", "float"],
    ["glow_radius", "float"],
    ["glow_intensity", "float"],
    ["glow_color_mode", "float"],
    ["glow_color", "color"],
    ["glow_blend", "float"],
    ["contour", "float"],
    ["contour_color", "color"],
    ["contour_alpha", "float"],
    ["contour_width", "float"],
    ["contour_spacing", "float"],
    ["aspect_correct", "float"],
  ],
};

export const SKIA_SDF_SPLINE_BUCKETS = [16, 32, 64, 128] as const;
export const SKIA_SDF_MAX_SEGMENTS = 128;

export interface SdfSkslOptions {
  resolution: [number, number];
  // Binds for every SKIA_SDF_TERMINAL_UNIFORMS[mode] entry, by param name.
  terminal: Record<string, Bind<number | number[]>>;
}

export interface SdfSkslResult {
  program: SkslProgramIR | null;
  problems: string[];
}

// ---- helpers (SkSL) ------------------------------------------------------------------

const HELPERS: Record<string, string> = {
  round: `float sdf_round(float x) { return sign(x) * floor(abs(x) + 0.5); }
float2 sdf_round2(float2 v) { return float2(sdf_round(v.x), sdf_round(v.y)); }`,
  // smoothstep that is defined for edge0 > edge1 (the formula GPUs use).
  smooth: `float sdf_smooth(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}`,
  posScale: `float2 sdf_posScale(float2 p, float2 s, float2 c) {
  return c + (p - c) / max(s, float2(0.0001));
}`,
  posRotate: `float2 sdf_posRotate(float2 p, float ang, float2 c) {
  float2 q = p - c;
  float ca = cos(-ang);
  float sa = sin(-ang);
  return c + float2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
}`,
  posRepeatJitter: `float2 sdf_repeatJitter(float2 id, float2 ql, float rotJ, float2 posJ, float sclJ, float seed) {
  if (rotJ != 0.0 || posJ.x != 0.0 || posJ.y != 0.0 || sclJ != 0.0) {
    float h1 = fract(sin(dot(id, float2(127.1, 311.7)) + seed) * 43758.5453);
    float h2 = fract(sin(dot(id, float2(269.5, 183.3)) + seed * 7.0) * 43758.5453);
    float h3 = fract(sin(dot(id, float2(113.5, 271.9)) + seed * 13.0) * 43758.5453);
    float h4 = fract(sin(dot(id, float2(213.7, 71.5)) + seed * 19.0) * 43758.5453);
    float scl = 1.0 + (h4 - 0.5) * 2.0 * sclJ;
    ql /= max(scl, 0.01);
    float ang = (h1 - 0.5) * 2.0 * rotJ;
    float ca = cos(-ang);
    float sa = sin(-ang);
    ql = float2(ca * ql.x - sa * ql.y, sa * ql.x + ca * ql.y);
    ql -= float2((h2 - 0.5) * 2.0 * posJ.x, (h3 - 0.5) * 2.0 * posJ.y);
  }
  return ql;
}`,
  posRepeat: `float2 sdf_posRepeat(float2 p, float2 spacing, float2 center, float rotJ, float2 posJ, float sclJ, float seed) {
  float2 q = p - center;
  float2 s = max(spacing, float2(0.0001));
  float2 id = sdf_round2(q / s);
  return center + sdf_repeatJitter(id, q - s * id, rotJ, posJ, sclJ, seed);
}`,
  posRepeatBounded: `float2 sdf_posRepeatBounded(float2 p, float2 spacing, float2 center, float2 limits, float rotJ, float2 posJ, float sclJ, float seed) {
  float2 q = p - center;
  float2 s = max(spacing, float2(0.0001));
  float2 id = clamp(sdf_round2(q / s), -limits, limits);
  return center + sdf_repeatJitter(id, q - s * id, rotJ, posJ, sclJ, seed);
}`,
  cellId: `float2 sdf_posCellId(float2 p, float2 spacing, float2 center) {
  float2 q = p - center;
  float2 s = max(spacing, float2(0.0001));
  return sdf_round2(q / s);
}`,
  posPolar: `float2 sdf_posPolar(float2 p, float2 center, float segments, float rot) {
  float2 q = p - center;
  float r = length(q);
  float a = atan(q.y, q.x) - rot;
  float sector = 6.28318530717958 / max(segments, 1.0);
  a = mod(a + sector * 0.5, sector) - sector * 0.5;
  return center + r * float2(cos(a + rot), sin(a + rot));
}`,
  posTwist: `float2 sdf_posTwist(float2 p, float2 center, float strength) {
  float2 q = p - center;
  float r = length(q);
  float a = atan(q.y, q.x) + r * strength;
  return center + r * float2(cos(a), sin(a));
}`,
  smin: `float sdf_smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}`,
  smax: `float sdf_smax(float a, float b, float k) {
  if (k <= 0.0) return max(a, b);
  float h = clamp(0.5 - 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}`,
  rect: `float sdf_rect(float2 p, float2 c, float2 s, float r) {
  float2 q = abs(p - c) - s + float2(r);
  return length(max(q, float2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}`,
  seg: `float sdf_seg(float2 p, float2 a, float2 b, float r) {
  float2 pa = p - a;
  float2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
  return length(pa - ba * h) - r;
}`,
  poly: `float sdf_poly(float2 p, float r, float n) {
  float an = 3.14159265358979 / n;
  float h = mod(atan(p.x, p.y), 2.0 * an) - an;
  return length(p) * cos(h) - r * cos(an);
}`,
  tri: `float sdf_tri(float2 p, float2 p0, float2 p1, float2 p2) {
  float2 e0 = p1 - p0;
  float2 e1 = p2 - p1;
  float2 e2 = p0 - p2;
  float2 v0 = p - p0;
  float2 v1 = p - p1;
  float2 v2 = p - p2;
  float2 pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 0.000001), 0.0, 1.0);
  float2 pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 0.000001), 0.0, 1.0);
  float2 pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 0.000001), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  float2 d = min(min(
    float2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
    float2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
    float2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}`,
  star: `float sdf_star(float2 p, float r, float n, float m) {
  float an = 3.14159265358979 / n;
  float en = 3.14159265358979 / max(m, 2.0);
  float2 acs = float2(cos(an), sin(an));
  float2 ecs = float2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  float2 q = length(p) * float2(cos(bn), abs(sin(bn)));
  q -= r * acs;
  q += ecs * clamp(-dot(q, ecs), 0.0, r * acs.y / max(ecs.y, 0.000001));
  return length(q) * sign(q.x);
}`,
  snoise: `float3 sdf_mod289v3(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float2 sdf_mod289v2(float2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float3 sdf_permute3(float3 x) { return sdf_mod289v3(((x * 34.0) + 1.0) * x); }
float sdf_snoise(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = sdf_mod289v2(i);
  float3 p = sdf_permute3(sdf_permute3(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
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
  snoiseFbm: `float2 sdf_snoiseHashOff(float wi) {
  if (wi == 0.0) return float2(0.0);
  return float2(fract(sin(wi * 12.9898) * 43758.5453), fract(sin(wi * 78.2330) * 43758.5453)) * 1000.0;
}
float sdf_snoiseFbmAt(float2 sp, int oct, float pers, float lac) {
  float total = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    total += sdf_snoise(sp * freq) * amp;
    maxAmp += amp;
    amp *= pers;
    freq *= lac;
  }
  return total / max(maxAmp, 0.0001);
}
float sdf_snoiseFbm(float2 p, float scl, float2 off, float seed, int oct, float pers, float lac, float w) {
  float2 sp = (p - 0.5) * scl + off + float2(seed * 127.1, seed * 311.7);
  float wi = floor(w);
  float wf = w - wi;
  wf = wf * wf * (3.0 - 2.0 * wf);
  float2 o0 = sdf_snoiseHashOff(wi);
  if (wf == 0.0) return sdf_snoiseFbmAt(sp + o0, oct, pers, lac);
  float2 o1 = sdf_snoiseHashOff(wi + 1.0);
  return mix(sdf_snoiseFbmAt(sp + o0, oct, pers, lac), sdf_snoiseFbmAt(sp + o1, oct, pers, lac), wf);
}`,
  hyper: `float sdf_trunc(float x) { return sign(x) * floor(abs(x)); }
float sdf_sinh(float x) { return 0.5 * (exp(x) - exp(-x)); }
float sdf_cosh(float x) { return 0.5 * (exp(x) + exp(-x)); }
float sdf_tanh(float x) { float e = exp(2.0 * clamp(x, -40.0, 40.0)); return (e - 1.0) / (e + 1.0); }`,
  // Colour carried with distance (compileSdf's SURF_DECLS). `lite` keeps
  // d + winner colour only (Rasterize / Bevel never read the bleed
  // accumulator); `full` adds acc / accW for SDF Shade.
  surfLite: `struct Surf { float d; float3 c; };
Surf sLeaf(float d, float3 col, float matW) { return Surf(d, col); }
Surf sUnion(Surf a, Surf b) { bool aw = a.d <= b.d; return Surf(aw ? a.d : b.d, aw ? a.c : b.c); }
Surf sIntersect(Surf a, Surf b) { bool aw = a.d >= b.d; return Surf(aw ? a.d : b.d, aw ? a.c : b.c); }
Surf sSubtract(Surf a, Surf b) { return Surf(max(a.d, -b.d), a.c); }
Surf sSmoothUnion(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(a.d, b.d) : clamp(0.5 + 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? min(a.d, b.d) : mix(b.d, a.d, h) - k * h * (1.0 - h);
  return Surf(d, mix(b.c, a.c, h));
}
Surf sSmoothIntersect(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(b.d, a.d) : clamp(0.5 - 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? max(a.d, b.d) : mix(b.d, a.d, h) + k * h * (1.0 - h);
  return Surf(d, mix(b.c, a.c, h));
}
Surf sSmoothSubtract(Surf a, Surf b, float k) {
  float nb = -b.d;
  float h = (k <= 0.0) ? step(nb, a.d) : clamp(0.5 - 0.5 * (nb - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? max(a.d, nb) : mix(nb, a.d, h) + k * h * (1.0 - h);
  return Surf(d, a.c);
}
Surf sMorph(Surf a, Surf b, float t) { return Surf(mix(a.d, b.d, t), mix(a.c, b.c, t)); }
Surf sOffset(Surf s, float r) { s.d -= r; return s; }
Surf sOnion(Surf s, float t) { s.d = abs(s.d) - t; return s; }`,
  surfFull: `struct Surf { float d; float3 c; float3 acc; float accW; };
float sdf_bleedInv() { return t_bleed > 0.5 ? 1.0 / max(t_bleed_radius, 0.001) : 0.0; }
Surf sLeaf(float d, float3 col, float matW) {
  float dd = (t_bleed_inside > 0.5) ? max(d, 0.0) : d;
  float w = matW * exp(clamp(-dd * sdf_bleedInv(), -60.0, 60.0));
  return Surf(d, col, col * w, w);
}
Surf sUnion(Surf a, Surf b) { bool aw = a.d <= b.d; return Surf(aw ? a.d : b.d, aw ? a.c : b.c, a.acc + b.acc, a.accW + b.accW); }
Surf sIntersect(Surf a, Surf b) { bool aw = a.d >= b.d; return Surf(aw ? a.d : b.d, aw ? a.c : b.c, a.acc + b.acc, a.accW + b.accW); }
Surf sSubtract(Surf a, Surf b) { return Surf(max(a.d, -b.d), a.c, a.acc, a.accW); }
Surf sSmoothUnion(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(a.d, b.d) : clamp(0.5 + 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? min(a.d, b.d) : mix(b.d, a.d, h) - k * h * (1.0 - h);
  return Surf(d, mix(b.c, a.c, h), a.acc + b.acc, a.accW + b.accW);
}
Surf sSmoothIntersect(Surf a, Surf b, float k) {
  float h = (k <= 0.0) ? step(b.d, a.d) : clamp(0.5 - 0.5 * (b.d - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? max(a.d, b.d) : mix(b.d, a.d, h) + k * h * (1.0 - h);
  return Surf(d, mix(b.c, a.c, h), a.acc + b.acc, a.accW + b.accW);
}
Surf sSmoothSubtract(Surf a, Surf b, float k) {
  float nb = -b.d;
  float h = (k <= 0.0) ? step(nb, a.d) : clamp(0.5 - 0.5 * (nb - a.d) / k, 0.0, 1.0);
  float d = (k <= 0.0) ? max(a.d, nb) : mix(nb, a.d, h) + k * h * (1.0 - h);
  return Surf(d, a.c, a.acc, a.accW);
}
Surf sMorph(Surf a, Surf b, float t) { return Surf(mix(a.d, b.d, t), mix(a.c, b.c, t), mix(a.acc, b.acc, t), mix(a.accW, b.accW, t)); }
Surf sOffset(Surf s, float r) { s.d -= r; return s; }
Surf sOnion(Surf s, float t) { s.d = abs(s.d) - t; return s; }`,
  lightDir: `float3 sdf_lightDir(float angDeg, float elevDeg) {
  float az = angDeg * 0.017453292519943295;
  float el = elevDeg * 0.017453292519943295;
  float ce = cos(el);
  return float3(cos(az) * ce, sin(az) * ce, sin(el));
}`,
  // One light's highlight / shadow over `col` (compileSdf's bevel/shade
  // loop body). hiB: 0 screen, 1 add, 2 normal. shB: 0 multiply,
  // 1 linear-burn, 2 color-burn, 3 normal.
  light: `float3 sdf_light(float3 col, float3 n, float3 ldir, float hiOp, float shOp, float3 hiC, float3 shC, float hiB, float shB) {
  float diff = dot(n, normalize(ldir));
  if (diff > 0.0) {
    float a = hiOp * diff;
    if (hiB < 0.5) {
      col = mix(col, float3(1.0) - (float3(1.0) - col) * (float3(1.0) - hiC), a);
    } else if (hiB < 1.5) {
      col = mix(col, min(col + hiC, float3(1.0)), a);
    } else {
      col = mix(col, hiC, a);
    }
  } else if (diff < 0.0) {
    float a = shOp * (-diff);
    if (shB < 0.5) {
      col = mix(col, col * shC, a);
    } else if (shB < 1.5) {
      col = mix(col, max(col + shC - float3(1.0), float3(0.0)), a);
    } else if (shB < 2.5) {
      float3 cb = float3(1.0) - clamp((float3(1.0) - col) / max(shC, float3(0.001)), 0.0, 1.0);
      col = mix(col, cb, a);
    } else {
      col = mix(col, shC, a);
    }
  }
  return col;
}`,
  srcOver: `float4 sdf_srcOver(float4 s, float4 d) {
  float a = s.a + d.a * (1.0 - s.a);
  if (a <= 0.000001) return float4(0.0);
  return float4((s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / a, a);
}`,
};

// Emission order (dependencies first).
const HELPER_ORDER = [
  "round",
  "smooth",
  "hyper",
  "posScale",
  "posRotate",
  "posRepeatJitter",
  "posRepeat",
  "posRepeatBounded",
  "cellId",
  "posPolar",
  "posTwist",
  "smin",
  "smax",
  "rect",
  "seg",
  "poly",
  "tri",
  "star",
  "snoise",
  "snoiseFbm",
  "surfLite",
  "surfFull",
  "lightDir",
  "light",
  "srcOver",
];
const HELPER_DEPS: Record<string, string[]> = {
  posRepeat: ["round", "posRepeatJitter"],
  posRepeatBounded: ["round", "posRepeatJitter"],
  cellId: ["round"],
  snoiseFbm: ["snoise"],
};

// ---- emitter ----------------------------------------------------------------------------

interface Material {
  col: string; // float3 expression
  w: string; // float expression
  key: string;
}

class Body {
  lines: string[] = [];
  pos = new Map<PositionNode, string>();
  dist = new Map<SdfNode, string>();
  field = new Map<ScalarFieldNode, string>();
  surf = new Map<string, string>();
  private n = 0;
  local(type: string, expr: string): string {
    const name = `${type === "Surf" ? "s" : type === "float2" ? "q" : "d"}${this.n++}`;
    this.lines.push(`${type} ${name} = ${expr};`);
    return name;
  }
}

class SdfSkslGen {
  problems: string[] = [];
  decls: string[] = [];
  uniforms: Record<string, Bind<number | number[]>> = {};
  helpers = new Set<string>();
  nodeFns: string[] = [];
  private ids = new Map<object, number>();
  private uni = new Map<object, Map<string, string>>();
  private surfIds = new Map<object, number>();
  private nodeFnFor = new Map<object, string>();

  use(h: string) {
    for (const d of HELPER_DEPS[h] ?? []) this.use(d);
    this.helpers.add(h);
  }

  private id(obj: object): number {
    let k = this.ids.get(obj);
    if (k === undefined) {
      k = this.ids.size;
      this.ids.set(obj, k);
    }
    return k;
  }

  private slot(obj: object, field: string, make: (name: string) => void): string {
    let m = this.uni.get(obj);
    if (!m) {
      m = new Map();
      this.uni.set(obj, m);
    }
    const hit = m.get(field);
    if (hit) return hit;
    const name = `u${this.id(obj)}_${field}`;
    m.set(field, name);
    make(name);
    return name;
  }

  // A scalar field of a tree object as a float uniform.
  f(obj: object, field: string, value: number): string {
    return this.slot(obj, field, (name) => {
      const v = Number.isFinite(value) ? value : 0;
      const bind = bindSdfField(obj, field, v);
      this.decls.push(`uniform float ${name};`);
      this.uniforms[name] = bind;
    });
  }

  // A derived value (deps on the producer's params / sockets).
  derived(obj: object, field: string, value: number | number[], params: string[], decl: string): string {
    return this.slot(obj, field, (name) => {
      this.decls.push(decl.replace("$", name));
      this.uniforms[name] = bindSdfDerived(obj, value, params);
    });
  }

  color(obj: object, field: string, rgb: readonly number[]): string {
    return this.slot(obj, field, (name) => {
      this.decls.push(`uniform float4 ${name};`);
      this.uniforms[name] = bindSdfColor(obj, field, rgb);
    });
  }

  // ---- position pipeline (vec2) ----

  pos(node: PositionNode, b: Body): string {
    const hit = b.pos.get(node);
    if (hit) return hit;
    const out = this.posUncached(node, b);
    b.pos.set(node, out);
    return out;
  }

  private xy(node: object, fx: string, fy: string, x: number, y: number): string {
    return `float2(${this.f(node, fx, x)}, ${this.f(node, fy, y)})`;
  }

  private posUncached(node: PositionNode, b: Body): string {
    switch (node.kind) {
      case "canvasUv":
        return "p";
      case "translate": {
        const t = this.xy(node, "tx", "ty", node.tx, node.ty);
        return b.local("float2", `${this.pos(node.child, b)} - ${t}`);
      }
      case "scale": {
        this.use("posScale");
        const s = this.xy(node, "sx", "sy", node.sx, node.sy);
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        return b.local("float2", `sdf_posScale(${this.pos(node.child, b)}, ${s}, ${c})`);
      }
      case "rotate": {
        this.use("posRotate");
        const ang = typeof node.rotation === "number" ? this.f(node, "rotation", node.rotation) : this.field(node.rotation, b);
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        return b.local("float2", `sdf_posRotate(${this.pos(node.child, b)}, ${ang}, ${c})`);
      }
      case "repeat": {
        const sp = `max(${this.xy(node, "spacingX", "spacingY", node.spacingX, node.spacingY)}, float2(0.001))`;
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const rotJ = `max(${this.f(node, "rotJitter", node.rotJitter ?? 0)}, 0.0)`;
        const posJ = `max(${this.xy(node, "posJitterX", "posJitterY", node.posJitterX ?? 0, node.posJitterY ?? 0)}, float2(0.0))`;
        const sclJ = `max(${this.f(node, "scaleJitter", node.scaleJitter ?? 0)}, 0.0)`;
        const seed = this.f(node, "seed", node.seed ?? 0);
        const child = this.pos(node.child, b);
        if (node.bounded) {
          this.use("posRepeatBounded");
          const lim = `max(${this.xy(node, "limitX", "limitY", node.limitX, node.limitY)}, float2(0.0))`;
          return b.local("float2", `sdf_posRepeatBounded(${child}, ${sp}, ${c}, ${lim}, ${rotJ}, ${posJ}, ${sclJ}, ${seed})`);
        }
        this.use("posRepeat");
        return b.local("float2", `sdf_posRepeat(${child}, ${sp}, ${c}, ${rotJ}, ${posJ}, ${sclJ}, ${seed})`);
      }
      case "mirror": {
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const q = b.local("float2", `${this.pos(node.child, b)} - ${c}`);
        const folded = node.axis === 1 ? `float2(abs(${q}.x), ${q}.y)` : node.axis === 2 ? `float2(${q}.x, abs(${q}.y))` : `abs(${q})`;
        return b.local("float2", `${c} + ${folded}`);
      }
      case "polar": {
        this.use("posPolar");
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const seg = this.f(node, "segments", node.segments);
        const rot = this.f(node, "rotation", node.rotation);
        return b.local("float2", `sdf_posPolar(${this.pos(node.child, b)}, ${c}, max(${seg}, 1.0), ${rot})`);
      }
      case "twist": {
        this.use("posTwist");
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const k = typeof node.strength === "number" ? this.f(node, "strength", node.strength) : this.field(node.strength, b);
        return b.local("float2", `sdf_posTwist(${this.pos(node.child, b)}, ${c}, ${k})`);
      }
      case "cellId": {
        this.use("cellId");
        const sp = `max(${this.xy(node, "spacingX", "spacingY", node.spacingX, node.spacingY)}, float2(0.001))`;
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        return b.local("float2", `sdf_posCellId(${this.pos(node.child, b)}, ${sp}, ${c})`);
      }
      default:
        this.problems.push(`position op "${(node as { kind: string }).kind}" has no Skia lowering`);
        return "p";
    }
  }

  // ---- scalar fields (float) ----

  field(node: ScalarFieldNode, b: Body): string {
    const hit = b.field.get(node);
    if (hit) return hit;
    const out = this.fieldUncached(node, b);
    b.field.set(node, out);
    return out;
  }

  private fieldUncached(node: ScalarFieldNode, b: Body): string {
    switch (node.kind) {
      case "constant":
        return this.f(node, "value", node.value);
      case "remap": {
        const child = this.field(node.child, b);
        const inMin = this.f(node, "inMin", node.inMin);
        const inMax = this.f(node, "inMax", node.inMax);
        const outMin = this.f(node, "outMin", node.outMin);
        const outMax = this.f(node, "outMax", node.outMax);
        const t = `(${child} - ${inMin}) / max(${inMax} - ${inMin}, 0.000001)`;
        return b.local("float", `${outMin} + ${node.clamp ? `clamp(${t}, 0.0, 1.0)` : `(${t})`} * (${outMax} - ${outMin})`);
      }
      case "mathOp": {
        const a = this.field(node.a, b);
        const bb = this.field(node.b, b);
        const c = this.field(node.c, b);
        const r = this.mathOp(node.op, a, bb, c);
        return b.local("float", node.clamp ? `clamp(${r}, 0.0, 1.0)` : r);
      }
      case "noise": {
        this.use("snoiseFbm");
        const pos = this.pos(node.position, b);
        const scale = this.f(node, "scale", node.scale);
        const off = `float2(${this.f(node, "offsetX", node.offsetX)}, ${this.f(node, "offsetY", node.offsetY)})`;
        const seed = this.f(node, "seed", node.seed);
        const oct = this.f(node, "octaves", node.octaves);
        const pers = this.f(node, "persistence", node.persistence);
        const lac = this.f(node, "lacunarity", node.lacunarity);
        const lo = this.f(node, "outLo", node.outLo);
        const hi = this.f(node, "outHi", node.outHi);
        const w = this.f(node, "w", node.w ?? 0);
        return b.local(
          "float",
          `${lo} + (${hi} - ${lo}) * ((sdf_snoiseFbm(${pos}, ${scale}, ${off}, ${seed}, int(${oct}), ${pers}, ${lac}, ${w}) + 1.0) * 0.5)`
        );
      }
      default:
        this.problems.push(`scalar field "${(node as { kind: string }).kind}" has no Skia lowering`);
        return "0.0";
    }
  }

  // engine/sdf-compile.ts mathOpExpr, with ES2 polyfills.
  private mathOp(op: string, a: string, b: string, c: string): string {
    switch (op) {
      case "Add": return `(${a} + ${b})`;
      case "Subtract": return `(${a} - ${b})`;
      case "Multiply": return `(${a} * ${b})`;
      case "Divide": return `((abs(${b}) < 0.00001) ? 0.0 : (${a} / ${b}))`;
      case "Multiply Add": return `(${a} * ${b} + ${c})`;
      case "Power": return `pow(max(${a}, 0.0), ${b})`;
      case "Logarithm": return `((${a} <= 0.0 || ${b} <= 0.0 || ${b} == 1.0) ? 0.0 : log(${a}) / log(${b}))`;
      case "Square Root": return `sqrt(max(${a}, 0.0))`;
      case "Inverse Square Root": return `((${a} <= 0.0) ? 0.0 : 1.0 / sqrt(${a}))`;
      case "Absolute": return `abs(${a})`;
      case "Exponent": return `exp(${a})`;
      case "Minimum": return `min(${a}, ${b})`;
      case "Maximum": return `max(${a}, ${b})`;
      case "Less Than": return `((${a} < ${b}) ? 1.0 : 0.0)`;
      case "Greater Than": return `((${a} > ${b}) ? 1.0 : 0.0)`;
      case "Sign": return `sign(${a})`;
      case "Compare": return `((abs(${a} - ${b}) <= ${c}) ? 1.0 : 0.0)`;
      case "Smooth Minimum": this.use("smin"); return `sdf_smin(${a}, ${b}, ${c})`;
      case "Smooth Maximum": this.use("smax"); return `sdf_smax(${a}, ${b}, ${c})`;
      case "Round": return `floor(${a} + 0.5)`;
      case "Floor": return `floor(${a})`;
      case "Ceiling": return `ceil(${a})`;
      case "Truncate": this.use("hyper"); return `sdf_trunc(${a})`;
      case "Fraction": return `fract(${a})`;
      case "Truncated Modulo": this.use("hyper"); return `((abs(${b}) < 0.00001) ? 0.0 : (${a} - sdf_trunc(${a} / ${b}) * ${b}))`;
      case "Floored Modulo": return `((abs(${b}) < 0.00001) ? 0.0 : (${a} - floor(${a} / ${b}) * ${b}))`;
      case "Wrap": return `(${b} + mod(mod(${a} - ${b}, max(${c} - ${b}, 0.00001)) + max(${c} - ${b}, 0.00001), max(${c} - ${b}, 0.00001)))`;
      case "Snap": return `((abs(${b}) < 0.00001) ? ${a} : floor(${a} / ${b} + 0.5) * ${b})`;
      case "Ping-Pong": return `((${b}) - abs(mod(mod(${a}, 2.0 * ${b}) + 2.0 * ${b}, 2.0 * ${b}) - ${b}))`;
      case "Sine": return `sin(${a})`;
      case "Cosine": return `cos(${a})`;
      case "Tangent": return `tan(${a})`;
      case "Arcsine": return `asin(clamp(${a}, -1.0, 1.0))`;
      case "Arccosine": return `acos(clamp(${a}, -1.0, 1.0))`;
      case "Arctangent": return `atan(${a})`;
      case "Arctan2": return `atan(${a}, ${b})`;
      case "Hyperbolic Sine": this.use("hyper"); return `sdf_sinh(${a})`;
      case "Hyperbolic Cosine": this.use("hyper"); return `sdf_cosh(${a})`;
      case "Hyperbolic Tangent": this.use("hyper"); return `sdf_tanh(${a})`;
      case "To Radians": return `(${a} * 0.0174532925199433)`;
      case "To Degrees": return `(${a} * 57.29577951308232)`;
      default: return `(${a} + ${b})`;
    }
  }

  // ---- distance pipeline (float) ----

  dist(node: SdfNode, b: Body): string {
    if (node.kind === "empty") return "1e10";
    const hit = b.dist.get(node);
    if (hit) return hit;
    const expr = this.distUncached(node, b);
    const out = /^[A-Za-z_]\w*$/.test(expr) || expr === "1e10" ? expr : b.local("float", expr);
    b.dist.set(node, out);
    return out;
  }

  private distUncached(node: SdfNode, b: Body): string {
    switch (node.kind) {
      case "empty":
        return "1e10";
      case "material":
        if (node.ramp) this.problems.push("SDF Material ramp mode samples a LUT texture — not ported to Skia (use constant mode)");
        return this.dist(node.child, b);
      case "circle": {
        const pos = this.pos(node.position, b);
        return `length(${pos} - ${this.xy(node, "cx", "cy", node.cx, node.cy)}) - ${this.f(node, "r", node.r)}`;
      }
      case "rect": {
        this.use("rect");
        const pos = this.pos(node.position, b);
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const s = b.local("float2", `max(${this.xy(node, "sx", "sy", node.sx, node.sy)}, float2(0.0))`);
        const r = `max(min(min(${s}.x, ${s}.y), ${this.f(node, "cornerRadius", node.cornerRadius)}), 0.0)`;
        return `sdf_rect(${pos}, ${c}, ${s}, ${r})`;
      }
      case "lineSegment": {
        this.use("seg");
        const pos = this.pos(node.position, b);
        const a = this.xy(node, "ax", "ay", node.ax, node.ay);
        const bb = this.xy(node, "bx", "by", node.bx, node.by);
        return `sdf_seg(${pos}, ${a}, ${bb}, max(${this.f(node, "r", node.r)}, 0.0))`;
      }
      case "polygon": {
        this.use("poly");
        const pos = this.pos(node.position, b);
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const r = this.f(node, "r", node.r);
        let n: string;
        if (typeof node.sides === "number") {
          n = `max(${this.f(node, "sides", node.sides)}, 3.0)`;
        } else {
          const raw = this.field(node.sides, b);
          n = node.quantizeSides ? `max(floor(${raw} + 0.5), 3.0)` : raw;
        }
        return `sdf_poly(${pos} - ${c}, ${r}, ${n})`;
      }
      case "triangle": {
        this.use("tri");
        const pos = this.pos(node.position, b);
        const a = this.xy(node, "ax", "ay", node.ax, node.ay);
        const bb = this.xy(node, "bx", "by", node.bx, node.by);
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        return `sdf_tri(${pos}, ${a}, ${bb}, ${c})`;
      }
      case "star": {
        this.use("star");
        const pos = this.pos(node.position, b);
        const c = this.xy(node, "cx", "cy", node.cx, node.cy);
        const r = this.f(node, "r", node.r);
        const n = b.local("float", `max(${this.f(node, "sides", node.sides)}, 3.0)`);
        const m = `max(min(${n}, ${this.f(node, "sharpness", node.sharpness)}), 2.0)`;
        return `sdf_star(${pos} - ${c}, ${r}, ${n}, ${m})`;
      }
      case "splineSdf":
        return `${this.splineFn(node)}(${this.pos(node.position, b)})`;
      case "sdfFromImage":
        this.problems.push("an SDF sampled from an image (SDF From Image, Text's SDF output) needs an engine texture — not ported to Skia");
        return "1e10";
      case "displace":
        this.problems.push("SDF Displace samples an engine image — not ported to Skia");
        return this.dist(node.child, b);
      case "union":
        return `min(${this.dist(node.a, b)}, ${this.dist(node.b, b)})`;
      case "intersection":
        return `max(${this.dist(node.a, b)}, ${this.dist(node.b, b)})`;
      case "subtraction":
        return `max(${this.dist(node.a, b)}, -(${this.dist(node.b, b)}))`;
      case "smoothUnion":
        this.use("smin");
        return `sdf_smin(${this.dist(node.a, b)}, ${this.dist(node.b, b)}, ${this.k(node)})`;
      case "smoothIntersection":
        this.use("smax");
        return `sdf_smax(${this.dist(node.a, b)}, ${this.dist(node.b, b)}, ${this.k(node)})`;
      case "smoothSubtraction":
        this.use("smax");
        return `sdf_smax(${this.dist(node.a, b)}, -(${this.dist(node.b, b)}), ${this.k(node)})`;
      case "morph":
        if (node.a.kind === "empty") return this.dist(node.b, b);
        if (node.b.kind === "empty") return this.dist(node.a, b);
        return `mix(${this.dist(node.a, b)}, ${this.dist(node.b, b)}, ${this.t(node)})`;
      case "round":
        return `${this.dist(node.child, b)} - ${this.f(node, "r", node.r)}`;
      case "onion":
        return `abs(${this.dist(node.child, b)}) - max(${this.f(node, "thickness", node.thickness)}, 0.0)`;
      default:
        this.problems.push(`SDF node "${(node as { kind: string }).kind}" has no Skia lowering`);
        return "1e10";
    }
  }

  private k(node: Extract<SdfNode, { k: number }>): string {
    return `max(${this.f(node, "k", node.k)}, 0.0)`;
  }

  private t(node: Extract<SdfNode, { kind: "morph" }>): string {
    return `clamp(${this.f(node, "t", node.t)}, 0.0, 1.0)`;
  }

  // One function per SDF Spline leaf (shared by both pipelines): distance
  // to the flattened polyline, signed by a horizontal-ray winding count
  // when closed.
  private splineFn(node: Extract<SdfNode, { kind: "splineSdf" }>): string {
    const known = this.nodeFnFor.get(node);
    if (known) return known;
    const seg = splineSegments(node);
    const count = Math.max(0, Math.min(node.segCount, seg.data ? seg.data.length / 4 : 0));
    if (!seg.data) this.problems.push(seg.problem);
    if (count > SKIA_SDF_MAX_SEGMENTS) {
      this.problems.push(`SDF Spline has ${count} segments; the Skia port caps at ${SKIA_SDF_MAX_SEGMENTS} (fragment uniform budget on phones) — lower its Subdivisions or simplify the path`);
    }
    const cap = SKIA_SDF_SPLINE_BUCKETS.find((n) => n >= count) ?? SKIA_SDF_MAX_SEGMENTS;
    const values = new Array<number>(cap * 4).fill(0);
    for (let i = 0; i < Math.min(count, cap) * 4; i++) values[i] = seg.data![i];
    const deps = ["spline", "subdivisions"];
    const segs = this.derived(node, "segs", values, deps, `uniform float4 $[${cap}];`);
    const n = this.derived(node, "count", Math.min(count, cap), deps, "uniform float $;");
    const closed = this.derived(node, "closed", node.closed ? 1 : 0, ["spline", "force_open"], "uniform float $;");
    const name = `sdf_spline${this.id(node)}`;
    this.nodeFns.push(`float ${name}(float2 p) {
  float d = 1e10;
  float wind = 0.0;
  for (int i = 0; i < ${cap}; i++) {
    if (float(i) >= ${n}) break;
    float4 s = ${segs}[i];
    float2 a = s.xy;
    float2 b = s.zw;
    float2 ba = b - a;
    float2 pa = p - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
    d = min(d, length(pa - ba * h));
    if ((a.y > p.y) != (b.y > p.y)) {
      float xCross = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (p.x < xCross) wind += 1.0;
    }
  }
  return (${closed} > 0.5 && mod(wind, 2.0) > 0.5) ? -d : d;
}`);
    this.nodeFnFor.set(node, name);
    return name;
  }

  // ---- colour pipeline (Surf) ----

  surf(node: SdfNode, b: Body, mat: Material): string {
    const key = `${this.surfKey(node)}|${mat.key}`;
    const hit = b.surf.get(key);
    if (hit) return hit;
    const expr = this.surfUncached(node, b, mat);
    const out = /^[A-Za-z_]\w*$/.test(expr) ? expr : b.local("Surf", expr);
    b.surf.set(key, out);
    return out;
  }

  private surfKey(node: object): number {
    let k = this.surfIds.get(node);
    if (k === undefined) {
      k = this.surfIds.size;
      this.surfIds.set(node, k);
    }
    return k;
  }

  private surfUncached(node: SdfNode, b: Body, mat: Material): string {
    switch (node.kind) {
      case "material": {
        if (node.ramp) {
          this.problems.push("SDF Material ramp mode samples a LUT texture — not ported to Skia (use constant mode)");
        }
        const col = `${this.color(node, "color", node.color)}.rgb`;
        // No param sets a material's bleed weight (SDF Material and paintSdf
        // both write 1), so it is a literal rather than an unbound uniform.
        const w = floatLiteral(node.bleed);
        return this.surf(node.child, b, { col, w, key: `m${this.surfKey(node)}` });
      }
      case "empty":
        return `sLeaf(1e10, ${mat.col}, 0.0)`;
      case "circle":
      case "rect":
      case "lineSegment":
      case "polygon":
      case "triangle":
      case "star":
      case "splineSdf":
      case "sdfFromImage":
        return `sLeaf(${this.dist(node, b)}, ${mat.col}, ${mat.w})`;
      case "union":
        return `sUnion(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)})`;
      case "intersection":
        return `sIntersect(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)})`;
      case "subtraction":
        return `sSubtract(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)})`;
      case "smoothUnion":
        return `sSmoothUnion(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)}, ${this.k(node)})`;
      case "smoothIntersection":
        return `sSmoothIntersect(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)}, ${this.k(node)})`;
      case "smoothSubtraction":
        return `sSmoothSubtract(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)}, ${this.k(node)})`;
      case "morph":
        if (node.a.kind === "empty") return this.surf(node.b, b, mat);
        if (node.b.kind === "empty") return this.surf(node.a, b, mat);
        return `sMorph(${this.surf(node.a, b, mat)}, ${this.surf(node.b, b, mat)}, ${this.t(node)})`;
      case "round":
        return `sOffset(${this.surf(node.child, b, mat)}, ${this.f(node, "r", node.r)})`;
      case "onion":
        return `sOnion(${this.surf(node.child, b, mat)}, max(${this.f(node, "thickness", node.thickness)}, 0.0))`;
      case "displace":
        this.problems.push("SDF Displace samples an engine image — not ported to Skia");
        return this.surf(node.child, b, mat);
      default:
        this.problems.push(`SDF node "${(node as { kind: string }).kind}" has no Skia lowering`);
        return `sLeaf(1e10, ${mat.col}, 0.0)`;
    }
  }
}

function floatLiteral(x: number): string {
  const v = Number.isFinite(x) ? x : 0;
  const t = String(v);
  return /[.eE]/.test(t) ? t : `${t}.0`;
}

// ---- spline segments ----------------------------------------------------------------------

const flatCache = new WeakMap<object, Map<number, Float32Array>>();

// The flattened segments behind a splineSdf leaf, recomputed from the wired
// spline the way SDF Spline flattens it (the tree only carries a texture).
function splineSegments(node: object): { data: Float32Array; problem?: undefined } | { data: null; problem: string } {
  const prov = sdfProvenance(node);
  const spline = prov?.sockets.spline as SocketValue | undefined;
  if (!prov || !spline || spline.kind !== "spline") {
    return { data: null, problem: "SDF Spline's segments are unavailable (its node was not instrumented) — not ported to Skia here" };
  }
  const subdivisions = Math.max(1, Math.round(typeof prov.params.subdivisions === "number" ? prov.params.subdivisions : 16));
  let bySub = flatCache.get(spline);
  if (!bySub) {
    bySub = new Map();
    flatCache.set(spline, bySub);
  }
  let data = bySub.get(subdivisions);
  if (!data) {
    data = flattenSpline(spline as SplineValue, subdivisions).segments;
    bySub.set(subdivisions, data);
  }
  return { data };
}

// ---- programs ---------------------------------------------------------------------------------

const UV_FN = `float2 sdf_uv(float2 fc) {
  float2 p = float2(fc.x / iResolution.x, 1.0 - fc.y / iResolution.y);
  if (t_aspect_correct > 0.5) {
    float aspect = iResolution.x / iResolution.y;
    p = float2(p.x, (p.y - 0.5) / aspect + 0.5);
  }
  return p;
}`;

const PREMUL = "return half4(c.rgb * c.a, c.a);";

function mainBody(mode: SkiaSdfMode): string[] {
  const head = ["float2 p = sdf_uv(fc);", "float pixel = 1.0 / max(iResolution.x, iResolution.y);"];
  switch (mode) {
    case "rasterize":
      return [
        ...head,
        "Surf s = sdf_s(p);",
        "float d = s.d;",
        "float soft = max(max(t_softness, 0.0) * pixel, pixel * 0.5);",
        "float fillMask = sdf_smooth(soft, -soft, d);",
        "float4 c = mix(float4(t_background.rgb, t_bg_alpha), float4(s.c, t_fg_alpha), fillMask);",
        "float cwPx = max(t_contour_width, 0.0);",
        "if (cwPx > 0.0) {",
        "  float cw = cwPx * pixel;",
        "  float contourMask = sdf_smooth(cw + soft, max(cw - soft, 0.0), abs(d));",
        "  c = mix(c, float4(t_contour.rgb, t_contour_alpha), contourMask);",
        "}",
        PREMUL,
      ];
    case "mask":
      return [
        ...head,
        "float d = sdf_d(p);",
        "float soft = max(max(t_softness, 0.0) * pixel, pixel * 0.5);",
        "float m = sdf_smooth(t_threshold + soft, t_threshold - soft, d);",
        "if (t_invert > 0.5) m = 1.0 - m;",
        "return half4(half(m), half(m), half(m), 1.0);",
      ];
    case "distance":
      return [
        ...head,
        "float d = sdf_d(p);",
        "float t = clamp(d / max(t_range, 0.00001), -1.0, 1.0);",
        "float3 col = (t < 0.0) ? mix(t_zero_color.rgb, t_neg_color.rgb, -t) : mix(t_zero_color.rgb, t_pos_color.rgb, t);",
        "float4 c = float4(col, t_alpha);",
        PREMUL,
      ];
    case "bevel":
      return [
        ...head,
        "float soften = max(t_soften, 0.0);",
        "float stepPx = max((1.0 + soften * 0.5) * pixel, pixel * 0.5);",
        "Surf s = sdf_s(p);",
        "float d = s.d;",
        "float depthN = max(t_depth, 0.000001);",
        "float h = sdf_bevelH(d, depthN);",
        "float hL = sdf_bevelH(sdf_d(p - float2(stepPx, 0.0)), depthN);",
        "float hR = sdf_bevelH(sdf_d(p + float2(stepPx, 0.0)), depthN);",
        "float hD = sdf_bevelH(sdf_d(p - float2(0.0, stepPx)), depthN);",
        "float hU = sdf_bevelH(sdf_d(p + float2(0.0, stepPx)), depthN);",
        "float3 n = normalize(float3(hL - hR, hU - hD, 0.5));",
        "float soft = max(soften * pixel, pixel * 0.5);",
        "float fillMask = sdf_smooth(soft, -soft, d);",
        "float4 base = mix(float4(t_background.rgb, t_bg_alpha), float4(s.c, t_fg_alpha), fillMask);",
        "float3 col = base.rgb;",
        "col = sdf_light(col, n, sdf_lightDir(t_l1_angle, t_l1_elevation), t_l1_hi_op, t_l1_sh_op, t_highlight_color.rgb, t_shadow_color.rgb, t_highlight_blend, t_shadow_blend);",
        "col = sdf_light(col, n, sdf_lightDir(t_l2_angle, t_l2_elevation), t_l2_hi_op, t_l2_sh_op, t_highlight_color.rgb, t_shadow_color.rgb, t_highlight_blend, t_shadow_blend);",
        "float4 c = float4(col, base.a);",
        PREMUL,
      ];
    case "shade":
      return [
        ...head,
        "Surf s = sdf_s(p);",
        "float d = s.d;",
        "float bleedMix = t_bleed > 0.5 ? t_bleed_mix : 0.0;",
        "float3 bleedCol = s.acc / max(s.accW, 0.0001);",
        "float3 matCol = (s.accW > 0.000001) ? mix(s.c, bleedCol, bleedMix) : s.c;",
        "float soft = max(max(t_softness, 0.0) * pixel, pixel * 0.5);",
        "float fillMask = sdf_smooth(soft, -soft, d);",
        "if (t_channel > 4.5) { return half4(half(fillMask), half(fillMask), half(fillMask), 1.0); }",
        "if (t_channel > 3.5) { return half4(half3(bleedCol), 1.0); }",
        "float4 acc = float4(t_background.rgb, t_bg_alpha);",
        "if (bleedMix > 0.0 && s.accW > 0.000001) {",
        "  acc = sdf_srcOver(float4(bleedCol, clamp(s.accW, 0.0, 1.0) * bleedMix), acc);",
        "}",
        "float glowAmt = 0.0;",
        "float3 glowCol = (t_glow_color_mode < 0.5) ? matCol : t_glow_color.rgb;",
        "if (t_glow > 0.5) {",
        "  float g = exp(-max(d, 0.0) / max(max(t_glow_radius, 0.001), 0.00001));",
        "  glowAmt = clamp(g * t_glow_intensity, 0.0, 1.0);",
        "}",
        "if (t_channel > 2.5) { float4 c = float4(glowCol, glowAmt); " + PREMUL + " }",
        "if (t_glow > 0.5) {",
        "  if (t_glow_blend < 0.5) {",
        "    acc = sdf_srcOver(float4(glowCol, glowAmt), acc);",
        "  } else if (t_glow_blend < 1.5) {",
        "    acc = float4(acc.rgb + glowCol * glowAmt, max(acc.a, glowAmt));",
        "  } else {",
        "    acc = float4(float3(1.0) - (float3(1.0) - acc.rgb) * (float3(1.0) - glowCol * glowAmt), max(acc.a, glowAmt));",
        "  }",
        "}",
        "acc = sdf_srcOver(float4(matCol, t_fill_alpha * fillMask), acc);",
        "float depthN = max(t_depth, 0.000001);",
        "float h = sdf_shadeH(d, depthN);",
        "float3 n = float3(0.0, 0.0, 1.0);",
        "if (t_light > 0.5 || (t_channel > 0.5 && t_channel < 2.5)) {",
        "  float stepPx = max((1.0 + max(t_soften, 0.0) * 0.5) * pixel, pixel * 0.5);",
        "  float hL = sdf_shadeH(sdf_d(p - float2(stepPx, 0.0)), depthN);",
        "  float hR = sdf_shadeH(sdf_d(p + float2(stepPx, 0.0)), depthN);",
        "  float hD = sdf_shadeH(sdf_d(p - float2(0.0, stepPx)), depthN);",
        "  float hU = sdf_shadeH(sdf_d(p + float2(0.0, stepPx)), depthN);",
        "  n = normalize(float3(hL - hR, hU - hD, 0.5));",
        "}",
        "if (t_channel > 1.5) { return half4(half(h), half(h), half(h), 1.0); }",
        "if (t_channel > 0.5) { return half4(half3(n * 0.5 + 0.5), 1.0); }",
        "if (t_light > 0.5) {",
        "  float3 col = acc.rgb;",
        "  col = sdf_light(col, n, sdf_lightDir(t_l1_angle, t_l1_elevation), t_l1_hi_op, t_l1_sh_op, t_highlight_color.rgb, t_shadow_color.rgb, t_highlight_blend, t_shadow_blend);",
        "  col = sdf_light(col, n, sdf_lightDir(t_l2_angle, t_l2_elevation), t_l2_hi_op, t_l2_sh_op, t_highlight_color.rgb, t_shadow_color.rgb, t_highlight_blend, t_shadow_blend);",
        "  acc = float4(col, acc.a);",
        "}",
        "float cwPx = max(t_contour_width, 0.0);",
        "if (t_contour > 0.5 && cwPx > 0.0) {",
        "  float cw = cwPx * pixel;",
        "  float spacing = max(t_contour_spacing, 0.0);",
        "  float dist = abs(d);",
        "  if (spacing > 0.0) {",
        "    float band = mod(d, spacing);",
        "    dist = min(band, spacing - band);",
        "  }",
        "  float m = sdf_smooth(cw + soft, max(cw - soft, 0.0), dist);",
        "  acc = sdf_srcOver(float4(t_contour_color.rgb, t_contour_alpha * m), acc);",
        "}",
        "float4 c = acc;",
        PREMUL,
      ];
  }
}

const BEVEL_H = `float sdf_bevelH(float dd, float depth) {
  if (t_style < 0.5) return (dd <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depth, dd);
  if (t_style < 1.5) return (dd >= 0.0) ? 0.0 : smoothstep(0.0, depth, -dd);
  if (t_style < 2.5) return clamp(0.5 - 0.5 * dd / depth, 0.0, 1.0);
  return 1.0 - smoothstep(0.0, depth, abs(dd));
}`;

// The height curve: engine/float-curve.ts evalMonotoneCubic over the
// uniform points (x, y, tangent), then SDF Shade's LUT read — 256 texels of
// round(clamp(curve((i + 0.5) / 256)) * 255) / 255, linearly filtered with
// clamp-to-edge — rebuilt from the two texels around the lookup.
const SHADE_H = `float sdf_curveEval(float x) {
  float n = t_height_curve_count;
  float4 a = t_height_curve[0];
  if (n < 0.5) return 0.0;
  if (n < 1.5 || x <= a.x) return a.y;
  float4 b = a;
  float4 last = a;
  bool found = false;
  for (int i = 1; i < ${SKIA_SDF_CURVE_POINTS}; i++) {
    if (float(i) >= n) break;
    float4 c = t_height_curve[i];
    last = c;
    if (!found && x <= c.x) {
      b = c;
      found = true;
    }
    if (!found) a = c;
  }
  if (!found) return last.y;
  float h = b.x - a.x;
  if (h == 0.0) return a.y;
  float t = (x - a.x) / h;
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * a.y + (t3 - 2.0 * t2 + t) * h * a.z + (-2.0 * t3 + 3.0 * t2) * b.y + (t3 - t2) * h * b.z;
}
float sdf_curveTexel(float i) {
  return floor(clamp(sdf_curveEval((i + 0.5) / 256.0), 0.0, 1.0) * 255.0 + 0.5) / 255.0;
}
float sdf_curveLut(float u) {
  float tc = u * 256.0 - 0.5;
  float i0 = floor(tc);
  float f = tc - i0;
  return mix(sdf_curveTexel(clamp(i0, 0.0, 255.0)), sdf_curveTexel(clamp(i0 + 1.0, 0.0, 255.0)), f);
}
float sdf_shadeH(float dd, float depth) {
  if (t_height_mode < 0.5) return (dd <= 0.0) ? 1.0 : 1.0 - smoothstep(0.0, depth, dd);
  if (t_height_mode < 1.5) return (dd >= 0.0) ? 0.0 : smoothstep(0.0, depth, -dd);
  if (t_height_mode < 2.5) return clamp(0.5 - 0.5 * dd / depth, 0.0, 1.0);
  if (t_height_mode < 3.5) return 1.0 - smoothstep(0.0, depth, abs(dd));
  return sdf_curveLut(clamp(0.5 - 0.5 * dd / depth, 0.0, 1.0));
}`;

const SURF_MODES = new Set<SkiaSdfMode>(["rasterize", "bevel", "shade"]);
const FLOAT_MODES = new Set<SkiaSdfMode>(["mask", "distance", "bevel", "shade"]);
const ROOT_MATERIAL: Partial<Record<SkiaSdfMode, string>> = {
  rasterize: "t_foreground.rgb",
  bevel: "t_foreground.rgb",
  shade: "t_fill_color.rgb",
};

export function compileSdfSksl(root: SdfNode, mode: SkiaSdfMode, opts: SdfSkslOptions): SdfSkslResult {
  const g = new SdfSkslGen();
  g.use("smooth");
  let distFn = "";
  let surfFn = "";
  if (FLOAT_MODES.has(mode)) {
    const b = new Body();
    const top = g.dist(root, b);
    distFn = [`float sdf_d(float2 p) {`, ...b.lines.map((l) => `  ${l}`), `  return ${top};`, `}`].join("\n");
  }
  if (SURF_MODES.has(mode)) {
    g.use(mode === "shade" ? "surfFull" : "surfLite");
    const b = new Body();
    const top = g.surf(root, b, { col: ROOT_MATERIAL[mode]!, w: "1.0", key: "root" });
    surfFn = [`Surf sdf_s(float2 p) {`, ...b.lines.map((l) => `  ${l}`), `  return ${top};`, `}`].join("\n");
  }
  if (mode === "bevel" || mode === "shade") {
    g.use("lightDir");
    g.use("light");
  }
  if (mode === "shade") g.use("srcOver");

  const problems = [...new Set(g.problems)];
  if (problems.length) return { program: null, problems };

  const uniforms: Record<string, Bind<number | number[]>> = {
    iResolution: { v: [opts.resolution[0], opts.resolution[1], 1] },
  };
  const termDecls: string[] = [];
  for (const [param, type] of SKIA_SDF_TERMINAL_UNIFORMS[mode]) {
    const name = `t_${param}`;
    const names = type === "curve" ? [name, `${name}_count`] : [name];
    const missing = names.filter((n) => !opts.terminal[n.slice(2)]);
    if (missing.length) {
      problems.push(`terminal uniform ${missing.join(", ")} has no bind`);
      continue;
    }
    if (type === "curve") {
      termDecls.push(`uniform float4 ${name}[${SKIA_SDF_CURVE_POINTS}];`, `uniform float ${name}_count;`);
    } else {
      termDecls.push(type === "color" ? `uniform float4 ${name};` : `uniform float ${name};`);
    }
    for (const n of names) uniforms[n] = opts.terminal[n.slice(2)];
  }
  if (problems.length) return { program: null, problems };
  Object.assign(uniforms, g.uniforms);

  const helpers = HELPER_ORDER.filter((h) => g.helpers.has(h)).map((h) => HELPERS[h]);
  const sksl = [
    `// Generated by toolbox (engine/skia/sdf/sksl.ts): SDF ${mode}`,
    "uniform float3 iResolution;",
    ...termDecls,
    ...g.decls,
    "",
    ...helpers,
    ...(mode === "bevel" ? [BEVEL_H] : mode === "shade" ? [SHADE_H] : []),
    ...g.nodeFns,
    ...(distFn ? [distFn] : []),
    ...(surfFn ? [surfFn] : []),
    UV_FN,
    colorManagementSksl(),
    "half4 sdf_main(float2 fc) {",
    ...mainBody(mode).map((l) => `  ${l}`),
    "}",
    "// The body's premultiplied sRGB result → the destination's working space.",
    "half4 main(float2 fc) {",
    "  return tbx_cm_premul_out(float4(sdf_main(fc)));",
    "}",
    "",
  ].join("\n");
  return { program: { sksl, uniforms, children: [] }, problems: [] };
}
