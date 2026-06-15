import type { InputSocketDef, ParamDef } from "./types";

// Universal opacity param. Any node def that declares it gets a free
// post-pass from the evaluator: every image output (primary AND aux)
// has its alpha multiplied by the value. Nodes never implement opacity
// themselves — declaring the param is the whole integration. Scalar,
// so it keyframes / exposes / drives like any other param.
export const OPACITY_PARAM: ParamDef = {
  name: "opacity",
  label: "Opacity",
  type: "scalar",
  min: 0,
  max: 1,
  step: 0.001,
  default: 1,
};

// Virtual animation keys for per-layer opacity inside a `merge_layers`
// param. The array param itself isn't keyframable, but each layer's
// opacity is a scalar — its keyframes live in the node's AnimationMap
// under "layer_opacity:<layerId>". The evaluator resolves these blocks
// into a cloned layers array at eval time; the param panel renders a
// diamond per layer; EffectsApp auto-keyframes opacity edits when a
// layer's block is animated.
export const LAYER_OPACITY_PREFIX = "layer_opacity:";

export function layerOpacityKey(layerId: string): string {
  return LAYER_OPACITY_PREFIX + layerId;
}

// Virtual animation keys for a multipoint gradient's per-point sub-values.
// The `gradient_points` array param isn't keyframable itself; each point's
// x / y (scalar) and color (RGBA) animate via their own blocks under these
// keys. Resolved by the evaluator into a cloned points array; the param
// panel renders a diamond per point; EffectsApp auto-keyframes edits when a
// point's block is animated. Same pattern as LAYER_OPACITY_PREFIX.
export const GPOINT_X_PREFIX = "gpoint_x:";
export const GPOINT_Y_PREFIX = "gpoint_y:";
export const GPOINT_C_PREFIX = "gpoint_c:";

export function gpointXKey(id: string): string {
  return GPOINT_X_PREFIX + id;
}
export function gpointYKey(id: string): string {
  return GPOINT_Y_PREFIX + id;
}
export function gpointCKey(id: string): string {
  return GPOINT_C_PREFIX + id;
}

export const MASK_INPUT_NAME = "mask";

export const MASK_INPUT: InputSocketDef = {
  name: MASK_INPUT_NAME,
  label: "mask",
  type: "mask",
  required: false,
};

// Appends the universal mask input if the node's declared inputs don't already
// include one. Used by both the evaluator and the UI layer so the socket list
// stays consistent. Pass the node def so `noMaskInput` opt-outs (nodes that
// produce no image, e.g. Render Queue) are respected everywhere.
export function withMaskInput(
  inputs: InputSocketDef[],
  def?: { noMaskInput?: boolean } | null
): InputSocketDef[] {
  if (def?.noMaskInput) return inputs;
  if (inputs.some((i) => i.name === MASK_INPUT_NAME)) return inputs;
  return [...inputs, MASK_INPUT];
}
