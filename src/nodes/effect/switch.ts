import {
  SWITCH_AUTO,
  SWITCH_COUNT_CAP,
  SWITCH_MIN_COUNT,
  SWITCH_MODE_TOGGLE,
  SWITCH_TYPE,
  readSwitchLabels,
  readSwitchSlots,
  switchIsToggle,
  switchToggleSlots,
  switchTypeIsAuto,
  unifySocketTypes,
} from "@/engine/graph-helpers";
import type {
  InputSocketDef,
  NodeDefinition,
  ResolveCtx,
  SocketType,
} from "@/engine/types";

// N-input multiplexer. Picks `slots[i]` where `i` is the value coming
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
// Inputs auto-grow (EffectsApp `slots` reconciler, same as Combine / SDF
// Union): there is always one spare empty socket. Wiring it mints the next.
// Pre-auto-grow saves used `count` (2–8) with sockets in0, in1, … — honor
// that when `slots` is absent so old projects and AI recipes that set count
// still resolve the same handles.
//
// Index is rounded and clamped into [0, slotCount-1]; an empty slot outputs
// nothing. `index` also renders as a bar on the node body (EffectNode's
// SCALAR_INPUT_PARAMS) whose range follows the live slot list via
// ParamDef.maxFrom.
//
// Mode "toggle" (2026-09-16) re-skins Index as a pick over the WIRED inputs
// — a segmented pill up to three, a dropdown past that — for the live link
// / exported app, where a viewer flips between looks rather than scrubs a
// number. The option list is `switchToggleSlots` (the auto-grow list minus
// its trailing spare, never fewer than two), and each input is nameable
// through `labels` (keyed by slot socket, so a name follows its wire). The
// names label the sockets too. All of it rides ParamDef hints — maxFrom /
// controlFrom / optionLabelsFrom — that the ParamPanel and the on-node
// control evaluate live and the export-manifest builder bakes into the
// live link's control def. compute is untouched: index in, slot out.
//
// Spec: specdocs/archive/080526_universal-switch.md.
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
  "transform",
];

const TYPE_OPTIONS: string[] = [SWITCH_AUTO, ...TYPES];

// What an unwired "auto" Switch shows before anything types it. Scalar was
// the node's original default, so a fresh Switch looks unchanged.
const RESTING_TYPE: SocketType = "scalar";

function slotNames(params: Record<string, unknown>): string[] {
  return readSwitchSlots(params);
}

function slotCount(params: Record<string, unknown>): number {
  return slotNames(params).length;
}

// Toggle mode's option count: the wired slots (spare excluded, min two).
function toggleCount(params: Record<string, unknown>): number {
  return switchToggleSlots(params).length;
}

// Toggle mode's pill / dropdown labels, keyed by the index value each state
// selects ("0" → the name on the first wired slot). Only named slots are
// listed — the control shows the bare number for the rest.
function toggleOptionLabels(
  params: Record<string, unknown>
): Record<string, string> {
  const names = readSwitchLabels(params);
  const out: Record<string, string> = {};
  switchToggleSlots(params).forEach((slot, i) => {
    const name = names[slot];
    if (name) out[String(i)] = name;
  });
  return out;
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
  // universal `mask` input must not retype the node. Walked in socket
  // order so unify's tie-break is deterministic: the topmost wire wins.
  const wired: (SocketType | undefined)[] = [];
  for (const name of slotNames(params)) wired.push(connected[name]);
  return unifySocketTypes(wired) ?? RESTING_TYPE;
}

