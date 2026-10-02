// check-viewport-pick: the viewport pick-select walk (src/lib/viewport-pick.ts).
//
//   - hits come back topmost first: Merge's last layer before its base, a
//     Layer's content before the stack below it (through a real flatten of
//     a Layer + interior Group Output)
//   - an edge is followed only where its source covers the click: image
//     alpha at the pixel, a spline's padded bounds for spline → raster
//   - modifiers (Blur) are walked through, never credited; masks and param
//     wires are never content; a bypassed pickable is walked but not hit
//   - the pickable flag sits on the discrete on-canvas sources and not on
//     full-canvas generators or modifiers
//   - repeated clicks at one spot cycle; moving or a changed stack restarts
//
// The GPU readback and the overlay itself are live-app questions.
//
//   npx tsx scripts/check-viewport-pick.mts
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type {
  ImageValue,
  MaskValue,
  NodeOutput,
  SplineValue,
} from "@/engine/types";

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { flattenGraph } = await import("@/engine/flatten");
const { pickNodesAt, advancePickCycle } = await import("@/lib/viewport-pick");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── Fixtures ─────────────────────────────────────────────────────────
// A fake image is "opaque inside a UV box". The sampler reads the box the
// pick point falls in — the stand-in for the 1×1 GPU readback.
type Box = [number, number, number, number]; // u0, v0, u1, v1 (Y-down)
const FULL: Box = [0, 0, 1, 1];
const boxes = new Map<object, Box>();
function img(box: Box): ImageValue {
  const v = { kind: "image", width: 100, height: 100, texture: {} } as any;
  boxes.set(v, box);
  return v;
}
function mask(box: Box): MaskValue {
  const v = { kind: "mask", width: 100, height: 100, texture: {} } as any;
  boxes.set(v, box);
  return v;
}
function rectSpline(x0: number, y0: number, x1: number, y1: number): SplineValue {
  return {
    kind: "spline",
    subpaths: [
      {
        closed: true,
        anchors: [
          { pos: [x0, y0] },
          { pos: [x1, y0] },
          { pos: [x1, y1] },
          { pos: [x0, y1] },
        ],
      },
    ],
  } as SplineValue;
}

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, params: {}, ...extra };
}
function edge(source: string, target: string, targetSocket: string, sourceHandle = "out:primary"): GraphEdge {
  return {
    id: `${source}->${target}:${targetSocket}`,
    source,
    sourceHandle,
    target,
    targetHandle: `in:${targetSocket}`,
  };
}

function pick(
  nodes: GraphNode[],
  edges: GraphEdge[],
  outputs: Map<string, NodeOutput>,
  startNodeId: string,
  u: number,
  v: number
): string[] {
  const reads: object[] = [];
  const hits = pickNodesAt({
    nodes,
    edges,
    outputs,
    startNodeId,
    u,
    v,
    aspect: 1,
    isPickable: (type) => getNodeDef(type)?.pickable === true,
    sampleAlpha: (val) => {
      reads.push(val);
      const b = boxes.get(val);
      if (!b) return null;
      return u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3] ? 1 : 0;
    },
  });
  return hits;
}

// ── 1. The flag ──────────────────────────────────────────────────────
for (const t of [
  "text",
  "image-source",
  "svg-source",
  "video-source",
  "rectangle",
  "circle",
  "polygon",
  "star",
  "line",
  "spline-draw",
  "paint",
  "sdf-circle",
  "sdf-rectangle",
]) {
  check(`${t} is pickable`, getNodeDef(t)?.pickable === true);
}
for (const t of ["blur", "merge", "layer", "output", "noise", "gradient", "solid-color", "transform"]) {
  const def = getNodeDef(t);
  check(`${t} is not pickable`, !!def && def.pickable !== true, def ? undefined : "def missing");
}

