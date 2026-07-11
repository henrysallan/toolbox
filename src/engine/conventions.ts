import type { InputSocketDef, ParamDef, SocketType } from "./types";

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

// Virtual keys for a color ramp's per-stop sub-values. Unlike gpoint keys
// these embed the PARAM name — a def may declare more than one `color_ramp`
// param, so the key must say which ramp the stop belongs to. One grammar is
// shared by all three per-stop systems:
//   - animation-map keys (per-stop keyframes; same clone-and-override
//     contract as LAYER_OPACITY / GPOINT above),
//   - `exposedParams` entries (per-stop input sockets, `in:param:<key>`
//     handles; color drives as vec4, alpha/position as scalar),
//   - `controlParams` entries (per-stop knobs in exported apps).
// Stop colors keyframe as RGBA tuples (keyframe-engine color interp);
// the evaluator normalizes back to hex before compute sees the stops.
export const RAMP_C_PREFIX = "ramp_c:";
export const RAMP_A_PREFIX = "ramp_a:";
export const RAMP_P_PREFIX = "ramp_p:";

export type RampStopField = "color" | "alpha" | "position";

export function rampColorKey(paramName: string, stopId: string): string {
  return RAMP_C_PREFIX + paramName + ":" + stopId;
}
export function rampAlphaKey(paramName: string, stopId: string): string {
  return RAMP_A_PREFIX + paramName + ":" + stopId;
}
export function rampPositionKey(paramName: string, stopId: string): string {
  return RAMP_P_PREFIX + paramName + ":" + stopId;
}
export function rampStopKey(
  field: RampStopField,
  paramName: string,
  stopId: string
): string {
  return field === "color"
    ? rampColorKey(paramName, stopId)
    : field === "alpha"
      ? rampAlphaKey(paramName, stopId)
      : rampPositionKey(paramName, stopId);
}

// Parse a virtual ramp key back into its parts. Returns null for anything
// that isn't a ramp key (literal param names, other virtual prefixes).
export function parseRampParamKey(
  key: string
): { field: RampStopField; paramName: string; stopId: string } | null {
  let field: RampStopField;
  if (key.startsWith(RAMP_C_PREFIX)) field = "color";
  else if (key.startsWith(RAMP_A_PREFIX)) field = "alpha";
  else if (key.startsWith(RAMP_P_PREFIX)) field = "position";
  else return null;
  const rest = key.slice(RAMP_C_PREFIX.length); // all three prefixes are 7 chars
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return {
    field,
    paramName: rest.slice(0, sep),
    stopId: rest.slice(sep + 1),
  };
}

// Socket type that drives a ramp-stop field when exposed.
export function rampFieldSocketType(field: RampStopField): SocketType {
  return field === "color" ? "vec4" : "scalar";
}

// Normalize a resolved `color`-param override to the hex string the param
// model stores. Colors reach the evaluator as 0..1 RGB(A) tuples from two
// paths — a wired vec4 on an exposed color param, and keyframe
// interpolation (which lerps in tuple space) — but compute functions only
// ever see hex, so both paths normalize through here before the value
// lands in effectiveParams. Tuple alpha is ignored: param colors are RGB
// (a paired opacity/alpha param carries transparency).
export function colorValueToHex(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length >= 3) {
    const c = (x: unknown) => {
      const n = typeof x === "number" ? x : 0;
      return Math.max(0, Math.min(255, Math.round(n * 255)))
        .toString(16)
        .padStart(2, "0");
    };
    return `#${c(v[0])}${c(v[1])}${c(v[2])}`;
  }
  return fallback;
}

export const RAMP_FIELD_LABEL: Record<RampStopField, string> = {
  color: "color",
  alpha: "alpha",
  position: "position",
};

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
