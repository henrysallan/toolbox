// Milestone-2 proof: run the recipe graph validator against the hand-built
// PRESETS (known-good → must pass) and deliberately broken fixtures (must fail
// with the expected error code).
//
//   npx tsx scripts/check-validator.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ValNode, ValEdge } from "@/engine/graph-validation";

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
g.HTMLImageElement ??= class {};
g.HTMLVideoElement ??= class {};
g.HTMLMediaElement ??= class {};
g.Image ??= class {};
g.Audio ??= class {};
g.Path2D ??= class {};
g.OffscreenCanvas ??= class { getContext() { return null; } };
g.WebGL2RenderingContext ??= class {};
g.AudioContext ??= class {};
g.requestAnimationFrame ??= () => 0;

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { PRESETS } = await import("@/state/presets");
const { validateGraph } = await import("@/engine/graph-validation");

const adapt = (built: { nodes: any[]; edges: any[] }) => ({
  nodes: built.nodes.map((n) => ({
    id: n.id,
    defType: n.data.defType,
    params: n.data.params,
  })) as ValNode[],
  edges: built.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
  })) as ValEdge[],
});

let failures = 0;

console.log("\n=== PRESETS (expect ok=true, errors=0) ===");
for (const p of PRESETS) {
  const { nodes, edges } = adapt(p.build());
  const r = validateGraph(nodes, edges);
  const errs = r.issues.filter((i) => i.severity === "error");
  const warns = r.issues.filter((i) => i.severity === "warning");
  const ok = r.ok && errs.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${p.name.padEnd(22)} ${nodes.length} nodes, ${edges.length} edges` +
      `  — ${errs.length} err, ${warns.length} warn`
  );
  for (const e of errs) console.log(`        ERROR [${e.code}] ${e.message}`);
}

console.log("\n=== BROKEN FIXTURES (expect the named error code) ===");
type Fixture = { name: string; expect: string; nodes: ValNode[]; edges: ValEdge[] };
const N = (id: string, defType: string, params: Record<string, unknown> = {}): ValNode => ({
  id,
  defType,
  params,
});
const E = (source: string, sourceHandle: string, target: string, targetHandle: string): ValEdge => ({
  id: `${source}->${target}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

const fixtures: Fixture[] = [
  {
    name: "unknown node type",
    expect: "NODE_UNKNOWN_TYPE",
    nodes: [N("a", "this-node-does-not-exist")],
    edges: [],
  },
  {
    name: "cycle (transform↔transform)",
    expect: "GRAPH_CYCLE",
    nodes: [N("a", "transform"), N("b", "transform")],
    edges: [E("a", "out:primary", "b", "in:image"), E("b", "out:primary", "a", "in:image")],
  },
  {
    name: "unknown input handle",
    expect: "EDGE_UNKNOWN_INPUT",
    nodes: [N("a", "circle"), N("b", "circle")],
    edges: [E("a", "out:primary", "b", "in:bogus")],
  },
  {
    name: "type mismatch (image → spline path)",
    expect: "EDGE_TYPE_MISMATCH",
    nodes: [N("a", "solid-color"), N("b", "spline-stroke")],
    edges: [E("a", "out:primary", "b", "in:path")],
  },
  {
    name: "param not drivable (string→enum)",
    expect: "PARAM_NOT_DRIVABLE",
    // gradient.mode is an enum — not socket-drivable. Wire a scalar at it.
    nodes: [N("a", "scene-time"), N("b", "gradient")],
    edges: [E("a", "out:primary", "b", "in:param:mode")],
  },
];

for (const f of fixtures) {
  const r = validateGraph(f.nodes, f.edges);
  const codes = r.issues.filter((i) => i.severity === "error").map((i) => i.code);
  const got = codes.includes(f.expect);
  if (!got) failures++;
  console.log(
    `${got ? "PASS" : "FAIL"}  ${f.name.padEnd(34)} expect ${f.expect}` +
      (got ? "" : `  — got [${codes.join(", ") || "no errors"}]`)
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
