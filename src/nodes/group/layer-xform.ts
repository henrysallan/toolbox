import type { NodeDefinition } from "@/engine/types";
import { LAYER_XFORM_TYPE } from "@/engine/groups";
import {
  asTransform,
  composeTransform,
  opFromParams,
  TRANSFORM_TRS_PARAMS,
} from "@/engine/transform-value";

// Eval-only: one per layer, synthesized by the flatten pass (engine/
// flatten.ts) and never present in a project. It shares the layer's
// `params` and `animation` objects by reference, so it reads the layer's
// TRS (keyframes included, on the layer node's clock) and emits the
// layer's world transform = parent ∘ local. Splitting this out of the
// layer keeps transform paths a DAG of their own, independent of stacking
// order. No clips and no bypass flag, so a hidden or out-of-window parent
// still drives its children (AE semantics).
// Spec: specdocs/101526_layer-transforms-parenting.md §3.

export const layerXformNode: NodeDefinition = {
  type: LAYER_XFORM_TYPE,
  name: "Layer Transform",
  hidden: true,
  category: "utility",
  description:
    "Internal: a layer's world transform (its TRS over its parent), split out of the layer at evaluation.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [{ name: "parent", type: "transform", required: false }],
  // Declared so the evaluator applies the layer's TRS keyframes here — it
  // walks def.params to resolve animation.
  params: TRANSFORM_TRS_PARAMS,
  primaryOutput: "transform",
  auxOutputs: [],

  compute({ inputs, params }) {
    return {
      primary: composeTransform(asTransform(inputs.parent), opFromParams(params)),
    };
  },
};
