import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { GATHER_EDGE } from "@/engine/skia/library/helpers-gather";
import { sharpenNode } from "../effect/sharpen";

// Sharpen (Skia) — the Skia-layer port of Sharpen (specdocs/101326_skia-target.md
// §3.2 `sksl-gather`). SHARPEN_FS line for line: one-pixel taps
// (1 / iResolution, the GL node's 1 / src size on a canvas-sized image),
// the four kernels, RGB unclamped, alpha passed through. Taps land on pixel
// centres, where re-evaluating the upstream equals sampling its texture; the
// frame edge clamps like the texture's CLAMP_TO_EDGE.

const SHARPEN_SKSL = `float3 tbx_sharpen_tap(float2 uv, float2 res) {
  return $src(tbx_gather_edge_uv(uv, res)).rgb;
}

float4 tbx_sharpen(float2 uv, float2 res, int algorithm, float amount) {
  float2 o = 1.0 / res;
  float4 c = $src(tbx_gather_edge_uv(uv, res));
  float3 center = c.rgb;
  float3 rgb;
  if (algorithm == 0) {
    // Box: 4-neighbor Laplacian.
    float3 n = tbx_sharpen_tap(uv + float2(0.0, -o.y), res);
    float3 s = tbx_sharpen_tap(uv + float2(0.0, o.y), res);
    float3 e = tbx_sharpen_tap(uv + float2(o.x, 0.0), res);
    float3 w = tbx_sharpen_tap(uv + float2(-o.x, 0.0), res);
    rgb = center * (1.0 + 4.0 * amount) - amount * (n + s + e + w);
  } else if (algorithm == 1) {
    // Diamond: 8-neighbor Laplacian.
    float3 nw = tbx_sharpen_tap(uv + float2(-o.x, -o.y), res);
    float3 n = tbx_sharpen_tap(uv + float2(0.0, -o.y), res);
    float3 ne = tbx_sharpen_tap(uv + float2(o.x, -o.y), res);
    float3 w = tbx_sharpen_tap(uv + float2(-o.x, 0.0), res);
    float3 e = tbx_sharpen_tap(uv + float2(o.x, 0.0), res);
    float3 sw = tbx_sharpen_tap(uv + float2(-o.x, o.y), res);
    float3 s = tbx_sharpen_tap(uv + float2(0.0, o.y), res);
    float3 se = tbx_sharpen_tap(uv + float2(o.x, o.y), res);
    float3 ring = nw + n + ne + w + e + sw + s + se;
    rgb = center * (1.0 + 8.0 * amount) - amount * ring;
  } else if (algorithm == 2) {
    // Cross: the four diagonal neighbors.
    float3 nw = tbx_sharpen_tap(uv + float2(-o.x, -o.y), res);
    float3 ne = tbx_sharpen_tap(uv + float2(o.x, -o.y), res);
    float3 sw = tbx_sharpen_tap(uv + float2(-o.x, o.y), res);
    float3 se = tbx_sharpen_tap(uv + float2(o.x, o.y), res);
    rgb = center * (1.0 + 4.0 * amount) - amount * (nw + ne + sw + se);
  } else {
    // Unsharp mask via the Gaussian 3x3 (corners 1, edges 2, center 4).
    float3 nw = tbx_sharpen_tap(uv + float2(-o.x, -o.y), res);
    float3 n = tbx_sharpen_tap(uv + float2(0.0, -o.y), res);
    float3 ne = tbx_sharpen_tap(uv + float2(o.x, -o.y), res);
    float3 w = tbx_sharpen_tap(uv + float2(-o.x, 0.0), res);
    float3 e = tbx_sharpen_tap(uv + float2(o.x, 0.0), res);
    float3 sw = tbx_sharpen_tap(uv + float2(-o.x, o.y), res);
    float3 s = tbx_sharpen_tap(uv + float2(0.0, o.y), res);
    float3 se = tbx_sharpen_tap(uv + float2(o.x, o.y), res);
    float cw = 1.0 + 0.75 * amount;
    float ew = -amount / 8.0;
    float corn = -amount / 16.0;
    rgb = center * cw + (n + s + e + w) * ew + (nw + ne + sw + se) * corn;
  }
  return float4(rgb, c.a);
}`;

export const skiaSharpenNode = defineSkslNode({
  type: "skia-sharpen",
  name: "Sharpen (Skia)",
  mirrors: "sharpen",
  subcategory: "modifier",
  description:
    "Skia-layer Sharpen: a 3×3 sharpen of the upstream shader (box, diamond, cross or unsharp kernel), fused into the layer's one runtime shader by re-evaluating the upstream at the eight neighbor pixels. Same params as Sharpen.",
  searchAliases: ["sharpen", "unsharp", "crisp", "laplacian", "skia", "sksl"],
  facts: {
    gotchas: [
      "Taps are one canvas pixel apart (1 / iResolution); on a device that is one point, so the kernel widens with pixel density.",
      "Up to 9 evaluations of the upstream per pixel (box and cross 5): cheap over an image child, 9× the cost of a procedural chain fused above it.",
      "Output RGB is not clamped and can overshoot [0,1] on edges; alpha passes through.",
      "Edge pixels repeat the outermost row / column, as the GL node's clamped texture does.",
    ],
  },
  fn: {
    id: "tbx.sharpen@1",
    entry: "tbx_sharpen",
    source: SHARPEN_SKSL,
    params: [
      { name: "algorithm", type: "int" },
      { name: "amount", type: "float" },
    ],
    inputs: [{ name: "src", mode: "gather", taps: 9 }],
    uses: [GATHER_EDGE],
    cost: 0.2,
  },
  params: mirrorParams(sharpenNode, ["algorithm", "amount"]),
  inputs: [{ name: "image", fnInput: "src" }],
});
