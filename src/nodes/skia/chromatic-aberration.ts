import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { TEXEL_HELPER } from "@/engine/skia/library/helpers-gather";
import { chromaticAberrationNode } from "../effect/chromatic-aberration";

// Chromatic Aberration (Skia) — the Skia-layer port of Chromatic Aberration
// (specdocs/101326_skia-target.md §3.2 `sksl-gather`). CA_FS line for line:
// three taps of the upstream (R at +offset, G at the pixel, B at −offset),
// out-of-frame taps transparent, alpha the max of the three. The center's
// Y-down → Y-up flip and the angle's degrees → radians, done on the CPU by
// the GL node, happen in the shader so each param ships as its own track.
// Opacity is folded into alpha (the evaluator's universal fade).

const CA_SKSL = `float4 tbx_chromatic_aberration_samp(float2 uv, float2 res) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return float4(0.0);
  return $src(tbx_texel_clamp(uv, res));
}

float4 tbx_chromatic_aberration(float2 uv, float2 res, float amount, int mode, float2 center,
                                float falloff, float angle, float opacity) {
  float2 dir;
  float k = 1.0;
  if (mode == 0) {
    // Stored center is normalized Y-DOWN; uv is Y-UP.
    float2 d = uv - float2(center.x, 1.0 - center.y);
    dir = d;
    k = pow(clamp(length(d) * 2.0, 0.0, 1.0), max(0.0, falloff));
  } else {
    float a = angle * 3.141592653589793 / 180.0;
    dir = float2(cos(a), sin(a));
  }
  float2 off = dir * amount * k;
  float4 r = tbx_chromatic_aberration_samp(uv + off, res);
  float4 g = tbx_chromatic_aberration_samp(uv, res);
  float4 b = tbx_chromatic_aberration_samp(uv - off, res);
  float alpha = max(max(r.a, g.a), b.a);
  return float4(r.r, g.g, b.b, alpha * clamp(opacity, 0.0, 1.0));
}`;

export const skiaChromaticAberrationNode = defineSkslNode({
  type: "skia-chromatic-aberration",
  name: "Chromatic Aberration (Skia)",
  mirrors: "chromatic-aberration",
  subcategory: "modifier",
  description:
    "Skia-layer Chromatic Aberration: splits red and blue away from green by re-evaluating the upstream shader at three offsets, fused into the layer's one runtime shader. Same params as Chromatic Aberration — radial (grows from a center, shaped by falloff) or directional (a uniform shift along angle).",
  searchAliases: ["chromatic aberration", "rgb split", "dispersion", "fringe", "skia", "sksl"],
  facts: {
    space: { "param:amount": "uv01", "param:center": "uv01" },
    gotchas: [
      "amount and center are uv fractions with no aspect term, as in Chromatic Aberration; center is Y-down like the param, flipped in the shader.",
      "Three taps of the upstream per pixel (R at +offset, G at the pixel, B at −offset): a 3× re-evaluation of everything fused above it.",
      "mode=directional ignores center and falloff; mode=radial ignores angle.",
      "Taps outside the frame read transparent; output alpha is the max of the three taps × opacity.",
    ],
  },
  fn: {
    id: "tbx.chromatic_aberration@1",
    entry: "tbx_chromatic_aberration",
    source: CA_SKSL,
    params: [
      { name: "amount", type: "float" },
      { name: "mode", type: "int" },
      { name: "center", type: "float2" },
      { name: "falloff", type: "float" },
      { name: "angle", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: [{ name: "src", mode: "gather", taps: 3 }],
    uses: [TEXEL_HELPER],
    cost: 0.2,
  },
  params: mirrorParams(chromaticAberrationNode, ["amount", "mode", "center", "falloff", "angle", "opacity"]),
  inputs: [{ name: "image", fnInput: "src" }],
});
