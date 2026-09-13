// Structural graph mutations, as pure functions over (nodes, edges)
// arrays. This module is the home for everything that creates, clones,
// or rewires nodes outside of React state plumbing — EffectsApp calls
// in here and applies the results via its setters. Group / layer /
// chain operations (specdocs/archive/layers-groups-attributes.md) land here;
// new structural logic must not be added to EffectsApp directly.

import type { Edge, Node } from "@xyflow/react";
import { getNodeDef } from "@/engine/registry";
import { withMaskInput } from "@/engine/conventions";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  FOREACH_INPUT_SOCKETS,
  FOREACH_INPUT_TYPE,
  FOREACH_TYPE,
  ITERATE_INPUT_SOCKETS,
  ITERATE_INPUT_TYPE,
  ITERATE_TYPE,
  LAYER_INPUT_SOCKETS,
  LAYER_OUTPUT_SOCKETS,
  LAYER_TYPE,
  REPEAT_INPUT_SOCKETS,
  REPEAT_INPUT_TYPE,
  REPEAT_TYPE,
  VIRTUAL_SOCKET,
  isFixedBoundary,
  isGroupInputWidgetType,
  isZoneInput,
  isZoneShell,
  readBoundarySockets,
  readGroupInterface,
  readInputValues,
  groupInputControlDef,
  groupInputControlFromType,
  pruneInputValues,
  readReservedSockets,
  resolveOutputBoundarySockets,
  withInputValues,
  zoneInputTypeForShell,
  type GroupInterface,
  type GroupSocketSpec,
} from "@/engine/groups";
import {
  channelParamDef,
  channelRangeOverride,
  findExprChannel,
  setExprChannelValue,
} from "@/engine/expr-channels";
import {
  accumulatorDomainForSource,
  COLLECT_TYPE,
  collectModeForSource,
  combineSelectionMode,
  FRAME_TYPE,
  isAccumulatorInputHandle,
  isCollectSlotHandle,
  isCollectType,
  paramSocketType,
  parseTargetHandleKind,
  REROUTE_TYPE,
} from "@/engine/graph-helpers";
import { EXPORT_PARAMS } from "@/nodes/output/output";
import {
  COLLECT_MAX_SLOTS,
  nextCollectSlot,
} from "@/nodes/effect/collect";
import type {
  ParamDef,
  ParamType,
  ResolveCtx,
  SocketType,
  SplineSubpath,
} from "@/engine/types";
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

// Widget-backed group/layer input, looked up by the exposed socket label
// (or the interior param name when that uniquely matches). Flatten copies
// `inputValues[socketName]` onto the interior consumer, so this is the
// value that actually wins at eval — the same knob the param panel shows
// on the shell.
export interface GroupShellControl {
  socketName: string;
  controlDef: ParamDef;
  value: unknown;
  consumerNodeId: string;
  // Interior param name when the socket feeds `in:param:`; null for a
  // data socket (GLSL channel, Math `a`, …).
  consumerParam: string | null;
  // Interior input socket name when the socket feeds `in:` (not param).
  consumerInput?: string;
  rangeOverride?: { min?: number; max?: number; softMax?: number };
}

function groupInputOf(shellId: string, nodes: GraphNode[]): GraphNode | undefined {
  return nodes.find(
    (n) => n.data.parentId === shellId && n.data.defType === GROUP_INPUT_TYPE
  );
}

function channelRowForSocket(
  node: GraphNode,
  socketName: string
) {
  const def = getNodeDef(node.data.defType);
  if (!def) return undefined;
  return (
    findExprChannel(def, node.data.params, socketName) ??
    (socketName.startsWith("in:")
      ? findExprChannel(def, node.data.params, socketName.slice(3))
      : undefined)
  );
}

function seedFromConsumerSocket(
  target: GraphNode,
  parsed: { kind: string; name: string }
): unknown {
  if (parsed.kind === "param") return target.data.params[parsed.name];
  if (parsed.kind !== "input") return undefined;
  const row = channelRowForSocket(target, parsed.name);
  return row?.default;
}

