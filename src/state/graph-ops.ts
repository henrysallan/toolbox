// Structural graph mutations, as pure functions over (nodes, edges)
// arrays. This module is the home for everything that creates, clones,
// or rewires nodes outside of React state plumbing — EffectsApp calls
// in here and applies the results via its setters. Group / layer /
// chain operations (specdocs/layers-groups-attributes.md) land here;
// new structural logic must not be added to EffectsApp directly.

import type { Edge, Node } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import { withMaskInput } from "@/engine/conventions";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  ITERATE_INPUT_SOCKETS,
  ITERATE_INPUT_TYPE,
  ITERATE_TYPE,
  LAYER_INPUT_SOCKETS,
  LAYER_OUTPUT_SOCKETS,
  LAYER_TYPE,
  VIRTUAL_SOCKET,
  isFixedBoundary,
  readBoundarySockets,
  readReservedSockets,
  type GroupInterface,
  type GroupSocketSpec,
} from "@/engine/groups";
import {
  FRAME_TYPE,
  paramSocketType,
  parseTargetHandleKind,
  REROUTE_TYPE,
} from "@/engine/graph-helpers";
import { EXPORT_PARAMS } from "@/nodes/output/output";
import type { ParamType, SocketType, SplineSubpath } from "@/engine/types";
import type { ClipBlock } from "@/engine/clips";
import {
  FRAME_XY_PROPS,
  newNodeId,
  newCompositionId,
  type NodeDataPayload,
} from "@/state/graph";

// A parameter promoted up to a group/layer's interface via a Group
// Input "new socket" wired into a deep node's exposed param. The
// keyframes live on the deep node — `nodeId`/`paramName` point there —
// while the group surfaces it under `label` (the socket name). Shared
// by the Layers twirl-down and the Track editor's group lanes.
export interface PromotedParam {
  nodeId: string;
  paramName: string;
  label: string;
  type: ParamType;
}

export function resolvePromotedParams(
  parentId: string,
  nodes: GraphNode[],
  edges: Edge[]
): PromotedParam[] {
  const groupInput = nodes.find(
    (n) => n.data.parentId === parentId && n.data.defType === GROUP_INPUT_TYPE
  );
  if (!groupInput) return [];
  const reserved = new Set(readReservedSockets(groupInput.data.params));
  const out: PromotedParam[] = [];
  for (const sock of readBoundarySockets(groupInput.data.params)) {
    if (reserved.has(sock.name)) continue;
    const edge = edges.find(
      (e) =>
        e.source === groupInput.id &&
        e.sourceHandle === `out:aux:${sock.name}` &&
        e.targetHandle?.startsWith("in:param:")
    );
    if (!edge) continue;
    const deep = nodes.find((n) => n.id === edge.target);
    const paramName = edge.targetHandle!.slice("in:param:".length);
    const pdef = deep
      ? getNodeDef(deep.data.defType)?.params.find((p) => p.name === paramName)
      : undefined;
    if (!deep || !pdef) continue;
    out.push({ nodeId: deep.id, paramName, label: sock.name, type: pdef.type });
  }
  return out;
}

export type GraphNode = Node<NodeDataPayload>;

export function newEdgeId(): string {
  return `e-${Math.random().toString(36).slice(2, 10)}`;
}

// Fresh node instance for a registered def type: params at defaults,
// sockets resolved (including the universal mask input), terminal nodes
// born active.
export function makeInstanceNode(
  type: string,
  position: { x: number; y: number }
): GraphNode {
  const def = getNodeDef(type);
  if (!def) throw new Error(`Unknown node type ${type}`);
  const params: Record<string, unknown> = {};
  for (const p of def.params) params[p.name] = p.default;
  const resolved = withMaskInput(def.resolveInputs?.(params) ?? def.inputs, def);
  return {
    id: newNodeId(type),
    // Reroutes render through the dedicated dot component (RerouteNode),
    // frame zones through FrameNode (click-through wrapper, edge-band drag
    // handles — FRAME_XY_PROPS); every other node uses the standard
    // EffectNode chrome.
    type:
      type === REROUTE_TYPE
        ? "reroute"
        : type === FRAME_TYPE
          ? "frame"
          : "effect",
    ...(type === FRAME_TYPE ? FRAME_XY_PROPS : {}),
    position,
    data: {
      defType: type,
      params,
      exposedParams: [],
      name: def.name,
      inputs: resolved.map((i) => ({
        name: i.name,
        label: i.label,
        type: i.type,
        hidden: i.hidden,
      })),
      auxOutputs: (def.resolveAuxOutputs?.(params) ?? def.auxOutputs).map(
        (a) => ({
          name: a.name,
          label: a.label,
          type: a.type,
          disabled: a.disabled,
        })
      ),
      primaryOutput: def.resolvePrimaryOutput?.(params) ?? def.primaryOutput,
      terminal: def.terminal,
      active: !!def.terminal,
      bypassed: false,
    },
  };
}

// Shallow-clone a node with a fresh id + position. Params share references
// (so fonts, bitmaps, paint canvases are reused rather than deep-copied) —
// intentional for v1: deep-cloning a paint canvas or video element would
// be a bigger project and isn't what most users expect from duplicate.
export function cloneNode(
  n: GraphNode,
  position: { x: number; y: number }
): GraphNode {
  const newId = newNodeId(n.data.defType);
  return {
    ...n,
    id: newId,
    position,
    selected: false,
    data: {
      ...n.data,
      params: { ...n.data.params },
      exposedParams: n.data.exposedParams ? [...n.data.exposedParams] : [],
      controlParams: n.data.controlParams ? [...n.data.controlParams] : [],
    },
  };
}

// Styling params shared by every spline-raster-family source — the
// SPLINE_RASTER_PARAMS set in spline-raster-aux.ts (Circle, Rectangle,
// Star, … and Spline Draw itself all declare these names) plus the
// universal opacity. Copied verbatim by makeSplineEditable so the baked
// node keeps the exact look of the source it replaces.
const RASTER_STYLE_PARAMS = [
  "opacity",
  "stroke_enabled",
  "stroke_thickness",
  "stroke_units",
  "stroke_color",
  "fill_enabled",
  "fill_color",
  "fill_fit",
];

// Right-click → "Make Editable" on a node with a spline-typed output.
// Spawns a Spline Draw node seeded with the BAKED subpaths (the node's
// evaluated output at the current playhead, handed in by EffectsApp from
// the eval cache — trim windows, corner fillets, and any animated
// procedural behavior are already resolved into that geometry), bypasses
// the original as a revert point, and moves the out-wires of the baked
// spline handle onto the new node so downstream keeps rendering. For
// raster-family sources the image out-wires and the fill/mask in-wires
// migrate too (same sockets, same copied styling ⇒ identical raster);
// trim params deliberately do NOT copy — the baked geometry is post-trim
// and copying them would trim twice. The new node returns selected and
// viewport-active (exclusive, same rule as the header Active toggle) so
// the pen overlay engages immediately.
export function makeSplineEditable(
  nodes: GraphNode[],
  edges: Edge[],
  nodeId: string,
  // The spline-typed output handle that was baked ("out:primary" or
  // "out:aux:<name>") — only ITS consumers are rewired.
  splineHandle: string,
  subpaths: SplineSubpath[]
): { nodes: GraphNode[]; edges: Edge[]; newNodeId: string } | null {
  const src = nodes.find((n) => n.id === nodeId);
  if (!src) return null;
  const splineHandles = new Set<string>();
  if (src.data.primaryOutput === "spline") splineHandles.add("out:primary");
  for (const a of src.data.auxOutputs) {
    if (a.type === "spline" && !a.disabled) splineHandles.add(`out:aux:${a.name}`);
  }
  if (!splineHandles.has(splineHandle)) return null;

  const draw = makeInstanceNode("spline-draw", {
    x: src.position.x + 48,
    y: src.position.y + 48,
  });
  draw.data.parentId = src.data.parentId;
  draw.data.compositionId = src.data.compositionId;
  draw.selected = true;
  draw.data.active = true;

  // Deep-copy the baked geometry — the caller hands us the runtime
  // SplineValue's subpaths straight out of the eval cache, and the spline
  // overlay mutates the param in place; sharing structure would corrupt
  // cached outputs. cornerRadius tags are dropped: fillets are already
  // resolved into real anchors in emitted geometry, and a surviving tag
  // would fillet a second time inside Spline Draw's compute.
  draw.data.params.spline = {
    subpaths: subpaths.map((sp) => ({
      ...sp,
      anchors: sp.anchors.map(({ cornerRadius: _cr, ...a }) => ({
        ...a,
        pos: [...a.pos] as [number, number],
        inHandle: a.inHandle
          ? ([...a.inHandle] as [number, number])
          : undefined,
        outHandle: a.outHandle
          ? ([...a.outHandle] as [number, number])
          : undefined,
      })),
    })),
  };

  const rasterFamily =
    "stroke_enabled" in src.data.params && "fill_enabled" in src.data.params;
  if (rasterFamily) {
    for (const k of RASTER_STYLE_PARAMS) {
      if (k in src.data.params) draw.data.params[k] = src.data.params[k];
    }
    // The copied stroke/fill flags may differ from Spline Draw's defaults —
    // re-resolve the aux sockets (the image aux only exists when one is on).
    const def = getNodeDef("spline-draw");
    if (def) {
      draw.data.auxOutputs = (
        def.resolveAuxOutputs?.(draw.data.params) ?? def.auxOutputs
      ).map((a) => ({
        name: a.name,
        label: a.label,
        type: a.type,
        disabled: a.disabled,
      }));
    }
  }

  const outEdges = edges.map((e) => {
    if (e.source === nodeId) {
      const h = e.sourceHandle ?? "out:primary";
      if (h === splineHandle) {
        return { ...e, source: draw.id, sourceHandle: "out:primary" };
      }
      if (rasterFamily && h === "out:aux:image") {
        return { ...e, source: draw.id, sourceHandle: "out:aux:image" };
      }
    }
    if (
      rasterFamily &&
      e.target === nodeId &&
      (e.targetHandle === "in:fill" || e.targetHandle === "in:mask")
    ) {
      return { ...e, target: draw.id };
    }
    return e;
  });

  const outNodes: GraphNode[] = nodes.map((n) => {
    if (n.id === nodeId) {
      // Bypass rather than delete — the procedural source stays in the
      // graph as a revert point (un-bypass + rewire to go back).
      return {
        ...n,
        selected: false,
        data: { ...n.data, bypassed: true, active: false },
      };
    }
    return n.selected || n.data.active
      ? { ...n, selected: false, data: { ...n.data, active: false } }
      : n;
  });
  outNodes.push(draw);
  return { nodes: outNodes, edges: outEdges, newNodeId: draw.id };
}