// ── 2. Merge stacking: Text layer over an Image Source base ──────────
{
  const nodes = [
    node("bg", "image-source"),
    node("title", "text"),
    node("soft", "blur"),
    node("m", "merge", { params: { layers: [{ id: "L1" }] } }),
    node("out", "output"),
  ];
  const edges = [
    edge("bg", "m", "base"),
    edge("title", "soft", "image"),
    edge("soft", "m", "layer:L1"),
    edge("m", "out", "image"),
  ];
  const outputs = new Map<string, NodeOutput>([
    ["bg", { primary: img(FULL) }],
    ["title", { primary: img([0.2, 0.2, 0.4, 0.3]) }],
    // Blur spreads the text a little — its footprint covers the text's.
    ["soft", { primary: img([0.18, 0.18, 0.42, 0.32]) }],
    ["m", { primary: img(FULL) }],
  ]);
  check(
    "on the text: text first, background below, blur walked but not hit",
    same(pick(nodes, edges, outputs, "out", 0.3, 0.25), ["title", "bg"])
  );
  check(
    "off the text: background only",
    same(pick(nodes, edges, outputs, "out", 0.8, 0.8), ["bg"])
  );
  check(
    "in the blur halo but outside the text itself: text drops out",
    same(pick(nodes, edges, outputs, "out", 0.19, 0.19), ["bg"])
  );

  // Two layers: the later one composites on top, so it is hit first.
  const nodes2 = [
    ...nodes.filter((n) => n.id !== "m"),
    node("logo", "image-source"),
    node("m", "merge", { params: { layers: [{ id: "L1" }, { id: "L2" }] } }),
  ];
  const edges2 = [...edges, edge("logo", "m", "layer:L2")];
  const outputs2 = new Map(outputs);
  outputs2.set("logo", { primary: img([0.25, 0.2, 0.5, 0.5]) });
  check(
    "merge: layer 2 over layer 1 over base",
    same(pick(nodes2, edges2, outputs2, "out", 0.3, 0.25), ["logo", "title", "bg"])
  );
  // Edge order in the graph must not matter — only the layer order does.
  check(
    "merge: stacking ignores edge order",
    same(pick(nodes2, [...edges2].reverse(), outputs2, "out", 0.3, 0.25), [
      "logo",
      "title",
      "bg",
    ])
  );
}

// ── 3. Masks and params are not content; bypass is walked, not hit ───
{
  const nodes = [
    node("bg", "image-source"),
    node("matte", "circle"),
    node("amount", "rectangle"),
    node("m", "merge", { params: { layers: [{ id: "L1" }] } }),
    node("title", "text", { bypassed: true }),
    node("inner", "image-source"),
    node("out", "output"),
  ];
  const edges = [
    edge("bg", "m", "base"),
    edge("matte", "m", "mask:L1", "out:aux:image"),
    edge("matte", "m", "mask"),
    edge("amount", "m", "param:opacity", "out:aux:image"),
    edge("inner", "title", "image"),
    edge("title", "m", "layer:L1"),
    edge("m", "out", "image"),
  ];
  const outputs = new Map<string, NodeOutput>([
    ["bg", { primary: img(FULL) }],
    ["matte", { primary: rectSpline(0, 0, 1, 1), aux: { image: img(FULL) } }],
    ["amount", { primary: rectSpline(0, 0, 1, 1), aux: { image: img(FULL) } }],
    ["inner", { primary: img(FULL) }],
    ["title", { primary: img(FULL) }],
    ["m", { primary: img(FULL) }],
  ]);
  check(
    "mask / param wires never credit; bypassed text passes through to its input",
    same(pick(nodes, edges, outputs, "out", 0.5, 0.5), ["inner", "bg"])
  );
}

// ── 4. Shape primitives: bundled aux image, and spline → raster ─────
{
  const nodes = [
    node("box", "rectangle"),
    node("ring", "circle"),
    node("stroke", "stroke"),
    node("m", "merge", { params: { layers: [{ id: "L1" }] } }),
    node("out", "output"),
  ];
  const edges = [
    edge("box", "m", "base", "out:aux:image"),
    edge("ring", "stroke", "spline"),
    edge("stroke", "m", "layer:L1"),
    edge("m", "out", "image"),
  ];
  const outputs = new Map<string, NodeOutput>([
    ["box", { primary: rectSpline(0.1, 0.1, 0.5, 0.5), aux: { image: img([0.1, 0.1, 0.5, 0.5]) } }],
    ["ring", { primary: rectSpline(0.6, 0.6, 0.9, 0.9) }],
    // Stroke output: pretend it draws the ring's outline plus a stray
    // mark far from it (a second spline source would be credited there).
    ["stroke", { primary: img([0.55, 0.55, 0.95, 0.95]) }],
    ["m", { primary: img(FULL) }],
  ]);
  check(
    "rectangle via its aux:image",
    same(pick(nodes, edges, outputs, "out", 0.3, 0.3), ["box"])
  );
  check(
    "circle via stroke: inside the spline's padded bounds",
    same(pick(nodes, edges, outputs, "out", 0.75, 0.75), ["ring"])
  );
  // Ring bounds 0.6..0.9 padded by 0.03 → 0.57..0.93; (0.94, 0.56) is on
  // the stroke raster but outside them.
  check(
    "stroke pixel outside the spline's padded bounds: circle not credited",
    same(pick(nodes, edges, outputs, "out", 0.94, 0.56), [])
  );
  const farOutputs = new Map(outputs);
  farOutputs.set("stroke", { primary: img(FULL) });
  check(
    "stroke covers everywhere, click far from the circle: no hit",
    same(pick(nodes, edges, farOutputs, "out", 0.2, 0.9), [])
  );
}