function controlForGroupSocket(
  sock: { name: string; type: string },
  groupInput: GraphNode,
  nodes: GraphNode[],
  edges: Edge[]
): Omit<GroupShellControl, "value"> | null {
  const fromGi = edges.filter(
    (e) =>
      e.source === groupInput.id && e.sourceHandle === `out:aux:${sock.name}`
  );
  const paramEdge = fromGi.find((e) => e.targetHandle?.startsWith("in:param:"));
  if (paramEdge) {
    const deep = nodes.find((n) => n.id === paramEdge.target);
    const paramName = paramEdge.targetHandle!.slice("in:param:".length);
    const pdef = deep
      ? getNodeDef(deep.data.defType)?.params.find((p) => p.name === paramName)
      : undefined;
    if (!deep || !pdef) return null;
    const controlDef = groupInputControlDef(
      sock.name,
      sock.type as SocketType,
      pdef
    );
    if (!controlDef) return null;
    return {
      socketName: sock.name,
      controlDef,
      consumerNodeId: deep.id,
      consumerParam: paramName,
    };
  }
  if (!isGroupInputWidgetType(sock.type)) return null;
  const dataEdge = fromGi.find((e) => {
    const parsed = parseTargetHandleKind(e.targetHandle ?? "");
    return parsed?.kind === "input";
  });
  if (!dataEdge) return null;
  const deep = nodes.find((n) => n.id === dataEdge.target);
  if (!deep) return null;
  const parsed = parseTargetHandleKind(dataEdge.targetHandle ?? "");
  const row = parsed ? channelRowForSocket(deep, parsed.name) : undefined;
  if (row) {
    const pdef = channelParamDef(row);
    const range = channelRangeOverride(row);
    if (range?.min !== undefined) pdef.min = range.min;
    if (range?.max !== undefined) pdef.max = range.max;
    if (range?.softMax !== undefined) pdef.softMax = range.softMax;
    const controlDef = groupInputControlDef(
      sock.name,
      sock.type as SocketType,
      pdef
    );
    if (!controlDef) return null;
    return {
      socketName: sock.name,
      controlDef,
      consumerNodeId: deep.id,
      consumerParam: null,
      consumerInput: parsed?.name,
      rangeOverride: range,
    };
  }
  const controlDef = groupInputControlFromType(
    sock.name,
    sock.type as SocketType
  );
  if (!controlDef) return null;
  return {
    socketName: sock.name,
    controlDef,
    consumerNodeId: deep.id,
    consumerParam: null,
    consumerInput: parsed?.name,
  };
}

function effectiveShellValue(
  shell: GraphNode,
  socketName: string,
  consumerNodeId: string,
  consumerParam: string | null,
  consumerInput: string | undefined,
  nodes: GraphNode[],
  fallback: unknown
): unknown {
  const stored = readInputValues(shell.data.params);
  if (socketName in stored) return stored[socketName];
  const consumer = nodes.find((n) => n.id === consumerNodeId);
  if (consumer && consumerParam && consumer.data.params[consumerParam] !== undefined) {
    return consumer.data.params[consumerParam];
  }
  if (consumer && consumerInput) {
    const row = channelRowForSocket(consumer, consumerInput);
    if (row && row.default !== undefined) return row.default;
  }
  return fallback;
}

/** Every widget-backed promoted input on a group/layer shell, with the value the panel would show. */
export function listGroupShellControls(
  shell: GraphNode,
  nodes: GraphNode[],
  edges: Edge[]
): GroupShellControl[] {
  const groupInput = groupInputOf(shell.id, nodes);
  if (!groupInput) return [];
  const reserved = new Set(readReservedSockets(groupInput.data.params));
  const out: GroupShellControl[] = [];
  for (const sock of readBoundarySockets(groupInput.data.params)) {
    if (reserved.has(sock.name)) continue;
    const ctrl = controlForGroupSocket(sock, groupInput, nodes, edges);
    if (!ctrl) continue;
    out.push({
      ...ctrl,
      value: effectiveShellValue(
        shell,
        ctrl.socketName,
        ctrl.consumerNodeId,
        ctrl.consumerParam,
        ctrl.consumerInput,
        nodes,
        ctrl.controlDef.default
      ),
    });
  }
  return out;
}

