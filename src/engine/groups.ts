// Node-group plumbing shared by the node defs, the editor's graph ops,
// and the evaluator's flatten pass. Engine-side so the export bundle
// (which copies src/engine + src/nodes) is self-contained.
//
// A group is a regular node (type "node-group") whose external socket
// interface lives in its params under `interface`. The interior
// Group Input / Group Output nodes (parentId = the group's id) carry
// the same socket lists in their params under `sockets`; they are the
// source of truth, and graph-ops keeps the group node's params in
// sync. See specdocs/layers-groups-attributes.md.

import type { SocketType } from "./types";

export const GROUP_TYPE = "node-group";
export const GROUP_INPUT_TYPE = "group-input";
export const GROUP_OUTPUT_TYPE = "group-output";

// A layer is a root-only group subtype with a fixed external interface
// (stack/audio in, image/audio out, blend mode + opacity) and AE-style
// local time for its interior. Unlike plain groups the layer node
// itself computes (the blend against the stack), so the flatten pass
// keeps it in the flat graph and rewires the interior content onto its
// hidden `content` input. See specdocs/layers-groups-attributes.md §2.
export const LAYER_TYPE = "layer";

// Fixed socket lists for a layer's interior boundary nodes. Stored in
// the boundary nodes' `sockets` param like any group, but with
// `fixed: true` alongside — which suppresses the virtual "new socket"
// port and the rename/remove UI.
export const LAYER_INPUT_SOCKETS = [
  { name: "backdrop", type: "image" },
] as const;
export const LAYER_OUTPUT_SOCKETS = [
  { name: "image", type: "image" },
  { name: "audio", type: "audio" },
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
