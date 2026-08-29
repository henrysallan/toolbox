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
const { editorCanCoerce, validateGraph } = await import("@/engine/graph-validation");
const { accumulatorDomainForSource, collectModeForSource } = await import(
  "@/engine/graph-helpers"
);
const { getNodeDef } = await import("@/engine/registry");
const { readCollectSlots, nextCollectSlot, COLLECT_MAX_SLOTS } = await import(
  "@/nodes/effect/collect"
);

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

console.log("\n=== COMBINE (collect) AUTOCOERCE / SLOTS ===");
{
  const ok = (label: string, pass: boolean, detail?: string) => {
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  ok(
    "spline → image-mode Combine slot",
    editorCanCoerce("spline", "image", "collect", "in:a")
  );
  ok(
    "points → image-mode Combine slot",
    editorCanCoerce("points", "image", "collect", "in:b")
  );
  ok(
    "geometry → image-mode Combine slot",
    editorCanCoerce("geometry", "image", "collect", "in:a")
  );
  ok(
    "object3d → spline-mode Combine slot",
    editorCanCoerce("object3d", "spline", "collect", "in:a")
  );
  ok(
    "scalar cannot land on Combine's mask (slot exception must not leak)",
    !editorCanCoerce("scalar", "mask", "collect", "in:mask")
  );
  ok(
    "scalar still cannot land on a Combine slot",
    !editorCanCoerce("scalar", "image", "collect", "in:a")
  );
  ok(
    "load-alias `group` gets the same exception",
    editorCanCoerce("spline", "image", "group", "in:a")
  );
  ok("collectModeForSource(spline)", collectModeForSource("spline") === "spline");
  ok("collectModeForSource(geometry)", collectModeForSource("geometry") === "object");
  ok("collectModeForSource(scalar)", collectModeForSource("scalar") === null);

  ok(
    "readCollectSlots default (count=2)",
    readCollectSlots({ count: 2 }).join(",") === "a,b"
  );
  ok(
    "readCollectSlots from count=4",
    readCollectSlots({ count: 4 }).join(",") === "a,b,c,d"
  );
  ok(
    "readCollectSlots prefers slots over count",
    readCollectSlots({ count: 4, slots: ["a", "x"] }).join(",") === "a,x"
  );
  ok(
    "nextCollectSlot skips taken letters",
    nextCollectSlot(new Set(["a", "b"])) === "c"
  );
  ok("COLLECT_MAX_SLOTS is 26", COLLECT_MAX_SLOTS === 26);

  const def = getNodeDef("collect");
  const inputsFromSlots = def?.resolveInputs?.({
    mode: "spline",
    slots: ["a", "b", "c"],
  });
  ok(
    "resolveInputs slots are spline-typed",
    !!inputsFromSlots &&
      inputsFromSlots.length === 3 &&
      inputsFromSlots.every((i) => i.type === "spline") &&
      inputsFromSlots.map((i) => i.name).join(",") === "a,b,c"
  );

  const r = validateGraph(
    [
      N("c", "circle"),
      N("g", "collect", { mode: "spline", count: 2 }),
    ],
    [E("c", "out:primary", "g", "in:a")]
  );
  ok(
    "validator accepts spline → Combine (mode already spline)",
    r.ok,
    r.issues.map((i) => i.code).join(",")
  );
}

console.log("\n=== ACCUMULATOR AUTOCOERCE ===");
{
  const ok = (label: string, pass: boolean, detail?: string) => {
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  ok(
    "points → scalar-resting Accumulator input",
    editorCanCoerce("points", "scalar", "accumulator", "in:input")
  );
  ok(
    "spline → scalar-resting Accumulator input",
    editorCanCoerce("spline", "scalar", "accumulator", "in:input")
  );
  ok(
    "vec2 → scalar-resting Accumulator input",
    editorCanCoerce("vec2", "scalar", "accumulator", "in:input")
  );
  ok(
    "object3d cannot land on Accumulator input",
    !editorCanCoerce("object3d", "scalar", "accumulator", "in:input")
  );
  ok(
    "reset socket stays scalar (exception does not leak)",
    !editorCanCoerce("points", "scalar", "accumulator", "in:reset")
  );
  ok(
    "accumulatorDomainForSource(points)",
    accumulatorDomainForSource("points") === "points"
  );
  ok(
    "accumulatorDomainForSource(image)",
    accumulatorDomainForSource("image") === null
  );

  const r = validateGraph(
    [N("s", "scatter-points"), N("a", "accumulator")],
    [E("s", "out:primary", "a", "in:input")]
  );
  ok(
    "validator accepts scatter → Accumulator (type still scalar)",
    r.ok,
    r.issues.map((i) => `${i.code}:${i.message}`).join(",")
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