/** Resolve one promoted input by exposed label, then by unique interior param name. */
export function resolveGroupShellControl(
  shell: GraphNode,
  param: string,
  nodes: GraphNode[],
  edges: Edge[]
): GroupShellControl | null {
  const listed = listGroupShellControls(shell, nodes, edges);
  const byLabel = listed.find((c) => c.socketName === param);
  if (byLabel) return byLabel;
  const byParam = listed.filter((c) => c.consumerParam === param);
  return byParam.length === 1 ? byParam[0] : null;
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

// Right-click → "Combine Nodes" on a multi-selection whose primary outputs
// share a Collect family (image/mask/element, spline, points, or
// object3d/geometry/instances). Spawns a Combine node to the right of the
// selection, sizes its slots to the sources plus one spare, and wires each
// source's primary output in left-to-right (then top-to-bottom) order.
// Existing downstream wires are left alone. Returns null when the selection
// isn't combinable.
export function combineSelection(
  nodes: GraphNode[],
  edges: Edge[],
  selectedIds: Iterable<string>
): { nodes: GraphNode[]; edges: Edge[]; combineId: string } | null {
  const wanted = new Set(selectedIds);
  const sources = nodes
    .filter((n) => wanted.has(n.id))
    .sort(
      (a, b) => a.position.x - b.position.x || a.position.y - b.position.y
    );
  const mode = combineSelectionMode(sources.map((n) => n.data.primaryOutput));
  if (!mode) return null;

  const wired = sources.slice(0, COLLECT_MAX_SLOTS);
  const taken = new Set<string>();
  const slotNames: string[] = [];
  for (let i = 0; i < wired.length; i++) {
    const name = nextCollectSlot(taken);
    slotNames.push(name);
    taken.add(name);
  }
  const slots =
    wired.length >= COLLECT_MAX_SLOTS
      ? slotNames
      : [...slotNames, nextCollectSlot(taken)];

  const rightEdge = Math.max(...wired.map((n) => n.position.x));
  const avgY =
    wired.reduce((s, n) => s + n.position.y, 0) / wired.length;
  const combine = makeInstanceNode(COLLECT_TYPE, {
    x: rightEdge + 360,
    y: avgY,
  });
  combine.data.params = {
    ...combine.data.params,
    mode,
    slots,
    count: wired.length,
  };
  const refreshed = refreshNodeSockets(combine);
  refreshed.data.parentId = wired[0].data.parentId;
  refreshed.data.compositionId = wired[0].data.compositionId;
  refreshed.selected = true;

  const newEdges: Edge[] = wired.map((src, i) => ({
    id: newEdgeId(),
    source: src.id,
    sourceHandle: "out:primary",
    target: refreshed.id,
    targetHandle: `in:${slotNames[i]}`,
  }));

  const outNodes = nodes.map((n) =>
    n.selected ? { ...n, selected: false } : n
  );
  outNodes.push(refreshed);
  return {
    nodes: outNodes,
    edges: [...edges, ...newEdges],
    combineId: refreshed.id,
  };
}

// Insert reroute nodes onto existing edges — the Shift-drag / double-click-a-
// wire gesture (specdocs/archive/071326_reroute-node.md). The listed edges are grouped
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
// riskfix-plan 070826 §5). Pass `ctx` when the caller already knows the
// live connectedTypes (incoming-wire promotion); omit it from the
// param-panel path, which must not overwrite connectedTypes-retyping
// nodes — EffectsApp skips those entirely.
export function withUpdatedParams(
  n: GraphNode,
  nextParams: Record<string, unknown>,
  ctx?: ResolveCtx
): GraphNode {
  return refreshNodeSockets(
    {
      ...n,
      data: { ...n.data, params: nextParams },
    },
    ctx
  );
}

// Recompute a node's cached socket arrays (data.inputs / auxOutputs /
// primaryOutput) from its def resolvers and current params. Call after
// any params change made outside the param-panel path, which keeps
// these caches fresh on its own. Optional `ctx` threads connectedTypes
// so polymorphic nodes (Transform, Switch, …) retype in the same pass.
export function refreshNodeSockets(n: GraphNode, ctx?: ResolveCtx): GraphNode {
  const def = getNodeDef(n.data.defType);
  if (!def) return n;
  const resolved = withMaskInput(
    def.resolveInputs?.(n.data.params, ctx) ?? def.inputs,
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
        def.resolvePrimaryOutput?.(n.data.params, ctx) ?? def.primaryOutput,
    },
  };
}

const COPY_INSTANCE_TYPE_TO_MODE: Record<string, string> = {
  image: "image",
  image_group: "image",
  spline: "spline",
  points: "point",
  text_instance: "text",
};

// Live connectedTypes map for one consumer: every currently-wired input,
// plus an optional extra that hasn't landed in `edges` yet (the wire
// about to be added). An existing edge on the extra's handle is skipped
// so a replacement wire types the socket, not the wire it displaces.
export function connectedTypesFromEdges(
  nodeId: string,
  nodes: GraphNode[],
  edges: Edge[],
  extra?: { targetHandle: string; srcType: SocketType }
): Record<string, SocketType | undefined> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ct: Record<string, SocketType | undefined> = {};
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    if (extra && e.targetHandle === extra.targetHandle) continue;
    const tp = parseTargetHandleKind(e.targetHandle ?? "");
    if (tp?.kind !== "input") continue;
    const src = byId.get(e.source);
    if (!src) continue;
    let t: string | null | undefined;
    if (e.sourceHandle === "out:primary") t = src.data.primaryOutput;
    else if (e.sourceHandle?.startsWith("out:aux:")) {
      const an = e.sourceHandle.slice("out:aux:".length);
      t = src.data.auxOutputs.find((a) => a.name === an)?.type;
    }
    if (t) ct[tp.name] = t as SocketType;
  }
  if (extra) {
    const tp = parseTargetHandleKind(extra.targetHandle);
    if (tp?.kind === "input") ct[tp.name] = extra.srcType;
  }
  return ct;
}

