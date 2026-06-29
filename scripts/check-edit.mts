// Milestone-1 proof for Edit-with-AI (strategy B): patch a real group and
// confirm preservation + validity.
//   - groupToSpec exposes the interior (settable params, edges, interface).
//   - a realistic patch (retune a param, insert a node into the output chain)
//     applies cleanly, the result still validates, and the change took effect.
//   - a bad patch (type-mismatched wire) applies structurally but the validator
//     rejects it — i.e. it would feed the repair loop.
//
//   npx tsx scripts/check-edit.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
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
const { PRESETS } = await import("@/state/presets");
const { groupToSpec, applyRecipeEdit } = await import("@/state/recipe-edit");
const { validateGraph } = await import("@/engine/graph-validation");

const adapt = (nodes: any[], edges: any[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
  edges: edges.map((e) => ({
    id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
  })),
});
const validate = (r: { nodes: any[]; edges: any[] }) =>
  validateGraph(adapt(r.nodes, r.edges).nodes, adapt(r.nodes, r.edges).edges);

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

const frag = PRESETS.find((p) => p.id === "cover-envelope")!.build();
const id = (t: string) => frag.nodes.find((n) => n.data.defType === t)!.id;
const groupId = id("node-group");
const outId = id("group-output");
const popId = id("points-on-path");
const strokeId = id("spline-stroke");

// --- groupToSpec sanity ---
{
  const spec = groupToSpec(groupId, frag.nodes, frag.edges);
  const pop = spec.nodes.find((n) => n.id === popId);
  check("groupToSpec lists interior nodes with settable params", !!pop && pop.params.count === 160, JSON.stringify(pop));
  check("groupToSpec reports the group interface", spec.interface.outputs.some((o) => o.name === "image"));
  check("groupToSpec exposes the output boundary id", spec.interface.outputNodeId === outId);
}

// --- a realistic patch: retune count + insert a transform before the image output ---
{
  const r = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    summary: "double the points and add a transform before the output",
    ops: [
      { op: "set_param", node: popId, param: "count", value: 320 },
      { op: "add_node", id: "t1", type: "transform", params: { scaleX: 1.2, scaleY: 1.2 } },
      { op: "remove_edge", from: `${strokeId}:out`, to: `${outId}:in:image` },
      { op: "add_edge", from: `${strokeId}:out`, to: "t1:in:image" },
      { op: "add_edge", from: "t1:out", to: `${outId}:in:image` },
    ],
  });
  const v = validate(r);
  const errs = v.issues.filter((i) => i.severity === "error");
  const pop = r.nodes.find((n) => n.id === popId);
  const transform = r.nodes.find((n) => n.data.defType === "transform");
  const oldEdgeGone = !r.edges.some((e) => e.source === strokeId && e.target === outId);
  const newWired =
    !!transform &&
    r.edges.some((e) => e.source === strokeId && e.target === transform.id) &&
    r.edges.some((e) => e.source === transform.id && e.target === outId);

  console.log(`\n[patch] build issues: ${r.issues.length}, validator errors: ${errs.length}`);
  check("patch applies with no issues", r.issues.length === 0, JSON.stringify(r.issues));
  check("patched group still validates", v.ok && errs.length === 0, errs.map((e) => e.code).join(","));
  check("set_param took effect (count 160 → 320)", (pop?.data.params as any)?.count === 320);
  check("inserted node + rewired the output chain", oldEdgeGone && newWired);
  // The original interior nodes keep their identity (preservation).
  check("untouched interior node ids preserved", r.nodes.some((n) => n.id === strokeId));
}

// --- bad patches ---
{
  // type-mismatched wire: circle (spline) → group image output. Applies
  // structurally, but the validator must reject it (→ repair loop).
  const r = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "add_edge", from: `${id("circle")}:out`, to: `${outId}:in:image` }],
  });
  const codes = validate(r).issues.filter((i) => i.severity === "error").map((i) => i.code);
  check("validator catches a type-mismatched patch", codes.includes("EDGE_TYPE_MISMATCH"), codes.join(","));

  // op against a non-existent node → a build issue (would feed the repair loop).
  const r2 = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "set_param", node: "ghost-node", param: "count", value: 5 }],
  });
  check("op on a missing node is reported", r2.issues.some((i) => i.code === "UNKNOWN_NODE"), JSON.stringify(r2.issues));

  // structural nodes are protected.
  const r3 = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "remove_node", node: outId }],
  });
  check("structural (boundary) nodes are protected", r3.issues.some((i) => i.code === "PROTECTED_NODE"));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
