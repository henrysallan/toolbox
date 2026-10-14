import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { thresholdNode } from "../effect/threshold";

// Threshold (Skia) — the Skia-layer port of Threshold
// (specdocs/101326_skia-target.md §3.2): THRESHOLD_FS line for line. Rec. 709
// luma against the threshold, a hard step at softness 0 and a centred
// smoothstep window otherwise; source alpha kept.

const THRESHOLD_SKSL = `float4 tbx_threshold(float2 uv, float2 res, float threshold, float softness, int invert, float4 src) {
  float luma = dot(src.rgb, float3(0.2126, 0.7152, 0.0722));
  // The GL node clamps softness at 0 before upload.
  float soft = max(softness, 0.0);
  float t;
  if (soft <= 0.0) {
    t = step(threshold, luma);
  } else {
    t = smoothstep(threshold - soft * 0.5, threshold + soft * 0.5, luma);
  }
  if (invert == 1) t = 1.0 - t;
  return float4(t, t, t, src.a);
}`;

export const skiaThresholdNode = defineSkslNode({
  type: "skia-threshold",
  name: "Threshold (Skia)",
  mirrors: "threshold",
  subcategory: "modifier",
  description:
    "Skia-layer Threshold: pixels whose Rec. 709 luminance is above the threshold turn white, the rest black; softness widens the cut into a centred smoothstep, invert swaps the sides. Same params as Threshold; fuses into the layer's one runtime shader.",
  searchAliases: ["threshold", "binary", "black and white", "cutoff", "skia", "sksl"],
  facts: {
    gotchas: [
      "softness is the full width of the smoothstep window, centred on threshold (threshold ± softness/2); 0 is a hard step.",
      "RGB becomes the grey result (t, t, t); the source alpha passes through, so transparent pixels stay transparent.",
      "Luma is Rec. 709 of the straight-alpha source RGB. Unwired, the output is transparent like Threshold's.",
    ],
  },
  fn: {
    id: "tbx.threshold@1",
    entry: "tbx_threshold",
    source: THRESHOLD_SKSL,
    params: [
      { name: "threshold", type: "float" },
      { name: "softness", type: "float" },
      { name: "invert", type: "int" },
    ],
    inputs: [{ name: "src", mode: "pure" }],
    cost: 0.2,
  },
  params: mirrorParams(thresholdNode, ["threshold", "softness", "invert"]),
  inputs: [{ name: "image", fnInput: "src" }],
  whenUnwired: () => [0, 0, 0, 0],
});