// Flip mode params (Math UV, Copy-to-Points instance, Combine type) and
// re-resolve sockets with the prospective connectedTypes so an incoming
// wire autocoerces the target in the same pass — used by the add-menu
// into-target path, which cannot go through onConnect (the producer
// isn't in nodesRef yet).
export function applyIncomingWireToTarget(
  target: GraphNode,
  targetHandle: string,
  srcType: string,
  connectedTypes: Record<string, SocketType | undefined>
): GraphNode {
  let params = target.data.params;
  const parsed = parseTargetHandleKind(targetHandle);
  const isInput = parsed?.kind === "input";

  if (
    isInput &&
    target.data.defType === "math" &&
    srcType === "uv" &&
    params.mode === "scalar"
  ) {
    params = { ...params, mode: "uv" };
  }

  if (
    isInput &&
    target.data.defType === "copy-to-points" &&
    targetHandle === "in:instance"
  ) {
    const mode = COPY_INSTANCE_TYPE_TO_MODE[srcType];
    if (mode && params.mode !== mode) params = { ...params, mode };
  }

  if (
    isInput &&
    isCollectType(target.data.defType) &&
    isCollectSlotHandle(targetHandle)
  ) {
    const mode = collectModeForSource(srcType);
    if (mode && params.mode !== mode) params = { ...params, mode };
  }

  if (
    isInput &&
    target.data.defType === "accumulator" &&
    isAccumulatorInputHandle(targetHandle)
  ) {
    const domain = accumulatorDomainForSource(srcType);
    if (domain && params.type !== domain) params = { ...params, type: domain };
  }

  const next =
    params === target.data.params
      ? target
      : { ...target, data: { ...target.data, params } };
  return refreshNodeSockets(next, { connectedTypes });
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
  const isZone = isZoneShell(
    nodes.find((n) => n.id === groupId)?.data.defType
  );
  const inputType = zoneInputTypeForShell(
    nodes.find((n) => n.id === groupId)?.data.defType ?? ""
  );
  const groupInput = nodes.find(
    (n) =>
      n.data.parentId === groupId &&
      n.data.defType === (isZone ? inputType : GROUP_INPUT_TYPE)
  );
  const groupOutput = isZone
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
          (s) => !isZone || !reserved.has(s.name)
        )
      : [],
    outputs: groupOutput ? readBoundarySockets(groupOutput.data.params) : [],
  };
  const liveNames = new Set(iface.inputs.map((s) => s.name));
  return nodes.map((n) => {
    if (n.id !== groupId) return n;
    const params = pruneInputValues(
      { ...n.data.params, interface: iface },
      liveNames
    );
    return refreshNodeSockets({
      ...n,
      data: { ...n.data, params },
    });
  });
}

