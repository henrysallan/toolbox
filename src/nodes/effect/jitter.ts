import type {
  InputSocketDef,
  NodeDefinition,
  Point,
  PointsValue,
  RenderContext,
  SocketType,
  SplineAnchor,
  SplineValue,
} from "@/engine/types";

// Jitter — displace each anchor of a spline (or each point of a points
// value) by sampling noise images at the anchor's own UV. The whole
// reason this node exists is that Transform's translate input is a
// single scalar / vec2 — wiring an image there auto-coerces to one
// number and applies it uniformly across every anchor, defeating the
// point. Jitter samples PER anchor, so a Perlin Noise plugged into
// the X-noise / Y-noise sockets gives independent offsets at every
// anchor's spatial position. Strength sliders multiply the result —
// the same "magnify the effect" recipe as Blender's geometry nodes.
//
// Conventions:
//  - Inputs map raw [0..1] sampled values to [-1..1] before scaling,
//    so a flat 0.5 noise value gives zero displacement (the visually
//    natural "no shift" point).
//  - Both noise inputs are optional. Disconnected = 0 displacement
//    on that axis. Connect just X-noise for horizontal-only jitter.
//  - Wiring the SAME noise to both X and Y gives a diagonal pattern
//    (same value drives both axes). Wiring two noises with different
//    seeds (or any pair of distinct images) gives decorrelated 2D
//    scatter — usually what you want.
//
// Polymorphic via the `mode` enum (spline / points), placed in
// Utility per the cross-type-polymorphic convention. groupIndex
// rides through unchanged on both modes — Jitter is a positional
// transform, not an identity-changing op.

type Mode = "spline" | "points";

interface JitterState {
  // One scratch 2D canvas, reused across both noise reads. We
  // getImageData once per noise input (which copies the pixel
  // bytes) so the canvas can be overwritten on the second blit
  // without losing the first read's data.
  scratchCanvas: HTMLCanvasElement;
}

interface ImageBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function ensureState(ctx: RenderContext, nodeId: string): JitterState {
  const key = `jitter:${nodeId}`;
  const existing = ctx.state[key] as JitterState | undefined;
  if (existing) return existing;
  const s: JitterState = {
    scratchCanvas: document.createElement("canvas"),
  };
  ctx.state[key] = s;
  return s;
}

function readImageToBuffer(
  ctx: RenderContext,
  canvas: HTMLCanvasElement,
  img: { texture: WebGLTexture; width: number; height: number }
): ImageBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  try {
    ctx.blitToCanvas(
      { kind: "image", texture: img.texture, width: img.width, height: img.height },
      canvas
    );
  } catch {
    return null;
  }
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) return null;
  const imgData = c2d.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imgData.data, w: canvas.width, h: canvas.height };
}

// Returns the R channel sampled at UV (0..1), Y-flipped to match
// the codebase's Y-DOWN convention vs. canvas Y-down rows. Output
// is in [0, 1].
function sampleR(buf: ImageBuffer, u: number, v: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  // Canvas rows go top→bottom; UV is Y-down for splines/points but
  // the canvas content from blitToCanvas is also row-0-top → no
  // explicit Y flip needed here for our internal pipeline.
  const py = Math.max(0, Math.min(buf.h - 1, Math.floor(v * buf.h)));
  return buf.data[(py * buf.w + px) * 4] / 255;
}

function innerType(mode: Mode): SocketType {
  return mode === "spline" ? "spline" : "points";
}

export const jitterNode: NodeDefinition = {
  type: "jitter",
  name: "Jitter",
  category: "utility",
  description:
    "Per-anchor positional jitter. Samples optional X-noise and Y-noise images at each anchor's own UV and displaces by the sampled value mapped to [-1..1] times the strength. Wire one Perlin Noise into both X and Y for diagonal jitter; wire two noises with different seeds for decorrelated 2D scatter. Disconnected inputs give 0 displacement on that axis.",
  backend: "webgl2",
  headerControl: { paramName: "mode" },
  inputs: [
    { name: "in", type: "spline", required: true },
    { name: "noise_x", type: "image", required: false },
    { name: "noise_y", type: "image", required: false },
  ],
  resolveInputs(params): InputSocketDef[] {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    return [
      {
        name: "in",
        type: innerType(mode),
        required: true,
        label: mode === "spline" ? "Spline" : "Points",
      },
      { name: "noise_x", type: "image", required: false, label: "X noise" },
      { name: "noise_y", type: "image", required: false, label: "Y noise" },
    ];
  },
  params: [
    {
      name: "mode",
      label: "Type",
      type: "enum",
      options: ["spline", "points"],
      default: "spline",
    },
    {
      name: "strength_x",
      label: "Strength X",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
    },
    {
      name: "strength_y",
      label: "Strength Y",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
    },
  ],
  primaryOutput: "spline",
  resolvePrimaryOutput(params): SocketType {
    return innerType(((params.mode as string) ?? "spline") as Mode);
  },
  auxOutputs: [],

  compute({ inputs, params, ctx, nodeId }) {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    const sx = (params.strength_x as number) ?? 0.05;
    const sy = (params.strength_y as number) ?? 0.05;
    const state = ensureState(ctx, nodeId);

    const noiseX = inputs.noise_x;
    const noiseY = inputs.noise_y;
    // Read each connected noise into its own CPU buffer. The same
    // scratch canvas gets reused across both reads — getImageData
    // copies the bytes out, so the first read's data persists past
    // the second blit.
    const bufX =
      noiseX?.kind === "image"
        ? readImageToBuffer(ctx, state.scratchCanvas, noiseX)
        : null;
    const bufY =
      noiseY?.kind === "image"
        ? readImageToBuffer(ctx, state.scratchCanvas, noiseY)
        : null;

    // Per-anchor displacement: 0.5 maps to zero shift, 0 → -strength,
    // 1 → +strength. That symmetry keeps jitter visually centered.
    const offsetAt = (u: number, v: number): [number, number] => {
      const rx = bufX ? (sampleR(bufX, u, v) - 0.5) * 2 : 0;
      const ry = bufY ? (sampleR(bufY, u, v) - 0.5) * 2 : 0;
      return [rx * sx, ry * sy];
    };

    if (mode === "points") {
      const src = inputs.in;
      if (!src || src.kind !== "points") {
        const empty: PointsValue = { kind: "points", points: [] };
        return { primary: empty };
      }
      const out: Point[] = src.points.map((p) => {
        const [dx, dy] = offsetAt(p.pos[0], p.pos[1]);
        return { ...p, pos: [p.pos[0] + dx, p.pos[1] + dy] };
      });
      return { primary: { kind: "points", points: out } };
    }

    // spline mode
    const src = inputs.in;
    if (!src || src.kind !== "spline") {
      const empty: SplineValue = { kind: "spline", subpaths: [] };
      return { primary: empty };
    }
    const out: SplineValue = {
      kind: "spline",
      subpaths: src.subpaths.map((sub) => ({
        // groupIndex rides on the subpath, not the anchor — pass
        // through unchanged.
        closed: sub.closed,
        groupIndex: sub.groupIndex,
        anchors: sub.anchors.map<SplineAnchor>((a) => {
          const [dx, dy] = offsetAt(a.pos[0], a.pos[1]);
          return {
            ...a,
            pos: [a.pos[0] + dx, a.pos[1] + dy],
          };
        }),
      })),
    };
    return { primary: out };
  },
};
