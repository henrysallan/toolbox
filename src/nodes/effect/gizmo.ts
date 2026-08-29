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
