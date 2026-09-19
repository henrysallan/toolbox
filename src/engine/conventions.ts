import type {
  InputSocketDef,
  ParamDef,
  ParamType,
  SocketType,
  SplineSubpath,
} from "./types";
import {
  evaluateKeyframesAt,
  findKeyframeAt,
  upsertKeyframe,
  type AnimationMap,
  type KeyframeAnimationBlock,
} from "./keyframes";

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

// Virtual control keys for one layer of a `merge_layers` param. The live
// link / exported app used to get the WHOLE layer stack as a single control
// (the param-level control toggle on "Layers"); since 2026-09-16 each layer
// carries its own toggle in the Merge editor instead. Three keys share one
// grammar, all embedding the owning param name like the ramp keys above:
//   - `mlayer:<param>:<layerId>` — the `controlParams` membership entry,
//     one per toggled layer (what the editor's per-layer button flips),
//   - `mlayer_m:<param>:<layerId>` / `mlayer_o:<param>:<layerId>` — the
//     paramNames of the two controls the manifest builder synthesizes from
//     that entry (blend mode enum, opacity scalar). The live viewer parses
//     them back and patches the layer inside the array param in place.
// A layer's opacity KEYFRAMES stay under LAYER_OPACITY_PREFIX — that's the
// animation map's namespace, this is controlParams'.
export const MLAYER_PREFIX = "mlayer:";
export const MLAYER_M_PREFIX = "mlayer_m:";
export const MLAYER_O_PREFIX = "mlayer_o:";

export type MergeLayerField = "layer" | "mode" | "opacity";

export function mergeLayerKey(paramName: string, layerId: string): string {
  return MLAYER_PREFIX + paramName + ":" + layerId;
}
export function mergeLayerModeKey(paramName: string, layerId: string): string {
  return MLAYER_M_PREFIX + paramName + ":" + layerId;
}
export function mergeLayerOpacityKey(
  paramName: string,
  layerId: string
): string {
  return MLAYER_O_PREFIX + paramName + ":" + layerId;
}

// Parse a virtual merge-layer key back into its parts. Returns null for
// anything that isn't one (literal param names, other virtual prefixes).
export function parseMergeLayerKey(
  key: string
): { field: MergeLayerField; paramName: string; layerId: string } | null {
  let field: MergeLayerField;
  let rest: string;
  if (key.startsWith(MLAYER_PREFIX)) {
    field = "layer";
    rest = key.slice(MLAYER_PREFIX.length);
  } else if (key.startsWith(MLAYER_M_PREFIX)) {
    field = "mode";
    rest = key.slice(MLAYER_M_PREFIX.length);
  } else if (key.startsWith(MLAYER_O_PREFIX)) {
    field = "opacity";
    rest = key.slice(MLAYER_O_PREFIX.length);
  } else return null;
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return {
    field,
    paramName: rest.slice(0, sep),
    layerId: rest.slice(sep + 1),
  };
}

// Legacy → per-layer expansion for a node's `controlParams`. Saves from
// before the per-layer toggle hold the literal `merge_layers` param name
// ("layers") meaning "every layer is a control". Rewrite that entry into
// one `mlayer:` key per layer currently in the array so the editor's
// per-layer buttons light up and the manifest builder sees one grammar.
// Order-preserving; a no-op (same array identity) when nothing to expand.
export function expandMergeLayerControls(
  paramDefs: readonly ParamDef[],
  params: Record<string, unknown>,
  controlParams: readonly string[]
): string[] {
  let changed = false;
  const out: string[] = [];
  for (const key of controlParams) {
    const pdef = paramDefs.find(
      (p) => p.name === key && p.type === "merge_layers"
    );
    if (!pdef) {
      if (!out.includes(key)) out.push(key);
      continue;
    }
    changed = true;
    const raw = params[pdef.name];
    const layers = Array.isArray(raw)
      ? (raw as { id?: unknown }[])
      : Array.isArray(pdef.default)
        ? (pdef.default as unknown as { id?: unknown }[])
        : [];
    for (const l of layers) {
      if (typeof l?.id !== "string") continue;
      const k = mergeLayerKey(pdef.name, l.id);
      if (!out.includes(k)) out.push(k);
    }
  }
  return changed ? out : (controlParams as string[]);
}

