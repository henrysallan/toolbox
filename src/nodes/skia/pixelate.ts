import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { TEXEL_HELPER } from "@/engine/skia/library/helpers-warp";
import { pixelateNode } from "../effect/pixelate";

// Pixelate (Skia) — the Skia-layer port of Pixelate
// (specdocs/101326_skia-target.md §3.2, Wave 2 warps). PIXELATE_FS line for
// line as a gather: the canvas is cut into cells of size·aspect × size
// pixels (counted from the bottom-left, like v_uv), each pixel re-evaluates
// the upstream once at its cell's center, and circle cells clear to
// transparent black outside the inscribed disc. The GL node reads the grid
// against the source texture's size, which is the canvas in a Skia layer
// (`res`). Every option is ported; opacity folds into alpha, as the
// evaluator's universal opacity does for the GL node.

const PIXELATE_SKSL = `float4 tbx_pixelate(float2 uv, float2 res, float size, int shape, float aspect, float opacity) {
  // The JS clamps size >= 1 and aspect >= 0.01 before building u_cell.
  float s = max(size, 1.0);
  float2 cell = float2(s * max(aspect, 0.01), s);
  float2 grid = res / max(cell, float2(1.0));
  float2 cellId = floor(uv * grid);
  float2 cellUv = (cellId + 0.5) / grid;
  float4 c = $image(tbx_texel_clamp(cellUv, res));
  if (shape == 1) {
    float2 f = fract(uv * grid) - 0.5;
    if (length(f) > 0.5) c = float4(0.0);
  }
  return float4(c.rgb, c.a * clamp(opacity, 0.0, 1.0));
}`;

export const skiaPixelateNode = defineSkslNode({
  type: "skia-pixelate",
  name: "Pixelate (Skia)",
  mirrors: "pixelate",
  subcategory: "modifier",
  description:
    "Skia-layer Pixelate: mosaics the upstream shader into blocks, sampling each block's center, with square or circular cells and an aspect that widens the cells; fused into the layer's one runtime shader. Same params as Pixelate. The `preview` output renders it through CanvasKit.",
  searchAliases: ["pixelate", "mosaic", "blocks", "pixel", "led", "skia", "sksl"],
  facts: {
    space: { "param:size": "pixels" },
    gotchas: [
      "size is the cell height in canvas pixels (the Skia layer's resolution); aspect multiplies only the cell width.",
      "Cells count from the bottom-left corner (v_uv), so a partial row/column lands at the top/right; its center may lie past the edge and reads the edge pixel.",
      "One upstream evaluation per pixel at the cell center: an exact point sample, where the GL node bilinearly filters its texture there.",
      "shape=circle sets RGBA to 0 outside the inscribed disc (transparent black holes, no soft edge); opacity multiplies alpha.",
    ],
  },
  fn: {
    id: "tbx.pixelate@1",
    entry: "tbx_pixelate",
    source: PIXELATE_SKSL,
    params: [
      { name: "size", type: "float" },
      { name: "shape", type: "int" },
      { name: "aspect", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: [{ name: "image", mode: "gather", taps: 1 }],
    uses: [TEXEL_HELPER],
    cost: 0.1,
  },
  params: mirrorParams(pixelateNode, ["size", "shape", "aspect", "opacity"]),
  inputs: [{ name: "image", label: "Image" }],
});
