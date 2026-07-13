import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
} from "@/engine/types";

// Keep or discard points by predicate. Two modes:
//
//   bbox:  keep points whose (x, y) falls inside the [x_min..x_max] ×
//          [y_min..y_max] window. Invert flips inside ↔ outside.
//
//   mask:  sample an image's luminance at each point's position; keep
//          points where the value is ≥ threshold. Invert flips the
//          comparison so the mask's dark areas keep instead.
//
// Output count is unbounded by the input — empty result is valid.
// Per-point attributes (scale / rotation / groupIndex) are preserved
// for the kept points; their indices in the output are sequential
// starting at 0 (i.e. the input order is kept, gaps closed up).

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

function sampleLuma(buf: ImageBuffer, u: number, v: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  const i = (py * buf.w + px) * 4;
  return (
    (0.2126 * buf.data[i] +
      0.7152 * buf.data[i + 1] +
      0.0722 * buf.data[i + 2]) /
    255
  );
}

const MODES = ["bbox", "mask"] as const;
type Mode = (typeof MODES)[number];

function emptyPoints(): PointsValue {
  return {
    kind: "points",
    count: 0,
    positions: new Float32Array(0),
    points: [],
  };
}

export const filterPointsNode: NodeDefinition = {
  type: "filter-points",
  name: "Filter Points",
  category: "point",
  subcategory: "modifier",
  description:
    "Keep or discard points by predicate. Bbox mode keeps points inside an XY window; Mask mode keeps points where the wired image's luminance is ≥ threshold. Invert flips which side is kept.",
  backend: "webgl2",
  inputs: [
    { name: "points", type: "points", required: true },
    { name: "mask", type: "image", required: false, label: "Mask" },
  ],
  params: [
    {
      name: "mode",
      label: "Mode",
      type: "enum",
      options: MODES as unknown as string[],
      default: "bbox",
    },
    {
      name: "x_min",
      label: "X min",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "x_max",
      label: "X max",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "y_min",
      label: "Y min",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "y_max",
      label: "Y max",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 1,
      visibleIf: (p) => p.mode === "bbox",
    },
    {
      name: "threshold",
      label: "Threshold",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "mask",
    },
    {
      name: "invert",
      label: "Invert",
      type: "boolean",
      default: false,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params, ctx }) {
    const src = inputs.points;
    if (!src || src.kind !== "points") {
      return { primary: emptyPoints() };
    }

    const mode = ((params.mode as string) ?? "bbox") as Mode;
    const invert = !!params.invert;
    const n = src.count;

    // Build a per-point keep mask, then compact into output buffers.
    const keep = new Uint8Array(n);
    let keepCount = 0;

    if (mode === "bbox") {
      const xMin = (params.x_min as number) ?? 0;
      const xMax = (params.x_max as number) ?? 1;
      const yMin = (params.y_min as number) ?? 0;
      const yMax = (params.y_max as number) ?? 1;
      const lo = Math.min(xMin, xMax);
      const hi = Math.max(xMin, xMax);
      const tlo = Math.min(yMin, yMax);
      const thi = Math.max(yMin, yMax);
      for (let i = 0; i < n; i++) {
        const x = src.positions[i * 2];
        const y = src.positions[i * 2 + 1];
        const inside = x >= lo && x <= hi && y >= tlo && y <= thi;
        const k = invert ? !inside : inside;
        if (k) {
          keep[i] = 1;
          keepCount++;
        }
      }
    } else {
      // mask mode
      const maskImg = inputs.mask;
      if (!maskImg || maskImg.kind !== "image") {
        // No mask wired — pass through unchanged so the user can wire it.
        return { primary: src };
      }
      const threshold = (params.threshold as number) ?? 0.5;
      const buf = readImage(ctx, maskImg);
      if (!buf) return { primary: src };
      for (let i = 0; i < n; i++) {
        const x = src.positions[i * 2];
        const y = src.positions[i * 2 + 1];
        const luma = sampleLuma(buf, x, y);
        const passes = luma >= threshold;
        const k = invert ? !passes : passes;
        if (k) {
          keep[i] = 1;
          keepCount++;
        }
      }
    }

    if (keepCount === n) return { primary: src };
    if (keepCount === 0) return { primary: emptyPoints() };

    const outPos = new Float32Array(keepCount * 2);
    const outScales = src.scales ? new Float32Array(keepCount * 2) : undefined;
    const outRots = src.rotations ? new Float32Array(keepCount) : undefined;
    const outGroups = src.groupIndices
      ? new Int32Array(keepCount)
      : undefined;

    let w = 0;
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      outPos[w * 2] = src.positions[i * 2];
      outPos[w * 2 + 1] = src.positions[i * 2 + 1];
      if (outScales && src.scales) {
        outScales[w * 2] = src.scales[i * 2];
        outScales[w * 2 + 1] = src.scales[i * 2 + 1];
      }
      if (outRots && src.rotations) outRots[w] = src.rotations[i];
      if (outGroups && src.groupIndices) outGroups[w] = src.groupIndices[i];
      w++;
    }

    const out: PointsValue = {
      kind: "points",
      count: keepCount,
      positions: outPos,
      scales: outScales,
      rotations: outRots,
      groupIndices: outGroups,
      points: [],
    };
    return { primary: out };
  },

  dispose(ctx, nodeId) {
    delete ctx.state[`filter-points:${nodeId}`];
  },
};