// Insert reroute nodes onto existing edges — the Shift-drag / double-click-a-
// wire gesture (specdocs/071326_reroute-node.md). The listed edges are grouped
// by their shared (source, sourceHandle); each group gets ONE reroute placed
// near `anchor` (staggered when there are several), with the shared source
// feeding the reroute's `value` input and every member edge re-pointed to
// leave the reroute's output. A reroute inherits its source's scope
// (parentId + compositionId) so it lands in the same group/composition as the
// wire. Returns the updated arrays plus the new reroute ids (to select them).
export function insertReroutesOnEdges(
  nodes: GraphNode[],
  edges: Edge[],
  edgeIds: string[],
  anchor: { x: number; y: number }
): { nodes: GraphNode[]; edges: Edge[]; rerouteIds: string[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const wanted = new Set(edgeIds);
  const groups = new Map<
    string,
    { source: string; sourceHandle: string; memberIds: string[] }
  >();
  for (const e of edges) {
    if (!wanted.has(e.id) || !e.sourceHandle) continue;
    const key = `${e.source}::${e.sourceHandle}`;
    const g = groups.get(key);
    if (g) g.memberIds.push(e.id);
    else
      groups.set(key, {
        source: e.source,
        sourceHandle: e.sourceHandle,
        memberIds: [e.id],
      });
  }
  if (groups.size === 0) return { nodes, edges, rerouteIds: [] };

  const newNodes: GraphNode[] = [];
  const feedEdges: Edge[] = [];
  const rerouteIds: string[] = [];
  const memberToReroute = new Map<string, string>();
  let gi = 0;
  for (const g of groups.values()) {
    const src = byId.get(g.source);
    const r = makeInstanceNode(REROUTE_TYPE, {
      x: anchor.x,
      y: anchor.y + gi * 30,
    });
    r.data.parentId = src?.data.parentId;
    r.data.compositionId = src?.data.compositionId;
    newNodes.push(r);
    rerouteIds.push(r.id);
    feedEdges.push({
      id: newEdgeId(),
      source: g.source,
      sourceHandle: g.sourceHandle,
      target: r.id,
      targetHandle: "in:value",
    });
    for (const mid of g.memberIds) memberToReroute.set(mid, r.id);
    gi++;
  }

  const nextEdges = edges.map((e) => {
    const rid = memberToReroute.get(e.id);
    return rid ? { ...e, source: rid, sourceHandle: "out:primary" } : e;
  });

  return {
    nodes: [...nodes, ...newNodes],
    edges: [...nextEdges, ...feedEdges],
    rerouteIds,
  };
}

// Param update + socket refresh in one step: the shape EffectsApp's
// param-change handlers need. Use THIS instead of hand-rolling the
// resolveInputs / withMaskInput / resolveAuxOutputs dance at call sites —
// the inline copies drifted (one dropped aux-output re-resolution;
// riskfix-plan 070826 §5). Not for connectedTypes-driven retyping — that
// path needs a ResolveCtx the UI doesn't have (see the devguide's
// "Dynamic input sockets" note).
export function withUpdatedParams(
  n: GraphNode,
  nextParams: Record<string, unknown>
): GraphNode {
  return refreshNodeSockets({
    ...n,
    data: { ...n.data, params: nextParams },
  });
}

// Recompute a node's cached socket arrays (data.inputs / auxOutputs /
// primaryOutput) from its def resolvers and current params. Call after
// any params change made outside the param-panel path, which keeps
// these caches fresh on its own.
export function refreshNodeSockets(n: GraphNode): GraphNode {
  const def = getNodeDef(n.data.defType);
  if (!def) return n;
  const resolved = withMaskInput(
    def.resolveInputs?.(n.data.params) ?? def.inputs,
    def
  );
  return {
    ...n,
    data: {
      ...n.data,
      inputs: resolved.map((i) => ({
        name: i.name,
        label: i.label,
        type: i.type,
        hidden: i.hidden,
      })),
      auxOutputs: (
        def.resolveAuxOutputs?.(n.data.params) ?? def.auxOutputs
      ).map((a) => ({
        name: a.name,
        label: a.label,
        type: a.type,
        disabled: a.disabled,
      })),
      primaryOutput:
        def.resolvePrimaryOutput?.(n.data.params) ?? def.primaryOutput,
    },
  };
}

// Re-derive a group node's `interface` param from its interior
// Group Input / Group Output boundary nodes (the source of truth for
// the socket lists) and refresh the cached socket arrays on the group
// node. Call after any mutation that touches a boundary node's
// `sockets` param. Pure — returns a new nodes array.
export function syncGroupInterface(
  nodes: GraphNode[],
  groupId: string
): GraphNode[] {
  // Iterate zones have no separate output boundary (the shell's own
  // minted sockets are the collect taps), and their input boundary is
  // the Iteration Input node — whose reserved iteration sockets
  // (index/t/random) are interior-provided and stay OUT of the
  // interface (only passthroughs surface, as the shell's hidden zi__
  // inputs).
  const isIterate =
    nodes.find((n) => n.id === groupId)?.data.defType === ITERATE_TYPE;
  const groupInput = nodes.find(
    (n) =>
      n.data.parentId === groupId &&
      n.data.defType === (isIterate ? ITERATE_INPUT_TYPE : GROUP_INPUT_TYPE)
  );
  const groupOutput = isIterate
    ? undefined
    : nodes.find(
        (n) =>
          n.data.parentId === groupId &&
          n.data.defType === GROUP_OUTPUT_TYPE
      );
  const reserved = groupInput
    ? new Set(readReservedSockets(groupInput.data.params))
    : new Set<string>();
  const iface: GroupInterface = {
    inputs: groupInput
      ? readBoundarySockets(groupInput.data.params).filter(
          (s) => !isIterate || !reserved.has(s.name)
        )
      : [],
    outputs: groupOutput ? readBoundarySockets(groupOutput.data.params) : [],
  };
  return nodes.map((n) => {
    if (n.id !== groupId) return n;
    return refreshNodeSockets({
      ...n,
      data: { ...n.data, params: { ...n.data.params, interface: iface } },
    });
  });
}

// --- group / ungroup -------------------------------------------------------

// Resolved socket type of a source endpoint, from the node's cached
// socket arrays.
function sourceSocketType(n: GraphNode, sourceHandle: string): string | null {
  if (sourceHandle === "out:primary") return n.data.primaryOutput;
  if (sourceHandle.startsWith("out:aux:")) {
    const name = sourceHandle.slice("out:aux:".length);
    return n.data.auxOutputs.find((a) => a.name === name)?.type ?? null;
  }
  return null;
}

// Resolved socket type of a target endpoint (regular input or exposed
// param), from the consumer's caches / def.
function targetSocketType(n: GraphNode, targetHandle: string): string | null {
  const parsed = parseTargetHandleKind(targetHandle ?? "");
  if (!parsed) return null;
  if (parsed.kind === "input") {
    return n.data.inputs.find((i) => i.name === parsed.name)?.type ?? null;
  }
  const def = getNodeDef(n.data.defType);
  const p = def?.params.find((x) => x.name === parsed.name);
  return p ? paramSocketType(p.type) : null;
}

function uniqueSocketName(base: string, used: Set<string>): string {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
  used.add(name);
  return name;
}

// True when grouping `selectedIds` would create a cycle: a data path
// that leaves the selection and re-enters it. After grouping, that
// path would run group → outside → group, which is a cycle in the
// shell graph even though the flat graph was acyclic.
function groupWouldCycle(
  selectedIds: ReadonlySet<string>,
  edges: Edge[]
): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  // BFS forward from the selection through unselected nodes only;
  // stepping from an unselected node back into the selection proves
  // the offending path.
  const queue: string[] = [];
  const visited = new Set<string>();
  for (const id of selectedIds) {
    for (const next of adj.get(id) ?? []) {
      if (!selectedIds.has(next) && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (selectedIds.has(next)) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

// Ids of every node nested (at any depth) inside any of `rootIds` —
// used to cascade deletion: removing a group shell must also remove
// its interior, or the orphans linger invisible in the flat array.
export function collectDescendantIds(
  nodes: GraphNode[],
  rootIds: Iterable<string>
): string[] {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const p = n.data.parentId;
    if (!p) continue;
    const list = children.get(p);
    if (list) list.push(n.id);
    else children.set(p, [n.id]);
  }
  const out: string[] = [];
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export type GroupSelectionResult =
  | { ok: true; nodes: GraphNode[]; edges: Edge[]; groupId: string }
  | { ok: false; error: string };

// Cmd+G: collapse the selected nodes (all in the scope `scopeId`,
// undefined = root) into a new group. Boundary edges become group
// sockets: each distinct exterior producer feeding the selection gets
// one input socket; each (interior source, handle) pair feeding the
// outside gets one output socket. Interior nodes keep their positions —
// scopes share one coordinate space and the editor just filters by
// parentId.
export function groupSelection(
  nodes: GraphNode[],
  edges: Edge[],
  selectedIds: ReadonlySet<string>,
  scopeId: string | undefined
): GroupSelectionResult {
  const selected = nodes.filter((n) => selectedIds.has(n.id));
  if (selected.length === 0) {
    return { ok: false, error: "Nothing selected to group" };
  }
  if (selected.some((n) => n.data.parentId !== scopeId)) {
    return { ok: false, error: "Selection spans multiple scopes" };
  }
  if (
    selected.some(
      (n) =>
        n.data.defType === GROUP_INPUT_TYPE ||
        n.data.defType === GROUP_OUTPUT_TYPE
    )
  ) {
    return {
      ok: false,
      error: "Group Input / Output nodes define this group and can't be grouped",
    };
  }
  if (selected.some((n) => n.data.defType === LAYER_TYPE)) {
    return { ok: false, error: "Layers can't be grouped" };
  }
  if (groupWouldCycle(selectedIds, edges)) {
    return {
      ok: false,
      error: "Grouping would create a cycle (a path leaves and re-enters the selection)",
    };
  }

  const minX = Math.min(...selected.map((n) => n.position.x));
  const maxX = Math.max(...selected.map((n) => n.position.x));
  const avgY =
    selected.reduce((s, n) => s + n.position.y, 0) / selected.length;
  const avgX = (minX + maxX) / 2;

  const group = makeInstanceNode(GROUP_TYPE, { x: avgX, y: avgY });
  const groupInput = makeInstanceNode(GROUP_INPUT_TYPE, {
    x: minX - 380,
    y: avgY,
  });
  const groupOutput = makeInstanceNode(GROUP_OUTPUT_TYPE, {
    x: maxX + 380,
    y: avgY,
  });
  group.data.parentId = scopeId;
  group.selected = true;
  groupInput.data.parentId = group.id;
  groupOutput.data.parentId = group.id;

  // --- boundary edges → group sockets --------------------------------
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = edges.filter(
    (e) => !selectedIds.has(e.source) && selectedIds.has(e.target)
  );
  const outgoing = edges.filter(
    (e) => selectedIds.has(e.source) && !selectedIds.has(e.target)
  );
  const boundaryIds = new Set([
    ...incoming.map((e) => e.id),
    ...outgoing.map((e) => e.id),
  ]);

  const newEdges: Edge[] = [];
  const usedInNames = new Set<string>();
  const usedOutNames = new Set<string>();
  const inSockets: GroupSocketSpec[] = [];
  const outSockets: GroupSocketSpec[] = [];

  // One input socket per distinct exterior producer endpoint, shared by
  // every selected consumer it feeds (mirrors Blender).
  const inByProducer = new Map<string, GroupSocketSpec>();
  for (const e of incoming) {
    const producerKey = `${e.source} ${e.sourceHandle ?? ""}`;
    let spec = inByProducer.get(producerKey);
    if (!spec) {
      const target = byId.get(e.target);
      const parsed = parseTargetHandleKind(e.targetHandle ?? "");
      const source = byId.get(e.source);
      const type = ((target && targetSocketType(target, e.targetHandle ?? "")) ??
        (source && sourceSocketType(source, e.sourceHandle ?? "")) ??
        "image") as SocketType;
      const base = parsed?.name ?? "in";
      spec = { name: uniqueSocketName(base, usedInNames), type };
      inByProducer.set(producerKey, spec);
      inSockets.push(spec);
      // Exterior producer → group shell.
      newEdges.push({
        id: newEdgeId(),
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: group.id,
        targetHandle: `in:${spec.name}`,
      });
    }
    // Group Input → the original interior consumer.
    newEdges.push({
      id: newEdgeId(),
      source: groupInput.id,
      sourceHandle: `out:aux:${spec.name}`,
      target: e.target,
      targetHandle: e.targetHandle,
    });
  }

  // One output socket per distinct interior producer endpoint, shared
  // by every exterior consumer it feeds.
  const outByProducer = new Map<string, GroupSocketSpec>();
  for (const e of outgoing) {
    const producerKey = `${e.source} ${e.sourceHandle ?? ""}`;
    let spec = outByProducer.get(producerKey);
    if (!spec) {
      const source = byId.get(e.source);
      const type = ((source && sourceSocketType(source, e.sourceHandle ?? "")) ??
        "image") as SocketType;
      const base =
        e.sourceHandle?.startsWith("out:aux:") === true
          ? e.sourceHandle.slice("out:aux:".length)
          : type;
      spec = { name: uniqueSocketName(base, usedOutNames), type };
      outByProducer.set(producerKey, spec);
      outSockets.push(spec);
      // Interior producer → Group Output.
      newEdges.push({
        id: newEdgeId(),
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: groupOutput.id,
        targetHandle: `in:${spec.name}`,
      });
    }
    // Group shell → the original exterior consumer.
    newEdges.push({
      id: newEdgeId(),
      source: group.id,
      sourceHandle: `out:aux:${spec.name}`,
      target: e.target,
      targetHandle: e.targetHandle,
    });
  }

  groupInput.data.params = { sockets: inSockets };
  groupOutput.data.params = { sockets: outSockets };

  const outNodes: GraphNode[] = [
    ...nodes.map((n) =>
      selectedIds.has(n.id)
        ? {
            ...n,
            selected: false,
            data: { ...n.data, parentId: group.id },
          }
        : n.selected
          ? { ...n, selected: false }
          : n
    ),
    group,
    refreshNodeSockets(groupInput),
    refreshNodeSockets(groupOutput),
  ];
  const outEdges = [
    ...edges.filter((e) => !boundaryIds.has(e.id)),
    ...newEdges,
  ];
  return {
    ok: true,
    nodes: syncGroupInterface(outNodes, group.id),
    edges: outEdges,
    groupId: group.id,
  };
}

export type UngroupResult =
  | { ok: true; nodes: GraphNode[]; edges: Edge[]; restoredIds: string[] }
  | { ok: false; error: string };

// Cmd+Shift+G: dissolve a group. Interior nodes return to the group's
// scope; boundary crossings are spliced back into direct edges (the
// same splice the flatten pass performs, restricted to one group).
// Nested groups inside survive untouched — only direct children are
// reparented.
export function ungroupNode(
  nodes: GraphNode[],
  edges: Edge[],
  groupId: string
): UngroupResult {
  const group = nodes.find((n) => n.id === groupId);
  if (!group || group.data.defType !== GROUP_TYPE) {
    return { ok: false, error: "Not a group node" };
  }
  const groupInput = nodes.find(
    (n) => n.data.parentId === groupId && n.data.defType === GROUP_INPUT_TYPE
  );
  const groupOutput = nodes.find(
    (n) => n.data.parentId === groupId && n.data.defType === GROUP_OUTPUT_TYPE
  );
  const removedIds = new Set(
    [groupId, groupInput?.id, groupOutput?.id].filter(
      (x): x is string => !!x
    )
  );

  // Exterior producer per group input socket, interior producer per
  // group output socket.
  const exteriorInto = new Map<string, Edge>(); // socket name → edge into shell
  const interiorInto = new Map<string, Edge>(); // socket name → edge into Group Output
  for (const e of edges) {
    const parsed = parseTargetHandleKind(e.targetHandle ?? "");
    if (parsed?.kind !== "input") continue;
    if (e.target === groupId) exteriorInto.set(parsed.name, e);
    if (groupOutput && e.target === groupOutput.id) {
      interiorInto.set(parsed.name, e);
    }
  }

  const splicedEdges: Edge[] = [];
  for (const e of edges) {
    // Interior consumers fed from Group Input → reconnect to the
    // exterior producer (if that socket is wired outside).
    if (groupInput && e.source === groupInput.id) {
      const name = e.sourceHandle?.startsWith("out:aux:")
        ? e.sourceHandle.slice("out:aux:".length)
        : null;
      const outer = name ? exteriorInto.get(name) : undefined;
      if (outer) {
        splicedEdges.push({
          ...e,
          id: newEdgeId(),
          source: outer.source,
          sourceHandle: outer.sourceHandle,
        });
      }
      continue;
    }
    // Exterior consumers fed from the shell → reconnect to the interior
    // producer (if that socket is wired inside).
    if (e.source === groupId) {
      const name = e.sourceHandle?.startsWith("out:aux:")
        ? e.sourceHandle.slice("out:aux:".length)
        : null;
      const inner = name ? interiorInto.get(name) : undefined;
      if (inner) {
        splicedEdges.push({
          ...e,
          id: newEdgeId(),
          source: inner.source,
          sourceHandle: inner.sourceHandle,
        });
      }
      continue;
    }
  }

  const restoredIds: string[] = [];
  const outNodes = nodes
    .filter((n) => !removedIds.has(n.id))
    .map((n) => {
      if (n.data.parentId !== groupId) return n;
      restoredIds.push(n.id);
      return {
        ...n,
        selected: true,
        data: { ...n.data, parentId: group.data.parentId },
      };
    });
  const outEdges = [
    ...edges.filter(
      (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
    ),
    ...splicedEdges,
  ];
  return { ok: true, nodes: outNodes, edges: outEdges, restoredIds };
}

// --- boundary socket editing ------------------------------------------------

// Replace `nodeId` in the array with an updated boundary node carrying
// `sockets`, refresh its socket caches, and re-sync the owning group's
// interface. Shared tail of every socket mutation below.
function applyBoundarySockets(
  nodes: GraphNode[],
  boundary: GraphNode,
  sockets: GroupSocketSpec[]
): GraphNode[] {
  const updated = refreshNodeSockets({
    ...boundary,
    data: {
      ...boundary.data,
      params: { ...boundary.data.params, sockets },
    },
  });
  const next = nodes.map((n) => (n.id === boundary.id ? updated : n));
  return boundary.data.parentId
    ? syncGroupInterface(next, boundary.data.parentId)
    : next;
}

export interface VirtualConnection {
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
}

// Wiring into the trailing virtual socket on Group Input / Group Output
// mints a real socket (typed and named after the far end of the
// connection) and lands the edge on it. Returns null when the
// connection doesn't involve a virtual socket — the caller falls
// through to its normal connect path. Virtual-to-virtual connections
// are rejected by the editor's validation (no type to infer).
export function connectToVirtualSocket(
  nodes: GraphNode[],
  edges: Edge[],
  conn: VirtualConnection
): { nodes: GraphNode[]; edges: Edge[] } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const source = byId.get(conn.source);
  const target = byId.get(conn.target);
  if (!source || !target) return null;

  // Member output → the Iterate shell's virtual input: mints the
  // collect socket (071926_iterate-zone-view.md rev 3). The shell's own
  // `sockets` param holds it; the matching grouped aux output appears
  // via resolveAuxOutputs. Single-collect for now — the virtual port
  // only renders while no socket exists.
  if (
    target.data.defType === ITERATE_TYPE &&
    conn.targetHandle === `in:${VIRTUAL_SOCKET}`
  ) {
    const type = (sourceSocketType(source, conn.sourceHandle ?? "") ??
      "image") as SocketType;
    const base =
      conn.sourceHandle?.startsWith("out:aux:") === true
        ? conn.sourceHandle.slice("out:aux:".length)
        : type;
    const name = uniqueSocketName(
      base,
      new Set(readBoundarySockets(target.data.params).map((s) => s.name))
    );
    const sockets = [
      ...readBoundarySockets(target.data.params),
      { name, type },
    ];
    return {
      nodes: applyBoundarySockets(nodes, target, sockets),
      edges: [
        ...edges,
        {
          id: newEdgeId(),
          source: conn.source,
          sourceHandle: conn.sourceHandle,
          target: conn.target,
          targetHandle: `in:${name}`,
        },
      ],
    };
  }

  // Exterior output → the Iteration Input's virtual input: mints a
  // passthrough socket (paired exterior `in:` face + interior aux
  // output) and lands the exterior wire on it.
  if (
    target.data.defType === ITERATE_INPUT_TYPE &&
    conn.targetHandle === `in:${VIRTUAL_SOCKET}`
  ) {
    const type = (sourceSocketType(source, conn.sourceHandle ?? "") ??
      "image") as SocketType;
    const base =
      conn.sourceHandle?.startsWith("out:aux:") === true
        ? conn.sourceHandle.slice("out:aux:".length)
        : type;
    const used = new Set(
      readBoundarySockets(target.data.params).map((s) => s.name)
    );
    const name = uniqueSocketName(base, used);
    const sockets = [
      ...readBoundarySockets(target.data.params),
      { name, type },
    ];
    return {
      nodes: applyBoundarySockets(nodes, target, sockets),
      edges: [
        ...edges,
        {
          id: newEdgeId(),
          source: conn.source,
          sourceHandle: conn.sourceHandle,
          target: conn.target,
          targetHandle: `in:${name}`,
        },
      ],
    };
  }

  // Interior output → Group Output's virtual input: new group output.
  if (
    target.data.defType === GROUP_OUTPUT_TYPE &&
    conn.targetHandle === `in:${VIRTUAL_SOCKET}`
  ) {
    const type = (sourceSocketType(source, conn.sourceHandle ?? "") ??
      "image") as SocketType;
    const base =
      conn.sourceHandle?.startsWith("out:aux:") === true
        ? conn.sourceHandle.slice("out:aux:".length)
        : type;
    const used = new Set(
      readBoundarySockets(target.data.params).map((s) => s.name)
    );
    const name = uniqueSocketName(base, used);
    const sockets = [
      ...readBoundarySockets(target.data.params),
      { name, type },
    ];
    return {
      nodes: applyBoundarySockets(nodes, target, sockets),
      edges: [
        ...edges,
        {
          id: newEdgeId(),
          source: conn.source,
          sourceHandle: conn.sourceHandle,
          target: conn.target,
          targetHandle: `in:${name}`,
        },
      ],
    };
  }

  // Group Input's (or Iteration Input's) virtual output → interior
  // input: new group input / passthrough socket minted from the inside.
  if (
    (source.data.defType === GROUP_INPUT_TYPE ||
      source.data.defType === ITERATE_INPUT_TYPE) &&
    conn.sourceHandle === `out:aux:${VIRTUAL_SOCKET}`
  ) {
    const parsed = parseTargetHandleKind(conn.targetHandle ?? "");
    if (!parsed) return null;
    const type = (targetSocketType(target, conn.targetHandle ?? "") ??
      "image") as SocketType;
    const used = new Set(
      readBoundarySockets(source.data.params).map((s) => s.name)
    );
    const name = uniqueSocketName(parsed.name, used);
    const sockets = [
      ...readBoundarySockets(source.data.params),
      { name, type },
    ];
    return {
      nodes: applyBoundarySockets(nodes, source, sockets),
      edges: [
        ...edges,
        {
          id: newEdgeId(),
          source: conn.source,
          sourceHandle: `out:aux:${name}`,
          target: conn.target,
          targetHandle: conn.targetHandle,
        },
      ],
    };
  }

  return null;
}

// Rename a socket on a Group Input / Group Output node, rewriting the
// handles on every edge that references it — both the interior face
// (the boundary node itself) and the exterior face (the group shell).
export function renameGroupSocket(
  nodes: GraphNode[],
  edges: Edge[],
  boundaryId: string,
  oldName: string,
  rawNewName: string
): { nodes: GraphNode[]; edges: Edge[] } | null {
  const boundary = nodes.find((n) => n.id === boundaryId);
  if (!boundary) return null;
  const kind = boundary.data.defType;
  if (kind !== GROUP_INPUT_TYPE && kind !== GROUP_OUTPUT_TYPE) return null;
  if (isFixedBoundary(boundary.data.params)) return null;
  if (readReservedSockets(boundary.data.params).includes(oldName)) return null;
  const groupId = boundary.data.parentId;
  const sockets = readBoundarySockets(boundary.data.params);
  if (!sockets.some((s) => s.name === oldName)) return null;

  const trimmed = rawNewName.trim();
  if (!trimmed || trimmed === oldName || trimmed === VIRTUAL_SOCKET) {
    return null;
  }
  const used = new Set(
    sockets.filter((s) => s.name !== oldName).map((s) => s.name)
  );
  const newName = uniqueSocketName(trimmed, used);

  const nextSockets = sockets.map((s) =>
    s.name === oldName ? { ...s, name: newName } : s
  );
  const isInput = kind === GROUP_INPUT_TYPE;
  const nextEdges = edges.map((e) => {
    // Interior face: edges touching the boundary node's socket.
    if (isInput) {
      if (e.source === boundaryId && e.sourceHandle === `out:aux:${oldName}`) {
        return { ...e, sourceHandle: `out:aux:${newName}` };
      }
    } else if (e.target === boundaryId && e.targetHandle === `in:${oldName}`) {
      return { ...e, targetHandle: `in:${newName}` };
    }
    // Exterior face: edges touching the group shell's matching socket.
    if (groupId) {
      if (isInput) {
        if (e.target === groupId && e.targetHandle === `in:${oldName}`) {
          return { ...e, targetHandle: `in:${newName}` };
        }
      } else if (
        e.source === groupId &&
        e.sourceHandle === `out:aux:${oldName}`
      ) {
        return { ...e, sourceHandle: `out:aux:${newName}` };
      }
    }
    return e;
  });
  return {
    nodes: applyBoundarySockets(nodes, boundary, nextSockets),
    edges: nextEdges,
  };
}

// Remove a socket from a Group Input / Group Output node, dropping the
// edges wired into it on both faces of the boundary.
export function removeGroupSocket(
  nodes: GraphNode[],
  edges: Edge[],
  boundaryId: string,
  name: string
): { nodes: GraphNode[]; edges: Edge[] } | null {
  const boundary = nodes.find((n) => n.id === boundaryId);
  if (!boundary) return null;
  const kind = boundary.data.defType;
  if (kind !== GROUP_INPUT_TYPE && kind !== GROUP_OUTPUT_TYPE) return null;
  if (isFixedBoundary(boundary.data.params)) return null;
  if (readReservedSockets(boundary.data.params).includes(name)) return null;
  const groupId = boundary.data.parentId;
  const sockets = readBoundarySockets(boundary.data.params);
  if (!sockets.some((s) => s.name === name)) return null;

  const isInput = kind === GROUP_INPUT_TYPE;
  const nextEdges = edges.filter((e) => {
    if (isInput) {
      if (e.source === boundaryId && e.sourceHandle === `out:aux:${name}`) {
        return false;
      }
      if (groupId && e.target === groupId && e.targetHandle === `in:${name}`) {
        return false;
      }
    } else {
      if (e.target === boundaryId && e.targetHandle === `in:${name}`) {
        return false;
      }
      if (
        groupId &&
        e.source === groupId &&
        e.sourceHandle === `out:aux:${name}`
      ) {
        return false;
      }
    }
    return true;
  });
  return {
    nodes: applyBoundarySockets(
      nodes,
      boundary,
      sockets.filter((s) => s.name !== name)
    ),
    edges: nextEdges,
  };
}

// --- iterate ----------------------------------------------------------------

// Zone auto-interface (071926_iterate-zone-view.md): a wire drawn
// straight across an Iterate's boundary mints the boundary socket and
// routes the data through it, instead of rejecting the connection.
//
//   exterior → member:   exterior → (shell in:<name>)  +
//                        (Iteration Input out:aux:<name>) → member
//   member → exterior:   member → (Iteration Output in:<name>)  +
//                        (shell out:aux:<name>) → exterior
//
// Returns null when the connection isn't an iterate-boundary crossing —
// the caller falls through to its normal connect path. member→exterior
// only applies while the Iteration Output has NO sockets yet: the first
// output socket is the collected result, and additional outputs aren't
// collected (the exterior face carries the GROUPED type — image becomes
// image_group — which is also why the editor's validation gates that
// direction on the grouped type being acceptable to the target).
export function connectAcrossIterateBoundary(
  nodes: GraphNode[],
  edges: Edge[],
  conn: VirtualConnection
): { nodes: GraphNode[]; edges: Edge[] } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const source = byId.get(conn.source);
  const target = byId.get(conn.target);
  if (!source || !target) return null;

  // exterior → member is NOT routed here anymore: the wire stays exactly
  // as drawn ("stay as wired" — 071926_iterate-zone-view.md); flatten
  // mirrors it onto a per-edge hidden shell input and the shell's
  // compute feeds the value into each iteration. Only member → exterior
  // needs a real boundary socket, because the exiting value changes
  // TYPE (it's the grouped collection).

  // member → exterior: the source lives in an Iterate whose shell sits
  // in the target's scope. Mint a collect socket on the shell (every
  // collect socket gets its own grouped output) and route through it —
  // reusing an existing tap when this exact member output already has
  // one. Wiring a member straight INTO the shell is the direct tap, not
  // a routing case.
  const sShell = source.data.parentId
    ? byId.get(source.data.parentId)
    : undefined;
  if (
    sShell?.data.defType === ITERATE_TYPE &&
    target.id !== sShell.id &&
    target.data.parentId === sShell.data.parentId &&
    source.data.defType !== ITERATE_INPUT_TYPE
  ) {
    const existingTap = edges.find(
      (e) =>
        e.target === sShell.id &&
        e.source === conn.source &&
        e.sourceHandle === conn.sourceHandle &&
        e.targetHandle?.startsWith("in:") === true
    );
    if (existingTap) {
      const name = existingTap.targetHandle!.slice("in:".length);
      return {
        nodes,
        edges: [
          ...edges,
          {
            id: newEdgeId(),
            source: sShell.id,
            sourceHandle: `out:aux:${name}`,
            target: conn.target,
            targetHandle: conn.targetHandle,
          },
        ],
      };
    }
    const type = (sourceSocketType(source, conn.sourceHandle ?? "") ??
      "image") as SocketType;
    const base =
      conn.sourceHandle?.startsWith("out:aux:") === true
        ? conn.sourceHandle.slice("out:aux:".length)
        : type;
    const name = uniqueSocketName(
      base,
      new Set(readBoundarySockets(sShell.data.params).map((s) => s.name))
    );
    return {
      nodes: applyBoundarySockets(nodes, sShell, [
        ...readBoundarySockets(sShell.data.params),
        { name, type },
      ]),
      edges: [
        ...edges,
        {
          id: newEdgeId(),
          source: conn.source,
          sourceHandle: conn.sourceHandle,
          target: sShell.id,
          targetHandle: `in:${name}`,
        },
        {
          id: newEdgeId(),
          source: sShell.id,
          sourceHandle: `out:aux:${name}`,
          target: conn.target,
          targetHandle: conn.targetHandle,
        },
      ],
    };
  }

  return null;
}

// Absorb an exterior node — and the part of its upstream chain that
// depends on the zone's iteration values — into an Iterate zone. This
// is the "build outside, then pipe it in" flow
// (071926_iterate-zone-view.md): wires from the Iteration Input's
// values (index/t/random) to exterior nodes are allowed as PENDING
// wires; when one of those chains is piped into the Iteration Output,
// this op expands the zone to include it. Pure; returns null when
// nothing applies or the required closure contains unabsorbable nodes
// (layers, outputs, other zones' machinery).
//
// Crossing edges after the absorb:
//  - inputs from nodes that STAY outside keep their wires exactly as
//    drawn — flatten mirrors them per-edge onto the shell and the
//    compute feeds them into each iteration ("stay as wired");
//  - outputs from absorbed nodes to consumers that stay outside mint
//    collect sockets on the shell (deduped) — the exiting value changes
//    TYPE (grouped collection), so an explicit socket is honest there;
//  - pending iteration wires into the absorbed chain simply come alive
//    (member → member now); pending wires to nodes outside the closure
//    stay pending.
export function absorbIntoIterateZone(
  nodes: GraphNode[],
  edges: Edge[],
  shellId: string,
  rootId: string
): { nodes: GraphNode[]; edges: Edge[] } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const shell = byId.get(shellId);
  if (!shell || shell.data.defType !== ITERATE_TYPE) return null;
  const scope = shell.data.parentId;
  const root = byId.get(rootId);
  if (!root || root.data.parentId !== scope) return null;

  const UNABSORBABLE = new Set<string>([
    LAYER_TYPE,
    ITERATE_TYPE,
    ITERATE_INPUT_TYPE,
    GROUP_INPUT_TYPE,
    GROUP_OUTPUT_TYPE,
    "output",
    "render-queue",
  ]);
  if (UNABSORBABLE.has(root.data.defType)) return null;

  // Existing members (direct or via nested plain groups).
  const isMember = (id: string): boolean => {
    let cur = byId.get(id)?.data.parentId;
    for (let hops = 0; cur && hops < nodes.length; hops++) {
      if (cur === shellId) return true;
      cur = byId.get(cur)?.data.parentId;
    }
    return false;
  };

  // Exterior nodes already downstream of the zone's iteration values
  // (via pending wires) — these can't stay outside if the piped chain
  // passes through them.
  const iterDep = new Set<string>();
  {
    const frontier: string[] = [];
    const addDep = (id: string) => {
      if (iterDep.has(id)) return;
      iterDep.add(id);
      frontier.push(id);
    };
    for (const e of edges) {
      if (!isMember(e.source)) continue;
      const t = byId.get(e.target);
      if (t && t.data.parentId === scope && t.id !== shellId) addDep(t.id);
    }
    while (frontier.length > 0) {
      const id = frontier.pop()!;
      for (const e of edges) {
        if (e.source !== id) continue;
        const t = byId.get(e.target);
        if (t && t.data.parentId === scope && t.id !== shellId) addDep(t.id);
      }
    }
  }

  // Closure: the root plus its upstream exterior nodes that are
  // iteration-dependent. Non-dependent upstream stays outside (its
  // values are the same every iteration — passthroughs cover it).
  const cluster = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.target !== id) continue;
      const s = byId.get(e.source);
      if (!s || cluster.has(s.id)) continue;
      if (s.data.parentId !== scope) continue;
      if (!iterDep.has(s.id)) continue;
      if (UNABSORBABLE.has(s.data.defType)) return null;
      cluster.add(s.id);
      stack.push(s.id);
    }
  }

  let outNodes = nodes.map((n) =>
    cluster.has(n.id)
      ? { ...n, data: { ...n.data, parentId: shellId } }
      : n
  );
  const inZone = (id: string) => cluster.has(id) || isMember(id);

  // Heal outbound crossing edges. Dedupe keys are "source|sourceHandle";
  // existing taps pre-seed the map so re-absorbing near an existing
  // collect socket reuses it.
  const tapSockets = [...readBoundarySockets(shell.data.params)];
  const tapUsed = new Set(tapSockets.map((s) => s.name));
  const tapNames = new Map<string, string>();
  for (const e of edges) {
    if (e.target === shellId && e.targetHandle?.startsWith("in:") === true) {
      tapNames.set(
        `${e.source}|${e.sourceHandle}`,
        e.targetHandle.slice("in:".length)
      );
    }
  }
  const tapMinted = new Set(tapNames.values());

  const outEdges: Edge[] = [];
  const extraEdges: Edge[] = [];
  for (const e of edges) {
    const sIn = inZone(e.source);
    const tIn = inZone(e.target);
    if (sIn === tIn || e.target === shellId || (!sIn && tIn)) {
      // Same side, a collect tap, or an inbound crossing wire — inbound
      // wires stay exactly as drawn (flatten feeds them per-edge).
      outEdges.push(e);
      continue;
    }
    // sIn && !tIn — a member's output crossing out.
    if (!cluster.has(e.source)) {
      // A pre-existing pending iteration wire to a node that stayed
      // outside the closure: keep pending.
      outEdges.push(e);
      continue;
    }
    // Newly absorbed node feeding an exterior consumer: collect route
    // (the consumer now receives the GROUPED result).
    const key = `${e.source}|${e.sourceHandle}`;
    let name = tapNames.get(key);
    if (!name) {
      const src = byId.get(e.source);
      const type = (src
        ? sourceSocketType(src, e.sourceHandle ?? "") ?? "image"
        : "image") as SocketType;
      name = uniqueSocketName(
        e.sourceHandle?.startsWith("out:aux:") === true
          ? e.sourceHandle.slice("out:aux:".length)
          : type,
        tapUsed
      );
      tapUsed.add(name);
      tapSockets.push({ name, type });
      tapNames.set(key, name);
    }
    if (!tapMinted.has(name)) {
      tapMinted.add(name);
      outEdges.push({
        ...e,
        target: shellId,
        targetHandle: `in:${name}`,
      });
    }
    extraEdges.push({
      id: newEdgeId(),
      source: shellId,
      sourceHandle: `out:aux:${name}`,
      target: e.target,
      targetHandle: e.targetHandle,
    });
  }

  // Apply the minted collect sockets.
  if (tapSockets.length > readBoundarySockets(shell.data.params).length) {
    outNodes = applyBoundarySockets(outNodes, shell, tapSockets);
  }

  return { nodes: outNodes, edges: [...outEdges, ...extraEdges] };
}

