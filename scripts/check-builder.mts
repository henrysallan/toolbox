// Milestone-3 proof: hand-written RecipeGraph → buildRecipe → validateGraph.
// A well-formed recipe must build clean AND validate green (the round trip);
// a bad-wiring recipe must build into something the validator rejects; a
// malformed recipe must surface build issues without crashing.
//
//   npx tsx scripts/check-builder.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RecipeGraph } from "@/state/recipe-builder";

const g = globalThis as any;
const stub = () => ({ getContext: () => null, style: {}, addEventListener() {} });
g.window ??= g;
g.self ??= g;
g.document ??= { createElement: stub, createElementNS: stub, fonts: { add() {}, forEach() {} }, body: { appendChild() {} }, addEventListener() {} };
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
const { buildRecipe } = await import("@/state/recipe-builder");
const { validateGraph } = await import("@/engine/graph-validation");

const adapt = (built: { nodes: any[]; edges: any[] }) => ({
  nodes: built.nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
  edges: built.edges.map((e) => ({
    id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
  })),
});

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

// --- 1. Well-formed recipe: image in → two transforms → image out, one knob.
const good: RecipeGraph = {
  name: "Double Transform",
  nodes: [
    { id: "t1", type: "transform", params: { scaleX: 1.5, scaleY: 1.5 } },
    { id: "t2", type: "transform", params: { rotate: 45 } },
  ],
  edges: [{ from: "t1:out", to: "t2:in:image" }],
  inputs: [{ name: "image", from: "t1:in:image", type: "image" }],
  outputs: [{ name: "image", from: "t2:out", type: "image" }],
  exposed: [{ name: "Spin", node: "t2", param: "rotate" }],
};
{
  const built = buildRecipe(good);
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  const errs = r.issues.filter((i) => i.severity === "error");
  console.log(`\n[good]  build issues: ${built.issues.length}, nodes: ${built.nodes.length}, edges: ${built.edges.length}, validator errors: ${errs.length}`);
  check("well-formed recipe builds clean", built.issues.length === 0, JSON.stringify(built.issues));
  check("well-formed recipe validates green", r.ok && errs.length === 0, errs.map((e) => e.code).join(","));
  // group wrapper present?
  const types = new Set(built.nodes.map((n) => n.data.defType));
  check("group wrapper synthesized", types.has("node-group") && types.has("group-input") && types.has("group-output"));
  check("group shell marked aiAuthored (gets the star button)", built.nodes.some((n) => n.data.defType === "node-group" && n.data.aiAuthored === true));
  // exposed param recorded?
  const t2 = built.nodes.find((n) => n.data.defType === "transform" && (n.data.params as any).rotate === 45);
  check("exposed param added to exposedParams", !!t2 && (t2.data.exposedParams ?? []).includes("rotate"));
}

// --- 2. Bad-wiring recipe: gradient image → spline-stroke path (mismatch).
const badWire: RecipeGraph = {
  name: "Bad Wire",
  nodes: [
    { id: "g", type: "gradient", params: { mode: "radial" } },
    { id: "s", type: "spline-stroke" },
  ],
  edges: [{ from: "g:out", to: "s:in:path" }],
  outputs: [{ name: "image", from: "s:out", type: "image" }],
};
{
  const built = buildRecipe(badWire);
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  const codes = r.issues.filter((i) => i.severity === "error").map((i) => i.code);
  console.log(`\n[bad-wire]  build issues: ${built.issues.length}, validator error codes: [${codes.join(", ")}]`);
  check("bad wiring builds (trust boundary)", built.issues.length === 0, JSON.stringify(built.issues));
  check("bad wiring rejected by validator", codes.includes("EDGE_TYPE_MISMATCH"), `[${codes.join(",")}]`);
}

// --- 3. Malformed recipe: unknown type, non-settable param, dangling edge.
const malformed: RecipeGraph = {
  name: "Malformed",
  nodes: [
    { id: "cc", type: "color-correction", params: { curves: "nope", opacity: 0.5 } }, // curves not settable
    { id: "bogus", type: "not-a-real-node" },
  ],
  edges: [{ from: "cc:out", to: "ghost:in:image" }], // ghost is not a node
  outputs: [{ name: "image", from: "cc:out", type: "image" }],
};
{
  const built = buildRecipe(malformed);
  const codes = built.issues.map((i) => i.code);
  console.log(`\n[malformed]  build issue codes: [${codes.join(", ")}]`);
  check("rejects non-settable param", codes.includes("PARAM_NOT_SETTABLE"), `[${codes.join(",")}]`);
  check("skips unknown node type", codes.includes("UNKNOWN_TYPE"));
  check("drops dangling edge", codes.includes("BAD_EDGE"));
  // It still produced a usable group from the one good node.
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  check("survivor graph still validates", r.ok, r.issues.filter((i) => i.severity === "error").map((e) => e.code).join(","));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
