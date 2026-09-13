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
const { accumulatorDomainForSource, collectModeForSource, nextSwitchSlot, readSwitchSlots, walkToCamera3DNode } = await import(
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
    name: "group :out has no primary",
    expect: "EDGE_UNKNOWN_OUTPUT",
    nodes: [
      N("g", "node-group", {
        interface: { inputs: [], outputs: [{ name: "image", type: "image" }] },
      }),
      N("t", "transform"),
    ],
    edges: [E("g", "out:primary", "t", "in:image")],
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

{
  const r = validateGraph(
    [
      N("g", "node-group", {
        interface: { inputs: [], outputs: [{ name: "image", type: "image" }] },
      }),
      N("t", "transform"),
    ],
    [E("g", "out:primary", "t", "in:image")]
  );
  const msg = r.issues.find((i) => i.code === "EDGE_UNKNOWN_OUTPUT")?.message ?? "";
  const ok = msg.includes("did you mean aux:image");
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  group :out hint                  expect aux:image` +
      (ok ? "" : `  — got ${JSON.stringify(msg)}`)
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
    "accumulatorDomainForSource(spline)",
    accumulatorDomainForSource("spline") === "spline"
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

console.log("\n=== 3D POINTS (scatter grid / mesh-to-points) ===");
{
  const ok = (label: string, pass: boolean, detail?: string) => {
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  ok(
    "object3d → 3D Scatter source (resting geometry)",
    editorCanCoerce("object3d", "geometry", "scatter-points-3d", "in:source")
  );
  ok(
    "object3d → Mesh to Points source (resting geometry)",
    editorCanCoerce("object3d", "geometry", "mesh-to-points-3d", "in:source")
  );
  const grid = validateGraph(
    [N("s", "scatter-points-3d", { mode: "grid" })],
    []
  );
  ok(
    "scatter grid mode has no required source",
    grid.ok && !grid.issues.some((i) => i.code === "REQUIRED_INPUT_UNWIRED"),
    grid.issues.map((i) => i.code).join(",")
  );
  const surface = validateGraph([N("s", "scatter-points-3d", { mode: "surface" })], []);
  ok(
    "scatter surface mode still warns on unwired source",
    surface.issues.some((i) => i.code === "REQUIRED_INPUT_UNWIRED")
  );
  const def = getNodeDef("mesh-to-points-3d");
  ok("mesh-to-points-3d is registered", def?.type === "mesh-to-points-3d");
  ok(
    "mesh-to-points primary is points3d",
    def?.primaryOutput === "points3d"
  );
}

console.log("\n=== CAMERA THROUGH REROUTE / SWITCH ===");
{
  const ok = (label: string, pass: boolean, detail?: string) => {
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const nodeOf = (ns: ValNode[]) =>
    new Map(ns.map((n) => [n.id, { defType: n.defType, params: n.params }]));
  const cam = N("cam", "camera-3d");
  const rr = N("rr", "reroute");
  const sw = N("sw", "switch", { count: 2, index: 1 });
  ok(
    "direct camera-3d",
    walkToCamera3DNode("cam", nodeOf([cam]), []) === "cam"
  );
  ok(
    "camera → reroute",
    walkToCamera3DNode(
      "rr",
      nodeOf([cam, rr]),
      [E("cam", "out:primary", "rr", "in:value")]
    ) === "cam"
  );
  ok(
    "camera → switch slot 1 (index 1)",
    walkToCamera3DNode(
      "sw",
      nodeOf([cam, sw]),
      [E("cam", "out:primary", "sw", "in:in1")]
    ) === "cam"
  );
  ok(
    "camera → reroute → switch",
    walkToCamera3DNode(
      "sw0",
      nodeOf([cam, rr, N("sw0", "switch", { count: 2, index: 0 })]),
      [
        E("cam", "out:primary", "rr", "in:value"),
        E("rr", "out:primary", "sw0", "in:in0"),
      ]
    ) === "cam"
  );
  ok(
    "switch index 1 with camera on slot 0 → null",
    walkToCamera3DNode(
      "sw",
      nodeOf([cam, sw]),
      [E("cam", "out:primary", "sw", "in:in0")]
    ) === null
  );
  ok(
    "non-camera producer → null",
    walkToCamera3DNode("cube", nodeOf([N("cube", "cube-3d")]), []) === null
  );

  ok(
    "readSwitchSlots default (count=2)",
    readSwitchSlots({ count: 2 }).join(",") === "in0,in1"
  );
  ok(
    "readSwitchSlots from count=12 (past the old 8 cap)",
    readSwitchSlots({ count: 12 }).join(",") ===
      "in0,in1,in2,in3,in4,in5,in6,in7,in8,in9,in10,in11"
  );
  ok(
    "readSwitchSlots prefers slots over count",
    readSwitchSlots({ count: 4, slots: ["in0", "in3"] }).join(",") === "in0,in3"
  );
  ok(
    "nextSwitchSlot skips taken numbered sockets",
    nextSwitchSlot(new Set(["in0", "in1"])) === "in2"
  );

  const swDef = getNodeDef("switch");
  const swInputs = swDef?.resolveInputs?.({ count: 12, type: "auto" });
  ok(
    "resolveInputs honors count=12",
    !!swInputs &&
      swInputs.filter((i) => /^in\d+$/.test(i.name)).length === 12 &&
      swInputs.some((i) => i.name === "in11") &&
      swInputs.some((i) => i.name === "index")
  );
  const swPicked = swDef?.compute({
    inputs: {
      in0: { kind: "scalar", value: 10 },
      in9: { kind: "scalar", value: 99 },
    },
    auxIn: {},
    params: { slots: ["in0", "in9"], index: 1 },
    ctx: {} as never,
    nodeId: "sw",
  });
  ok(
    "compute picks by slots order, not inN name",
    !!swPicked &&
      swPicked.primary?.kind === "scalar" &&
      swPicked.primary.value === 99 &&
      swPicked.ownsTextures === false
  );
  ok(
    "camera → switch slot 1 of a 12-input node (index 9)",
    walkToCamera3DNode(
      "sw12",
      nodeOf([cam, N("sw12", "switch", { count: 12, index: 9 })]),
      [E("cam", "out:primary", "sw12", "in:in9")]
    ) === "cam"
  );
  ok(
    "camera → switch via non-sequential slots array",
    walkToCamera3DNode(
      "sws",
      nodeOf([
        cam,
        N("sws", "switch", { slots: ["in0", "in9"], index: 1 }),
      ]),
      [E("cam", "out:primary", "sws", "in:in9")]
    ) === "cam"
  );
}

console.log("\n=== VECTOR FIELD ===");
{
  const ok = (label: string, pass: boolean, detail?: string) => {
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  const def = getNodeDef("vector-field");
  ok("vector-field is registered", def?.type === "vector-field");
  ok(
    "sdf → Vector Field source (resting image)",
    editorCanCoerce("sdf", "image", "vector-field", "in:source")
  );
  ok(
    "image → Vector Field source (same type)",
    editorCanCoerce("image", "image", "vector-field", "in:source")
  );
  const r = validateGraph(
    [N("c", "sdf-circle"), N("v", "vector-field")],
    [E("c", "out:primary", "v", "in:source")]
  );
  ok(
    "validator accepts SDF Circle → Vector Field",
    r.ok,
    r.issues.map((i) => `${i.code}:${i.message}`).join(",")
  );
  const { pointExpressionNode } = await import("@/nodes/effect/point-expression");
  const exprOk = pointExpressionNode.validateParams!({
    expression: "x = px + fieldX();\ny = py + fieldY();",
  });
  ok(
    "point-expression fieldX/fieldY compile",
    exprOk.length === 0,
    exprOk.join(",")
  );
}

console.log("\n=== MIRROR ===");
{
  const ok = (label: string, pass: boolean, detail?: string) => {
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };
  ok(
    "image → image-resting Mirror source (plain table)",
    editorCanCoerce("image", "image", "mirror", "in:source")
  );
  ok(
    "spline → image-resting Mirror source",
    editorCanCoerce("spline", "image", "mirror", "in:source")
  );
  ok(
    "image → spline-typed stored Mirror source",
    editorCanCoerce("image", "spline", "mirror", "in:source")
  );
  const r = validateGraph(
    [N("img", "image-source"), N("m", "mirror")],
    [E("img", "out:primary", "m", "in:source")]
  );
  ok(
    "validator accepts Image Source → Mirror",
    r.ok,
    r.issues.map((i) => `${i.code}:${i.message}`).join(",")
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