// Zone-view drop-to-reparent (071926_iterate-zone-view.md): move one
// node into / out of an Iterate scope by dragging it across the zone
// boundary. Pure; returns null when the move is illegal — boundary
// nodes never move, the target scope must not be the node itself or a
// descendant of it (cycle), and every edge touching the node must stay
// scope-legal after the move (its other endpoint already in the target
// scope). Wired nodes therefore refuse to cross the boundary — the
// caller toasts "disconnect first". Moving a group/iterate shell
// carries its subtree for free (descendants' parentId chains are
// relative and untouched).
export function reparentNode(
  nodes: GraphNode[],
  edges: Edge[],
  nodeId: string,
  newParentId: string | undefined
): { nodes: GraphNode[] } | null {
  const n = nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  const t = n.data.defType;
  if (
    t === GROUP_INPUT_TYPE ||
    t === GROUP_OUTPUT_TYPE ||
    t === ITERATE_INPUT_TYPE
  ) {
    return null;
  }
  if (n.data.parentId === newParentId) return null;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  // Cycle guard: the new scope may not sit inside the moved node's own
  // subtree.
  let cur = newParentId;
  for (let guard = 0; cur && guard < nodes.length; guard++) {
    if (cur === nodeId) return null;
    cur = byId.get(cur)?.data.parentId;
  }
  for (const e of edges) {
    if (e.source !== nodeId && e.target !== nodeId) continue;
    const other = byId.get(e.source === nodeId ? e.target : e.source);
    if (other && other.data.parentId !== newParentId) return null;
  }
  return {
    nodes: nodes.map((x) =>
      x.id === nodeId
        ? { ...x, data: { ...x.data, parentId: newParentId } }
        : x
    ),
  };
}