// Fill `inputValues` keys that a promote/mint path forgot, using the
// interior consumer's current value — never the widget type-default (0
// for a bare scalar socket). Flatten copies these onto the consumer, so
// a missing key that later gets written as 0 silently shadows a 0.3
// constant. Call after any mutation that adds a group input.
export function seedMissingGroupInputValues(
  nodes: GraphNode[],
  edges: Edge[],
  groupId: string
): GraphNode[] {
  const shell = nodes.find((n) => n.id === groupId);
  const gi = groupInputOf(groupId, nodes);
  if (!shell || !gi) return nodes;
  const stored = readInputValues(shell.data.params);
  const next = { ...stored };
  let added = false;
  for (const sock of readBoundarySockets(gi.data.params)) {
    if (sock.name in next) continue;
    const promote = edges.find(
      (e) =>
        e.source === gi.id && e.sourceHandle === `out:aux:${sock.name}`
    );
    if (!promote) continue;
    const parsed = parseTargetHandleKind(promote.targetHandle ?? "");
    const target = nodes.find((n) => n.id === promote.target);
    if (!parsed || !target) continue;
    const seed = seedFromConsumerSocket(target, parsed);
    if (seed === undefined) continue;
    next[sock.name] = seed;
    added = true;
  }
  if (!added) return nodes;
  return nodes.map((n) =>
    n.id === groupId
      ? { ...n, data: { ...n.data, params: withInputValues(n.data.params, next) } }
      : n
  );
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
  const inputValues: Record<string, unknown> = {};
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
      if (parsed && target) {
        const seed = seedFromConsumerSocket(target, parsed);
        if (seed !== undefined && !(spec.name in inputValues)) {
          inputValues[spec.name] = seed;
        }
      }
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
  if (Object.keys(inputValues).length > 0) {
    group.data.params = withInputValues(group.data.params, inputValues);
  }

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

function writeShellValueToConsumers(
  nodes: GraphNode[],
  edges: Edge[],
  boundaryId: string,
  socketName: string,
  value: unknown
): GraphNode[] {
  const paramsByNode = new Map<string, string[]>();
  const channelByNode = new Map<string, string[]>();
  for (const e of edges) {
    if (
      e.source !== boundaryId ||
      e.sourceHandle !== `out:aux:${socketName}`
    ) {
      continue;
    }
    const parsed = parseTargetHandleKind(e.targetHandle ?? "");
    if (!parsed) continue;
    if (parsed.kind === "param") {
      const list = paramsByNode.get(e.target);
      if (list) list.push(parsed.name);
      else paramsByNode.set(e.target, [parsed.name]);
    } else if (parsed.kind === "input") {
      const list = channelByNode.get(e.target);
      if (list) list.push(parsed.name);
      else channelByNode.set(e.target, [parsed.name]);
    }
  }
  if (paramsByNode.size === 0 && channelByNode.size === 0) return nodes;
  return nodes.map((n) => {
    const names = paramsByNode.get(n.id);
    const channels = channelByNode.get(n.id);
    if (!names && !channels) return n;
    let params = { ...n.data.params };
    if (names) {
      for (const p of names) params[p] = value;
    }
    if (channels) {
      const def = getNodeDef(n.data.defType);
      if (def) {
        for (const sock of channels) {
          const row = channelRowForSocket(n, sock);
          if (!row) continue;
          const next = setExprChannelValue(def, params, row.name, value);
          if (next.ok) params = next.params;
        }
      }
    }
    return { ...n, data: { ...n.data, params } };
  });
}

function patchShellInputValues(
  nodes: GraphNode[],
  groupId: string | undefined,
  mut: (iv: Record<string, unknown>) => Record<string, unknown>
): GraphNode[] {
  if (!groupId) return nodes;
  return nodes.map((n) => {
    if (n.id !== groupId) return n;
    const prev = readInputValues(n.data.params);
    const next = mut(prev);
    if (next === prev) return n;
    const params = withInputValues(n.data.params, next);
    if (params === n.data.params) return n;
    return { ...n, data: { ...n.data, params } };
  });
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
    isZoneShell(target.data.defType) &&
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
    isZoneInput(target.data.defType) &&
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
      isZoneInput(source.data.defType)) &&
    conn.sourceHandle === `out:aux:${VIRTUAL_SOCKET}`
  ) {
    const parsed = parseTargetHandleKind(conn.targetHandle ?? "");
    if (!parsed) return null;
    const type = targetSocketType(target, conn.targetHandle ?? "");
    // Don't invent an `image` socket when the far end isn't a real input —
    // that used to let recipe add_edge store a dead `__virtual__` edge.
    if (type == null && parsed.kind !== "param") return null;
    const sockType = (type ?? "image") as SocketType;
    const used = new Set(
      readBoundarySockets(source.data.params).map((s) => s.name)
    );
    // Channel sockets are named `in:<id>` with label = the ch() name;
    // mint the group input after the label so the interface reads `ink`.
    const base =
      parsed.kind === "input"
        ? target.data.inputs.find((i) => i.name === parsed.name)?.label ||
          parsed.name
        : parsed.name;
    const name = uniqueSocketName(base, used);
    const sockets = [
      ...readBoundarySockets(source.data.params),
      { name, type: sockType },
    ];
    let nextNodes = applyBoundarySockets(nodes, source, sockets);
    // Promoted params and widget-typed data sockets (channels): seed the
    // shell's inputValues from the interior node's current value so flatten
    // can substitute it as the unwired default without mutating the interior.
    if (source.data.parentId) {
      const seed = seedFromConsumerSocket(target, parsed);
      if (seed !== undefined) {
        nextNodes = patchShellInputValues(
          nextNodes,
          source.data.parentId,
          (iv) => (name in iv ? iv : { ...iv, [name]: seed })
        );
      }
    }
    return {
      nodes: nextNodes,
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
    nodes: applyBoundarySockets(
      patchShellInputValues(nodes, groupId, (iv) => {
        if (!(oldName in iv)) return iv;
        const next = { ...iv, [newName]: iv[oldName] };
        delete next[oldName];
        return next;
      }),
      boundary,
      nextSockets
    ),
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
  // Write the group knob back onto interior param consumers before
  // dropping it. Unexpose used to delete only the named key and leave
  // the interior at its authored default — re-expose then seeded that
  // default, and any leftover keys were easy to re-bind by position.
  let nextNodes = nodes;
  if (isInput && groupId) {
    const stored = readInputValues(
      nodes.find((n) => n.id === groupId)?.data.params ?? {}
    );
    if (name in stored) {
      nextNodes = writeShellValueToConsumers(
        nextNodes,
        edges,
        boundaryId,
        name,
        stored[name]
      );
    }
  }
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
    nodes: patchShellInputValues(
      applyBoundarySockets(
        nextNodes,
        boundary,
        sockets.filter((s) => s.name !== name)
      ),
      groupId,
      (iv) => {
        if (!(name in iv)) return iv;
        const next = { ...iv };
        delete next[name];
        return next;
      }
    ),
    edges: nextEdges,
  };
}

