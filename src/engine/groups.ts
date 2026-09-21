// Node-group plumbing shared by the node defs, the editor's graph ops,
// and the evaluator's flatten pass. Engine-side so the export bundle
// (which copies src/engine + src/nodes) is self-contained.
//
// A group is a regular node (type "node-group") whose external socket
// interface lives in its params under `interface`. Promoted-input
// defaults live beside it under `inputValues` (keyed by socket name);
// flatten copies those onto interior consumers when the shell input is
// unwired: `in:param:` patches the consumer's params, and promoted
// scalar/vec/color/string/ramp `in:` sockets land as `inputOverrides`
// the evaluator injects (so a GLSL/Point Expression channel doesn't
// need a Constant shim). The interior Group Input / Group Output
// nodes (parentId = the group's id) carry the same socket lists in
// their params under `sockets`; they are the source of truth, and
// graph-ops keeps the group node's params in sync. See
// specdocs/archive/layers-groups-attributes.md.

import type { ColorRampStop } from "./color-ramp";
import type { CurvePoint } from "./float-curve";
import type {
  ParamDef,
  ParamType,
  SocketType,
  SocketValue,
} from "./types";

export const GROUP_TYPE = "node-group";
export const GROUP_INPUT_TYPE = "group-input";
export const GROUP_OUTPUT_TYPE = "group-output";

// A layer is a root-only group subtype with a fixed external interface
// (stack/audio in, image/audio out, blend mode + opacity) and AE-style
// local time for its interior. Unlike plain groups the layer node
// itself computes (the blend against the stack), so the flatten pass
// keeps it in the flat graph and rewires the interior content onto its
// hidden `content` input. See specdocs/archive/layers-groups-attributes.md §2.
export const LAYER_TYPE = "layer";

// An Iterate is the third structural variant, presented as a ZONE of
// exactly two nodes (071926_iterate-zone-view.md rev 3):
//
//  - The **Iteration Output** node (type ITERATE_TYPE) is the
//    engine-side shell: it COMPUTES (a nested evaluation of the zone
//    members, K times, collecting the results into an image_group /
//    grouped spline / grouped points), it anchors membership (members'
//    parentId = its id), and its minted input socket is the collect
//    tap — the matching aux output carries the GROUPED result onward.
//  - The **Iteration Input** node (type ITERATE_INPUT_TYPE, itself a
//    member) carries the loop params (count / seed / random range) and
//    emits the per-iteration values (index / t / random) on its aux
//    outputs during the nested evaluation. It is also the exterior
//    face for passthrough inputs: an exterior wire lands on its `in:`
//    side; flatten reroutes that edge onto the shell's hidden
//    `zi__<name>` input, and the value re-enters each iteration
//    through the same-named aux output.
//
// The flatten pass drops the zone members (Iteration Input included)
// from the flat graph wholesale — they evaluate privately inside the
// shell's compute. See specdocs/archive/071826_iterate-node.md.
export const ITERATE_TYPE = "iterate";
export const ITERATE_INPUT_TYPE = "iterate-input";

// Reserved sockets on the Iteration Input (can't be renamed/removed;
// user passthrough sockets mint alongside).
export const ITERATE_INPUT_SOCKETS = [
  { name: "index", type: "scalar" },
  { name: "t", type: "scalar" },
  { name: "random", type: "scalar" },
] as const;

// Prefix for the shell's hidden passthrough inputs (see above). Namespaced
// so a passthrough can never collide with a minted collect socket on the
// same node.
export const ITERATE_PASSTHROUGH_PREFIX = "zi__";