// Normalize a resolved `color`-param override to the hex string the param
// model stores. Colors reach the evaluator as 0..1 RGB(A) tuples from two
// paths — a wired vec4 on an exposed color param, and keyframe
// interpolation (which lerps in tuple space) — but compute functions only
// ever see hex, so both paths normalize through here before the value
// lands in effectiveParams. Tuple alpha is carried as an 8-digit
// `#rrggbbaa` ONLY when the def opts in (`ParamDef.alpha`) and the tuple
// is actually translucent — everywhere else it's dropped, so un-audited
// nodes never receive 8 digits (spec 072026_color-alpha.md).
export function colorValueToHex(
  v: unknown,
  fallback: string,
  alpha = false
): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length >= 3) {
    const byte = (x: unknown) => {
      const n = typeof x === "number" ? x : 0;
      return Math.max(0, Math.min(255, Math.round(n * 255)));
    };
    const c = (x: unknown) => byte(x).toString(16).padStart(2, "0");
    const rgb = `#${c(v[0])}${c(v[1])}${c(v[2])}`;
    if (alpha) {
      const a = byte(typeof v[3] === "number" ? v[3] : 1);
      if (a < 255) return rgb + a.toString(16).padStart(2, "0");
    }
    return rgb;
  }
  return fallback;
}

// Display-value resolution for UI readouts: the keyframe-evaluated value
// of a param (or virtual-key sub-value) at `tick`, falling back to the
// stored constant when the block is missing/disabled/empty. This is the
// keyframe step of the evaluator's wire > keyframe > constant merge —
// callers handle the wire case themselves (driven params show stored).
// Colors normalize to hex exactly like effectiveParams does (interpolation
// returns 0..1 RGBA tuples between keyframes); pass the def's `alpha`
// flag as `alphaColor` so opted-in params keep their alpha byte.
export function animatedValueAt(
  block: KeyframeAnimationBlock | undefined,
  type: ParamType,
  tick: number,
  stored: unknown,
  alphaColor = false
): unknown {
  if (!block || !block.animated || block.keyframes.length === 0) return stored;
  const v = evaluateKeyframesAt(block, type, tick);
  if (v === undefined) return stored;
  if (type === "color") {
    return colorValueToHex(
      v,
      typeof stored === "string" ? stored : "#000000",
      alphaColor
    );
  }
  return v;
}

export const RAMP_FIELD_LABEL: Record<RampStopField, string> = {
  color: "color",
  alpha: "alpha",
  position: "position",
};

// ---------------------------------------------------------------------
// Per-anchor spline tracks (Spline Draw, spec 072726 M6)
// ---------------------------------------------------------------------
//
// Virtual keys animating INDIVIDUAL anchors of a `spline_anchors` param —
// the ramp-stop pattern one level deeper. Three vec2 tracks per anchor id:
// position, in-handle offset, out-handle offset (a missing handle IS
// [0, 0], so vec2 lerp is exact and handles can grow/retract smoothly).
// EITHER/OR with whole-shape "Path Animation": when the spline param's own
// block is animated, per-anchor tracks are ignored (the caller guards).

export const ANCHOR_P_PREFIX = "anchor_p:";
export const ANCHOR_IN_PREFIX = "anchor_in:";
export const ANCHOR_OUT_PREFIX = "anchor_out:";

export function anchorPosKey(id: string): string {
  return `${ANCHOR_P_PREFIX}${id}`;
}
export function anchorInKey(id: string): string {
  return `${ANCHOR_IN_PREFIX}${id}`;
}
export function anchorOutKey(id: string): string {
  return `${ANCHOR_OUT_PREFIX}${id}`;
}
export function isAnchorTrackKey(key: string): boolean {
  return (
    key.startsWith(ANCHOR_P_PREFIX) ||
    key.startsWith(ANCHOR_IN_PREFIX) ||
    key.startsWith(ANCHOR_OUT_PREFIX)
  );
}
// The anchor id a track key names, or null for non-anchor keys.
export function anchorTrackId(key: string): string | null {
  for (const p of [ANCHOR_P_PREFIX, ANCHOR_IN_PREFIX, ANCHOR_OUT_PREFIX]) {
    if (key.startsWith(p)) return key.slice(p.length);
  }
  return null;
}

