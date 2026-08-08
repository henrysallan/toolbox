// Node-group plumbing shared by the node defs, the editor's graph ops,
// and the evaluator's flatten pass. Engine-side so the export bundle
// (which copies src/engine + src/nodes) is self-contained.
//
// A group is a regular node (type "node-group") whose external socket
// interface lives in its params under `interface`. The interior
// Group Input / Group Output nodes (parentId = the group's id) carry
// the same socket lists in their params under `sockets`; they are the
// source of truth, and graph-ops keeps the group node's params in
// sync. See specdocs/archive/layers-groups-attributes.md.

import type { SocketType } from "./types";

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