// New empty Iterate zone: exactly two nodes
// (071926_iterate-zone-view.md rev 3). The Iteration Input carries the
// loop params (count / seed / random range) and the reserved iteration
// sockets; the Iteration Output ("iterate" — the computing shell)
// starts socketless: wiring a member into its virtual input mints the
// collect socket, whose type picks the collection form.
export function makeIterateNodes(position: { x: number; y: number }): {
  iterate: GraphNode;
  iterateInput: GraphNode;
} {
  const iterate = makeInstanceNode(ITERATE_TYPE, {
    x: position.x + 840,
    y: position.y,
  });
  const iterateInput = makeInstanceNode(ITERATE_INPUT_TYPE, position);
  iterateInput.data.parentId = iterate.id;
  iterateInput.data.params = {
    ...iterateInput.data.params,
    sockets: [...ITERATE_INPUT_SOCKETS],
    reserved: ITERATE_INPUT_SOCKETS.map((s) => s.name),
  };
  iterate.data.params = {
    ...iterate.data.params,
    sockets: [],
    interface: { inputs: [], outputs: [] } satisfies GroupInterface,
  };
  return {
    iterate: refreshNodeSockets(iterate),
    iterateInput: refreshNodeSockets(iterateInput),
  };
}

// --- layers -----------------------------------------------------------------

