import type { NodeDefinition } from "@/engine/types";

// Identity UV field — each output pixel stores its own (u, v) in the R and G
// channels. Feed this into UV-aware nodes (image-source, gradient, perlin,
// math in UV mode) as a starting point for warps and coordinate math.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = vec4(v_uv, 0.0, 1.0);
}`;

export const uvCoordsNode: NodeDefinition = {
  type: "texture-coordinate",
  name: "Texture Coordinate",
  category: "source",
  description:
    "Emits the default per-pixel (u, v) as a UV field. Feed it into UV-aware generators (Image Source, Gradient, Perlin) — with Math in UV mode sitting in between to warp, offset, or animate the coordinates.",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "uv",
  auxOutputs: [],

  compute({ ctx }) {
    const output = ctx.allocUv();
    const prog = ctx.getShader("uv-coords/fs", FS);
    ctx.drawFullscreen(prog, output);
    return { primary: output };
  },
};
