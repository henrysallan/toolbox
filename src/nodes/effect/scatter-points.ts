import type {
  ImageValue,
  NodeDefinition,
  Point,
  PointsValue,
  RenderContext,
} from "@/engine/types";

// Scatter N points across the canvas. When a density input is attached,
// uses rejection sampling on the image's R channel (brighter = more
// likely to accept). No density → uniform random.
//
// Density readback happens once per compute via blitToCanvas into a small
// offscreen 2D canvas, so we can sample CPU-side without stalling the
// GPU on a float-texture readback path.

interface ScatterState {
  readbackCanvas: HTMLCanvasElement;
  // Cache the last density + readback so a scatter that doesn't depend on
  // a density input (or whose density hasn't changed) doesn't re-blit.
  lastDensityTex: WebGLTexture | null;
  lastW: number;
  lastH: number;
  data: Uint8ClampedArray | null;
  dataW: number;
  dataH: number;
}

// Small seed PRNG. Mulberry32 — 32-bit state, good uniform distribution,
// deterministic for the same seed. Enough for visual scatter work.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ensureState(ctx: RenderContext, nodeId: string): ScatterState {
  const key = `scatter-points:${nodeId}`;
  const existing = ctx.state[key] as ScatterState | undefined;
  if (existing) return existing;
  const s: ScatterState = {
    readbackCanvas: document.createElement("canvas"),
    lastDensityTex: null,
    lastW: 0,
    lastH: 0,
    data: null,
    dataW: 0,
    dataH: 0,
  };
  ctx.state[key] = s;
  return s;
}

function readbackDensity(
  ctx: RenderContext,
  density: ImageValue,
  state: ScatterState
): { data: Uint8ClampedArray; W: number; H: number } | null {
  // Downsample to a max of 256×256 so the CPU-side sample loop stays
  // cheap. Rejection sampling only needs relative weights, not resolution.
  const MAX = 256;
  const aspect = density.width / density.height;
  let W: number;
  let H: number;
  if (density.width >= density.height) {
    W = Math.min(MAX, density.width);
    H = Math.max(1, Math.round(W / aspect));
  } else {
    H = Math.min(MAX, density.height);
    W = Math.max(1, Math.round(H * aspect));
  }
  const canvas = state.readbackCanvas;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  // Cache hit: same texture, same dims — reuse the already-populated data.
  if (
    state.lastDensityTex === density.texture &&
    state.dataW === W &&
    state.dataH === H &&
    state.data
  ) {
    return { data: state.data, W, H };
  }
  try {
    ctx.blitToCanvas(density, canvas);
  } catch {
    return null;
  }
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return null;
  const img = ctx2d.getImageData(0, 0, W, H);
  state.data = img.data;
  state.dataW = W;
  state.dataH = H;
  state.lastDensityTex = density.texture;
  state.lastW = density.width;
  state.lastH = density.height;
  return { data: img.data, W, H };
}

export const scatterPointsNode: NodeDefinition = {
  type: "scatter-points",
  name: "Scatter Points",
  category: "point",
  subcategory: "generator",
  description:
    "Scatter N points across the canvas, optionally weighted by a density image (brighter pixels = more points). Deterministic — same seed, same layout.",
  backend: "webgl2",
  inputs: [
    {
      name: "density",
      label: "Density",
      type: "image",
      required: false,
    },
  ],
  params: [
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: 1,
      max: 4096,
      softMax: 500,
      step: 1,
      default: 100,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 10000,
      step: 1,
      default: 1,
    },
    {
      name: "rotation_deg",
      label: "Rotation (deg)",
      type: "scalar",
      min: -360,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "rotation_jitter_deg",
      label: "Rotation jitter",
      type: "scalar",
      min: 0,
      max: 360,
      step: 0.5,
      default: 0,
    },
    {
      name: "scale",
      label: "Scale",
      type: "scalar",
      min: 0,
      max: 5,
      softMax: 2,
      step: 0.01,
      default: 1,
    },
    {
      name: "scale_jitter",
      label: "Scale jitter",
      type: "scalar",
      min: 0,
      max: 2,
      step: 0.01,
      default: 0,
    },
  ],
  primaryOutput: "points",
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const density = inputs.density as ImageValue | undefined;
    const count = Math.max(
      1,
      Math.floor((params.count as number) ?? 100)
    );
    const seed = Math.floor((params.seed as number) ?? 1);
    const rotDeg = (params.rotation_deg as number) ?? 0;
    const rotJitterDeg = (params.rotation_jitter_deg as number) ?? 0;
    const scaleBase = (params.scale as number) ?? 1;
    const scaleJitter = (params.scale_jitter as number) ?? 0;

    const rng = mulberry32(seed);
    const state = ensureState(ctx, nodeId);
    const points: Point[] = [];

    // Per-point transform. Rotation in radians; scale is symmetric.
    const makePoint = (x: number, y: number): Point => {
      const rj = (rng() - 0.5) * 2 * rotJitterDeg;
      const rot = ((rotDeg + rj) * Math.PI) / 180;
      const sj = scaleJitter > 0 ? (rng() - 0.5) * 2 * scaleJitter : 0;
      const s = Math.max(0, scaleBase + sj);
      return { pos: [x, y], rotation: rot, scale: [s, s] };
    };

    if (density && density.kind === "image") {
      const readback = readbackDensity(ctx, density, state);
      if (readback) {
        const { data, W, H } = readback;
        // Rejection sampling. Cap attempts so pathological density maps
        // (almost all zero) still terminate in a reasonable time.
        const maxAttempts = count * 50;
        let attempts = 0;
        while (points.length < count && attempts < maxAttempts) {
          attempts++;
          const x = rng();
          const y = rng();
          const px = Math.min(W - 1, Math.floor(x * W));
          const py = Math.min(H - 1, Math.floor(y * H));
          const idx = (py * W + px) * 4;
          // R channel = density. Multiplied by the source alpha so a
          // transparent mask region counts as zero density regardless of
          // its RGB content.
          const d = (data[idx] / 255) * (data[idx + 3] / 255);
          if (rng() < d) points.push(makePoint(x, y));
        }
      }
    } else {
      for (let i = 0; i < count; i++) {
        points.push(makePoint(rng(), rng()));
      }
    }

    const out: PointsValue = { kind: "points", points };
    return { primary: out };
  },

  dispose(_ctx, nodeId) {
    // State canvas is just a DOM element; GC handles it. Nothing GPU-side
    // to release since we don't create textures in this node.
    void nodeId;
  },
};
