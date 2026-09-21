// check-svg-export-stash: guards the contract the SVG export button relies
// on — the `svg-export:<id>` stash in ctx.state is written by whichever node
// COMPUTES for a given surface, and the exporter can force that node into
// the pass (evaluateGraph's extraTargets) when the live needed set would
// skip it.
//
// The failure mode this catches shipped as "Nothing to export — wire a
// spline into Layer Output" on a wired Layer Output: the stash lives under
// the enclosing LAYER's id (flatten pushes the Layer Output's `spline` tap
// onto the layer shell's hidden input, and layer.compute stashes it), so
// any pass in which the layer shell doesn't compute — an Active node inside
// the layer, or the offline exporter's forced terminal on the Layer Output,
// which remaps to the interior image producer — leaves the stash empty even
// though the wire is there. EffectsApp's exportSvgNode now renders with the
// stash owner in extraTargets; this pins the evaluator side of that.
//
//   npx tsx scripts/check-svg-export-stash.mts
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

const { registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { resolvePreviewProducer } = await import("@/engine/flatten");
const { layerNode } = await import("@/nodes/group/layer");
const { groupOutputNode } = await import("@/nodes/group/group-output");
const { groupInputNode } = await import("@/nodes/group/group-input");
const { outputNode } = await import("@/nodes/output/output");
const { svgExportNode, svgExportStashKey } = await import("@/nodes/output/svg-export");
const { LAYER_INPUT_SOCKETS, LAYER_OUTPUT_SOCKETS } = await import("@/engine/groups");
import type { SvgExportStash } from "@/nodes/output/svg-export";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
  );
}

registerNode(layerNode);
registerNode(groupOutputNode);
registerNode(groupInputNode);
registerNode(outputNode);
registerNode(svgExportNode);

// GL-free producers. The spline source's subpath count is switchable so the
// "honestly empty" case can be told apart from "never computed".
let splineSubpaths = 1;
registerNode({
  type: "test-spline-src",
  name: "Spline src",
  category: "spline",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "spline",
  compute() {
    const anchor = (x: number) => ({ pos: [x, x], inHandle: null, outHandle: null });
    return {
      primary: {
        kind: "spline",
        subpaths: Array.from({ length: splineSubpaths }, () => ({
          anchors: [anchor(0.1), anchor(0.9)],
          closed: false,
        })),
      },
    };
  },
} as any);
registerNode({
  type: "test-img-src",
  name: "Image src",
  category: "source",
  backend: "webgl2",
  inputs: [],
  params: [],
  primaryOutput: "image",
  compute({ ctx }: any) {
    return { primary: ctx.allocImage() };
  },
} as any);

const ctx = {
  gl: {},
  width: 16,
  height: 9,
  time: 0,
  frame: 0,
  tick: 0,
  ticksPerFrame: 1000,
  fps: 30,
  playing: false,
  offline: true,
  cursor: { x: 0, y: 0, active: false },
  state: {} as Record<string, unknown>,
  allocImage: () => ({ kind: "image", texture: {}, width: 16, height: 9 }),
  allocMask: () => ({ kind: "mask", texture: {}, width: 16, height: 9 }),
  allocUv: () => ({ kind: "uv", texture: {}, width: 16, height: 9 }),
  releaseTexture: () => {},
  drawFullscreen: () => {},
  clearTarget: () => {},
  getShader: () => ({}),
} as any;

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }) as any;

// A root Output fed by one layer whose interior holds an image source (the
// layer's content) and a spline source wired into the Layer Output's tap.
function layerGraph(layerExtra: Record<string, unknown> = {}) {
  const nodes: any[] = [
    { id: "L", type: "layer", params: {}, ...layerExtra },
    { id: "LI", type: "group-input", params: { sockets: [...LAYER_INPUT_SOCKETS], reserved: ["backdrop"] }, parentId: "L" },
    { id: "LO", type: "group-output", params: { sockets: [...LAYER_OUTPUT_SOCKETS], fixed: true }, parentId: "L" },
    { id: "S", type: "test-spline-src", params: {}, parentId: "L" },
    { id: "C", type: "test-img-src", params: {}, parentId: "L" },
    { id: "O", type: "output", params: {} },
  ];
  const edges = [
    edge("S", "out:primary", "LO", "in:spline"),
    edge("C", "out:primary", "LO", "in:image"),
    edge("L", "out:primary", "O", "in:image"),
  ];
  return { nodes, edges };
}

function stashOf(id: string): SvgExportStash | undefined {
  return ctx.state[svgExportStashKey(id)] as SvgExportStash | undefined;
}

function evalWith(
  graph: { nodes: any[]; edges: any[] },
  active: string | null,
  opts?: { extraTargets?: string[] }
) {
  ctx.state = {};
  evaluateGraph(graph.nodes, graph.edges, ctx, new Map(), active, undefined, null, opts);
}

