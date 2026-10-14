import { defineSkslNode, mirrorParams } from "@/engine/skia/library";
import { solidColorNode } from "../source/solid-color";

// Solid Color (Skia) — the Skia-layer port of Solid Color
// (specdocs/101326_skia-target.md §3.2): one flat straight-alpha color,
// `alpha` × `opacity`. As a shader it fuses into whatever reads it (a Skia
// Fill paints it over the canvas; a modifier downstream colors it).

const SOLID_COLOR_SKSL = `float4 tbx_solid_color(float2 uv, float2 res, float4 color, float alpha, float opacity) {
  return float4(color.rgb, alpha * opacity);
}`;

export const skiaSolidColorNode = defineSkslNode({
  type: "skia-solid-color",
  name: "Solid Color (Skia)",
  mirrors: "solid-color",
  subcategory: "generator",
  description:
    "Skia-layer Solid Color: one flat color as an SkSL function that fuses into the layer's runtime shader. Same params as Solid Color (color, alpha, opacity).",
  searchAliases: ["solid color", "fill", "flat color", "skia", "sksl"],
  facts: {
    gotchas: [
      "Output alpha is alpha × opacity, folded into the shader; the color's own alpha digits (#rrggbbaa) are ignored, as in Solid Color.",
      "The color uniform is layout(color): on a non-sRGB canvas Skia converts it to the working space.",
    ],
  },
  fn: {
    id: "tbx.solid_color@1",
    entry: "tbx_solid_color",
    source: SOLID_COLOR_SKSL,
    params: [
      { name: "color", type: "color" },
      { name: "alpha", type: "float" },
      { name: "opacity", type: "float" },
    ],
    inputs: [],
    cost: 0,
  },
  params: mirrorParams(solidColorNode, ["opacity", "color", "alpha"]),
});
