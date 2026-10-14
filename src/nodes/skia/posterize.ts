import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { posterizeNode } from "../effect/posterize";

// Posterize (Skia) — the Skia-layer port of Posterize
// (specdocs/101326_skia-target.md §3.2): POSTERIZE_FS line for line. Each
// channel (rgb) or the Rec. 709 luma (luma, rgb rescaled by the ratio)
// snaps to `levels` evenly spaced values in de-gamma'd space.

const POSTERIZE_SKSL = `float tbx_posterize_quant(float x, float L, float g) {
  float v = pow(clamp(x, 0.0, 1.0), 1.0 / g);
  float steps = max(L - 1.0, 1.0);
  float q = floor(v * steps + 0.5) / steps;
  return pow(clamp(q, 0.0, 1.0), g);
}

float4 tbx_posterize(float2 uv, float2 res, float levels, int channels, float gamma, float opacity, float4 src) {
  // The GL node floors levels at 2 and gamma at 0.001 before upload.
  float L = max(levels, 2.0);
  float g = max(gamma, 0.001);
  float3 rgb;
  if (channels == 1) {
    float l = dot(src.rgb, float3(0.2126, 0.7152, 0.0722));
    float ql = tbx_posterize_quant(l, L, g);
    float ratio = l > 1e-4 ? ql / l : 0.0;
    rgb = src.rgb * ratio;
  } else {
    rgb = float3(tbx_posterize_quant(src.r, L, g), tbx_posterize_quant(src.g, L, g), tbx_posterize_quant(src.b, L, g));
  }
  return float4(rgb, src.a * opacity);
}`;

export const skiaPosterizeNode = defineSkslNode({
  type: "skia-posterize",
  name: "Posterize (Skia)",
  mirrors: "posterize",
  subcategory: "modifier",
  description:
    "Skia-layer Posterize: quantizes the upstream shader to `levels` tonal steps per channel (rgb) or by brightness only (luma, hue kept), with a gamma that shifts where the bands land. Same params as Posterize; fuses into the layer's one runtime shader.",
  searchAliases: ["posterize", "quantize", "bands", "cel", "skia", "sksl"],
  facts: {
    gotchas: [
      "Snaps to L evenly spaced values including both ends, in de-gamma'd space (pow(x, 1/gamma)), then re-gammas; levels floors at 2 and gamma at 0.001.",
      "channels=luma rescales rgb by quantized/original Rec. 709 luma (near-black pixels go black), so hue is kept but rgb may exceed 1.",
      "Alpha passes through × opacity (folded into the shader). Unwired, the output is transparent like Posterize's.",
    ],
  },
  fn: {
    id: "tbx.posterize@1",
    entry: "tbx_posterize",
    source: POSTERIZE_SKSL,
    params: [
      { name: "levels", type: "float" },
      { name: "channels", type: "int" },
      { name: "gamma", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: [{ name: "src", mode: "pure" }],
    cost: 0.5,
  },
  params: mirrorParams(posterizeNode, ["levels", "channels", "gamma", "opacity"]),
  inputs: [{ name: "image", fnInput: "src" }],
  whenUnwired: () => [0, 0, 0, 0],
});
