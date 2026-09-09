import type {
  InputSocketDef,
  NodeDefinition,
  SdfNode,
  SdfValue,
} from "@/engine/types";

// Boolean union of N SDFs — the result is "inside if any input is
// inside". Implemented as nested min(). Sharp boundary; for a blended
// boundary use SDF Smooth Union.
//
// N-ary: the input sockets auto-grow. `slots` holds the socket names in
// order and always carries exactly one trailing spare — wiring the spare
// spawns the next one (the reconciler lives in EffectsApp, keyed off
// edges so it stays undo-safe). The original `a`/`b` names are the
// default slot list, so saved two-input projects keep their wires.

const DEFAULT_SLOTS = ["a", "b"];

// Sockets that are NOT auto-grow slots — mirrored in EffectsApp's
// reconciler exclusion list.
const FIXED_INPUTS = new Set(["mask"]);

function readUnionSlots(params: Record<string, unknown>): string[] {
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

// A, B, … Z, then S27, S28 — same ordinals as SDF Smooth Union.
function slotLabel(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `S${i + 1}`;
}

export const sdfUnionNode: NodeDefinition = {
  type: "sdf-union",
  name: "SDF Union",
  category: "utility",
  description:
    "Boolean union of any number of SDFs (min). Result is inside if any input is inside. Inputs auto-grow: wire the empty socket and another appears. For a blended boundary use SDF Smooth Union.",
  facts: {
    gotchas: [
      "N-ary via auto-growing sockets (a, b, ... always one spare); wiring the spare socket adds another.",
      "Unwired slots are dropped rather than folded in as the empty sentinel, so extra unused sockets add nothing to the emitted tree.",
    ],
  },
  backend: "webgl2",
  stable: true,
  inputs: [
    { name: "a", type: "sdf", required: false, label: "A" },
    { name: "b", type: "sdf", required: false, label: "B" },
  ],
  resolveInputs(params): InputSocketDef[] {
    return readUnionSlots(params).map((name, i) => ({
      name,
      type: "sdf" as const,
      required: false,
      label: slotLabel(i),
    }));
  },
  params: [],
  primaryOutput: "sdf",
  auxOutputs: [],

  compute({ inputs, params }) {
    // Unwired slots are dropped rather than folded in as the `empty`
    // sentinel. min(d, 1e10) already collapses to d, so this changes no
    // pixels — it just keeps the emitted tree (and its structural hash)
    // free of dead branches.
    const roots: SdfNode[] = [];
    for (const name of readUnionSlots(params)) {
      const r = rootOf(inputs[name]);
      if (r) roots.push(r);
    }

    // Left fold. min is associative, so fold order only matters for
    // material blending (sUnion) — socket order is what the node
    // visually implies.
    let root: SdfNode = roots[0] ?? { kind: "empty" };
    for (let i = 1; i < roots.length; i++) {
      root = { kind: "union", a: root, b: roots[i] };
    }

    const out: SdfValue = { kind: "sdf", root };
    return { primary: out };
  },
};
