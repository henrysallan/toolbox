// Presets: canned subgraphs, authored already-grouped, inserted from the
// add menu's "Presets" category. A preset's build() returns a fragment with
// TEMPLATE ids; EffectsApp's onAddNode runs it through `cloneSubgraph`,
// which mints fresh ids, remaps edges + interior parentId, and retargets
// the group shell into the current scope (auto-wrapping into a layer at
// root) — the exact paste path. So a preset is purely an insertion-time
// concept: once dropped it's an ordinary node-group that serializes and
// loads through the normal path. No schema or engine changes.
//
// Authoring note: presets are built programmatically here (typechecked)
// rather than hand-written JSON. The `groupFragment` helper assembles the
// node-group + boundary nodes the same way graph-ops' groupSelection does,
// so the result is structurally identical to a group the user would make
// with Cmd+G. Param promotion (surfacing interior knobs on the group node)
// is a follow-up — today a dropped preset exposes its OUTPUT sockets and is
// tuned by diving in (Tab).

import type { Edge } from "@xyflow/react";
import type { SocketType } from "@/engine/types";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
} from "@/engine/groups";
import {
  makeInstanceNode,
  newEdgeId,
  refreshNodeSockets,
  syncGroupInterface,
  type GraphNode,
} from "@/state/graph-ops";

export interface PresetDef {
  id: string;
  name: string;
  description: string;
  build: () => { nodes: GraphNode[]; edges: Edge[] };
}

interface GroupOutputSpec {
  // Interior endpoint feeding the group's output socket.
  from: { nodeId: string; handle: string };
  name: string;
  type: SocketType;
}

// Build an edge between two fragment nodes (raw handle ids).
function edge(
  a: GraphNode,
  sourceHandle: string,
  b: GraphNode,
  targetHandle: string
): Edge {
  return { id: newEdgeId(), source: a.id, sourceHandle, target: b.id, targetHandle };
}

