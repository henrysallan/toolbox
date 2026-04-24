import type { NodeDefinition } from "@/engine/types";

const FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}`;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16);
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  ];
}

export const solidColorNode: NodeDefinition = {
  type: "solid-color",
  name: "Solid Color",
  category: "image",
  subcategory: "generator",
  description: "Fills the frame with a single color.",
  backend: "webgl2",
  inputs: [],
  params: [
    { name: "color", label: "Color", type: "color", default: "#808080" },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
  ],
  primaryOutput: "image",
  auxOutputs: [],

  compute({ params, ctx }) {
    const output = ctx.allocImage();
    const [r, g, b] = hexToRgb((params.color as string) ?? "#808080");
    const a = (params.alpha as number) ?? 1;

    const prog = ctx.getShader("solid-color/fs", FS);
    ctx.drawFullscreen(prog, output, (gl) => {
      gl.uniform4f(gl.getUniformLocation(prog, "u_color"), r, g, b, a);
    });

    return { primary: output };
  },
};
