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
  const post = async (_b: EditPostBody) => { calls++; return { edit: GOOD }; };
  const r = await editGroupRecipe(groupId, frag.nodes, frag.edges, "double the points", { post });
  const pop = r.nodes?.find((n) => n.id === popId);
  check("good-first-try converges in 1 attempt", r.ok && r.attempts === 1 && calls === 1, JSON.stringify({ ok: r.ok, attempts: r.attempts, errors: r.errors }));
  check("the edit actually changed the param", (pop?.data.params as any)?.count === 320);
}

// 2. bad then good — repair carries the validator error; progress is emitted
{
  const seenRepairs: (string[] | undefined)[] = [];
  const events: { kind: string; text?: string }[] = [];
  const post = async (b: EditPostBody) =>
    b.repair ? { edit: GOOD, thinking: "reasoned about the wiring" } : { edit: BAD };
  const r = await editGroupRecipe(groupId, frag.nodes, frag.edges, "improve it", {
    post: async (b) => { seenRepairs.push(b.repair?.errors); return post(b); },
    onProgress: (e) => events.push(e),
  });
  check("bad-then-good converges in 2 attempts", r.ok && r.attempts === 2, JSON.stringify({ ok: r.ok, attempts: r.attempts }));
  check("repair turn received the type-mismatch error", !!seenRepairs[1]?.some((e) => /Incompatible wire/.test(e)), JSON.stringify(seenRepairs[1]));
  check("progress trace: request → invalid → request → thinking → applied", events.map((e) => e.kind).join(",") === "request,invalid,request,thinking,applied", events.map((e) => e.kind).join(","));
  check("progress includes the thinking summary", events.some((e) => e.kind === "thinking" && /reasoned/.test(e.text ?? "")));
}

// 3. multi-turn: the local-cache transcript round-trips and threads as history
{
  const { getTranscript, appendTurn, clearTranscript } = await import("@/state/recipe-chat");
  clearTranscript(groupId);
  const seenHistory: ({ instruction: string; summary: string }[] | undefined)[] = [];
  const post = async (b: EditPostBody) => { seenHistory.push(b.history); return { edit: GOOD }; };

  await editGroupRecipe(groupId, frag.nodes, frag.edges, "first change", { post, history: getTranscript(groupId) });
  appendTurn(groupId, { instruction: "first change", summary: "did the first thing" });
  await editGroupRecipe(groupId, frag.nodes, frag.edges, "second change", { post, history: getTranscript(groupId) });

  check("turn 1 sends empty history", Array.isArray(seenHistory[0]) && seenHistory[0]!.length === 0);
  check("transcript persists turn 1 → sent on turn 2", seenHistory[1]?.length === 1 && seenHistory[1]![0].instruction === "first change");
  clearTranscript(groupId);
  check("clear empties the transcript", getTranscript(groupId).length === 0);
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
