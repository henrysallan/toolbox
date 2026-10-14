import { defineSkslNode } from "@/engine/skia/library";

// Texture Coordinate (Skia) — the Skia-layer port of Texture Coordinate
// (src/nodes/source/uv-coords.ts): the pixel's own (u, v) in R and G. Wire
// it into a Skia node's UV input (Noise (Skia), Lyapunov (Skia)) through
// whatever warps the coordinates. Fused, the coordinates stay fp32 — the GL
// node stores them in a half-float texture, so a wired Noise there samples
// a slightly quantized uv.

export const skiaTextureCoordinateNode = defineSkslNode({
  type: "skia-texture-coordinate",
  name: "Texture Coordinate (Skia)",
  mirrors: "texture-coordinate",
  subcategory: "generator",
  description:
    "Skia-layer Texture Coordinate: emits each pixel's (u, v) in R and G (B = 0, A = 1) as an SkSL function that fuses into the layer's one runtime shader. Feed it into the UV input of Noise (Skia) or Lyapunov (Skia), with warps in between.",
  searchAliases: ["texture coordinate", "uv", "coordinates", "skia", "sksl"],
  facts: {
    gotchas: [
      "Only R and G carry u and v (toolbox v_uv: 0..1, Y-up); B is always 0 and A is always 1.",
      "The coordinates are evaluated inside the fused shader in fp32; Texture Coordinate stores them in a half-float texture, so consumers there see uv quantized to ~1/2048.",
    ],
  },
  fn: {
    id: "tbx.texcoord@1",
    entry: "tbx_texcoord",
    source: `float4 tbx_texcoord(float2 uv, float2 res) {
  return float4(uv, 0.0, 1.0);
}`,
    params: [],
    inputs: [],
    cost: 0,
  },
  params: [],
});
