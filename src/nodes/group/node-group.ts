import type {
  InputSocketDef,
  NodeDefinition,
  OutputSocketDef,
  SocketType,
} from "@/engine/types";
import { readGroupInterface } from "@/engine/groups";

// Node group — a collapsed subgraph. Interior nodes live in the same
// flat nodes array tagged with `parentId = <this node's id>`; this node
// is just the exterior shell whose sockets mirror the interior
// Group Input / Group Output boundary nodes (the source of truth —
// graph-ops keeps the `interface` param in sync with them).
//
// Groups are transparent at eval time: the flatten pass splices every
// exterior edge through the boundary to the interior producer/consumer,
// so this node never computes. The compute below is a dead-graph
// fallback (an unflattened group yields nothing and downstream sockets
// fall back to their defaults).
//
// Created via Cmd+G in the node editor, never from the add menus
// (`hidden`). All interface sockets are aux outputs / named inputs —
// there is no primary output, so handle ids stay name-addressed and
// stable as the interface is edited.

export const nodeGroupNode: NodeDefinition = {
  type: "node-group",
  name: "Group",
  hidden: true,
  category: "utility",
  description:
    "A collapsed subgraph with its own socket interface. Tab dives in; Cmd+Shift+G dissolves it back into the parent scope. Sockets are defined by the Group Input / Group Output nodes inside.",
  backend: "webgl2",
  noMaskInput: true,
  inputs: [],
  resolveInputs(params): InputSocketDef[] {
    return readGroupInterface(params).inputs.map((s) => ({
      name: s.name,
      type: s.type as SocketType,
      required: false,
    }));
  },
  params: [],
  primaryOutput: null,
  auxOutputs: [],
  resolveAuxOutputs(params): OutputSocketDef[] {
    return readGroupInterface(params).outputs.map((s) => ({
      name: s.name,
      type: s.type as SocketType,
    }));
  },
  compute() {},
};