// --- Layer Output: the stash lives under the LAYER's id -------------------
{
  const graph = layerGraph();
  evalWith(graph, null);
  check("layer: plain pass (Output terminal) stashes under the layer id", !!stashOf("L"), true);
  check("layer: nothing is stashed under the Layer Output's own id", stashOf("LO"), undefined);
  check("layer: stash carries the tap's subpaths", stashOf("L")?.subpaths.length, 1);
  check("layer: stash records the canvas size", `${stashOf("L")?.width}x${stashOf("L")?.height}`, "16x9");

  // The forced-terminal path the offline exporters use for a Layer Output:
  // it remaps to the interior image producer, so the shell never computes.
  const remap = resolvePreviewProducer(graph.nodes, graph.edges, "LO");
  check("layer: a Layer Output terminal remaps to the interior image producer", remap?.nodeId, "C");
  evalWith(graph, "LO");
  check("layer: forced terminal on the Layer Output alone leaves NO stash (the bug)", stashOf("L"), undefined);
  evalWith(graph, "C");
  check("layer: an Active interior node alone leaves NO stash (the bug)", stashOf("L"), undefined);

  // The fix: force the stash owner via extraTargets.
  evalWith(graph, "LO", { extraTargets: ["L"] });
  check("layer: forced terminal + extraTargets [layer] stashes", stashOf("L")?.subpaths.length, 1);
  evalWith(graph, "C", { extraTargets: ["L"] });
  check("layer: Active interior node + extraTargets [layer] stashes", stashOf("L")?.subpaths.length, 1);

  // Honest misses the exporter must still report: bypass, clip gating, an
  // empty spline. None of these can be rescued by forcing.
  evalWith(layerGraph({ bypassed: true }), null, { extraTargets: ["L"] });
  check("layer: a bypassed layer stashes nothing even when forced", stashOf("L"), undefined);
  evalWith(
    layerGraph({ clips: [{ inTick: 5000, outTick: 9000, sourceInTick: 0, enabled: true }] }),
    null,
    { extraTargets: ["L"] }
  );
  check("layer: a clip-gated layer stashes nothing even when forced", stashOf("L"), undefined);
  evalWith(
    layerGraph({ clips: [{ inTick: 0, outTick: 9000, sourceInTick: 0, enabled: true }] }),
    null,
    { extraTargets: ["L"] }
  );
  check("layer: inside its clip window the layer stashes", stashOf("L")?.subpaths.length, 1);
  splineSubpaths = 0;
  evalWith(graph, null, { extraTargets: ["L"] });
  check("layer: an empty spline clears the stash", stashOf("L"), undefined);
  splineSubpaths = 1;

  // A stale stash must not survive a bypass: the exporter would otherwise
  // hand back the previous frame's path for a layer that isn't rendering.
  // (Known gap — bypass skips compute, so the stale key lingers until the
  // exporter's own forced pass; documented here, asserted as current
  // behavior so a fix flips it deliberately.)
  const bypassed = layerGraph({ bypassed: true });
  ctx.state = { [svgExportStashKey("L")]: { subpaths: [{ anchors: [], closed: false }], width: 1, height: 1 } };
  evaluateGraph(bypassed.nodes, bypassed.edges, ctx, new Map(), null, undefined, null, { extraTargets: ["L"] });
  check("layer: (current) a pre-existing stash outlives a bypass pass", !!stashOf("L"), true);
}

// --- Output: its own compute stashes under its own id ---------------------
{
  const nodes: any[] = [
    { id: "S", type: "test-spline-src", params: {} },
    { id: "C", type: "test-img-src", params: {} },
    { id: "X", type: "test-img-src", params: {} },
    { id: "O", type: "output", params: {} },
  ];
  const edges = [edge("S", "out:primary", "O", "in:spline"), edge("C", "out:primary", "O", "in:image")];
  const graph = { nodes, edges };
  evalWith(graph, null);
  check("output: plain pass stashes under the Output id", stashOf("O")?.subpaths.length, 1);
  // An unrelated Active node narrows the pass to its branch — Output is out.
  evalWith(graph, "X");
  check("output: an unrelated Active node starves the Output (the bug)", stashOf("O"), undefined);
  evalWith(graph, "X", { extraTargets: ["O"] });
  check("output: extraTargets [Output] restores the stash under an Active node", stashOf("O")?.subpaths.length, 1);
}

// --- SVG Export node: terminal, stashes under its own id ------------------
{
  const nodes: any[] = [
    { id: "S", type: "test-spline-src", params: {} },
    { id: "X", type: "test-img-src", params: {} },
    { id: "E", type: "svg-export", params: {} },
  ];
  const edges = [edge("S", "out:primary", "E", "in:path")];
  const graph = { nodes, edges };
  evalWith(graph, null);
  check("svg-export: plain pass stashes under the node id", stashOf("E")?.subpaths.length, 1);
  evalWith(graph, "X");
  check("svg-export: an unrelated Active node starves it (the bug)", stashOf("E"), undefined);
  evalWith(graph, "X", { extraTargets: ["E"] });
  check("svg-export: extraTargets [node] restores the stash", stashOf("E")?.subpaths.length, 1);
}

console.log(
  failures === 0
    ? "\nall svg-export-stash checks passed"
    : `\n${failures} svg-export-stash check(s) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
