import {
  SWITCH_AUTO,
  SWITCH_TYPE,
  switchTypeIsAuto,
  unifySocketTypes,
} from "@/engine/graph-helpers";
import type {
  InputSocketDef,
  NodeDefinition,
  ResolveCtx,
  SocketType,
} from "@/engine/types";

// N-input multiplexer. Picks `inputs[i]` where `i` is the value coming
// in on the `index` socket (or, if unconnected, the index param).
//
// UNIVERSAL: the slots carry ANY socket type, not a fixed shortlist. By
// default (`type: "auto"`) the node adopts whatever is wired in — one wire
// types the whole node, sockets and output together, exactly like Reroute —
// and mixed wires unify on the one type they can all coerce into
// (`unifySocketTypes`). Because every slot then shares that type, the
// evaluator's per-socket coercion does the conversion for free: a scalar and
// a vec4 in the same Switch make it a vec4 switch with the scalar broadcast
// to (s,s,s,s); a mask beside an image makes it an image switch. Set `type`
// explicitly to pin the node to one family (the slots are then honestly
// typed and only genuinely coercible wires land).
//
// Index is rounded and clamped into [0, count-1]; an empty slot outputs
// nothing. `index` also renders as a bar on the node body (EffectNode's
// SCALAR_INPUT_PARAMS) whose range follows `count` via ParamDef.maxFrom.
//
// Spec: specdocs/080526_universal-switch.md.
//
// The picked value is passed through UNTOUCHED — `ownsTextures: false`, like
// Reroute. A mux never allocates, so it must never release its inputs'
// textures back to the pool (the upstream node owns them).

// Every socket type a Switch can carry. `render` is excluded — it's an inert
// organizational link (Output → Render Queue), nothing to multiplex — as is
// `vector`, which no node emits.
const TYPES: SocketType[] = [
  "scalar",
  "vec2",
  "vec3",
  "vec4",
  "image",
  "mask",
  "uv",
  "spline",
  "points",
  "string",
  "element",
  "image_group",
  "text_instance",
  "audio",
  "sdf",
  "position",
  "scalar_field",
  "object3d",
  "camera",
  "force",
  "emitter",
  "collider",
  "particles",
];

const TYPE_OPTIONS: string[] = [SWITCH_AUTO, ...TYPES];

// What an unwired "auto" Switch shows before anything types it. Scalar was
// the node's original default, so a fresh Switch looks unchanged.
const RESTING_TYPE: SocketType = "scalar";

const MIN_COUNT = 2;
const MAX_COUNT = 8;

function activeCount(params: Record<string, unknown>): number {
  const raw = (params.count as number) ?? MIN_COUNT;
  if (!Number.isFinite(raw)) return MIN_COUNT;
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(raw)));
}

// The type every slot (and the output) takes this resolve. Explicit `type`
// wins; "auto" unifies whatever is wired into the live slots.
function activeType(
  params: Record<string, unknown>,
  ctx?: ResolveCtx
): SocketType {
  const t = params.type;
  if (!switchTypeIsAuto(t)) {
    return TYPES.includes(t as SocketType) ? (t as SocketType) : RESTING_TYPE;
  }
  const connected = ctx?.connectedTypes;
  if (!connected) return RESTING_TYPE;
  // Only the numbered value slots vote — `index` (always scalar) and the
  // universal `mask` input must not retype the node — and only slots within
  // the current count (a wire can outlive a lowered Count). Walked in socket
  // order so unify's tie-break is deterministic: the topmost wire wins.
  const n = activeCount(params);
  const wired: (SocketType | undefined)[] = [];
  for (let i = 0; i < n; i++) wired.push(connected[`in${i}`]);
  return unifySocketTypes(wired) ?? RESTING_TYPE;
}

export const switchNode: NodeDefinition = {
  type: SWITCH_TYPE,
  name: "Switch",
  category: "utility",
  description:
    "Picks one of N inputs by index. Accepts any socket type: leave Type on \"auto\" and the node adopts whatever you wire in — mixed inputs coerce to the one type they share (a scalar beside a vec4 becomes vec4; a mask beside an image becomes image). Count sets how many slots render. Wire a scalar to Index for live switching.",
  backend: "webgl2",
  headerControl: { paramName: "type" },
  inputs: [
    { name: "index", type: "scalar", required: false, label: "Index" },
    { name: "in0", type: RESTING_TYPE, required: false, label: "Input 0" },
    { name: "in1", type: RESTING_TYPE, required: false, label: "Input 1" },
  ],
  resolveInputs(params, ctx): InputSocketDef[] {
    const t = activeType(params, ctx);
    const n = activeCount(params);
    const sockets: InputSocketDef[] = [
      { name: "index", type: "scalar", required: false, label: "Index" },
    ];
    for (let i = 0; i < n; i++) {
      sockets.push({
        name: `in${i}`,
        type: t,
        required: false,
        label: `Input ${i}`,
      });
    }
    return sockets;
  },
  params: [
    {
      name: "type",
      label: "Type",
      type: "enum",
      options: TYPE_OPTIONS,
      default: SWITCH_AUTO,
    },
    {
      name: "count",
      label: "Count",
      type: "scalar",
      min: MIN_COUNT,
      max: MAX_COUNT,
      step: 1,
      default: 2,
    },
    {
      name: "index",
      label: "Index",
      type: "scalar",
      min: 0,
      // The slider spans exactly the slots that exist — the static `max` is
      // only the fallback for contexts without sibling params in reach
      // (exported-app controls). compute clamps regardless.
      max: MAX_COUNT - 1,
      maxFrom: (p) => activeCount(p) - 1,
      step: 1,
      default: 0,
    },
  ],
  primaryOutput: RESTING_TYPE,
  resolvePrimaryOutput(params, ctx): SocketType {
    return activeType(params, ctx);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const n = activeCount(params);
    const idxRaw =
      inputs.index?.kind === "scalar"
        ? inputs.index.value
        : ((params.index as number) ?? 0);
    let i = Math.round(idxRaw);
    if (!Number.isFinite(i)) i = 0;
    if (i < 0) i = 0;
    if (i > n - 1) i = n - 1;
    const picked = inputs[`in${i}`];
    if (!picked) return {};
    // Borrowed, not produced — the upstream node owns these textures.
    return { primary: picked, ownsTextures: false };
  },
};
