// Milestone-4 proof (offline): the generate → validate → repair loop converges
// without a live Claude call, by injecting a fake "model" as the POST fn.
//   1. good-first-try   → ok in 1 attempt
//   2. bad-then-good     → 1st RecipeGraph is invalid; the repair turn (which
//                          receives the validator errors) returns a valid one → ok in 2
//   3. always-bad        → never converges → ok:false after maxRepairs+1 attempts
//
//   npx tsx scripts/check-recipe-loop.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RecipeGraph } from "@/state/recipe-builder";
import type { PostBody } from "@/lib/ai/generate-recipe-client";

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
const { generateRecipe } = await import("@/lib/ai/generate-recipe-client");

const GOOD: RecipeGraph = {
  name: "Spin",
  nodes: [{ id: "t", type: "transform", params: { rotate: 30 } }],
  inputs: [{ name: "image", from: "t:in:image", type: "image" }],
  outputs: [{ name: "image", from: "t:out", type: "image" }],
  exposed: [{ name: "Angle", node: "t", param: "rotate" }],
};
const BAD: RecipeGraph = {
  name: "Broken",
  nodes: [
    { id: "g", type: "gradient", params: { mode: "radial" } },
    { id: "s", type: "spline-stroke" },
  ],
  edges: [{ from: "g:out", to: "s:in:path" }], // image → spline path: mismatch
  outputs: [{ name: "image", from: "s:out", type: "image" }],
};

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

// 1. good first try
{
  let calls = 0;
  const post = async (_b: PostBody) => { calls++; return { recipe: GOOD }; };
  const r = await generateRecipe("spin an image", { post });
  check("good-first-try converges in 1 attempt", r.ok && r.attempts === 1 && calls === 1, JSON.stringify({ ok: r.ok, attempts: r.attempts, errors: r.errors }));
}

// 2. bad then good — the repair turn must carry the validator's errors back
{
  const seenRepairs: (string[] | undefined)[] = [];
  const post = async (b: PostBody) => {
    seenRepairs.push(b.repair?.errors);
    return b.repair ? { recipe: GOOD } : { recipe: BAD };
  };
  const r = await generateRecipe("make something", { post });
  check("bad-then-good converges in 2 attempts", r.ok && r.attempts === 2, JSON.stringify({ ok: r.ok, attempts: r.attempts }));
  check("repair turn received the type-mismatch error", !!seenRepairs[1]?.some((e) => /Incompatible wire/.test(e)), JSON.stringify(seenRepairs[1]));
}

// 3. always bad — gives up after maxRepairs+1 attempts, returns the errors
{
  const post = async (_b: PostBody) => ({ recipe: BAD });
  const r = await generateRecipe("never works", { post, maxRepairs: 2 });
  check("always-bad gives up after 3 attempts", !r.ok && r.attempts === 3, JSON.stringify({ ok: r.ok, attempts: r.attempts }));
  check("failure surfaces the blocking error", r.errors.some((e) => /Incompatible wire/.test(e)), JSON.stringify(r.errors));
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