// Direct crossing wires: an `exterior → member` edge STAYS exactly as
// the user drew it — no boundary socket, no visible rerouting
// (071926_iterate-zone-view.md, "stay as wired"). The flatten extraction
// mirrors each such edge onto a per-edge hidden shell input
// (`zi__e_<edgeId>`, raw/uncoerced — the evaluator special-cases these
// on ITERATE_TYPE nodes) and keeps the original edge in the interior
// record; the shell's compute synthesizes an eval-only ITERATE_FEED_TYPE
// node per crossing edge that re-emits the value inside each iteration.
export const ITERATE_EDGE_PREFIX = "zi__e_";
export const ITERATE_FEED_TYPE = "iterate-feed";

// The Iteration Input's loop params, resolved SHELL-SIDE with the house
// wire > keyframe > constant precedence (the Iteration Input never runs
// through the outer evaluator, so the shell does the resolution itself —
// keyframes from the stashed node's animation at ctx.tick, wires through
// the shell's hidden `zi__param__<name>` inputs, which flatten reroutes
// exterior `in:param:` edges onto). See 071926_iterate-zone-view.md.
export const ITERATE_LOOP_PARAMS = [
  "count",
  "seed",
  "random_min",
  "random_max",
] as const;
export const ITERATE_PARAM_PREFIX = "zi__param__";

// Repeat and For Each Element are the same two-node zone shape as Iterate
// (shell + input member, parentId membership, flatten extraction, nested
// eval). They share the zi__ / zi__e_ / zi__param__ plumbing and the
// iterate-feed node. Differences are in what the shell loops over and
// how it emits:
//
//   Repeat  — K from count; each pass's collect becomes the next pass's
//             matching passthrough (feedback by socket name); output is
//             the LAST iteration, same type (no image_group promotion).
//   For Each — K from a geometry input on the shell (subpaths or points);
//             each pass sees one element; output is grouped like Iterate.
export const REPEAT_TYPE = "repeat";
export const REPEAT_INPUT_TYPE = "repeat-input";
export const FOREACH_TYPE = "foreach";
export const FOREACH_INPUT_TYPE = "foreach-input";

export const ZONE_SHELL_TYPES = [
  ITERATE_TYPE,
  REPEAT_TYPE,
  FOREACH_TYPE,
] as const;
export const ZONE_INPUT_TYPES = [
  ITERATE_INPUT_TYPE,
  REPEAT_INPUT_TYPE,
  FOREACH_INPUT_TYPE,
] as const;

export function isZoneShell(type: string | undefined | null): boolean {
  return (
    type === ITERATE_TYPE || type === REPEAT_TYPE || type === FOREACH_TYPE
  );
}

export function isZoneInput(type: string | undefined | null): boolean {
  return (
    type === ITERATE_INPUT_TYPE ||
    type === REPEAT_INPUT_TYPE ||
    type === FOREACH_INPUT_TYPE
  );
}

export function zoneInputTypeForShell(
  shellType: string
): string | undefined {
  if (shellType === ITERATE_TYPE) return ITERATE_INPUT_TYPE;
  if (shellType === REPEAT_TYPE) return REPEAT_INPUT_TYPE;
  if (shellType === FOREACH_TYPE) return FOREACH_INPUT_TYPE;
  return undefined;
}

/** Iterate / For Each promote image → image_group. Repeat does not. */
export function zoneCollectsGrouped(shellType: string): boolean {
  return shellType === ITERATE_TYPE || shellType === FOREACH_TYPE;
}

export const REPEAT_INPUT_SOCKETS = [
  { name: "index", type: "scalar" },
  { name: "t", type: "scalar" },
  { name: "random", type: "scalar" },
] as const;

export const FOREACH_INPUT_SOCKETS = [
  { name: "element", type: "spline" },
  { name: "index", type: "scalar" },
  { name: "count", type: "scalar" },
  { name: "t", type: "scalar" },
  { name: "random", type: "scalar" },
] as const;

// Hidden loop-param inputs every zone shell declares. Iterate / Repeat
// use count + seed + random range; For Each uses seed + random range +
// max_elements. Unused names simply never get a wire.
export const ZONE_LOOP_PARAMS = [
  "count",
  "seed",
  "random_min",
  "random_max",
  "max_elements",
] as const;

