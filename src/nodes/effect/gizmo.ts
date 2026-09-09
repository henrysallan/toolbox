import type { NodeDefinition, TransformValue } from "@/engine/types";
import {
  composeTransform,
  opFromParams,
  TRANSFORM_TRS_PARAMS,
} from "@/engine/transform-value";

// Authors a `transform` value through the on-canvas TRS+pivot gizmo.
// Has no geometry of its own — fan the output into primitives and Transform
// so many shapes share one placement. Optional `transform` input composes
// as parent ∘ local (local first). Spec: specdocs/082826_gizmo-node.md.

export const gizmoNode: NodeDefinition = {
  type: "gizmo",
  name: "Gizmo",
  category: "utility",
  description:
    "On-canvas position / rotation / scale / pivot control. Outputs a transform value you can wire into primitives (Circle, Rectangle, Point, …) and Transform so several shapes share one placement. Wire another Gizmo into this node's Transform input to parent them.",
  facts: {
    space: {
      "param:translateX": "canvas01",
      "param:translateY": "canvas01",
      "param:pivotX": "canvas01",
      "param:pivotY": "canvas01",
    },
    gotchas: [
      "Outputs a transform value only; nothing moves until it's wired into a primitive or Transform that applies parent ops first, then this node's TRS.",
      "An identity local transform (defaults unchanged) is dropped when composing over a wired parent, so a default Gizmo just passes the parent through.",
      "pivotX/Y are absolute canvas01 coordinates (default 0.5,0.5 = canvas center), not a 0..1 fraction of the consumer's own bounds.",
    ],
  },
  backend: "webgl2",
  stable: true,
  noMaskInput: true,
  supportsTransformGizmo: true,
  inputs: [
    {
      name: "transform",
      type: "transform",
      required: false,
      label: "Transform",
    },
  ],
  params: TRANSFORM_TRS_PARAMS,
  primaryOutput: "transform",
  auxOutputs: [],
  linkedPairs: [{ a: "scaleX", b: "scaleY" }],

  compute({ inputs, params }) {
    const parent =
      inputs.transform?.kind === "transform" ? inputs.transform : undefined;
    const out: TransformValue = composeTransform(parent, opFromParams(params));
    return { primary: out };
  },
};
