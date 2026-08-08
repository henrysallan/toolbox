// Shared "wrap interior nodes in a node-group shell" assembly. Extracted from
// presets.ts so both canned presets and LLM-authored recipes
// (specdocs/archive/062526_ai-recipe-generation.md) build groups through one code
// path. Mirrors graph-ops' groupSelection structurally, but for a generator
// fragment with no exterior edges — the shell's parentId is left undefined so
// cloneSubgraph treats it as the single top-level node and retargets it into
// the insertion scope.

import type { Edge } from "@xyflow/react";
import type { SocketType } from "@/engine/types";
import { GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE, GROUP_TYPE } from "@/engine/groups";
import { getNodeDef } from "@/engine/registry";
import { paramSocketType } from "@/engine/graph-helpers";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  syncGroupInterface,
  type GraphNode,
} from "@/state/graph-ops";

// Interior endpoint feeding one of the group's OUTPUT sockets.
export interface GroupOutputSpec {
  from: { nodeId: string; handle: string };
  name: string;
  type: SocketType;
}

// A group DATA input: a boundary socket wired from Group Input into an interior
// consumer's input handle. (Presets don't use these — generator groups have no
// data inputs — but recipes do, e.g. a "halftone from luminance" recipe that
// takes an image.)
export interface GroupInputSpec {
  name: string;
  type: SocketType;
  to: { nodeId: string; handle: string }; // interior target, e.g. "in:image"
}

// One interior param to surface as an editable/keyframable knob (and input
// socket) on the group node.
export interface PromoteSpec {
  node: GraphNode;
  param: string;
  label: string;
}

export function groupFragment(opts: {
  name: string;
  interior: GraphNode[];
  edges: Edge[];
  inputs?: GroupInputSpec[];
  outputs: GroupOutputSpec[];
  promote?: PromoteSpec[];
  position?: { x: number; y: number };
}): { nodes: GraphNode[]; edges: Edge[] } {
  const at = opts.position ?? { x: 240, y: 0 };
  const group = makeInstanceNode(GROUP_TYPE, at);
  group.data.name = opts.name;
  group.data.parentId = undefined;

  const groupInput = makeInstanceNode(GROUP_INPUT_TYPE, { x: at.x - 400, y: at.y });
  const groupOutput = makeInstanceNode(GROUP_OUTPUT_TYPE, { x: at.x + 400, y: at.y });
  groupInput.data.parentId = group.id;
  groupOutput.data.parentId = group.id;
  groupOutput.data.params = {
    sockets: opts.outputs.map((o) => ({ name: o.name, type: o.type })),
  };

  for (const n of opts.interior) n.data.parentId = group.id;

  // Group Input sockets = declared data inputs + promoted-param sockets, in
  // that order. Each data input wires straight into its interior consumer;
  // each promoted param wires into the deep node's exposed `in:param:<name>`.
  const inSockets: { name: string; type: SocketType }[] = [];
  const inputEdges: Edge[] = [];
  for (const inp of opts.inputs ?? []) {
    inSockets.push({ name: inp.name, type: inp.type });
    inputEdges.push({
      id: newEdgeId(),
      source: groupInput.id,
      sourceHandle: `out:aux:${inp.name}`,
      target: inp.to.nodeId,
      targetHandle: inp.to.handle,
    });
  }

  const promoteEdges: Edge[] = [];
  for (const p of opts.promote ?? []) {
    const pdef = getNodeDef(p.node.data.defType)?.params.find((x) => x.name === p.param);
    const sockType = pdef ? paramSocketType(pdef.type) : null;
    if (!pdef || !sockType) continue;
    inSockets.push({ name: p.label, type: sockType });
    p.node.data.exposedParams = [
      ...new Set([...(p.node.data.exposedParams ?? []), p.param]),
    ];
    p.node.data.controlParams = [
      ...new Set([...(p.node.data.controlParams ?? []), p.param]),
    ];
    promoteEdges.push({
      id: newEdgeId(),
      source: groupInput.id,
      sourceHandle: `out:aux:${p.label}`,
      target: p.node.id,
      targetHandle: `in:param:${p.param}`,
    });
  }
  groupInput.data.params = { sockets: inSockets };

  const edges: Edge[] = [
    ...opts.edges,
    ...inputEdges,
    ...promoteEdges,
    ...opts.outputs.map((o) => ({
      id: newEdgeId(),
      source: o.from.nodeId,
      sourceHandle: o.from.handle,
      target: groupOutput.id,
      targetHandle: `in:${o.name}`,
    })),
  ];

  const nodes = syncGroupInterface(
    [
      group,
      refreshNodeSockets(groupInput),
      refreshNodeSockets(groupOutput),
      ...opts.interior,
    ],
    group.id
  );
  return { nodes, edges };
}