// Fixed socket lists for a layer's interior boundary nodes. Stored in
// the boundary nodes' `sockets` param like any group, but with
// `fixed: true` alongside — which suppresses the virtual "new socket"
// port and the rename/remove UI.
export const LAYER_INPUT_SOCKETS = [
  { name: "backdrop", type: "image" },
] as const;
// `spline` is the layer's vector export tap — the same side-channel the
// composition Output carries. It is NOT part of the layer's rendered
// result: flatten splices it onto the layer node's hidden `spline` input,
// whose compute stashes the evaluated path for the Layer Output's SVG
// button. Appended last so it lands under image/audio on the node, and
// back-filled onto layers saved before it existed (group-output.ts).
export const LAYER_OUTPUT_SOCKETS = [
  { name: "image", type: "image" },
  { name: "audio", type: "audio" },
  { name: "spline", type: "spline" },
] as const;

export function isFixedBoundary(params: Record<string, unknown>): boolean {
  return params.fixed === true;
}

// Socket names on a boundary node that can't be renamed or removed (the
// layer's reserved interface, e.g. the Group Input's `backdrop`). New
// sockets can still be added alongside them. Distinct from `fixed`,
// which locks the boundary entirely (no virtual port, no edits).
export function readReservedSockets(
  params: Record<string, unknown>
): string[] {
  return Array.isArray(params.reserved)
    ? params.reserved.filter((x): x is string => typeof x === "string")
    : [];
}

// Name of the trailing "virtual" socket on Group Input / Group Output
// (Blender-style): wiring into it mints a real typed socket named after
// the far end of the connection. The virtual socket never appears in
// the `sockets` param or the group interface — the defs append it to
// their resolved socket lists, and the editor's connect path swaps the
// connection onto the freshly-minted real socket before any edge ever
// references this name.
export const VIRTUAL_SOCKET = "__virtual__";

export interface GroupSocketSpec {
  name: string;
  type: SocketType;
}

export interface GroupInterface {
  inputs: GroupSocketSpec[];
  outputs: GroupSocketSpec[];
}

const EMPTY_INTERFACE: GroupInterface = { inputs: [], outputs: [] };

function isSpec(v: unknown): v is GroupSocketSpec {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.name === "string" && typeof s.type === "string";
}

function specList(v: unknown): GroupSocketSpec[] {
  return Array.isArray(v) ? v.filter(isSpec) : [];
}

// Tolerant reader for a group node's `interface` param. Hand-edited or
// partially-written params degrade to empty socket lists rather than
// throwing mid-eval.
export function readGroupInterface(
  params: Record<string, unknown>
): GroupInterface {
  const raw = params.interface;
  if (!raw || typeof raw !== "object") return EMPTY_INTERFACE;
  const r = raw as Record<string, unknown>;
  return { inputs: specList(r.inputs), outputs: specList(r.outputs) };
}

// Tolerant reader for a Group Input / Group Output node's `sockets`
// param.
export function readBoundarySockets(
  params: Record<string, unknown>
): GroupSocketSpec[] {
  return specList(params.sockets);
}

// Socket types that can show a shell widget and take an unwired
// `inputValues` default. Image/spline/points/… stay bare ports.
export const GROUP_INPUT_WIDGET_TYPES: ReadonlySet<SocketType> = new Set([
  "scalar",
  "vec2",
  "vec3",
  "vec4",
  "string",
  "color_ramp",
]);

export function isGroupInputWidgetType(
  type: string | undefined | null
): type is SocketType {
  return !!type && GROUP_INPUT_WIDGET_TYPES.has(type as SocketType);
}