// New empty layer: the layer node plus its fixed-interface boundary
// nodes. Position is the exterior (root-chain) position; the interior
// boundary nodes spread around it in the shared coordinate space.
export function makeLayerNodes(
  name: string,
  position: { x: number; y: number }
): { layer: GraphNode; groupInput: GraphNode; groupOutput: GraphNode } {
  const layer = makeInstanceNode(LAYER_TYPE, position);
  layer.data.name = name;
  const groupInput = makeInstanceNode(GROUP_INPUT_TYPE, {
    x: position.x - 420,
    y: position.y,
  });
  const groupOutput = makeInstanceNode(GROUP_OUTPUT_TYPE, {
    x: position.x + 420,
    y: position.y,
  });
  groupInput.data.parentId = layer.id;
  // Group Input is extensible (the "new socket" port shows) so deep
  // params can be promoted up to the layer, but `backdrop` is reserved
  // (can't be renamed/removed). Group Output is fully fixed — image +
  // audio are the layer's render contract.
  groupInput.data.params = {
    sockets: [...LAYER_INPUT_SOCKETS],
    reserved: ["backdrop"],
  };
  groupOutput.data.parentId = layer.id;
  // A Layer Output carries its own independent export config (filename,
  // format, codec, frame range, …) so a layer can be rendered in a
  // different form than the composition. Seed the same defaults the
  // composition Output ships with — the canonical EXPORT_PARAMS list
  // (see 071526_layer-output-export-settings.md). Read from that list
  // rather than the whole Output def, whose params also carry the
  // Output-only SVG styling rows (there's no spline tap on a Layer Output).
  // `sockets`/`fixed` come last so a future export param can't shadow them.
  const exportDefaults: Record<string, unknown> = {};
  for (const p of EXPORT_PARAMS) exportDefaults[p.name] = p.default;
  groupOutput.data.params = {
    ...exportDefaults,
    sockets: [...LAYER_OUTPUT_SOCKETS],
    fixed: true,
  };
  return {
    layer,
    groupInput: refreshNodeSockets(groupInput),
    groupOutput: refreshNodeSockets(groupOutput),
  };
}

