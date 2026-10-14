import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { GATHER_EDGE } from "@/engine/skia/library/helpers-gather";
import { edgeDetectNode } from "../effect/edge-detect";

// Edge Detect (Skia) — the Skia-layer port of Edge Detect
// (specdocs/101326_skia-target.md §3.2 `sksl-gather`). EDGE_FS line for line:
// Rec. 601 luminance at the eight one-pixel neighbors (the center is never
// read), Sobel or Prewitt, magnitude × strength, hard threshold, opaque
// grey out. Unwired, the output is transparent like Edge Detect's (a
// transparent upstream would otherwise read as opaque black).

const EDGE_SKSL = `float tbx_edge_detect_lum(float2 uv, float2 res) {
  return dot($src(tbx_gather_edge_uv(uv, res)).rgb, float3(0.299, 0.587, 0.114));
}

float4 tbx_edge_detect(float2 uv, float2 res, int algorithm, float strength, float threshold) {
  float2 o = 1.0 / res;
  float lnw = tbx_edge_detect_lum(uv + float2(-o.x, -o.y), res);
  float ln = tbx_edge_detect_lum(uv + float2(0.0, -o.y), res);
  float lne = tbx_edge_detect_lum(uv + float2(o.x, -o.y), res);
  float lw = tbx_edge_detect_lum(uv + float2(-o.x, 0.0), res);
  float le = tbx_edge_detect_lum(uv + float2(o.x, 0.0), res);
  float lsw = tbx_edge_detect_lum(uv + float2(-o.x, o.y), res);
  float ls = tbx_edge_detect_lum(uv + float2(0.0, o.y), res);
  float lse = tbx_edge_detect_lum(uv + float2(o.x, o.y), res);
  float gx;
  float gy;
  if (algorithm == 0) {
    // Sobel: center row/column weighted 2x.
    gx = -lnw + lne - 2.0 * lw + 2.0 * le - lsw + lse;
    gy = -lnw - 2.0 * ln - lne + lsw + 2.0 * ls + lse;
  } else {
    // Prewitt: uniform weights.
    gx = -lnw + lne - lw + le - lsw + lse;
    gy = -lnw - ln - lne + lsw + ls + lse;
  }
  float mag = sqrt(gx * gx + gy * gy) * strength;
  if (mag < threshold) mag = 0.0;
  return float4(mag, mag, mag, 1.0);
}`;

export const skiaEdgeDetectNode = defineSkslNode({
  type: "skia-edge-detect",
  name: "Edge Detect (Skia)",
  mirrors: "edge-detect",
  subcategory: "modifier",
  description:
    "Skia-layer Edge Detect: Sobel or Prewitt gradient magnitude of the upstream shader's luminance, fused into the layer's one runtime shader by re-evaluating the upstream at the eight neighbor pixels. Same params as Edge Detect; output is opaque grey.",
  searchAliases: ["edge detect", "sobel", "prewitt", "outline", "gradient", "skia", "sksl"],
  facts: {
    gotchas: [
      "Eight evaluations of the upstream per pixel (the center is not read): 8× the cost of a procedural chain fused above it.",
      "Taps are one canvas pixel apart (1 / iResolution); on a device that is one point, so edges widen with pixel density.",
      "threshold clips the strength-scaled magnitude, so raising strength lowers the effective threshold.",
      "Output is opaque grey (the source alpha is discarded); unwired, it is transparent like Edge Detect's.",
    ],
  },
  fn: {
    id: "tbx.edge_detect@1",
    entry: "tbx_edge_detect",
    source: EDGE_SKSL,
    params: [
      { name: "algorithm", type: "int" },
      { name: "strength", type: "float" },
      { name: "threshold", type: "float" },
    ],
    inputs: [{ name: "src", mode: "gather", taps: 8 }],
    uses: [GATHER_EDGE],
    cost: 0.3,
  },
  params: mirrorParams(edgeDetectNode, ["algorithm", "strength", "threshold"]),
  inputs: [{ name: "image", fnInput: "src" }],
  whenUnwired: () => [0, 0, 0, 0],
});