function hexToRgba01(hex: string): [number, number, number, number] {
  const h = hex.replace(/^#/, "");
  const read = (i: number, n: number) =>
    parseInt(h.slice(i, i + n).repeat(n === 1 ? 2 : 1), 16) / 255;
  if (h.length === 3 || h.length === 4) {
    const r = read(0, 1);
    const g = read(1, 1);
    const b = read(2, 1);
    const a = h.length === 4 ? read(3, 1) : 1;
    if ([r, g, b, a].every((v) => Number.isFinite(v))) return [r, g, b, a];
  } else if (h.length >= 6) {
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b, a].every((v) => Number.isFinite(v))) return [r, g, b, a];
  }
  return [1, 1, 1, 1];
}

function finiteNums(v: unknown, n: number): number[] | null {
  if (!Array.isArray(v) || v.length < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (typeof v[i] !== "number" || !Number.isFinite(v[i])) return null;
    out.push(v[i]);
  }
  return out;
}

// Wrap a shell `inputValues` entry as the SocketValue the evaluator would
// see on a wired producer of `socketType`. Null when the stored shape
// can't feed that socket (image defaults never land here).
export function socketValueFromGroupDefault(
  raw: unknown,
  socketType: SocketType
): SocketValue | undefined {
  switch (socketType) {
    case "scalar":
      if (typeof raw === "number" && Number.isFinite(raw))
        return { kind: "scalar", value: raw };
      if (typeof raw === "boolean")
        return { kind: "scalar", value: raw ? 1 : 0 };
      return undefined;
    case "vec2": {
      const n = finiteNums(raw, 2);
      return n ? { kind: "vec2", value: [n[0], n[1]] } : undefined;
    }
    case "vec3": {
      const n = finiteNums(raw, 3);
      return n ? { kind: "vec3", value: [n[0], n[1], n[2]] } : undefined;
    }
    case "vec4": {
      const n = finiteNums(raw, 4);
      if (n) return { kind: "vec4", value: [n[0], n[1], n[2], n[3]] };
      if (typeof raw === "string")
        return { kind: "vec4", value: hexToRgba01(raw) };
      return undefined;
    }
    case "string":
      return typeof raw === "string" ? { kind: "string", value: raw } : undefined;
    case "color_ramp":
      return Array.isArray(raw)
        ? { kind: "color_ramp", stops: raw as ColorRampStop[], interp: "linear" }
        : undefined;
    case "float_curve":
      // A shell default for a curve socket is the bare CurvePoint[] the
      // param type stores; wrap it as the Float Curve node's aux would.
      return Array.isArray(raw)
        ? { kind: "float_curve", points: raw as CurvePoint[] }
        : undefined;
    default:
      return undefined;
  }
}

