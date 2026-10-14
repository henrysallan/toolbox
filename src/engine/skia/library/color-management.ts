// Color management for every toolbox runtime program
// (specdocs/101326_skia-target.md §5 decision 5, 2026-10-14).
//
// toolbox math — every library function, the SDF programs, an SkSL Shader's
// own main — runs on gamma-encoded sRGB numbers, exactly like the engine's
// GL shaders. Skia runs a runtime effect in the DESTINATION's working color
// space instead: on a Display P3 canvas (React Native Skia on a wide-gamut
// iPhone, no option to opt out) the color main returns is read as P3, and a
// child shader samples in P3. So every program generator converts at the
// program's boundaries with the `tbx.color.cm` helper below:
//
//   main        straight sRGB result → working space → premultiplied
//               (tbx_cm_out; tbx_cm_premul_out for a premultiplied result)
//   children    premultiplied working-space sample → straight sRGB
//               (tbx_cm_child; tbx_cm_premul_in keeps it premultiplied)
//   uniforms    plain sRGB numbers — never `layout(color)`, which would hand
//               the sRGB math P3 numbers
//
// The conversions are Skia's own intrinsics (toLinearSrgb / fromLinearSrgb,
// half3 in and out) around the exact sRGB transfer functions of
// tbx.color.srgb. Native drawing (paint colors, gradients, images) needs
// none of this: Skia converts those from their sRGB tags itself.
//
// Where sRGB numbers already ARE working-space numbers, nothing converts
// and the program is bit-for-bit its sRGB math: an sRGB canvas (toolbox,
// Android, React Native Skia web) and a destination with no color space
// (color management off — Skia then runs the intrinsics as identities;
// React Native Skia's snapshot and offscreen surfaces are untagged). The
// program tells them apart from a P3 canvas by one probe,
// fromLinearSrgb(0.5, 0, 0): (0.7354, 0, 0) on sRGB, (0.5, 0, 0) unmanaged,
// anything else converts. A LINEAR-sRGB working space would also probe as
// "unmanaged"; no toolbox target renders into one.
//
// Cost: the conversions are evaluated even where they are then discarded
// (two transfer functions + Skia's transform per boundary — main's result
// and each child sample), because Skia's CPU backend skips a color
// intrinsic inside a conditional once a child has been sampled; the probe
// only SELECTS the result. Small next to any fused program's math.
//
// fp16: the intrinsics are half3. Metal runs half as 16-bit, so on a P3
// iPhone a converted value carries ~2^-11 relative error (≤ 0.5/255 on the
// encoded result) — measured as fp32 in CanvasKit, to confirm on device.
//
// check:skia-color-management renders every program generator on sRGB and
// Display P3 CanvasKit surfaces and holds them to 1/255.

import "./helpers";
import { registerSkslHelper, resolveHelpers } from "./registry";

export const SKSL_CM_HELPER = "tbx.color.cm";

registerSkslHelper({
  id: SKSL_CM_HELPER,
  uses: ["tbx.color.srgb"],
  source: `// sRGB numbers are already working-space numbers (sRGB canvas, or no
// color space at all): convert nothing. See engine/skia/library/color-management.ts.
// The intrinsics are always evaluated, never inside a branch, and the result
// is SELECTED afterwards: Skia's CPU backend mis-runs a color-space intrinsic
// inside a conditional once a child has been sampled (CanvasKit 0.41.0).
bool tbx_cm_active() {
  half3 w = fromLinearSrgb(half3(0.5, 0.0, 0.0));
  float r = float(w.r);
  return abs(float(w.g)) + abs(float(w.b)) + min(abs(r - 0.735357), abs(r - 0.5)) > 0.002;
}
float3 tbx_cm_enc(float3 srgb) {
  return float3(fromLinearSrgb(half3(tbx_srgb_to_linear3(srgb))));
}
float3 tbx_cm_dec(float3 working) {
  return tbx_linear_to_srgb3(float3(toLinearSrgb(half3(working))));
}
// Straight sRGB ↔ the working space (rgb only).
float3 tbx_cm_to_working(float3 srgb) {
  float3 w = tbx_cm_enc(srgb);
  bool on = tbx_cm_active();
  return on ? w : srgb;
}
float3 tbx_cm_from_working(float3 working) {
  float3 s = tbx_cm_dec(working);
  bool on = tbx_cm_active();
  return on ? s : working;
}
// A straight-alpha sRGB result → what main returns (premultiplied, working).
// Converting, it takes the pixel an 8-bit sRGB canvas would store (each
// premultiplied channel clamped to 0..1), so an out-of-range result (a
// sharpen overshoot) clips the way it does on sRGB, not in P3.
half4 tbx_cm_out(float4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  float3 p = clamp(c.rgb * c.a, 0.0, 1.0);
  float3 w = tbx_cm_enc(a > 0.0 ? p / a : p);
  bool on = tbx_cm_active();
  return on ? half4(w * a, a) : half4(c.rgb * c.a, c.a);
}
// A child sample (premultiplied, working) → straight sRGB.
float4 tbx_cm_child(float4 c) {
  bool some = c.a > 0.0;
  float3 s = tbx_cm_from_working(some ? c.rgb / c.a : float3(0.0));
  return some ? float4(s, c.a) : float4(0.0);
}
// Premultiplied sRGB ↔ premultiplied working space. Color at alpha 0
// (additive light) converts as it is; out-of-range results clip as an
// 8-bit sRGB canvas clips them (see tbx_cm_out).
half4 tbx_cm_premul_out(float4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  float3 p = clamp(c.rgb, 0.0, 1.0);
  bool some = a > 0.0;
  float3 w = tbx_cm_enc(some ? p / a : p);
  bool on = tbx_cm_active();
  return on ? half4(some ? w * a : w, a) : half4(c);
}
half4 tbx_cm_premul_in(half4 h) {
  float4 c = float4(h);
  bool some = c.a > 0.0;
  float3 s = tbx_cm_dec(some ? c.rgb / c.a : c.rgb);
  bool on = tbx_cm_active();
  return on ? half4(some ? s * c.a : s, c.a) : h;
}`,
});

// The helper and its dependencies as one block of SkSL, for generators that
// assemble a whole program themselves (the SDF compiler, the SkSL Shader
// prelude) instead of going through the fuser's helper resolution.
export function colorManagementSksl(): string {
  const r = resolveHelpers([SKSL_CM_HELPER]);
  if (r.problems.length) throw new Error(r.problems.join("; "));
  return r.order.map((h) => `// ---- ${h.id}\n${h.source.trim()}`).join("\n");
}

// A program whose main hands its result through the helper — what every
// toolbox generator emits. The manifests' `colorManaged` reads this.
export function isColorManagedSksl(sksl: string): boolean {
  const code = sksl.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return /\bbool\s+tbx_cm_active\s*\(/.test(code) && /\btbx_cm_(?:premul_)?out\s*\(/.test(code.replace(/\b(?:half4|float4)\s+tbx_cm_(?:premul_)?out\s*\(/g, ""));
}