// ── 5. Layers through a real flatten: content over stack ─────────────
{
  // root: layerB (stack ← layerA) → Output. Each layer's interior is one
  // pickable node wired into its Group Output's image socket.
  const raw: GraphNode[] = [
    node("layerA", "layer"),
    node("a", "image-source", { parentId: "layerA" }),
    node("aOut", "group-output", { parentId: "layerA" }),
    node("layerB", "layer"),
    node("b", "text", { parentId: "layerB" }),
    node("bOut", "group-output", { parentId: "layerB" }),
    node("out", "output"),
  ];
  const rawEdges: GraphEdge[] = [
    edge("a", "aOut", "image"),
    edge("b", "bOut", "image"),
    edge("layerA", "layerB", "stack"),
    edge("layerB", "out", "image"),
  ];
  const flat = flattenGraph(raw, rawEdges);
  check(
    "flatten wires interior results into the layers' content",
    flat.edges.some((e) => e.source === "b" && e.target === "layerB" && e.targetHandle === "in:content")
  );
  const outputs = new Map<string, NodeOutput>([
    ["a", { primary: img(FULL) }],
    ["b", { primary: img([0.4, 0.4, 0.6, 0.6]) }],
    ["layerA", { primary: img(FULL) }],
    ["layerB", { primary: img(FULL) }],
  ]);
  check(
    "upper layer's content first, then the layer below",
    same(pick(flat.nodes, flat.edges, outputs, "out", 0.5, 0.5), ["b", "a"])
  );
  check(
    "outside the upper layer's content: only the lower layer",
    same(pick(flat.nodes, flat.edges, outputs, "out", 0.1, 0.1), ["a"])
  );
}

// ── 6. Active node on its own: the start node itself is a hit ────────
{
  const nodes = [node("title", "text")];
  const outputs = new Map<string, NodeOutput>([["title", { primary: img(FULL) }]]);
  check("start node that is pickable is hit", same(pick(nodes, [], outputs, "title", 0.5, 0.5), ["title"]));

  // A mask-valued output on a content socket reads its coverage (R).
  const mNodes = [node("paint", "paint"), node("out", "output")];
  const mEdges = [edge("paint", "out", "image")];
  const mOutputs = new Map<string, NodeOutput>([
    ["paint", { primary: mask([0, 0, 0.5, 1]) }],
  ]);
  check(
    "mask-valued content: hit inside its coverage, not outside",
    same(pick(mNodes, mEdges, mOutputs, "out", 0.25, 0.5), ["paint"]) &&
      same(pick(mNodes, mEdges, mOutputs, "out", 0.75, 0.5), [])
  );
}

// ── 7. Cycling ───────────────────────────────────────────────────────
{
  const hits = ["a", "b", "c"];
  let c = advancePickCycle(null, 100, 100, hits);
  check("first click: topmost", c?.index === 0);
  c = advancePickCycle(c, 101, 102, hits);
  check("click again nearby: next", c?.index === 1);
  c = advancePickCycle(c, 100, 100, hits);
  c = advancePickCycle(c, 100, 100, hits);
  check("wraps back to the top", c?.index === 0);
  c = advancePickCycle(c, 100, 100, hits);
  c = advancePickCycle(c, 160, 100, hits);
  check("moving away restarts at the top", c?.index === 0);
  c = advancePickCycle(c, 160, 100, ["a", "c"]);
  check("a changed stack restarts at the top", c?.index === 0);
  check("no hits: no cycle", advancePickCycle(c, 160, 100, []) === null);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall viewport-pick checks passed");