// Reorder a socket on a Group Input / Group Output node. Handles are
// name-addressed, so edges on both faces of the boundary follow the
// socket without rewriting. Reserved sockets (a layer's `backdrop`)
// can't be the item being moved; they can still be the drop target,
// which lets a user socket slide past them. Fixed boundaries refuse.
export function reorderGroupSockets(
  nodes: GraphNode[],
  edges: Edge[],
  boundaryId: string,
  fromName: string,
  toName: string
): { nodes: GraphNode[]; edges: Edge[] } | null {
  if (fromName === toName) return null;
  const boundary = nodes.find((n) => n.id === boundaryId);
  if (!boundary) return null;
  const kind = boundary.data.defType;
  if (kind !== GROUP_INPUT_TYPE && kind !== GROUP_OUTPUT_TYPE) return null;
  if (isFixedBoundary(boundary.data.params)) return null;
  if (readReservedSockets(boundary.data.params).includes(fromName)) return null;
  const sockets = readBoundarySockets(boundary.data.params);
  const fromIndex = sockets.findIndex((s) => s.name === fromName);
  const toIndex = sockets.findIndex((s) => s.name === toName);
  if (fromIndex < 0 || toIndex < 0) return null;
  const nextSockets = [...sockets];
  const [moved] = nextSockets.splice(fromIndex, 1);
  nextSockets.splice(toIndex, 0, moved);
  return {
    nodes: applyBoundarySockets(nodes, boundary, nextSockets),
    edges,
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
    sShell &&
    isZoneShell(sShell.data.defType) &&
    target.id !== sShell.id &&
    target.data.parentId === sShell.data.parentId &&
    !isZoneInput(source.data.defType)
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
  if (!shell || !isZoneShell(shell.data.defType)) return null;
  const scope = shell.data.parentId;
  const root = byId.get(rootId);
  if (!root || root.data.parentId !== scope) return null;

  const UNABSORBABLE = new Set<string>([
    LAYER_TYPE,
    ITERATE_TYPE,
    ITERATE_INPUT_TYPE,
    REPEAT_TYPE,
    REPEAT_INPUT_TYPE,
    FOREACH_TYPE,
    FOREACH_INPUT_TYPE,
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
    isZoneInput(t)
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

export function makeRepeatNodes(position: { x: number; y: number }): {
  repeat: GraphNode;
  repeatInput: GraphNode;
} {
  const repeat = makeInstanceNode(REPEAT_TYPE, {
    x: position.x + 840,
    y: position.y,
  });
  const repeatInput = makeInstanceNode(REPEAT_INPUT_TYPE, position);
  repeatInput.data.parentId = repeat.id;
  repeatInput.data.params = {
    ...repeatInput.data.params,
    sockets: [...REPEAT_INPUT_SOCKETS],
    reserved: REPEAT_INPUT_SOCKETS.map((s) => s.name),
  };
  repeat.data.params = {
    ...repeat.data.params,
    sockets: [],
    interface: { inputs: [], outputs: [] } satisfies GroupInterface,
  };
  return {
    repeat: refreshNodeSockets(repeat),
    repeatInput: refreshNodeSockets(repeatInput),
  };
}

export function makeForEachNodes(position: { x: number; y: number }): {
  foreach: GraphNode;
  foreachInput: GraphNode;
} {
  const foreach = makeInstanceNode(FOREACH_TYPE, {
    x: position.x + 840,
    y: position.y,
  });
  const foreachInput = makeInstanceNode(FOREACH_INPUT_TYPE, position);
  foreachInput.data.parentId = foreach.id;
  foreachInput.data.params = {
    ...foreachInput.data.params,
    sockets: [...FOREACH_INPUT_SOCKETS],
    reserved: FOREACH_INPUT_SOCKETS.map((s) => s.name),
  };
  foreach.data.params = {
    ...foreach.data.params,
    sockets: [],
    interface: { inputs: [], outputs: [] } satisfies GroupInterface,
  };
  return {
    foreach: refreshNodeSockets(foreach),
    foreachInput: refreshNodeSockets(foreachInput),
  };
}

// Recipe / edit-group edges name collect, passthrough, and group-boundary
// sockets that the live editor would mint by wiring the virtual port.
// Create the named socket if it is missing so a RecipeGraph can use
// "<id>:in:spline" / "<gi>:aux:ink" without a prior UI gesture. No-op
// when the handle is already present (or is `__virtual__` — that path
// goes through connectToVirtualSocket so no edge ever lands on the
// virtual name).
export function mintZoneEdgeSockets(
  nodes: GraphNode[],
  source: GraphNode,
  sourceHandle: string,
  target: GraphNode,
  targetHandle: string
): GraphNode[] {
  if (
    target.data.defType === FOREACH_TYPE &&
    targetHandle === "in:geometry"
  ) {
    const t = sourceSocketType(source, sourceHandle);
    if (t === "points" || t === "spline") {
      return applyForeachGeometryType(nodes, target.id, t);
    }
    return nodes;
  }

  const srcType = (sourceSocketType(source, sourceHandle) ??
    "image") as SocketType;
  let next = nodes;

  const mintOn = (
    nodeId: string,
    name: string,
    type: SocketType,
    skipReserved: boolean
  ) => {
    const boundary = next.find((n) => n.id === nodeId);
    if (!boundary) return;
    if (skipReserved) {
      const reserved = new Set(readReservedSockets(boundary.data.params));
      if (reserved.has(name)) return;
    }
    if (isFixedBoundary(boundary.data.params)) return;
    const sockets = readBoundarySockets(boundary.data.params);
    if (sockets.some((s) => s.name === name)) return;
    next = applyBoundarySockets(next, boundary, [...sockets, { name, type }]);
  };

  if (
    isZoneShell(target.data.defType) &&
    targetHandle.startsWith("in:") &&
    !targetHandle.startsWith("in:param:")
  ) {
    const name = targetHandle.slice("in:".length);
    if (name && name !== VIRTUAL_SOCKET) mintOn(target.id, name, srcType, false);
  }

  if (
    isZoneInput(target.data.defType) &&
    targetHandle.startsWith("in:") &&
    !targetHandle.startsWith("in:param:")
  ) {
    const name = targetHandle.slice("in:".length);
    if (name && name !== VIRTUAL_SOCKET) mintOn(target.id, name, srcType, true);
  }

  if (
    isZoneInput(source.data.defType) &&
    sourceHandle.startsWith("out:aux:")
  ) {
    const name = sourceHandle.slice("out:aux:".length);
    const tgtType = (targetSocketType(target, targetHandle) ??
      srcType) as SocketType;
    if (name && name !== VIRTUAL_SOCKET) {
      mintOn(source.id, name, tgtType, true);
    }
  }

  // Group Input / Group Output: the same named-socket mint the editor
  // does when wiring the virtual port. Recipe add_edge can then say
  // `gi:aux:ink → pex:in:ink` without a prior UI gesture (and without
  // leaving a dead edge on `__virtual__`).
  if (
    source.data.defType === GROUP_INPUT_TYPE &&
    sourceHandle.startsWith("out:aux:")
  ) {
    const name = sourceHandle.slice("out:aux:".length);
    const tgtType = (targetSocketType(target, targetHandle) ??
      srcType) as SocketType;
    if (name && name !== VIRTUAL_SOCKET) {
      mintOn(source.id, name, tgtType, true);
    }
  }

  if (
    target.data.defType === GROUP_OUTPUT_TYPE &&
    targetHandle.startsWith("in:") &&
    !targetHandle.startsWith("in:param:")
  ) {
    const name = targetHandle.slice("in:".length);
    if (name && name !== VIRTUAL_SOCKET) mintOn(target.id, name, srcType, false);
  }

  return next;
}

export function applyForeachGeometryType(
  nodes: GraphNode[],
  shellId: string,
  srcType: string
): GraphNode[] {
  const domain = srcType === "points" ? "points" : "subpaths";
  const elementType = domain === "points" ? "points" : "spline";
  return nodes.map((n) => {
    if (n.id === shellId) {
      return refreshNodeSockets({
        ...n,
        data: { ...n.data, params: { ...n.data.params, domain } },
      });
    }
    if (
      n.data.defType === FOREACH_INPUT_TYPE &&
      n.data.parentId === shellId
    ) {
      const sockets = readBoundarySockets(n.data.params).map((s) =>
        s.name === "element" ? { ...s, type: elementType } : s
      );
      return refreshNodeSockets({
        ...n,
        data: {
          ...n.data,
          params: { ...n.data.params, domain, sockets },
        },
      });
    }
    return n;
  });
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

// Where insert_recipe / commitRecipeFragment should parent the new group.
// `requested` is the tool's `scope` argument:
//   omit     → current editor scope (or a new layer if there isn't one)
//   "root"   → wrap in a fresh composition layer
//   "parent" → the current scope's parent (sibling of the group you're in)
//   an id    → that layer / node-group / Repeat / For Each
// `parentId: null` means "wrap in a new layer".
export function resolveInsertParent(
  requested: string | undefined,
  currentScopeId: string | undefined,
  nodes: GraphNode[]
): { ok: true; parentId: string | null } | { ok: false; reason: string } {
  const req = requested?.trim() || undefined;
  const current = currentScopeId
    ? nodes.find((n) => n.id === currentScopeId)
    : undefined;

  const asParent = (
    id: string | undefined
  ): { ok: true; parentId: string | null } | { ok: false; reason: string } => {
    if (!id) return { ok: true, parentId: null };
    const node = nodes.find((n) => n.id === id);
    if (!node) {
      return { ok: false, reason: `scope "${id}" is not a node in the graph.` };
    }
    const t = node.data.defType;
    if (t !== GROUP_TYPE && t !== LAYER_TYPE && !isZoneShell(t)) {
      return {
        ok: false,
        reason: `scope "${id}" is a ${t} — pass a layer, node-group, Repeat/For Each id, "parent", or "root".`,
      };
    }
    return { ok: true, parentId: id };
  };

  if (req === "root") return { ok: true, parentId: null };
  if (req === "parent") return asParent(current?.data.parentId);
  if (req) return asParent(req);
  if (current) return { ok: true, parentId: current.id };
  return { ok: true, parentId: null };
}

// Wire a node-group's aux outputs into the enclosing layer/group's Output
// boundary. Used by insert_recipe so a group dropped into an empty layer
// actually renders (groups have no primary — the image lives on aux:<name>).
// Occupied sockets are left alone unless `replaceOccupied` is set, in which
// case the existing wire is dropped and the new group takes the socket.
export function connectGroupToEmptyScopeOutput(
  nodes: GraphNode[],
  edges: Edge[],
  groupId: string,
  scopeId: string,
  opts?: { replaceOccupied?: boolean }
): {
  edges: Edge[];
  wired: { from: string; to: string }[];
  skippedOccupied: { socket: string }[];
} {
  const group = nodes.find((n) => n.id === groupId);
  const output = nodes.find(
    (n) =>
      n.data.parentId === scopeId && n.data.defType === GROUP_OUTPUT_TYPE
  );
  if (!group || group.data.defType !== GROUP_TYPE || !output) {
    return { edges, wired: [], skippedOccupied: [] };
  }
  const groupOuts = readGroupInterface(group.data.params).outputs;
  if (groupOuts.length === 0) return { edges, wired: [], skippedOccupied: [] };
  const scopeSocks = resolveOutputBoundarySockets(output.data.params).filter(
    (s) => s.name !== VIRTUAL_SOCKET
  );
  let next = [...edges];
  const wired: { from: string; to: string }[] = [];
  const skippedOccupied: { socket: string }[] = [];
  const replace = opts?.replaceOccupied === true;
  for (const sock of scopeSocks) {
    const occupied = next.some(
      (e) => e.target === output.id && e.targetHandle === `in:${sock.name}`
    );
    const named = groupOuts.find(
      (o) => o.name === sock.name && o.type === sock.type
    );
    const pick = named ?? groupOuts.find((o) => o.type === sock.type);
    if (!pick) continue;
    if (occupied) {
      if (!replace) {
        skippedOccupied.push({ socket: sock.name });
        continue;
      }
      next = next.filter(
        (e) => !(e.target === output.id && e.targetHandle === `in:${sock.name}`)
      );
    }
    next.push({
      id: newEdgeId(),
      source: groupId,
      sourceHandle: `out:aux:${pick.name}`,
      target: output.id,
      targetHandle: `in:${sock.name}`,
    });
    wired.push({
      from: `${groupId}:aux:${pick.name}`,
      to: `${output.id}:in:${sock.name}`,
    });
  }
  return { edges: next, wired, skippedOccupied };
}

// Fresh-project scaffold: Output + "Layer 1" with only Group Input /
// Group Output inside. The editor opens inside the layer so a new
// project is a blank in→out graph.
export function buildStarterGraph(): {
  nodes: GraphNode[];
  edges: Edge[];
  layerId: string;
  compositionId: string;
} {
  // Tag the empty graph into one fresh composition so a brand-new
  // project carries stable composition ids before its first save (v5).
  const compositionId = newCompositionId();
  const empty = buildEmptyComposition(compositionId);
  return { ...empty, compositionId };
}

// --- compositions (v5) ------------------------------------------------------

// Build the graph for a brand-new composition: an Output fed by one
// empty "Layer 1" (Group Input / Group Output only). Same shape as
// buildStarterGraph. All nodes are tagged into the given composition id.
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
// specdocs/archive/062926_compositions-and-project-view.md.
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