// Resolve every animated anchor track onto a cloned spline at `tick`.
// Returns null when nothing applied (caller keeps the original — and does
// the either/or guard against whole-shape Path Animation). Shared by the
// evaluator's clone-and-override block and the editor overlay's
// value-at-tick derivation, so what's edited is what renders.
export function resolveAnchorTracks<T extends { subpaths: SplineSubpath[] }>(
  spline: T,
  animation: Record<string, KeyframeAnimationBlock | undefined> | undefined,
  tick: number
): T | null {
  if (!animation) return null;
  let out: SplineSubpath[] | null = null;
  const ensure = () =>
    out ??
    (out = spline.subpaths.map((s) => ({
      ...s,
      anchors: s.anchors.map((a) => ({ ...a })),
    })));
  let touched = false;
  for (const [key, block] of Object.entries(animation)) {
    if (!block || !block.animated || block.keyframes.length === 0) continue;
    let field: "p" | "in" | "out" | null = null;
    if (key.startsWith(ANCHOR_P_PREFIX)) field = "p";
    else if (key.startsWith(ANCHOR_IN_PREFIX)) field = "in";
    else if (key.startsWith(ANCHOR_OUT_PREFIX)) field = "out";
    if (!field) continue;
    const id = anchorTrackId(key);
    if (!id) continue;
    const v = evaluateKeyframesAt(block, "vec2", tick);
    if (!Array.isArray(v) || v.length < 2) continue;
    const vec: [number, number] = [v[0] as number, v[1] as number];
    for (const s of ensure()) {
      const a = s.anchors.find((x) => x.id === id);
      if (!a) continue;
      if (field === "p") {
        a.pos = vec;
      } else if (field === "in") {
        if (Math.hypot(vec[0], vec[1]) < 1e-9) delete a.inHandle;
        else a.inHandle = vec;
      } else {
        if (Math.hypot(vec[0], vec[1]) < 1e-9) delete a.outHandle;
        else a.outHandle = vec;
      }
      touched = true;
      break;
    }
  }
  return touched && out ? { ...spline, subpaths: out } : null;
}

// Anchors that can take a new key at `tick`: at least one of their
// pos/in/out tracks is animated and has no keyframe there. Empty while
// whole-shape Path Animation is on (the either/or).
export function insertableAnchorIdsAtTick(
  animation: AnimationMap | undefined,
  tick: number
): Set<string> {
  const out = new Set<string>();
  if (!animation) return out;
  if (animation.spline?.animated && animation.spline.keyframes.length > 0) {
    return out;
  }
  for (const [key, block] of Object.entries(animation)) {
    if (!block.animated) continue;
    const id = anchorTrackId(key);
    if (!id) continue;
    if (!findKeyframeAt(block, tick)) out.add(id);
  }
  return out;
}

// Pin the evaluated pose of `anchorIndexes` onto their existing per-anchor
// tracks at `tick`. Skips un-animated anchors and Path Animation. Returns
// null when nothing changed so the caller can skip the undo/write.
export function insertAnchorKeysAtTick(
  animation: AnimationMap,
  spline: { subpaths: SplineSubpath[] },
  subpathIndex: number,
  anchorIndexes: number[],
  tick: number
): AnimationMap | null {
  if (animation.spline?.animated && animation.spline.keyframes.length > 0) {
    return null;
  }
  const evaluated = resolveAnchorTracks(spline, animation, tick) ?? spline;
  const sub = evaluated.subpaths[subpathIndex];
  if (!sub) return null;
  let next: AnimationMap = animation;
  let changed = false;
  const pin = (key: string, value: [number, number]) => {
    const blk = next[key];
    if (!blk?.animated) return;
    next = { ...next, [key]: upsertKeyframe(blk, tick, value, "easeInOut") };
    changed = true;
  };
  for (const ai of anchorIndexes) {
    const a = sub.anchors[ai];
    if (!a?.id) continue;
    pin(anchorPosKey(a.id), [a.pos[0], a.pos[1]]);
    pin(anchorInKey(a.id), [a.inHandle?.[0] ?? 0, a.inHandle?.[1] ?? 0]);
    pin(anchorOutKey(a.id), [a.outHandle?.[0] ?? 0, a.outHandle?.[1] ?? 0]);
  }
  return changed ? next : null;
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
