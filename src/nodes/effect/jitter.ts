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
import { copyPointsWith, EMPTY_POINTS } from "@/engine/points";

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

interface ImageBuffer {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

function readImageToBuffer(
  ctx: RenderContext,
  img: { texture: WebGLTexture; width: number; height: number }
): ImageBuffer | null {
  if (img.width <= 0 || img.height <= 0) return null;
  const data = ctx.readImagePixels(
    { kind: "image", texture: img.texture, width: img.width, height: img.height }
  );
  if (!data) return null;
  return { data, w: img.width, h: img.height };
}

// Returns the R channel sampled at UV (0..1). Output is in [0, 1].
function sampleR(buf: ImageBuffer, u: number, v: number): number {
  const px = Math.max(0, Math.min(buf.w - 1, Math.floor(u * buf.w)));
  // UV is Y-down for splines/points and readImagePixels returns rows
  // top-down (ImageData order) → no explicit Y flip needed here.
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
  // Merged into the polymorphic Displace node (effect/displace.ts), which now
  // warps splines/points as well as images. Kept registered (back-compat
  // invariant #2) but hidden from the add menus so old projects still load and
  // render their existing Jitter nodes; new work uses Displace.
  hidden: true,
  description:
    "Deprecated — use Displace (it now warps splines and points too). Per-anchor positional jitter: samples optional X-noise and Y-noise images at each anchor's own UV and displaces by the sampled value mapped to [-1..1] times the strength.",
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

  compute({ inputs, params, ctx }) {
    const mode = ((params.mode as string) ?? "spline") as Mode;
    const sx = (params.strength_x as number) ?? 0.05;
    const sy = (params.strength_y as number) ?? 0.05;

    const noiseX = inputs.noise_x;
    const noiseY = inputs.noise_y;
    // Read each connected noise into its own CPU buffer.
    const bufX =
      noiseX?.kind === "image" ? readImageToBuffer(ctx, noiseX) : null;
    const bufY =
      noiseY?.kind === "image" ? readImageToBuffer(ctx, noiseY) : null;

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
        return { primary: EMPTY_POINTS };
      }
      // Positions-only transform in SoA — every other channel carries.
      const n = src.count;
      const positions = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const px = src.positions[i * 2];
        const py = src.positions[i * 2 + 1];
        const [dx, dy] = offsetAt(px, py);
        positions[i * 2] = px + dx;
        positions[i * 2 + 1] = py + dy;
      }
      return { primary: copyPointsWith(src, { positions }) };
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