// Add a new layer on top of the root chain: it takes over the Output's
// image input, with whatever fed Output before becoming the new layer's
// stack. Without an Output the layer just lands unwired at root.
//
// `opts.content` seeds a source node inside the layer, wired to its
// Group Output's image — so "Image / Text / Video" layers come up ready
// to use. Omit it for an empty layer.
export function createLayer(
  nodes: GraphNode[],
  edges: Edge[],
  opts?: { name?: string; content?: string },
  // Composition to add the layer into. Scopes the target Output (and the new
  // nodes' tag + the "Layer N" count) so "Add layer" in a multi-composition
  // project can't wire into ANOTHER composition's Output. Omit for a
  // single-composition / unscoped caller — old behavior (first root Output).
  compositionId?: string
): { nodes: GraphNode[]; edges: Edge[]; layerId: string } {
  const rootLayerCount = nodes.filter(
    (n) =>
      n.data.defType === LAYER_TYPE &&
      !n.data.parentId &&
      belongsToComposition(n, compositionId)
  ).length;
  const name = opts?.name ?? `Layer ${rootLayerCount + 1}`;

  const output = nodes.find(
    (n) =>
      n.data.defType === "output" &&
      !n.data.parentId &&
      belongsToComposition(n, compositionId)
  );
  const intoOutput = output
    ? edges.find(
        (e) => e.target === output.id && e.targetHandle === "in:image"
      )
    : undefined;
  const prevTop = intoOutput
    ? nodes.find((n) => n.id === intoOutput.source)
    : undefined;

  const position = prevTop
    ? { x: prevTop.position.x, y: prevTop.position.y - 140 }
    : output
      ? { x: output.position.x - 380, y: output.position.y }
      : { x: 200, y: 200 };
  const { layer, groupInput, groupOutput } = makeLayerNodes(name, position);
  layer.selected = true;

  const newEdges: Edge[] = [];
  if (intoOutput && output) {
    // Previous top of the chain becomes this layer's stack.
    newEdges.push({
      id: newEdgeId(),
      source: intoOutput.source,
      sourceHandle: intoOutput.sourceHandle,
      target: layer.id,
      targetHandle: "in:stack",
    });
  }
  if (output) {
    newEdges.push({
      id: newEdgeId(),
      source: layer.id,
      sourceHandle: "out:primary",
      target: output.id,
      targetHandle: "in:image",
    });
  }

  // Tag the new boundary nodes into the target composition — an untagged
  // node (undefined compositionId) counts as belonging to EVERY composition
  // (belongsToComposition), so without this a multi-comp "Add layer" would
  // surface the new layer in every composition's chain.
  if (compositionId) {
    layer.data.compositionId = compositionId;
    groupInput.data.compositionId = compositionId;
    groupOutput.data.compositionId = compositionId;
  }

  // Optional interior source node, wired to the layer's content output.
  const interior: GraphNode[] = [];
  if (opts?.content) {
    const src = makeInstanceNode(opts.content, {
      x: position.x - 40,
      y: position.y,
    });
    src.data.parentId = layer.id;
    if (compositionId) src.data.compositionId = compositionId;
    interior.push(src);
    newEdges.push({
      id: newEdgeId(),
      source: src.id,
      sourceHandle: "out:primary",
      target: groupOutput.id,
      targetHandle: "in:image",
    });
  }

  return {
    nodes: [
      ...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
      layer,
      groupInput,
      groupOutput,
      ...interior,
    ],
    edges: [
      ...edges.filter((e) => e.id !== intoOutput?.id),
      ...newEdges,
    ],
    layerId: layer.id,
  };
}

