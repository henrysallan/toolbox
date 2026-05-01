import type { NodeDefinition } from "@/engine/types";

// Color value source — emits a vec4 (r, g, b, a) without rasterizing it.
// Solid Color produces a full-frame image; this one produces the raw
// color value, which color-math nodes (and any vec4 consumer) can read
// directly without a rasterize → sample round trip.

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

export const colorLiteralNode: NodeDefinition = {
  type: "color-literal",
  name: "Color",
  category: "utility",
  description:
    "Emits a single color as a vec4 value (not an image). Use to drive color-math nodes that want a value rather than a rasterized image.",
  backend: "webgl2",
  stable: true,
  inputs: [],
  params: [
    { name: "color", label: "Color", type: "color", default: "#ffffff" },
    {
      name: "alpha",
      label: "Alpha",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "vec4",
  auxOutputs: [],

  compute({ params }) {
    const [r, g, b] = hexToRgb((params.color as string) ?? "#ffffff");
    const a = (params.alpha as number) ?? 1;
    return { primary: { kind: "vec4", value: [r, g, b, a] } };
  },
};
