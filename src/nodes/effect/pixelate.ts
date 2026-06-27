import type { NodeDefinition } from "@/engine/types";
import { OPACITY_PARAM } from "@/engine/conventions";

// Pixelate / Mosaic — snap the image to a grid of blocks, point-sampling each
// block's center (crisp, cheap). `size` is the block edge in pixels; `aspect`
// stretches the cell horizontally for non-square mosaics; `circle` masks each
// block to an inscribed dot (Lite-Brite / LED look).
//
// Universal mask + opacity are applied by the evaluator (this node has an
// `image` input → mask blends the pixelated effect over the source).
const PIXELATE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_res;   // texture size in px
uniform vec2 u_cell;  // cell size in px (x = size*aspect, y = size)
uniform int u_shape;  // 0 square, 1 circle
out vec4 outColor;

void main() {
  vec2 grid = u_res / max(u_cell, vec2(1.0));
  vec2 cellId = floor(v_uv * grid);
  vec2 cellUv = (cellId + 0.5) / grid;     // block center
  vec4 c = texture(u_src, cellUv);
  if (u_shape == 1) {
    vec2 f = fract(v_uv * grid) - 0.5;     // [-0.5,0.5] within the cell
    if (length(f) > 0.5) c = vec4(0.0);    // inscribed circle
  }
  outColor = c;
}`;

export const pixelateNode: NodeDefinition = {
  type: "pixelate",
  name: "Pixelate",
  category: "image",
  subcategory: "modifier",
  description:
    "Mosaic the image into blocks, sampling each block's center. Square or circular cells; aspect stretches the grid for non-square mosaics.",
  backend: "webgl2",
  inputs: [{ name: "image", type: "image", required: true }],
  params: [
    {
      name: "size",
      label: "Block size (px)",
      type: "scalar",
      min: 1,
      max: 256,
      softMax: 64,
      step: 1,
      default: 16,
    },
    {
      name: "shape",
      label: "Cell shape",
      type: "enum",
      options: ["square", "circle"],
      default: "square",
    },
    {
      name: "aspect",
      label: "Aspect",
      type: "scalar",
      min: 0.25,
      max: 4,
      step: 0.01,
      default: 1,
    },
    OPACITY_PARAM,
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const output = ctx.allocImage();
    const src = inputs.image;
    if (!src || src.kind !== "image") {
      ctx.clearTarget(output, [0, 0, 0, 0]);
      return { primary: output };
    }
    const size = Math.max(1, (params.size as number) ?? 16);
    const aspect = Math.max(0.01, (params.aspect as number) ?? 1);
    const shape = (params.shape as string) === "circle" ? 1 : 0;

    const prog = ctx.getShader("pixelate/main", PIXELATE_FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_res"), src.width, src.height);
      gl.uniform2f(
        gl.getUniformLocation(prog, "u_cell"),
        size * aspect,
        size
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_shape"), shape);
    });

    return { primary: output };
  },
};
