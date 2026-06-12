import type {
  NodeDefinition,
  OutputSocketDef,
  SocketType,
} from "@/engine/types";
import {
  isFixedBoundary,
  readBoundarySockets,
  VIRTUAL_SOCKET,
} from "@/engine/groups";

// Group Input — the interior face of a group's input interface. Lives
// inside a group (parentId = the group's id); its aux outputs mirror
// the group node's external inputs 1:1 and are the source of truth for
// them. The flatten pass splices each exterior edge
// `X → (group, in:k)` straight through to the interior consumers of
// `(this, out:aux:k)`, so this node never computes.
//
// Auto-created by Cmd+G, never via the add menus. One per group;
// sockets are added by wiring into the trailing virtual socket and
// renamed/removed from the param panel (editor-side UI).

export const groupInputNode: NodeDefinition = {
  type: "group-input",
  name: "Group Input",
  hidden: true,
  category: "utility",
  description:
    "The group's incoming sockets, seen from inside. Wire from here to feed interior nodes; each socket mirrors an input on the group node outside.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    const real = readBoundarySockets(params).map((s) => ({
      name: s.name,
      type: s.type as SocketType,
    }));
    // Fixed boundaries (layer interiors) have an immutable interface —
    // no trailing virtual socket. Plain groups get one: wiring from it
    // into an interior input mints a real group-input socket
    // typed/named after that input.
    if (isFixedBoundary(params)) return real;
    return [...real, { name: VIRTUAL_SOCKET, type: "image" as SocketType }];
  },
  compute() {},
};
