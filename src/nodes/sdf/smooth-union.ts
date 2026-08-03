import type {
  InputSocketDef,
  NodeDefinition,
  SdfNode,
  SdfValue,
} from "@/engine/types";

// Polynomial smin (Iñigo Quilez). Smoothness controls the blend
// width — when two SDFs come within `smoothness` of each other their
// boundaries merge into a single curved blob. Set to 0 for a sharp
// union (degenerates to plain min).
//
// N-ary: the input sockets auto-grow. `slots` holds the socket names in
// order and always carries exactly one trailing spare — wiring the spare
// spawns the next one (the reconciler lives in EffectsApp, keyed off
// edges so it stays undo-safe). The original `a`/`b` names are the
// default slot list, so saved projects keep their wires.
//
// Blobbing more than two shapes is the whole point of this node with
// materials in play: each input can carry its own colour, and every
// smin fold blends the colours with the same factor it blends the
// distances. Spec: 080226_sdf-materials-and-shading.md.

const DEFAULT_SLOTS = ["a", "b"];

// Sockets that are NOT auto-grow slots — mirrored in EffectsApp's
// reconciler exclusion list.
const FIXED_INPUTS = new Set(["smoothness", "mask"]);

export function readSmoothUnionSlots(
  params: Record<string, unknown>
): string[] {
  const raw = params.slots;
  return Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((x) => typeof x === "string") &&
    !raw.some((x) => FIXED_INPUTS.has(x as string))
    ? (raw as string[])
    : DEFAULT_SLOTS;
}

function rootOf(v: unknown): SdfNode | null {
  if (v && typeof v === "object" && (v as { kind?: string }).kind === "sdf") {
    return (v as SdfValue).root;
  }
  return null;
}

// A, B, … Z, then S27, S28 — plain ordinals past the alphabet rather
// than AA/AB, which would read like a spreadsheet.
function slotLabel(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`;
}

export const sdfSmoothUnionNode: NodeDefinition = {
  type: "sdf-smooth-union",
  name: "SDF Smooth Union",
  category: "utility",
  description:
    "Smooth (blob) union of any number of SDFs. Smoothness sets the blend width — when boundaries come within Smoothness of each other they merge into a curved metaball-style join. Inputs auto-grow: wire the empty socket and another appears.",
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A" },
    { name: "b", type: "sdf", required: false, label: "B" },
    { name: "smoothness", type: "scalar", required: false, label: "Smoothness" },
  ],
  resolveInputs(params): InputSocketDef[] {
    const slots = readSmoothUnionSlots(params);
    return [
      ...slots.map((name, i) => ({
        name,
        type: "sdf" as const,
        required: false,
        label: slotLabel(i),
      })),
      {
        name: "smoothness",
        type: "scalar" as const,
        required: false,
        label: "Smoothness",
      },
    ];
  },
  params: [
    {
      name: "smoothness",
      label: "Smoothness",
      type: "scalar",
      min: 0,
      max: 0.5,
      softMax: 0.2,
      step: 0.001,
      default: 0.05,
    },
  ],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    const k = Math.max(
      0,
      inputs.smoothness?.kind === "scalar"
        ? inputs.smoothness.value
        : ((params.smoothness as number) ?? 0.05)
    );

    // Unwired slots are dropped rather than folded in as the `empty`
    // sentinel. smin(d, 1e10, k) already collapses to exactly d, so this
    // changes no pixels — it just keeps the emitted tree (and its
    // structural hash) free of dead branches.
    const roots: SdfNode[] = [];
    for (const name of readSmoothUnionSlots(params)) {
      const r = rootOf(inputs[name]);
      if (r) roots.push(r);
    }

    // Left fold. smin is not perfectly associative, so the fold order is
    // the socket order — stable, and what the sockets visually imply.
    let root: SdfNode = roots[0] ?? { kind: "empty" };
    for (let i = 1; i < roots.length; i++) {
      root = { kind: "smoothUnion", a: root, b: roots[i], k };
    }

    const out: SdfValue = { kind: "sdf", root };
    return { primary: out };
  },
};
