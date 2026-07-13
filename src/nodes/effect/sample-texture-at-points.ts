import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
} from "@/engine/types";

// Sample an image at each point's UV position and write the value into
// a chosen per-point attribute (scale or rotation). The base primitive
// for "drive geometry from an image" — height-mapping a scatter, sizing
// dots by a mask, twisting copies by luminance, etc.
//
// Mechanically similar to Modulate Points' field samplers, but this is
// a dedicated, discoverable name doing the simplest thing: read the
// chosen channel at each point's (x, y), remap [0..1] linearly to
// [lo..hi], and combine with the existing attribute via the chosen
// blend mode (replace / multiply / add).
//
// Scaling targets write the same value to both x and y (uniform scale)
// to keep the V1 mental model simple. If you need anisotropic scaling,
// stack two of these with `target = scale` after splitting the source.

const CHANNEL_OPTIONS = ["luminance", "r", "g", "b", "a"] as const;
type Channel = (typeof CHANNEL_OPTIONS)[number];

const TARGET_OPTIONS = ["scale", "rotation"] as const;
type Target = (typeof TARGET_OPTIONS)[number];

const BLEND_OPTIONS = ["replace", "multiply", "add"] as const;
type Blend = (typeof BLEND_OPTIONS)[number];

interface ImageBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function readImage(
  ctx: RenderContext,
  img: { texture: WebGLTexture; width: number; height: number }
): ImageBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  const data = ctx.readImagePixels({
    kind: "image",
    texture: img.texture,
    width: img.width,
    height: img.height,
  });
  if (!data) return null;
  return { data, w: img.width, h: img.height };
}

function pickChannel(buf: ImageBuffer, ch: Channel, u: number, v: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  const i = (py * buf.w + px) * 4;
  switch (ch) {
    case "r":
      return buf.data[i] / 255;
    case "g":
      return buf.data[i + 1] / 255;
    case "b":
      return buf.data[i + 2] / 255;
    case "a":
      return buf.data[i + 3] / 255;
    case "luminance":
    default:
      return (
        (0.2126 * buf.data[i] +
          0.7152 * buf.data[i + 1] +
          0.0722 * buf.data[i + 2]) /
        255
      );
  }
}

export const sampleTextureAtPointsNode: NodeDefinition = {
  type: "sample-texture-at-points",
  name: "Sample Texture at Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Reads a channel of an image at each point's position and writes the value into the chosen attribute (scale or rotation). The sampled [0..1] value remaps linearly to [Lo..Hi] before being combined via Replace / Multiply / Add.",
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "image", type: "image", required: true },
  ],
  params: [
    {
      name: "channel",
      label: "Channel",
      type: "enum",
      options: CHANNEL_OPTIONS as unknown as string[],
      default: "luminance",
    },
    {
      name: "target",
      label: "Target",
      type: "enum",
      options: TARGET_OPTIONS as unknown as string[],
      default: "scale",
    },
    {
      name: "blend",
      label: "Blend",
      type: "enum",
      options: BLEND_OPTIONS as unknown as string[],
      default: "replace",
    },
    {
      name: "lo",
      label: "Lo (black ⇒)",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 2,
      step: 0.001,
      default: 0,
    },
    {
      name: "hi",
      label: "Hi (white ⇒)",
      type: "scalar",
      min: -100,
      max: 100,
      softMax: 2,
      step: 0.001,
      default: 1,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") {
      const empty: PointsValue = {
        kind: "points",
        count: 0,
        positions: new Float32Array(0),
        points: [],
      };
      return { primary: empty };
    }

    const img = inputs.image;
    if (!img || img.kind !== "image") {
      // No image to sample — pass through unchanged so the graph
      // stays usable while wiring.
      return { primary: src };
    }

    const channel = ((params.channel as string) ?? "luminance") as Channel;
    const target = ((params.target as string) ?? "scale") as Target;
    const blend = ((params.blend as string) ?? "replace") as Blend;
    const lo = (params.lo as number) ?? 0;
    const hi = (params.hi as number) ?? 1;

    const buf = readImage(ctx, img);
    if (!buf) return { primary: src };

    const n = src.count;
    const inPos = src.positions;
    const inScales = src.scales;
    const inRots = src.rotations;
    const inGroups = src.groupIndices;

    const outScales = new Float32Array(n * 2);
    const outRotations = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const px = inPos[i * 2];
      const py = inPos[i * 2 + 1];
      const sample = pickChannel(buf, channel, px, py);
      const remapped = lo + (hi - lo) * sample;

      const oldSx = inScales ? inScales[i * 2] : 1;
      const oldSy = inScales ? inScales[i * 2 + 1] : 1;
      const oldRot = inRots ? inRots[i] : 0;

      if (target === "scale") {
        let s: number;
        if (blend === "multiply") s = remapped;
        else if (blend === "add") s = remapped;
        else s = remapped;
        // Combine with existing scale per blend mode.
        const sx =
          blend === "multiply"
            ? oldSx * s
            : blend === "add"
              ? oldSx + s
              : s;
        const sy =
          blend === "multiply"
            ? oldSy * s
            : blend === "add"
              ? oldSy + s
              : s;
        outScales[i * 2] = sx;
        outScales[i * 2 + 1] = sy;
        outRotations[i] = oldRot;
      } else {
        const r =
          blend === "multiply"
            ? oldRot * remapped
            : blend === "add"
              ? oldRot + remapped
              : remapped;
        outRotations[i] = r;
        outScales[i * 2] = oldSx;
        outScales[i * 2 + 1] = oldSy;
      }
    }

    const out: PointsValue = {
      kind: "points",
      count: n,
      // Positions unchanged — share the buffer to keep the hot path
      // allocation-free.
      positions: inPos,
      scales: outScales,
      rotations: outRotations,
      groupIndices: inGroups,
      points: [],
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`sample-texture-at-points:${nodeId}`];
  },
};