// Fresh-project scaffold: Output + "Layer 1" with the familiar starter
// chain (Image Source → Bloom) inside, wired to the layer's Group
// Output. The editor opens inside the layer so a new project feels
// exactly like the pre-layers app.
export function buildStarterGraph(): {
  nodes: GraphNode[];
  edges: Edge[];
  layerId: string;
  compositionId: string;
} {
  const output = makeInstanceNode("output", { x: 640, y: 120 });
  const { layer, groupInput, groupOutput } = makeLayerNodes("Layer 1", {
    x: 340,
    y: 120,
  });
  const imageSrc = makeInstanceNode("image-source", { x: 40, y: 80 });
  const bloom = makeInstanceNode("bloom", { x: 340, y: 80 });
  imageSrc.data.parentId = layer.id;
  bloom.data.parentId = layer.id;
  groupInput.position = { x: -260, y: 80 };
  groupOutput.position = { x: 640, y: 80 };

  const edges: Edge[] = [
    {
      id: newEdgeId(),
      source: imageSrc.id,
      sourceHandle: "out:primary",
      target: bloom.id,
      targetHandle: "in:image",
    },
    {
      id: newEdgeId(),
      source: bloom.id,
      sourceHandle: "out:primary",
      target: groupOutput.id,
      targetHandle: "in:image",
    },
    {
      id: newEdgeId(),
      source: layer.id,
      sourceHandle: "out:primary",
      target: output.id,
      targetHandle: "in:image",
    },
  ];
  // Tag the whole starter graph into one fresh composition so a brand-new
  // project carries stable composition ids before its first save (v5).
  const compositionId = newCompositionId();
  const nodes = [output, layer, groupInput, groupOutput, imageSrc, bloom];
  for (const n of nodes) n.data.compositionId = compositionId;
  return {
    nodes,
    edges,
    layerId: layer.id,
    compositionId,
  };
}

// --- compositions (v5) ------------------------------------------------------

// Build the graph for a brand-new (user-created) composition: an Output fed
// by one empty "Layer 1". Unlike buildStarterGraph it carries no demo
// content — a fresh comp is a clean slate. All nodes are tagged into the
// given composition id.
export function buildEmptyComposition(compositionId: string): {
  nodes: GraphNode[];
  edges: Edge[];
  layerId: string;
} {
  const output = makeInstanceNode("output", { x: 640, y: 120 });
  const { layer, groupInput, groupOutput } = makeLayerNodes("Layer 1", {
    x: 340,
    y: 120,
  });
  groupInput.position = { x: -260, y: 80 };
  groupOutput.position = { x: 640, y: 80 };
  const edges: Edge[] = [
    {
      id: newEdgeId(),
      source: layer.id,
      sourceHandle: "out:primary",
      target: output.id,
      targetHandle: "in:image",
    },
  ];
  const nodes = [output, layer, groupInput, groupOutput];
  for (const n of nodes) n.data.compositionId = compositionId;
  return { nodes, edges, layerId: layer.id };
}

