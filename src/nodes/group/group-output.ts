import type {
  InputSocketDef,
  NodeDefinition,
  SocketType,
} from "@/engine/types";
import {
  isFixedBoundary,
  readBoundarySockets,
  VIRTUAL_SOCKET,
} from "@/engine/groups";

// Group Output — the interior face of a group's output interface. Lives
// inside a group (parentId = the group's id); its input sockets mirror
// the group node's external outputs 1:1 and are the source of truth for
// them. The flatten pass splices each exterior edge
// `(group, out:aux:j) → Y` straight through to the interior producer
// wired into `(this, in:j)`, so this node never computes.
//
// Auto-created by Cmd+G, never via the add menus. One per group.

export const groupOutputNode: NodeDefinition = {
  type: "group-output",
  name: "Group Output",
  hidden: true,
  category: "utility",
  description:
    "The group's outgoing sockets, seen from inside. Wire interior results in here; each socket mirrors an output on the group node outside.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    const real = readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: s.type as SocketType,
      required: false,
    }));
    // Fixed boundaries (layer interiors) have an immutable interface —
    // no trailing virtual socket. Plain groups get one: wiring an
    // interior output into it mints a real group-output socket
    // typed/named after that output.
    if (isFixedBoundary(params)) return real;
    return [
      ...real,
      { name: VIRTUAL_SOCKET, type: "image" as SocketType, required: false },
    ];
  },
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  compute() {},
};