export const switchNode: NodeDefinition = {
  type: SWITCH_TYPE,
  name: "Switch",
  category: "utility",
  description:
    "Picks one of N inputs by index. Accepts any socket type: leave Type on \"auto\" and the node adopts whatever you wire in — mixed inputs coerce to the one type they share (a scalar beside a vec4 becomes vec4; a mask beside an image becomes image). Inputs auto-grow — there's always one spare empty socket. Wire a scalar to Index for live switching. Mode \"toggle\" turns Index into a pill (up to three wired inputs) or dropdown over the wired inputs, each nameable via Names — the pick the live link shows when Index is marked as a control.",
  facts: {
    space: { out: "in:*" },
    gotchas: [
      "type=auto adopts whatever is wired into the numbered in0, in1, … slots; only those vote (index and mask never retype the node), topmost wire wins ties.",
      "Inputs auto-grow: connected numbered slots stay in order plus one trailing spare; disconnecting a middle slot drops it and later indices shift.",
      "The picked value passes through untouched and borrowed (ownsTextures: false) — the node never releases the upstream texture itself.",
      "index is rounded and clamped into [0, slotCount-1]; an unwired index slot falls back to the index param, and an empty slot at the picked index outputs nothing.",
      "mode=toggle only changes how index is edited (pill ≤3 states, dropdown past that, over the wired slots — the spare is excluded); labels are keyed by slot socket (in0, in1, …), not position.",
      "render and vector socket types are excluded from the switchable type list.",
    ],
  },
  backend: "webgl2",
  headerControl: { paramName: "type" },
  inputs: [
    { name: "index", type: "scalar", required: false, label: "Index" },
    { name: "in0", type: RESTING_TYPE, required: false, label: "Input 0" },
    { name: "in1", type: RESTING_TYPE, required: false, label: "Input 1" },
  ],
  resolveInputs(params, ctx): InputSocketDef[] {
    const t = activeType(params, ctx);
    const slots = slotNames(params);
    // Toggle mode's per-input names label the sockets too, so the node
    // reads the same as the pill (`Day` / `Night`, not `Input 0` / `1`).
    const names = switchIsToggle(params) ? readSwitchLabels(params) : {};
    const sockets: InputSocketDef[] = [
      { name: "index", type: "scalar", required: false, label: "Index" },
    ];
    for (let i = 0; i < slots.length; i++) {
      sockets.push({
        name: slots[i],
        type: t,
        required: false,
        label: names[slots[i]] ?? `Input ${i}`,
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
      // How Index is edited — the data path is identical either way.
      // "toggle" is the live-link mode: a pick over the wired inputs.
      name: "mode",
      label: "Mode",
      type: "enum",
      options: ["slider", SWITCH_MODE_TOGGLE],
      control: "segmented",
      default: "slider",
    },
    {
      // Hidden: the editor auto-grows `slots`. Kept so old saves and
      // recipes that set `count` still size the socket list when `slots`
      // is absent (readSwitchSlots).
      name: "count",
      label: "Inputs",
      type: "scalar",
      min: SWITCH_MIN_COUNT,
      max: SWITCH_COUNT_CAP,
      step: 1,
      default: 2,
      hidden: true,
    },
    {
      name: "index",
      label: "Index",
      type: "scalar",
      min: 0,
      // The slider spans exactly the slots that exist — the static `max` is
      // only the fallback for contexts without sibling params in reach
      // (a def rendered with no node behind it). The export-manifest
      // builder bakes maxFrom's result, so the live link matches the
      // editor. compute clamps regardless.
      max: SWITCH_COUNT_CAP - 1,
      // Slider mode counts every slot (the spare included — scrubbing onto
      // it is how you see "nothing wired here"); toggle mode offers only
      // the wired ones, so no pill state selects an empty socket.
      maxFrom: (p) =>
        Math.max(0, (switchIsToggle(p) ? toggleCount(p) : slotCount(p)) - 1),
      controlFrom: (p) => (switchIsToggle(p) ? "segmented" : undefined),
      optionLabelsFrom: (p) =>
        switchIsToggle(p) ? toggleOptionLabels(p) : undefined,
      step: 1,
      default: 0,
    },
    {
      // Per-input display names for toggle mode, keyed by slot socket
      // (engine/graph-helpers readSwitchLabels). Shown on the sockets and
      // as the pill / dropdown labels; unnamed inputs show their index.
      name: "labels",
      label: "Names",
      type: "slot_labels",
      default: {},
      visibleIf: (p) => switchIsToggle(p),
    },
  ],
  primaryOutput: RESTING_TYPE,
  resolvePrimaryOutput(params, ctx): SocketType {
    return activeType(params, ctx);
  },
  auxOutputs: [],

  compute({ inputs, params }) {
    const slots = slotNames(params);
    const n = slots.length;
    const idxRaw =
      inputs.index?.kind === "scalar"
        ? inputs.index.value
        : ((params.index as number) ?? 0);
    let i = Math.round(idxRaw);
    if (!Number.isFinite(i)) i = 0;
    if (i < 0) i = 0;
    if (i > n - 1) i = n - 1;
    const picked = inputs[slots[i]];
    if (!picked) return {};
    // Borrowed, not produced — the upstream node owns these textures.
    return { primary: picked, ownsTextures: false };
  },
};
