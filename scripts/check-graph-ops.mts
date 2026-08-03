// check-graph-ops: guards composition scoping in the pure structural ops
// (createLayer / reorderLayers). Before the 072226 fix these found "the" root
// Output over the WHOLE node array, so in a multi-composition project "Add
// layer" / reorder could silently rewire ANOTHER composition's Output. Each
// test puts the WRONG composition's Output FIRST in the array, so an unscoped
// regression is caught (it would pick the first one).
//
// Also covers makeSplineEditable (right-click "Make Editable" bake): edge
// migration, styling copy vs. trim non-copy, cornerRadius stripping, and
// the bypass/active/selection handoff.
//
//   npx tsx scripts/check-graph-ops.mts
/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes(); // createLayer mints nodes via the registry (makeInstanceNode)
const { createLayer, reorderLayers, makeInstanceNode, makeSplineEditable } =
  await import("@/state/graph-ops");
const { LAYER_TYPE } = await import("@/engine/groups");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const node = (id: string, defType: string, compositionId: string, extra: any = {}): any => ({
  id,
  position: { x: 0, y: 0 },
  selected: false,
  data: { defType, compositionId, ...extra },
});
const edge = (id: string, source: string, target: string, targetHandle: string): any => ({
  id,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});
const intoImageEdge = (edges: any[], source: string) =>
  edges.find((e) => e.source === source && e.targetHandle === "in:image");
const newLayerNode = (before: any[], after: any[]) => {
  const ids = new Set(before.map((n) => n.id));
  return after.find((n) => n.data.defType === LAYER_TYPE && !ids.has(n.id));
};

// --- 1. createLayer into compB wires into compB's Output (outA listed FIRST) ---
{
  const outA = node("outA", "output", "compA");
  const layA1 = node("layA1", LAYER_TYPE, "compA");
  const outB = node("outB", "output", "compB");
  const nodes = [outA, layA1, outB];
  const edges = [edge("eA", "layA1", "outA", "in:image")];

  const res = createLayer(nodes, edges, undefined, "compB");
  const nl = newLayerNode(nodes, res.nodes);
  const toOut = nl ? intoImageEdge(res.edges, nl.id) : undefined;
  check("createLayer(compB) wires into compB's Output, not the first one", toOut?.target === "outB", toOut?.target);
  check("new layer is tagged into compB", nl?.data.compositionId === "compB");
  check("compA's Output edge is untouched", res.edges.some((e) => e.id === "eA" && e.target === "outA"));
  check("compB add creates no edge into compA's Output", !res.edges.some((e) => e.target === "outA" && e.source === nl?.id));
}

// --- 2. createLayer into compA splices into compA's chain (outB listed FIRST) ---
{
  const outB = node("outB", "output", "compB");
  const outA = node("outA", "output", "compA");
  const layA1 = node("layA1", LAYER_TYPE, "compA");
  const nodes = [outB, outA, layA1];
  const edges = [edge("eA", "layA1", "outA", "in:image")];

  const res = createLayer(nodes, edges, undefined, "compA");
  const nl = newLayerNode(nodes, res.nodes);
  const toOut = nl ? intoImageEdge(res.edges, nl.id) : undefined;
  check("createLayer(compA) wires into compA's Output", toOut?.target === "outA", toOut?.target);
  check("splice removes the old top→Output edge", !res.edges.some((e) => e.id === "eA"));
  check("previous top feeds the new layer's stack", res.edges.some((e) => e.source === "layA1" && e.target === nl?.id && e.targetHandle === "in:stack"));
  check("compB's Output receives no new edge", !res.edges.some((e) => e.target === "outB"));
}

