import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { SKSL_CURVE_MAX_POINTS } from "@/engine/skia/library/helpers-color";
import { colorCorrectionNode, GRADE_WHEELS } from "../effect/color-correction";
import { CURVE_LIB_PARAMS, curveBinds, curveProblems } from "./rgb-curves";

// Color Correction (Skia) — the Skia-layer port of Color Correction
// (specdocs/101326_skia-target.md §3.2). The GL node's fragment shader
// statement for statement: white balance, the four lift / gamma / gain /
// offset wheels, per-zone exposure and saturation, pivoted brightness /
// contrast, midtone detail, legacy hue / saturation, then the RGB curves —
// which reproduce the node's 8-bit LUT exactly as RGB Curves (Skia) does.

const N = SKSL_CURVE_MAX_POINTS;
const WHEEL_FIELDS = ["X", "Y", "Lum", "Exp", "Sat"] as const;
const WHEEL_PARAMS = GRADE_WHEELS.flatMap((w) => WHEEL_FIELDS.map((f) => `${w}${f}`));
const BAR_PARAMS = ["temp", "tint", "pivot", "md", "boffset"];
const SCALAR_PARAMS = ["hue", "saturation", "contrast", "brightness", ...WHEEL_PARAMS, ...BAR_PARAMS];

const COLOR_CORRECTION_SKSL = `float3 tbx_color_correction_wheel(float2 p, float lum) {
  float radius = min(length(p), 1.0);
  float ang = atan(p.x, -p.y);
  float hue = fract(ang / 6.2831853 + 1.0);
  float3 tint = tbx_cf_hsv2rgb(float3(hue, 1.0, 1.0)) - float3(1.0 / 3.0);
  return tint * radius * 0.8 + lum * 0.5;
}

float4 tbx_color_correction(float2 uv, float2 res, ${SCALAR_PARAMS.map((p) => `float ${p}`).join(", ")},
                            float4 curves_rgb[${N}], float4 curves_r[${N}], float4 curves_g[${N}],
                            float4 curves_b[${N}], float4 curves_count, float4 src) {
  float3 c = src.rgb;
  // White balance.
  c.r *= 1.0 + temp * 0.4;
  c.b *= 1.0 - temp * 0.4;
  c.g *= 1.0 + tint * 0.4;
  c.r *= 1.0 - tint * 0.2;
  c.b *= 1.0 - tint * 0.2;
  c = max(c, 0.0);
  // Lift / Gamma / Gain / Offset.
  float3 lift = tbx_color_correction_wheel(float2(darkX, darkY), darkLum);
  float3 gainv = 1.0 + tbx_color_correction_wheel(float2(lightX, lightY), lightLum);
  float3 gammav = 1.0 + tbx_color_correction_wheel(float2(shadowX, shadowY), shadowLum);
  float3 offv = tbx_color_correction_wheel(float2(globalX, globalY), globalLum);
  c = gainv * c + lift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / max(gammav, float3(0.05)));
  c = c + offv;
  c += float3(boffset * 0.2);
  // Zone weights.
  float luma = dot(clamp(c, 0.0, 1.0), float3(0.2126, 0.7152, 0.0722));
  float wDark = 1.0 - smoothstep(0.0, 0.5, luma);
  float wLight = smoothstep(0.5, 1.0, luma);
  float wMid = clamp(1.0 - abs(luma - 0.5) * 2.0, 0.0, 1.0);
  float ev = darkExp * wDark + shadowExp * wMid + lightExp * wLight + globalExp;
  c *= exp2(ev);
  float satF = 1.0 + (darkSat - 1.0) * wDark + (shadowSat - 1.0) * wMid + (lightSat - 1.0) * wLight + (globalSat - 1.0);
  float l2 = dot(c, float3(0.2126, 0.7152, 0.0722));
  c = mix(float3(l2), c, satF);
  // Brightness + contrast about the pivot, then midtone detail.
  c += float3(brightness);
  c = (c - pivot) * contrast + pivot;
  float3 cm = (c - 0.5) * (1.0 + md) + 0.5;
  c = mix(c, cm, wMid);
  c = clamp(c, 0.0, 1.0);
  // Legacy hue rotation (degrees → turns, wrapped like the GL node's
  // ((hue % 360) + 360) / 360) and saturation.
  float3 hsv = tbx_cf_rgb2hsv(c);
  hsv.x = fract(hsv.x + (hue - 360.0 * floor(hue / 360.0)) / 360.0 + 2.0);
  hsv.y = clamp(hsv.y * saturation, 0.0, 1.0);
  c = clamp(tbx_cf_hsv2rgb(hsv), 0.0, 1.0);
  c = tbx_cf_curves_apply(c, curves_rgb, curves_r, curves_g, curves_b, curves_count);
  return float4(c, src.a);
}`;

export const skiaColorCorrectionNode = defineSkslNode({
  type: "skia-color-correction",
  name: "Color Correction (Skia)",
  mirrors: "color-correction",
  subcategory: "modifier",
  description:
    "Skia-layer Color Correction: white balance, lift/gamma/gain/offset wheels, per-zone exposure and saturation, pivoted brightness/contrast, midtone detail, hue/saturation and RGB curves, fused into the layer's one runtime shader. Same params as Color Correction.",
  searchAliases: ["color correction", "grade", "lift gamma gain", "hue saturation", "skia", "sksl"],
  facts: {
    gotchas: [
      "Order: white balance, wheels, per-zone exposure/saturation, brightness/contrast (pivoted), midtone detail, hue/saturation, RGB curves last — as Color Correction.",
      "Wheel balance (X, Y) is a clockwise angle from up (red at top) with radius as strength; per-wheel Sat/Exp weight by luma zone.",
      "Curves reproduce the GL node's 8-bit 256-entry LUT; up to 16 points per curve (more emits transparent and reports it).",
      "Alpha passes through. Unwired, the output is opaque black like Color Correction's.",
    ],
  },
  fn: {
    id: "tbx.color_correction@1",
    entry: "tbx_color_correction",
    source: COLOR_CORRECTION_SKSL,
    params: [...SCALAR_PARAMS.map((name) => ({ name, type: "float" as const })), ...CURVE_LIB_PARAMS],
    inputs: [{ name: "src", mode: "pure" }],
    uses: ["tbx.cf.hsv", "tbx.cf.curve"],
    cost: 3,
  },
  params: mirrorParams(colorCorrectionNode, ["hue", "saturation", "contrast", "brightness", "curves", ...WHEEL_PARAMS, ...BAR_PARAMS]),
  inputs: [{ name: "image", fnInput: "src" }],
  binds: ({ params, nodeId }) => curveBinds(params, nodeId),
  whenUnwired: () => [0, 0, 0, 1],
  unsupported: (params) => curveProblems("Color Correction (Skia)", params),
});
