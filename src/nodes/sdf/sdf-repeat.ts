import type {
  NodeDefinition,
  PositionNode,
  PositionValue,
} from "@/engine/types";

// SDF position-pipeline op — tile the per-pixel sample position. Cost
// is O(1) regardless of tile count; downstream ops (SDF Rotate, SDF
// Mirror, etc.) compose in tile-local space.
//
// Per-cell jitter (`rotation jitter`, `position jitter`, `scale
// jitter`) hashes the cell ID inside the GLSL fold so each tile
// independently rotates / shifts / scales by a pseudo-random amount.
// Use this for "every hexagon spins to its own beat" — wiring an
// upstream Noise scalar into a downstream SDF Rotate gives all tiles
// the same uniform angle, which is rarely what you want.

function rootOfPosition(v: unknown): PositionNode {
  if (
    v &&
    typeof v === "object" &&
    (v as { kind?: string }).kind === "position"
  ) {
    return (v as PositionValue).root;
  }
  return { kind: "canvasUv" };
}

export const sdfRepeatNode: NodeDefinition = {
  type: "sdf-repeat",
  name: "SDF Repeat",
  category: "utility",
  description:
    "SDF position-pipeline op — tile the sample position. Infinite by default; toggle Bounded for a finite tile count. Use the Jitter params for per-cell pseudo-random rotation / position / scale (each tile varies independently — what wiring an upstream Noise scalar into SDF Rotate cannot give you).",
  backend: "webgl2",
  stable: true,
  inputs: [
    {
      name: "position",
      type: "position",
      required: false,
      label: "Position",
    },
    { name: "spacing", type: "vec2", required: false, label: "Spacing" },
    { name: "center", type: "vec2", required: false, label: "Center" },
  ],
  params: [
    {
      name: "spacing_x",
      label: "Spacing X",
      type: "scalar",
      min: 0.001,
      max: 2,
      softMax: 0.5,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "spacing_y",
      label: "Spacing Y",
      type: "scalar",
      min: 0.001,
      max: 2,
      softMax: 0.5,
      step: 0.001,
      default: 0.25,
    },
    {
      name: "center_x",
      label: "Center X",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "center_y",
      label: "Center Y",
      type: "scalar",
      min: -1,
      max: 2,
      step: 0.001,
      default: 0.5,
    },
    {
      name: "bounded",
      label: "Bounded",
      type: "boolean",
      default: false,
    },
    {
      name: "limit_x",
      label: "Tiles X (±)",
      type: "scalar",
      min: 0,
      max: 32,
      step: 1,
      default: 3,
      visibleIf: (p) => !!p.bounded,
    },
    {
      name: "limit_y",
      label: "Tiles Y (±)",
      type: "scalar",
      min: 0,
      max: 32,
      step: 1,
      default: 3,
      visibleIf: (p) => !!p.bounded,
    },
    // Per-cell jitter. Hashes the cell ID inside the GLSL fold; each
    // tile gets independent pseudo-random variation. seed shifts the
    // hash so two Repeats in the same graph don't co-vary.
    {
      name: "rotation_jitter",
      label: "Rotation Jitter (rad)",
      type: "scalar",
      min: 0,
      max: Math.PI,
      step: 0.001,
      default: 0,
    },
    {
      name: "position_jitter_x",
      label: "Position Jitter X",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.1,
      step: 0.001,
      default: 0,
    },
    {
      name: "position_jitter_y",
      label: "Position Jitter Y",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.1,
      step: 0.001,
      default: 0,
    },
    {
      name: "scale_jitter",
      label: "Scale Jitter",
      type: "scalar",
      min: 0,
      max: 1,
      softMax: 0.5,
      step: 0.001,
      default: 0,
    },
    {
      name: "seed",
      label: "Seed",
      type: "scalar",
      min: 0,
      max: 1000,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: "position",
  auxOutputs: [
    {
      name: "cell_id",
      type: "position",
      description:
        "Per-pixel cell ID (vec2 integer), constant within a tile and varying between tiles. Wire into SDF Noise's `position` for true per-tile noise variation that can drive SDF Rotate's angle / SDF Twist's strength.",
    },
  ],
  linkedPairs: [{ a: "spacing_x", b: "spacing_y" }],

  compute({ inputs, params }) {
    const sp = inputs.spacing;
    const c = inputs.center;
    const spacingX =
      sp?.kind === "vec2"
        ? sp.value[0]
        : ((params.spacing_x as number) ?? 0.25);
    const spacingY =
      sp?.kind === "vec2"
        ? sp.value[1]
        : ((params.spacing_y as number) ?? 0.25);
    const cx =
      c?.kind === "vec2" ? c.value[0] : ((params.center_x as number) ?? 0.5);
    const cy =
      c?.kind === "vec2" ? c.value[1] : ((params.center_y as number) ?? 0.5);
    const bounded = !!params.bounded;
    const limitX = Math.max(0, (params.limit_x as number) ?? 3);
    const limitY = Math.max(0, (params.limit_y as number) ?? 3);
    const rotJitter = Math.max(0, (params.rotation_jitter as number) ?? 0);
    const posJitterX = Math.max(0, (params.position_jitter_x as number) ?? 0);
    const posJitterY = Math.max(0, (params.position_jitter_y as number) ?? 0);
    const scaleJitter = Math.max(0, (params.scale_jitter as number) ?? 0);
    const seed = (params.seed as number) ?? 0;

    const childPos = rootOfPosition(inputs.position);
    const finalSpacingX = Math.max(0.001, spacingX);
    const finalSpacingY = Math.max(0.001, spacingY);

    const out: PositionValue = {
      kind: "position",
      root: {
        kind: "repeat",
        child: childPos,
        spacingX: finalSpacingX,
        spacingY: finalSpacingY,
        cx,
        cy,
        bounded,
        limitX,
        limitY,
        rotJitter,
        posJitterX,
        posJitterY,
        scaleJitter,
        seed,
      },
    };
    const cellIdOut: PositionValue = {
      kind: "position",
      root: {
        kind: "cellId",
        child: childPos,
        spacingX: finalSpacingX,
        spacingY: finalSpacingY,
        cx,
        cy,
      },
    };
    return { primary: out, aux: { cell_id: cellIdOut } };
  },
};
