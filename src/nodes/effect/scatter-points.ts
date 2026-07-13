import type {
  ImageValue,
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SplineValue,
} from "@/engine/types";
import { pointsFromArray } from "@/engine/points";
import { buildPath2D } from "@/engine/spline-raster";

// Scatter N points across the canvas. When a density input is attached,
// uses rejection sampling on the density's R channel (brighter = more
// likely to accept). No density → uniform random.
//
// The density socket is polymorphic:
//   image  — GPU texture read back once per compute via readImagePixels
//            at ≤256px (rejection sampling only needs relative weights,
//            not resolution).
//   spline — the shape's filled silhouette, rasterized DIRECTLY at the
//            same ≤256px on a CPU canvas. No full-res rasterize, no GPU
//            upload, no readback — wiring a spline (Circle, Copy to
//            Points output…) straight in skips the whole
//            Rasterize Spline → texture → readback round trip.

interface ScatterState {
  // Spline-density path only: tiny CPU canvas the silhouette rasterizes
  // into at readback size. Lazily created.
  rasterCanvas: HTMLCanvasElement | null;
  // Identity of the density source `data` was built from — the ImageValue's
  // texture, or the SplineValue reference (the evaluator hands back the
  // same object while the upstream node is cache-hit, so a static density
  // reuses the buffer and an animated one rebuilds it).
  lastDensityKey: WebGLTexture | SplineValue | null;
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
    rasterCanvas: null,
    lastDensityKey: null,
    data: null,
    dataW: 0,
    dataH: 0,
  };
  ctx.state[key] = s;
  return s;
}

// Aspect-preserving downsample dims, ≤256 on the long edge.
function fitReadback(w: number, h: number): { W: number; H: number } {
  const MAX = 256;
  const aspect = w / h;
  if (w >= h) {
    const W = Math.min(MAX, w);
    return { W, H: Math.max(1, Math.round(W / aspect)) };
  }
  const H = Math.min(MAX, h);
  return { W: Math.max(1, Math.round(H * aspect)), H };
}

interface DensityBuffer {
  data: Uint8ClampedArray;
  W: number;
  H: number;
}

function readbackDensity(
  ctx: RenderContext,
  density: ImageValue,
  state: ScatterState
): DensityBuffer | null {
  const { W, H } = fitReadback(density.width, density.height);
  if (
    state.lastDensityKey === density.texture &&
    state.dataW === W &&
    state.dataH === H &&
    state.data
  ) {
    return { data: state.data, W, H };
  }
  const data = ctx.readImagePixels(density, W, H);
  if (!data) return null;
  state.data = data;
  state.dataW = W;
  state.dataH = H;
  state.lastDensityKey = density.texture;
  return { data, W, H };
}

// Spline density: rasterize the filled silhouette straight into the
// readback buffer's resolution. Subpaths fill individually (union), same
// as Rasterize Spline's stack-subpaths default — overlapping copies from
// Copy to Points merge instead of punching even-odd holes into each
// other. buildPath2D applies the standard y aspect-correction, and the
// canvas keeps the render aspect, so the silhouette lands exactly where
// a full-res Rasterize Spline → density wire would have put it.
function rasterizeSplineDensity(
  ctx: RenderContext,
  density: SplineValue,
  state: ScatterState
): DensityBuffer | null {
  const { W, H } = fitReadback(ctx.width, ctx.height);
  if (
    state.lastDensityKey === density &&
    state.dataW === W &&
    state.dataH === H &&
    state.data
  ) {
    return { data: state.data, W, H };
  }
  const canvas =
    state.rasterCanvas ?? (state.rasterCanvas = document.createElement("canvas"));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) return null;
  c2d.clearRect(0, 0, W, H);
  c2d.fillStyle = "#ffffff";
  for (const sub of density.subpaths) {
    const path = buildPath2D([sub], W, H, true);
    if (path) c2d.fill(path);
  }
  const data = c2d.getImageData(0, 0, W, H).data;
  state.data = data;
  state.dataW = W;
  state.dataH = H;
  state.lastDensityKey = density;
  return { data, W, H };
}

export const scatterPointsNode: NodeDefinition = {
  type: "scatter-points",
  name: "Scatter Points",
  category: "point",
  subcategory: "generator",
  description:
    "Scatter N points across the canvas, optionally weighted by a density input (brighter pixels = more points). Wire an image, or a spline directly — the spline's filled silhouette is the density, sampled without rasterizing to a texture. Deterministic — same seed, same layout.",
  backend: "webgl2",
  inputs: [
    {
      name: "density",
      label: "Density",
      type: "image",
      required: false,
    },
  ],
  // The density socket adapts to what's wired in — image (default) or
  // spline. It just reads "image" before anything connects.
  resolveInputs(_params, rctx): InputSocketDef[] {
    const t = rctx?.connectedTypes?.density;
    const type: SocketType = t === "spline" ? "spline" : "image";
    return [{ name: "density", label: "Density", type, required: false }];
  },
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
    const density = inputs.density as ImageValue | SplineValue | undefined;
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

    if (density && (density.kind === "image" || density.kind === "spline")) {
      const readback =
        density.kind === "image"
          ? readbackDensity(ctx, density, state)
          : rasterizeSplineDensity(ctx, density, state);
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

    const out: PointsValue = pointsFromArray(points);
    return { primary: out };
  },

  dispose(_ctx, nodeId) {
    // State canvas is just a DOM element; GC handles it. Nothing GPU-side
    // to release since we don't create textures in this node.
    void nodeId;
  },
};