// --- 3. reorderLayers only touches the scoped composition's Output (outB FIRST) ---
{
  const outB = node("outB", "output", "compB");
  const layB1 = node("layB1", LAYER_TYPE, "compB");
  const outA = node("outA", "output", "compA");
  const layA1 = node("layA1", LAYER_TYPE, "compA");
  const layA2 = node("layA2", LAYER_TYPE, "compA");
  const nodes = [outB, layB1, outA, layA1, layA2];
  const edges = [
    edge("eB", "layB1", "outB", "in:image"),
    edge("eA", "layA2", "outA", "in:image"),
  ];

  const res = reorderLayers(nodes, edges, ["layA2", "layA1"], "compA");
  check("reorderLayers(compA) leaves compB's Output edge intact", res.edges.some((e) => e.source === "layB1" && e.target === "outB" && e.targetHandle === "in:image"));
  check("reorderLayers(compA) rewires compA's Output to the new top", res.edges.some((e) => e.source === "layA1" && e.target === "outA" && e.targetHandle === "in:image"));
  check("reorderLayers(compA) never wires a compA layer into compB's Output", !res.edges.some((e) => e.target === "outB" && (e.source === "layA1" || e.source === "layA2")));
}

// --- 4. makeSplineEditable: bake a Circle into an editable Spline Draw ---
{
  const circle = makeInstanceNode("circle", { x: 100, y: 100 }) as any;
  circle.id = "circ";
  circle.data.compositionId = "compA";
  circle.data.params.stroke_color = "#ff0000";
  circle.data.params.trim_end = 0.5; // must NOT copy — bake is post-trim
  const consumer = node("cons", "stroke", "compA", { active: true });
  consumer.selected = true;
  const fillSrc = node("fillSrc", "image-source", "compA");
  const nodes = [circle, consumer, fillSrc];
  const edges = [
    edge("eSpline", "circ", "cons", "in:spline"),
    { ...edge("eImg", "circ", "cons", "in:image"), sourceHandle: "out:aux:image" },
    { ...edge("eEl", "circ", "cons", "in:element"), sourceHandle: "out:aux:element" },
    edge("eFill", "fillSrc", "circ", "in:fill"),
  ];
  const subpaths = [
    {
      anchors: [
        { pos: [0.2, 0.2], cornerRadius: 0.05 },
        { pos: [0.8, 0.2] },
        { pos: [0.5, 0.8], inHandle: [-0.1, 0], outHandle: [0.1, 0] },
      ],
      closed: true,
    },
  ] as any;

  const res = makeSplineEditable(nodes, edges, "circ", "out:primary", subpaths);
  const draw = res?.nodes.find((n) => n.id === res.newNodeId);
  check("bake returns a Spline Draw node", draw?.data.defType === "spline-draw");
  const sp = (draw?.data.params.spline as any)?.subpaths;
  check("baked geometry copied (3 anchors, closed)", sp?.[0]?.anchors?.length === 3 && sp?.[0]?.closed === true);
  check("baked geometry is a deep copy", sp !== subpaths && sp?.[0]?.anchors?.[0] !== subpaths[0].anchors[0]);
  check("cornerRadius stripped from baked anchors", sp?.[0]?.anchors?.[0]?.cornerRadius === undefined);
  check("styling copied from the raster family", draw?.data.params.stroke_color === "#ff0000");
  check("trim params NOT copied", draw?.data.params.trim_end === 1);
  check("spline out-wire moved to the new node", !!res?.edges.some((e) => e.id === "eSpline" && e.source === draw?.id && e.sourceHandle === "out:primary"));
  check("image aux out-wire moved to the new node", !!res?.edges.some((e) => e.id === "eImg" && e.source === draw?.id && e.sourceHandle === "out:aux:image"));
  check("element aux out-wire stays on the original", !!res?.edges.some((e) => e.id === "eEl" && e.source === "circ"));
  check("fill in-wire moved to the new node", !!res?.edges.some((e) => e.id === "eFill" && e.target === draw?.id && e.targetHandle === "in:fill"));
  const orig = res?.nodes.find((n) => n.id === "circ");
  check("original is bypassed", orig?.data.bypassed === true);
  check("new node is viewport-active + selected", draw?.data.active === true && draw?.selected === true);
  check("active cleared elsewhere (exclusive)", res?.nodes.find((n) => n.id === "cons")?.data.active === false);
  check("selection cleared elsewhere", res?.nodes.find((n) => n.id === "cons")?.selected === false);
  check("composition + scope carried over", draw?.data.compositionId === "compA");
  check("non-spline handle is refused", makeSplineEditable(nodes, edges, "circ", "out:aux:image", subpaths) === null);
}

if (failures === 0) console.log("\nALL GREEN ✅");
process.exit(failures ? 1 : 0);