// Group-level defaults for promoted inputs, stored on the shell
// (`params.inputValues[socketName]`). Flatten copies each entry onto the
// interior consumer when the shell's matching input is unwired — params
// for `in:param:`, `inputOverrides` for widget-typed `in:` sockets — so
// the interior node's own default stays the authored value.
export function readInputValues(
  params: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  const raw = params?.inputValues;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

export function withInputValues(
  params: Record<string, unknown>,
  inputValues: Record<string, unknown>
): Record<string, unknown> {
  if (Object.keys(inputValues).length === 0) {
    if (!("inputValues" in params)) return params;
    const next = { ...params };
    delete next.inputValues;
    return next;
  }
  return { ...params, inputValues };
}

// Drop keys that don't match a current input socket. Values are keyed by
// socket *name*, never by list position — leftover keys after unexpose
// would otherwise be easy to zip against the remaining sockets by index.
export function pruneInputValues(
  params: Record<string, unknown>,
  socketNames: Iterable<string>
): Record<string, unknown> {
  const keep = new Set(socketNames);
  const iv = readInputValues(params);
  const next: Record<string, unknown> = {};
  let dropped = false;
  for (const [k, v] of Object.entries(iv)) {
    if (keep.has(k)) next[k] = v;
    else dropped = true;
  }
  if (!dropped) return params;
  return withInputValues(params, next);
}

// Synthetic ParamDef when a promoted input has no interior param (a
// GLSL/Point Expression channel, a Math `a` data socket, …). Range is a
// generic 0–1 slider; the caller overlays an explicit ch() range.
export function groupInputControlFromType(
  socketName: string,
  socketType: SocketType
): ParamDef | null {
  if (!isGroupInputWidgetType(socketType)) return null;
  let type: ParamType;
  let deflt: unknown;
  switch (socketType) {
    case "scalar":
      type = "scalar";
      deflt = 0;
      break;
    case "vec4":
      type = "color";
      deflt = "#ffffff";
      break;
    case "string":
      type = "string";
      deflt = "";
      break;
    case "vec2":
      type = "vec2";
      deflt = [0, 0];
      break;
    case "vec3":
      type = "vec3";
      deflt = [0, 0, 0];
      break;
    case "color_ramp":
      type = "color_ramp";
      deflt = [];
      break;
    default:
      return null;
  }
  return groupInputControlDef(socketName, socketType, {
    name: socketName,
    type,
    default: deflt,
    ...(socketType === "scalar" ? { min: 0, max: 1, step: 0.001 } : {}),
    ...(socketType === "vec4" ? { alpha: true } : {}),
  });
}

// ParamDef shown on a group/layer shell for a promoted input. Range /
// options come from the interior target; the widget itself is picked
// from the group input's socket type (scalar → slider, vec4 → color,
// string → text). Enum and boolean keep their native controls.
// Returns null when the socket has no param-shaped control (image,
// spline, …) — those stay a bare port.
export function groupInputControlDef(
  socketName: string,
  socketType: SocketType,
  target: ParamDef
): ParamDef | null {
  if (target.type === "enum") {
    return {
      name: socketName,
      label: socketName,
      type: "enum",
      options: target.options,
      optionLabels: target.optionLabels,
      default: target.default,
    };
  }
  if (target.type === "boolean") {
    return {
      name: socketName,
      label: socketName,
      type: "boolean",
      default: target.default,
    };
  }
  let type: ParamType | null = null;
  switch (socketType) {
    case "scalar":
      type = "scalar";
      break;
    case "vec4":
      type = "color";
      break;
    case "string":
      type = "string";
      break;
    case "vec2":
    case "vec3":
    case "color_ramp":
      type = target.type;
      break;
    default:
      return null;
  }
  if (!type) return null;
  return {
    name: socketName,
    label: socketName,
    type,
    min: target.min,
    max: target.max,
    softMax: target.softMax,
    step: target.step,
    stepFrom: target.stepFrom,
    minFrom: target.minFrom,
    maxFrom: target.maxFrom,
    softMaxFrom: target.softMaxFrom,
    options: target.options,
    optionLabels: target.optionLabels,
    default: target.default,
    alpha: target.alpha,
    placeholder: target.placeholder,
    multiline: target.multiline,
  };
}

// A Group **Output**'s socket list, with a fixed (layer) boundary's
// canonical sockets back-filled. A layer's interface is immutable, so
// LAYER_OUTPUT_SOCKETS — not the stored `sockets` param — is its source of
// truth: a socket added after a project was saved (the `spline` SVG tap)
// shows up with no migration and no schema bump. Appending is safe because
// handle ids are name-based, so edges already on the stored sockets can't
// shift. Plain groups are untouched (their stored list IS the truth).
// Used by group-output.resolveInputs and the read-only socket panel, which
// must agree on what the node has.
export function resolveOutputBoundarySockets(
  params: Record<string, unknown>
): GroupSocketSpec[] {
  const stored = readBoundarySockets(params);
  if (!isFixedBoundary(params)) return stored;
  const have = new Set(stored.map((s) => s.name));
  return [
    ...stored,
    ...LAYER_OUTPUT_SOCKETS.filter((s) => !have.has(s.name)).map((s) => ({
      name: s.name,
      type: s.type as SocketType,
    })),
  ];
}
