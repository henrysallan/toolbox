import type {
  NodeDefinition,
  PointsValue,
  RenderContext,
} from "@/engine/types";

// Keep or discard points by predicate. Four modes:
//
//   bbox:   keep points whose (x, y) falls inside the [x_min..x_max] ×
//           [y_min..y_max] window. Invert flips inside ↔ outside.
//
//   mask:   sample an image's luminance at each point's position; keep
//           points where the value is ≥ threshold. Invert flips the
//           comparison so the mask's dark areas keep instead.
//
//   index:  keep 1 of every N points (Every) at a phase (Offset) — a
//           deterministic decimation / thinning. Invert drops that set.
//
//   random: keep a random SUBSET, but stably. Each point's keep/drop is a
//           frame-independent hash of its index, so points don't flicker in
//           and out — raising Amount only ever REVEALS more of the same
//           points (monotonic), and Seed re-rolls which points are chosen
//           without changing the count. Same hash as Point Expression's
//           `rand(index)`, so the two nodes agree. This is the fix for the
//           classic per-frame-random shimmer.
//
// Output count is unbounded by the input — empty result is valid.
// Per-point attributes (scale / rotation / groupIndex) are preserved
// for the kept points; their indices in the output are sequential
// starting at 0 (i.e. the input order is kept, gaps closed up).
//
// Stability note (index/random): both key off the point's INDEX, so a
// fixed upstream point set stays put frame-to-frame. If the incoming count
// changes, which indices exist changes with it.

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

// Frame-independent per-seed hash → [0,1). triple32 (Wellons) — strong
// avalanche on sequential integer seeds (0,1,2,…), our exact input pattern.
// Byte-for-byte the "Random Value hashed on Index" primitive Point
// Expression exposes as `rand()`, so a Filter Points "random" cull and an
// expression `keep = rand(index) < amount` select the identical points.
function hash01(seed: number): number {
  let x = seed >>> 0;
  x ^= x >>> 17;
  x = Math.imul(x, 0xed5ad4bb);
  x ^= x >>> 11;
  x = Math.imul(x, 0xac4c1b51);
  x ^= x >>> 15;
  x = Math.imul(x, 0x31848bab);
  x ^= x >>> 14;
  return (x >>> 0) / 4294967296;
}

const MODES = ["bbox", "mask", "index", "random"] as const;
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
    "Keep or discard points by predicate. Bbox keeps points inside an XY window; Mask keeps points where the wired image's luminance is ≥ threshold; Index keeps 1 of every N points; Random keeps a stable random subset (hashed on index, so points don't flicker in/out — raising Amount reveals more of the same points, Seed re-rolls the selection). Invert flips which side is kept.",
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
      // index mode: keep 1 of every N points.
      name: "every",
      label: "Keep 1 of every",
      type: "scalar",
      min: 1,
      max: 32,
      softMax: 10,
      step: 1,
      default: 2,
      visibleIf: (p) => p.mode === "index",
    },
    {
      // index mode: phase — which residue class survives.
      name: "offset",
      label: "Offset",
      type: "scalar",
      min: 0,
      max: 32,
      softMax: 10,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "index",
    },
    {
      // random mode: fraction kept. Monotonic — raising this only ever adds
      // points, so dragging it feels like a stable reveal, not a reshuffle.
      name: "amount",
      label: "Amount",
      type: "scalar",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.5,
      visibleIf: (p) => p.mode === "random",
    },
    {
      // random mode: re-roll WHICH points are kept (not how many).
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 999,
      step: 1,
      default: 0,
      visibleIf: (p) => p.mode === "random",
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
    } else if (mode === "index") {
      const every = Math.max(1, Math.round((params.every as number) ?? 2));
      const offset = Math.round((params.offset as number) ?? 0);
      for (let i = 0; i < n; i++) {
        // Floor-mod so negative offsets still land on a stable residue.
        const hit = (((i + offset) % every) + every) % every === 0;
        const k = invert ? !hit : hit;
        if (k) {
          keep[i] = 1;
          keepCount++;
        }
      }
    } else if (mode === "random") {
      const amount = Math.max(0, Math.min(1, (params.amount as number) ?? 0.5));
      const seed = Math.round((params.seed as number) ?? 0);
      // Mix the seed in strongly so adjacent seeds give unrelated selections.
      // seed 0 collapses to hash01(index) == Point Expression's rand(index).
      const seedMix = Math.imul(seed, 0x9e3779b1);
      for (let i = 0; i < n; i++) {
        // Strict `<`: amount 0 keeps nothing, amount 1 keeps everything.
        const pass = hash01(i ^ seedMix) < amount;
        const k = invert ? !pass : pass;
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