// Default name for the next composition: "Composition N", N chosen to avoid
// colliding with existing "Composition <n>" names (and never below
// count + 1).
function nextCompositionName(existing: readonly { name: string }[]): string {
  let max = 0;
  for (const c of existing) {
    const m = /^Composition (\d+)$/.exec(c.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Composition ${Math.max(max + 1, existing.length + 1)}`;
}

// Mint a new composition: a fresh id, an empty starter graph tagged into it,
// and the registry entry (no scene — the caller seeds it from the current
// canvas). Pure: the caller splices nodes/edges into the project and appends
// the composition to the registry.
export function createComposition(
  existing: readonly { name: string }[],
  name?: string
): {
  compositionId: string;
  nodes: GraphNode[];
  edges: Edge[];
  layerId: string;
  composition: { id: string; name: string };
} {
  const compositionId = newCompositionId();
  const built = buildEmptyComposition(compositionId);
  return {
    compositionId,
    nodes: built.nodes,
    edges: built.edges,
    layerId: built.layerId,
    composition: { id: compositionId, name: name ?? nextCompositionName(existing) },
  };
}

// Remove every node belonging to a composition (and the edges touching
// them). The caller drops the composition from the registry separately —
// graph-ops owns the node/edge graph, EffectsApp owns the registry array.
// Expects nodes to be tagged (sweep untagged into the active comp first).
export function deleteCompositionNodes(
  nodes: GraphNode[],
  edges: Edge[],
  compositionId: string
): { nodes: GraphNode[]; edges: Edge[] } {
  const removed = new Set(
    nodes
      .filter((n) => n.data.compositionId === compositionId)
      .map((n) => n.id)
  );
  return {
    nodes: nodes.filter((n) => !removed.has(n.id)),
    edges: edges.filter(
      (e) => !removed.has(e.source) && !removed.has(e.target)
    ),
  };
}

// Clone every node of one composition into a new composition id (fresh node
// ids, internal edges remapped, parentId structure preserved). Returns only
// the clones; the caller splices them into the graph and adds the registry
// entry. Expects the source comp's nodes to be tagged.
export function cloneCompositionNodes(
  nodes: GraphNode[],
  edges: Edge[],
  sourceCompositionId: string,
  targetCompositionId: string
): { nodes: GraphNode[]; edges: Edge[] } {
  const source = nodes.filter(
    (n) => n.data.compositionId === sourceCompositionId
  );
  const { nodes: clones, edges: clonedEdges } = cloneSubgraph(
    source,
    edges,
    { x: 0, y: 0 }
  );
  for (const n of clones) {
    n.data.compositionId = targetCompositionId;
    n.selected = false;
  }
  return { nodes: clones, edges: clonedEdges };
}

// Composition membership. A node belongs to a composition when its tag
// matches it — or when it is untagged (defensive: freshly-created runtime
// nodes are tagged lazily, and a single-composition project may carry no
// tags at all before its first save). Passing `undefined` disables the
// filter entirely (legacy / whole-project callers). See
// specdocs/062926_compositions-and-project-view.md.
export function belongsToComposition(
  node: GraphNode,
  compositionId: string | undefined
): boolean {
  if (!compositionId) return true;
  return !node.data.compositionId || node.data.compositionId === compositionId;
}

// Restrict a graph to one composition's nodes and the edges between them.
// This is the eval / export seam for per-composition rendering: today a
// no-op for the single composition that exists, and the inline point where
// a `composition` reference (precomp) would expand later. Edges with an
// endpoint outside the composition are dropped.
export function resolveComposition(
  nodes: GraphNode[],
  edges: Edge[],
  compositionId: string | undefined
): { nodes: GraphNode[]; edges: Edge[] } {
  if (!compositionId) return { nodes, edges };
  const keep = nodes.filter((n) => belongsToComposition(n, compositionId));
  const ids = new Set(keep.map((n) => n.id));
  return {
    nodes: keep,
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  };
}

// --- layer chain (root compositing stack) -----------------------------------

// Ordered root layer chain, bottom → top (index 0 composites first,
// last feeds Output). Derived by walking the primary Output's image
// feed down through each layer's `stack` input. Root layers not in the
// chain (orphans from a delete/duplicate) are appended on top so the
// Layers editor never silently hides one. `compositionId`, when given,
// scopes the chain to that composition (v5) — a no-op for a single comp.
export function getLayerChain(
  nodes: GraphNode[],
  edges: Edge[],
  compositionId?: string
): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isRootLayer = (n: GraphNode | undefined): n is GraphNode =>
    !!n &&
    n.data.defType === LAYER_TYPE &&
    !n.data.parentId &&
    belongsToComposition(n, compositionId);

  const output = nodes.find(
    (n) =>
      n.data.defType === "output" &&
      !n.data.parentId &&
      belongsToComposition(n, compositionId)
  );
  const sourceInto = (target: string, handle: string) =>
    edges.find((e) => e.target === target && e.targetHandle === handle)
      ?.source;

  // Walk top → bottom from Output's image input.
  const topToBottom: GraphNode[] = [];
  const visited = new Set<string>();
  let cur = output ? byId.get(sourceInto(output.id, "in:image") ?? "") : undefined;
  while (isRootLayer(cur) && !visited.has(cur.id)) {
    visited.add(cur.id);
    topToBottom.push(cur);
    cur = byId.get(sourceInto(cur.id, "in:stack") ?? "");
  }
  const chain = topToBottom.reverse(); // bottom → top
  const orphans = nodes.filter(
    (n) => isRootLayer(n) && !visited.has(n.id)
  );
  return [...chain, ...orphans];
}

// Rewire the root stack chain to the given bottom → top order. Only the
// layers' `stack` edges and the Output's `image` edge are touched —
// audio and everything else is left alone. Bottom layer gets no stack
// input (composites over transparency); the top layer feeds Output.
export function reorderLayers(
  nodes: GraphNode[],
  edges: Edge[],
  orderedBottomToTop: string[],
  // Scope the target Output to this composition (see createLayer) so a
  // reorder in a multi-composition project can't rewire another
  // composition's Output. Omit for single-composition / unscoped callers.
  compositionId?: string
): { nodes: GraphNode[]; edges: Edge[] } {
  const ids = new Set(orderedBottomToTop);
  const output = nodes.find(
    (n) =>
      n.data.defType === "output" &&
      !n.data.parentId &&
      belongsToComposition(n, compositionId)
  );
  const kept = edges.filter((e) => {
    if (e.targetHandle === "in:stack" && ids.has(e.target)) return false;
    if (output && e.target === output.id && e.targetHandle === "in:image") {
      return false;
    }
    return true;
  });
  const added: Edge[] = [];
  for (let i = 1; i < orderedBottomToTop.length; i++) {
    added.push({
      id: newEdgeId(),
      source: orderedBottomToTop[i - 1],
      sourceHandle: "out:primary",
      target: orderedBottomToTop[i],
      targetHandle: "in:stack",
    });
  }
  const top = orderedBottomToTop[orderedBottomToTop.length - 1];
  if (output && top) {
    added.push({
      id: newEdgeId(),
      source: top,
      sourceHandle: "out:primary",
      target: output.id,
      targetHandle: "in:image",
    });
  }
  return { nodes, edges: [...kept, ...added] };
}

// Split a layer at `splitTick` into two DISTINCT layers (unlike a slice,
// which just cuts one layer's clip into two windows). The layer's full
// active span [in, out] becomes [in, split] on the original and
// [split, out] on a deep copy inserted directly above it in the chain.
// The copy's interior (and simulation zone ids) is duplicated so the two
// halves edit independently. Returns null when the playhead isn't inside
// the layer's span.
export function splitLayer(
  nodes: GraphNode[],
  edges: Edge[],
  layerId: string,
  splitTick: number,
  sceneDurationTicks: number
): { nodes: GraphNode[]; edges: Edge[]; newLayerId: string } | null {
  const layer = nodes.find((n) => n.id === layerId);
  if (!layer || layer.data.defType !== LAYER_TYPE) return null;

  // Active span: union of enabled clip windows, or the whole scene when
  // the layer has none.
  const enabled = (layer.data.clips ?? []).filter((c) => c.enabled);
  const inTick = enabled.length
    ? Math.min(...enabled.map((c) => c.inTick))
    : 0;
  const outTick = enabled.length
    ? Math.max(...enabled.map((c) => c.outTick))
    : sceneDurationTicks;
  const split = Math.round(splitTick);
  if (!(split > inTick && split < outTick)) return null;

  // Deep-copy the layer subtree (fresh ids, remapped interior parents +
  // zone ids). The clone sits one chain slot above the original.
  const ids = expandWithDescendants(nodes, [layerId]);
  const { nodes: clones, edges: cloneEdges, idMap } = cloneSubgraph(
    nodes.filter((n) => ids.has(n.id)),
    edges,
    { x: 0, y: -140 }
  );
  const newLayerId = idMap.get(layerId);
  if (!newLayerId) return null;

  // The clone takes over the original's outgoing connections (image to
  // Output / the layer above, audio passthrough); the original now feeds
  // the clone's stack. Net chain order: …below → original → clone → above.
  const nextEdges = edges.map((e) =>
    e.source === layerId && !ids.has(e.target)
      ? { ...e, source: newLayerId }
      : e
  );
  nextEdges.push({
    id: newEdgeId(),
    source: layerId,
    sourceHandle: "out:primary",
    target: newLayerId,
    targetHandle: "in:stack",
  });

  const setClips = (n: GraphNode, clips: ClipBlock[]): GraphNode => ({
    ...n,
    data: { ...n.data, clips },
  });

  const outNodes = [
    ...nodes.map((n) =>
      n.id === layerId
        ? setClips(n, [{ inTick, outTick: split, sourceInTick: 0, enabled: true }])
        : n
    ),
    ...clones.map((n) =>
      n.id === newLayerId
        ? setClips(n, [{ inTick: split, outTick, sourceInTick: 0, enabled: true }])
        : n
    ),
  ];
  return {
    nodes: outNodes,
    edges: [...nextEdges, ...cloneEdges],
    newLayerId,
  };
}

// Which scope the editor should open after loading a graph: inside the
// layer when there's exactly one (the common single-layer project feels
// like the pre-layers app), at root otherwise.
export function defaultScopeFor(
  nodes: GraphNode[],
  compositionId?: string
): string | undefined {
  const rootLayers = nodes.filter(
    (n) =>
      n.data.defType === LAYER_TYPE &&
      !n.data.parentId &&
      belongsToComposition(n, compositionId)
  );
  return rootLayers.length === 1 ? rootLayers[0].id : undefined;
}

// A selection plus everything nested inside any selected group, so
// copy / duplicate always travel with group interiors.
export function expandWithDescendants(
  nodes: GraphNode[],
  ids: Iterable<string>
): Set<string> {
  const set = new Set(ids);
  for (const id of collectDescendantIds(nodes, set)) set.add(id);
  return set;
}

// Clone a set of nodes plus the edges internal to that set (both
// endpoints inside), offsetting positions and remapping edge endpoints
// to the fresh ids. The set is expected to be parentId-closed (see
// expandWithDescendants) — nesting inside the set is remapped onto the
// fresh ids, so cloned group interiors point at the cloned shells.
// Top-level clones come back `selected` so the caller can swap the
// selection to the copies (interior clones stay unselected — they're
// hidden in other scopes); `retarget`, when given, moves the top-level
// clones to a different scope (paste into the scope being viewed).
//
// Simulation `zone_id`s shared by two or more cloned nodes are minted
// fresh so a duplicated Start/End pair simulates independently of the
// original. A zone with only one node in the set keeps its id — the
// clone stays paired with the original's counterpart, which is the
// only meaningful reading of duplicating half a zone.
export function cloneSubgraph(
  selection: GraphNode[],
  allEdges: Edge[],
  offset: { x: number; y: number },
  retarget?: { parentId: string | undefined }
): { nodes: GraphNode[]; edges: Edge[]; idMap: Map<string, string> } {
  const ids = new Set(selection.map((n) => n.id));
  const internalEdges = allEdges.filter(
    (e) => ids.has(e.source) && ids.has(e.target)
  );

  const zoneCounts = new Map<string, number>();
  for (const n of selection) {
    const z = n.data.params.zone_id;
    if (typeof z === "string" && z) {
      zoneCounts.set(z, (zoneCounts.get(z) ?? 0) + 1);
    }
  }
  const zoneMap = new Map<string, string>();
  for (const [z, count] of zoneCounts) {
    if (count >= 2) {
      zoneMap.set(z, `zone-${Math.random().toString(36).slice(2, 10)}`);
    }
  }

  const idMap = new Map<string, string>();
  const nodes = selection.map((n) => {
    const cloned = cloneNode(n, {
      x: n.position.x + offset.x,
      y: n.position.y + offset.y,
    });
    idMap.set(n.id, cloned.id);
    const z = cloned.data.params.zone_id;
    if (typeof z === "string" && zoneMap.has(z)) {
      cloned.data.params = { ...cloned.data.params, zone_id: zoneMap.get(z) };
    }
    return cloned;
  });
  // Second pass once the full idMap exists: remap in-set nesting, and
  // select / retarget the top-level clones.
  for (const cloned of nodes) {
    const parent = cloned.data.parentId;
    if (parent && idMap.has(parent)) {
      cloned.data.parentId = idMap.get(parent);
    } else {
      cloned.selected = true;
      if (retarget) cloned.data.parentId = retarget.parentId;
    }
    // Frame membership travels like nesting: a member cloned together with
    // its frame points at the cloned frame; a member cloned alone keeps
    // pointing at the original (the half-a-zone reading above).
    const frame = cloned.data.frameId;
    if (frame && idMap.has(frame)) {
      cloned.data.frameId = idMap.get(frame);
    }
  }
  const edges = internalEdges.map((e) => ({
    ...e,
    id: newEdgeId(),
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
  }));
  return { nodes, edges, idMap };
}
