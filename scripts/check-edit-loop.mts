// Milestone-2 proof for Edit-with-AI: the patch → apply → validate → repair
// loop converges, offline, with a fake model.
//   1. good-first-try → ok in 1 attempt, the param actually changed.
//   2. bad-then-good   → 1st patch is a type-mismatched wire; the repair turn
//                        (which sees the validator error) returns a valid patch.
//
//   npx tsx scripts/check-edit-loop.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EditPostBody } from "@/lib/ai/edit-recipe-client";
import type { RecipeEdit } from "@/state/recipe-edit";

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
const { editGroupRecipe } = await import("@/lib/ai/edit-recipe-client");

const frag = PRESETS.find((p) => p.id === "cover-envelope")!.build();
const idOf = (t: string) => frag.nodes.find((n) => n.data.defType === t)!.id;
const groupId = idOf("node-group");
const outId = idOf("group-output");
const popId = idOf("points-on-path");
const circleId = idOf("circle");

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

const GOOD: RecipeEdit = {
  summary: "doubled the point count",
  ops: [{ op: "set_param", node: popId, param: "count", value: 320 }],
};
// circle outputs spline; wiring it into the image output is a type mismatch.
const BAD: RecipeEdit = {
  summary: "(broken) routed the circle straight to the image output",
  ops: [{ op: "add_edge", from: `${circleId}:out`, to: `${outId}:in:image` }],
};

// 1. good first try
{
  let calls = 0;
  const post = async (_b: EditPostBody) => { calls++; return GOOD; };
  const r = await editGroupRecipe(groupId, frag.nodes, frag.edges, "double the points", { post });
  const pop = r.nodes?.find((n) => n.id === popId);
  check("good-first-try converges in 1 attempt", r.ok && r.attempts === 1 && calls === 1, JSON.stringify({ ok: r.ok, attempts: r.attempts, errors: r.errors }));
  check("the edit actually changed the param", (pop?.data.params as any)?.count === 320);
}

// 2. bad then good — the repair turn must carry the validator error
{
  const seenRepairs: (string[] | undefined)[] = [];
  const post = async (b: EditPostBody) => {
    seenRepairs.push(b.repair?.errors);
    return b.repair ? GOOD : BAD; // first call (no repair) → BAD; repair call → GOOD
  };
  const r = await editGroupRecipe(groupId, frag.nodes, frag.edges, "improve it", { post });
  check("bad-then-good converges in 2 attempts", r.ok && r.attempts === 2, JSON.stringify({ ok: r.ok, attempts: r.attempts }));
  check("repair turn received the type-mismatch error", !!seenRepairs[1]?.some((e) => /Incompatible wire/.test(e)), JSON.stringify(seenRepairs[1]));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