// Wrap interior nodes in a node-group shell + Group Input / Group Output
// boundary nodes, with the interior wired to the Group Output's sockets.
// Mirrors groupSelection's structure but for a standalone generator group
// (no exterior edges) whose outputs the user wires after dropping it in.
// The shell's parentId is left undefined so cloneSubgraph treats it as the
// single top-level node and retargets it into the insertion scope.
function groupFragment(opts: {
  name: string;
  interior: GraphNode[];
  edges: Edge[];
  outputs: GroupOutputSpec[];
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
  // Generator group: no external inputs; outputs are the terminal sockets.
  groupInput.data.params = { sockets: [] };
  groupOutput.data.params = {
    sockets: opts.outputs.map((o) => ({ name: o.name, type: o.type })),
  };

  for (const n of opts.interior) n.data.parentId = group.id;

  const edges: Edge[] = [
    ...opts.edges,
    ...opts.outputs.map((o) => ({
      id: newEdgeId(),
      source: o.from.nodeId,
      sourceHandle: o.from.handle,
      target: groupOutput.id,
      targetHandle: `in:${o.name}`,
    })),
  ];

  // syncGroupInterface writes the {inputs, outputs} interface onto the
  // shell from the boundary sockets and refreshes its socket caches, so the
  // dropped group renders its output handles ready to wire.
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

// Make an interior node with overridden params, then refresh its socket
// caches so mode-dependent sockets (Array point mode, Copy to Points spline
// mode, Collect spline mode) carry the right types/handles immediately
// rather than the def-default ones.
function node(
  type: string,
  pos: { x: number; y: number },
  params?: Record<string, unknown>
): GraphNode {
  const n = makeInstanceNode(type, pos);
  if (params) n.data.params = { ...n.data.params, ...params };
  return refreshNodeSockets(n);
}

// Common ending: composite a list of spline producers with Collect, then
// rasterize. Returns the collect + render nodes, their edges, and the two
// group outputs (image + the combined spline).
function splineRenderTail(opts: {
  layers: { nodeId: string }[]; // spline producers, in draw order
  render: "stroke" | "fill";
  renderParams?: Record<string, unknown>;
  at: { x: number; y: number };
}): {
  nodes: GraphNode[];
  edges: Edge[];
  outputs: GroupOutputSpec[];
} {
  const collect = node("collect", opts.at, {
    mode: "spline",
    count: opts.layers.length,
  });
  const renderType = opts.render === "fill" ? "spline-fill" : "spline-stroke";
  const render = node(
    renderType,
    { x: opts.at.x + 240, y: opts.at.y },
    opts.renderParams
  );
  const edges: Edge[] = [
    ...opts.layers.map((l, i) => ({
      id: newEdgeId(),
      source: l.nodeId,
      sourceHandle: "out:primary",
      // Collect inputs are a, b, c, … in order.
      target: collect.id,
      targetHandle: `in:${String.fromCharCode(97 + i)}`,
    })),
    {
      id: newEdgeId(),
      source: collect.id,
      sourceHandle: "out:primary",
      target: render.id,
      targetHandle: "in:path",
    },
  ];
  return {
    nodes: [collect, render],
    edges,
    outputs: [
      { from: { nodeId: render.id, handle: "out:primary" }, name: "image", type: "image" },
      { from: { nodeId: collect.id, handle: "out:primary" }, name: "spline", type: "spline" },
    ],
  };
}

// --- Cover · Envelope --------------------------------------------------
// Times-table string art: points evenly around a circle → connect i→(i·k)
// with the String Art primitive → stroke. Outputs image + chord spline.
function buildEnvelope(): { nodes: GraphNode[]; edges: Edge[] } {
  const circle = node("circle", { x: 0, y: 0 });
  const pop = node("points-on-path", { x: 240, y: 0 }, { count: 160, show_viz: false });
  const sa = node("string-art", { x: 480, y: 0 }, { k: 2 });
  const stroke = node("spline-stroke", { x: 720, y: 0 }, { thickness: 1 });

  return groupFragment({
    name: "Cover · Envelope",
    interior: [circle, pop, sa, stroke],
    edges: [
      edge(circle, "out:primary", pop, "in:path"),
      edge(pop, "out:primary", sa, "in:points"),
      edge(sa, "out:primary", stroke, "in:path"),
    ],
    outputs: [
      { from: { nodeId: stroke.id, handle: "out:primary" }, name: "image", type: "image" },
      { from: { nodeId: sa.id, handle: "out:primary" }, name: "spline", type: "spline" },
    ],
  });
}

// --- Cover · Diffraction ----------------------------------------------
// A regular point lattice (Point → Array grid) whose dot sizes are
// modulated by a concentric-ring field (Gradient wave/ring) fed into
// Copy to Points' scale_field, then filled. Reciprocal-space look.
function buildDiffraction(): { nodes: GraphNode[]; edges: Edge[] } {
  const pt = node("point", { x: -200, y: -100 });
  const arr = node("array", { x: 40, y: -100 }, {
    mode: "point",
    countX: 22,
    countY: 22,
  });
  const field = node("gradient", { x: -200, y: 140 }, {
    mode: "wave",
    wave_mode: "ring",
  });
  const dot = node("circle", { x: 40, y: 140 }, { radiusX: 0.013, radiusY: 0.013 });
  const ctp = node("copy-to-points", { x: 320, y: 0 }, {
    mode: "spline",
    scale_field_lo: 0.1,
    scale_field_hi: 2.6,
  });
  const fillN = node("spline-fill", { x: 600, y: 0 }, { color: "#000000" });

  return groupFragment({
    name: "Cover · Diffraction",
    interior: [pt, arr, field, dot, ctp, fillN],
    edges: [
      edge(pt, "out:primary", arr, "in:instance"),
      edge(arr, "out:primary", ctp, "in:points"),
      edge(dot, "out:primary", ctp, "in:instance"),
      edge(field, "out:primary", ctp, "in:scale_field"),
      edge(ctp, "out:primary", fillN, "in:path"),
    ],
    outputs: [
      { from: { nodeId: fillN.id, handle: "out:primary" }, name: "image", type: "image" },
      { from: { nodeId: ctp.id, handle: "out:primary" }, name: "spline", type: "spline" },
    ],
  });
}

// --- Cover · Inters Grid ----------------------------------------------
// Scattered overlapping circles + a regular grid of small square nodes,
// composited as one spline and stroked.
function buildIntersGrid(): { nodes: GraphNode[]; edges: Edge[] } {
  const scatter = node("scatter-points", { x: -220, y: -120 }, {
    count: 7,
    seed: 3,
    scale: 1,
    scale_jitter: 0.5,
  });
  const circle = node("circle", { x: -220, y: 60 }, { radiusX: 0.16, radiusY: 0.16 });
  const ctpC = node("copy-to-points", { x: 60, y: -40 }, { mode: "spline" });

  const pt = node("point", { x: -220, y: 220 });
  const grid = node("array", { x: -20, y: 220 }, {
    mode: "point",
    countX: 10,
    countY: 10,
  });
  const sq = node("rectangle", { x: -220, y: 340 }, { width: 0.02, height: 0.02 });
  const ctpG = node("copy-to-points", { x: 120, y: 260 }, { mode: "spline" });

  const tail = splineRenderTail({
    layers: [{ nodeId: ctpC.id }, { nodeId: ctpG.id }],
    render: "stroke",
    renderParams: { thickness: 1.2 },
    at: { x: 400, y: 80 },
  });

  return groupFragment({
    name: "Cover · Inters Grid",
    interior: [scatter, circle, ctpC, pt, grid, sq, ctpG, ...tail.nodes],
    edges: [
      edge(scatter, "out:primary", ctpC, "in:points"),
      edge(circle, "out:primary", ctpC, "in:instance"),
      edge(pt, "out:primary", grid, "in:instance"),
      edge(grid, "out:primary", ctpG, "in:points"),
      edge(sq, "out:primary", ctpG, "in:instance"),
      ...tail.edges,
    ],
    outputs: tail.outputs,
  });
}

// --- Cover · Rectilinear ----------------------------------------------
// Scattered squares + nodes marked at every edge/line crossing (Spline
// Intersections primitive), composited and stroked.
function buildRectilinear(): { nodes: GraphNode[]; edges: Edge[] } {
  const scatter = node("scatter-points", { x: -220, y: -80 }, {
    count: 4,
    seed: 2,
    scale: 1,
    scale_jitter: 0.5,
  });
  const rect = node("rectangle", { x: -220, y: 100 }, { width: 0.34, height: 0.34 });
  const ctpR = node("copy-to-points", { x: 60, y: 0 }, { mode: "spline" });
  const xings = node("spline-intersections", { x: 300, y: 60 });
  const marker = node("rectangle", { x: 300, y: 220 }, { width: 0.02, height: 0.02 });
  const ctpM = node("copy-to-points", { x: 540, y: 120 }, { mode: "spline" });

  const tail = splineRenderTail({
    layers: [{ nodeId: ctpR.id }, { nodeId: ctpM.id }],
    render: "stroke",
    renderParams: { thickness: 1 },
    at: { x: 820, y: 40 },
  });

  return groupFragment({
    name: "Cover · Rectilinear",
    interior: [scatter, rect, ctpR, xings, marker, ctpM, ...tail.nodes],
    edges: [
      edge(scatter, "out:primary", ctpR, "in:points"),
      edge(rect, "out:primary", ctpR, "in:instance"),
      edge(ctpR, "out:primary", xings, "in:spline"),
      edge(xings, "out:primary", ctpM, "in:points"),
      edge(marker, "out:primary", ctpM, "in:instance"),
      ...tail.edges,
    ],
    outputs: tail.outputs,
  });
}

// --- Cover · Intersected ----------------------------------------------
// Overlapping circles (vesica / flower-of-life family) with square nodes
// marked at every circle crossing (Spline Intersections primitive).
function buildIntersected(): { nodes: GraphNode[]; edges: Edge[] } {
  const scatter = node("scatter-points", { x: -220, y: -80 }, {
    count: 6,
    seed: 5,
    scale: 1,
    scale_jitter: 0.5,
  });
  const circle = node("circle", { x: -220, y: 100 }, { radiusX: 0.2, radiusY: 0.2 });
  const ctpC = node("copy-to-points", { x: 60, y: 0 }, { mode: "spline" });
  const xings = node("spline-intersections", { x: 300, y: 60 });
  const marker = node("rectangle", { x: 300, y: 220 }, { width: 0.018, height: 0.018 });
  const ctpM = node("copy-to-points", { x: 540, y: 120 }, { mode: "spline" });

  const tail = splineRenderTail({
    layers: [{ nodeId: ctpC.id }, { nodeId: ctpM.id }],
    render: "stroke",
    renderParams: { thickness: 1.2 },
    at: { x: 820, y: 40 },
  });

  return groupFragment({
    name: "Cover · Intersected",
    interior: [scatter, circle, ctpC, xings, marker, ctpM, ...tail.nodes],
    edges: [
      edge(scatter, "out:primary", ctpC, "in:points"),
      edge(circle, "out:primary", ctpC, "in:instance"),
      edge(ctpC, "out:primary", xings, "in:spline"),
      edge(xings, "out:primary", ctpM, "in:points"),
      edge(marker, "out:primary", ctpM, "in:instance"),
      ...tail.edges,
    ],
    outputs: tail.outputs,
  });
}

export const PRESETS: PresetDef[] = [
  {
    id: "cover-envelope",
    name: "Cover · Envelope",
    description:
      "Times-table string art around a circle (String Art primitive), stroked. Outputs image + chord spline; dive in (Tab) to tune k / point count.",
    build: buildEnvelope,
  },
  {
    id: "cover-diffraction",
    name: "Cover · Diffraction",
    description:
      "Point lattice (Array grid) with dot sizes modulated by a concentric-ring gradient field. Outputs image + dot spline.",
    build: buildDiffraction,
  },
  {
    id: "cover-inters-grid",
    name: "Cover · Inters Grid",
    description:
      "Scattered overlapping circles plus a regular grid of square nodes. Outputs image + combined spline.",
    build: buildIntersGrid,
  },
  {
    id: "cover-rectilinear",
    name: "Cover · Rectilinear",
    description:
      "Scattered squares with nodes marked at every crossing (Spline Intersections primitive). Outputs image + combined spline.",
    build: buildRectilinear,
  },
  {
    id: "cover-intersected",
    name: "Cover · Intersected",
    description:
      "Overlapping circles with square nodes at every circle crossing (Spline Intersections primitive). Outputs image + combined spline.",
    build: buildIntersected,
  },
];

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}
