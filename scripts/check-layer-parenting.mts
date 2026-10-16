// check-layer-parenting: timeline parenting ops
// (src/state/layer-parenting.ts; specdocs/101526_layer-transforms-parenting.md
// §7, M4) — loop guard, keep-in-place compensation (parent / re-parent /
// unparent, keyframed parent), the animated / shear / Alt jump cases,
// deleting a parent, the duplicate and split rules — and a cross-check that
// worldOpsAt matches what the engine's layer-xform nodes evaluate.
//
//   npx tsx scripts/check-layer-parenting.mts
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
registerAllNodes();
const {
  carriedParentEdges,
  layerChildrenOf,
  layerParentOf,
  setLayerParent,
  unparentChildrenOf,
  worldOpsAt,
  wouldLoop,
} = await import("@/state/layer-parenting");
const { splitLayer } = await import("@/state/graph-ops");
const { composeOpsToAffine } = await import("@/engine/transform-value");
const { evaluateGraph } = await import("@/engine/evaluator");
const { layerXformId } = await import("@/engine/groups");
const { emptyAnimationBlock, upsertKeyframe } = await import("@/engine/keyframes");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type N = any;
type E = any;
const layer = (id: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): N => ({
  id,
  type: "effect",
  position: { x: 0, y: 0 },
  data: { defType: "layer", name: id, params: { ...params }, ...extra },
});
const parentEdge = (parent: string, child: string): E => ({
  id: `p:${parent}>${child}`,
  source: parent,
  sourceHandle: "out:aux:transform",
  target: child,
  targetHandle: "in:transform",
});
const stackEdge = (below: string, above: string): E => ({
  id: `s:${below}>${above}`,
  source: below,
  sourceHandle: "out:primary",
  target: above,
  targetHandle: "in:stack",
});

const paramsOf = (nodes: readonly N[], id: string): any =>
  (nodes.find((n: N) => n.id === id) as N).data.params;

const worldAffine = (nodes: N[], edges: E[], id: string, tick = 0) => {
  const ops = worldOpsAt(nodes, edges, id, tick);
  return ops ? composeOpsToAffine(ops) : null;
};
const affineClose = (a: any, b: any, eps = 1e-6) =>
  !!a && !!b && (["a", "b", "c", "d", "tx", "ty"] as const).every((k) => Math.abs(a[k] - b[k]) < eps);
const fmt = (m: any) => (m ? (["a", "b", "tx", "c", "d", "ty"] as const).map((k) => m[k].toFixed(4)).join(",") : "null");

// ── Basics ──────────────────────────────────────────────────────────────
{
  const nodes = [layer("A"), layer("B"), layer("C"), { id: "G", position: { x: 0, y: 0 }, data: { defType: "gizmo", params: {} } }];
  const edges = [parentEdge("B", "A"), parentEdge("C", "B"), { ...parentEdge("G", "C"), id: "g" }];
  check("parentOf: reads the Parent wire", layerParentOf(nodes, edges, "A")?.id === "B" && layerParentOf(nodes, edges, "A")?.isLayer === true);
  check("parentOf: a non-layer source is flagged", layerParentOf(nodes, edges, "C")?.isLayer === false);
  check("childrenOf: layers wired to its transform output", layerChildrenOf(nodes, edges, "B").join() === "A");
  check("loop: a layer can't parent itself", wouldLoop(edges, "A", "A"));
  check("loop: an ancestor can't take its descendant as parent", wouldLoop(edges, "C", "A") && wouldLoop(edges, "B", "A"));
  check("loop: an unrelated layer is fine", !wouldLoop([parentEdge("B", "A")], "C", "A"));
  check("worldOps: null when a parent in the chain isn't a layer", worldOpsAt(nodes, edges, "A", 0) === null);
}

// ── Keep-in-place ───────────────────────────────────────────────────────
const P = { translateX: 0.1, translateY: -0.05, rotate: 30, scaleX: 1.5, scaleY: 1.5, pivotX: 0.4, pivotY: 0.6 };
const Cp = { translateX: -0.2, translateY: 0.15, rotate: -10, scaleX: 0.8, scaleY: 1.2, pivotX: 0.55, pivotY: 0.45 };
{
  const nodes = [layer("C", Cp), layer("P", P)];
  const edges = [stackEdge("C", "P")];
  const before = worldAffine(nodes, edges, "C");
  const r = setLayerParent(nodes, edges, "C", "P", 0, { keepInPlace: true });
  check("parent: succeeds and holds", r.ok && r.held && !r.jumped);
  if (r.ok) {
    check("parent: wires P.aux:transform → C.in:transform", layerParentOf(r.nodes, r.edges, "C")?.id === "P");
    check("parent: the child's world placement is unchanged", affineClose(worldAffine(r.nodes, r.edges, "C"), before), `${fmt(worldAffine(r.nodes, r.edges, "C"))} vs ${fmt(before)}`);
    const pv = paramsOf(r.nodes, "C");
    check("parent: the child keeps its own pivot", pv.pivotX === Cp.pivotX && pv.pivotY === Cp.pivotY);
    check("parent: the stack edge is untouched", r.edges.some((e: E) => e.id === "s:C>P"));

    const u = setLayerParent(r.nodes, r.edges, "C", null, 0, { keepInPlace: true });
    check("unparent: holds", u.ok && u.held);
    if (u.ok) {
      check("unparent: the wire is gone", layerParentOf(u.nodes, u.edges, "C") === null);
      check("unparent: placement unchanged", affineClose(worldAffine(u.nodes, u.edges, "C"), before));
      const back = paramsOf(u.nodes, "C");
      check(
        "unparent: round trip restores the original TRS",
        ["translateX", "translateY", "rotate", "scaleX", "scaleY"].every((k) => Math.abs(back[k] - (Cp as any)[k]) < 1e-6),
        JSON.stringify(back)
      );
    }
  }
}

{
  // Re-parent P1 → P2, child BELOW both.
  const nodes = [layer("C", Cp), layer("P1", P), layer("P2", { rotate: -45, scaleX: 0.5, scaleY: 0.5, translateY: 0.2 })];
  const edges = [stackEdge("C", "P1"), stackEdge("P1", "P2"), parentEdge("P1", "C")];
  const before = worldAffine(nodes, edges, "C");
  const r = setLayerParent(nodes, edges, "C", "P2", 0, { keepInPlace: true });
  check("re-parent: holds placement", r.ok && r.held && affineClose(worldAffine(r.nodes, r.edges, "C"), before));
  check("re-parent: exactly one Parent wire remains", r.ok && r.edges.filter((e: E) => e.target === "C" && e.targetHandle === "in:transform").length === 1);
}

{
  // Keyframed parent: compensation uses the parent's transform AT the tick.
  let b = emptyAnimationBlock();
  b = upsertKeyframe(b, 0, 0, "linear");
  b = upsertKeyframe(b, 1000, 0.4, "linear");
  const nodes = [layer("C", { translateX: 0.1 }), layer("P", {}, { animation: { translateX: { ...b, animated: true } } })];
  const edges: E[] = [];
  const before = worldAffine(nodes, edges, "C", 500);
  const r = setLayerParent(nodes, edges, "C", "P", 500, { keepInPlace: true });
  check("keyframed parent: holds at the playhead", r.ok && r.held && affineClose(worldAffine(r.nodes, r.edges, "C", 500), before));
  check(
    "keyframed parent: the child's new translateX offsets the parent's value there (0.1 − 0.2)",
    r.ok && Math.abs(paramsOf(r.nodes, "C").translateX + 0.1) < 1e-6
  );
}

// ── Jumps ───────────────────────────────────────────────────────────────
{
  let b = emptyAnimationBlock();
  b = upsertKeyframe(b, 0, 0.1, "linear");
  const nodes = [layer("C", Cp, { animation: { rotate: { ...b, animated: true } } }), layer("P", P)];
  const r = setLayerParent(nodes, [], "C", "P", 0, { keepInPlace: true });
  check("animated child: wires but jumps (reason animated), TRS untouched", r.ok && !r.held && r.jumped === "animated" && r.nodes === nodes && layerParentOf(r.nodes, r.edges, "C")?.id === "P");
}
{
  const nodes = [layer("C", { rotate: 30 }), layer("P", { scaleX: 2, scaleY: 1 })];
  const r = setLayerParent(nodes, [], "C", "P", 0, { keepInPlace: true });
  check("non-uniform parent + rotated child: jumps (reason shear)", r.ok && !r.held && r.jumped === "shear");
}
{
  const nodes = [layer("C", Cp), layer("P", P)];
  const r = setLayerParent(nodes, [], "C", "P", 0, { keepInPlace: false });
  check("Alt (keepInPlace false): rewires only, no reason", r.ok && !r.held && !r.jumped && r.nodes === nodes);
}

{
  // Wired TRS (review fix): wire beats static + keys, so a rewrite can't hold.
  const wire = { id: "w", source: "LFO", sourceHandle: "out:primary", target: "C", targetHandle: "in:param:translateX" };
  const nodes = [layer("C", Cp), layer("P", P), { id: "LFO", position: { x: 0, y: 0 }, data: { defType: "lfo", params: {} } }];
  const r = setLayerParent(nodes, [wire], "C", "P", 0, { keepInPlace: true });
  check("wired child TRS: wires but jumps (reason wired), TRS untouched", r.ok && !r.held && r.jumped === "wired" && r.nodes === nodes);
  const pw = { ...wire, target: "P" };
  const r2 = setLayerParent(nodes, [pw], "C", "P", 0, { keepInPlace: true });
  check("wired parent TRS: its world is unknowable → jumps (unknown-parent)", r2.ok && !r2.held && r2.jumped === "unknown-parent");
  check("worldOps: null for a layer with a wired TRS param", worldOpsAt(nodes, [wire], "C", 0) === null);
  const opacityWire = { ...wire, targetHandle: "in:param:opacity" };
  const r3 = setLayerParent(nodes, [opacityWire], "C", "P", 0, { keepInPlace: true });
  check("a wired non-TRS param (opacity) doesn't block the hold", r3.ok && r3.held);
}

// ── Refusals ────────────────────────────────────────────────────────────
{
  const nodes = [layer("A"), layer("B"), { id: "X", position: { x: 0, y: 0 }, data: { defType: "gizmo", params: {} } }];
  const edges = [parentEdge("A", "B")];
  const loop = setLayerParent(nodes, edges, "A", "B", 0, { keepInPlace: true });
  check("refuse: parenting into a loop", !loop.ok);
  const nonLayer = setLayerParent(nodes, edges, "A", "X", 0, { keepInPlace: true });
  check("refuse: a non-layer parent from the timeline", !nonLayer.ok);
  const same = setLayerParent(nodes, edges, "B", "A", 0, { keepInPlace: true });
  check("same parent: no-op", same.ok && same.edges === edges && same.nodes === nodes);
}

// ── Delete a parent ─────────────────────────────────────────────────────
{
  const nodes = [layer("C", Cp), layer("P", P), layer("G", { translateX: 0.05, rotate: 15 })];
  const edges = [parentEdge("G", "P"), parentEdge("P", "C")];
  const before = worldAffine(nodes, edges, "C");
  const res = unparentChildrenOf(nodes, edges, new Set(["P"]), 0);
  const survivors = res.nodes.filter((n: N) => n.id !== "P");
  const survEdges = res.edges.filter((e: E) => e.source !== "P" && e.target !== "P");
  check("delete parent: child unparented (not adopted by the grandparent)", layerParentOf(survivors, survEdges, "C") === null);
  check("delete parent: child holds its world placement", affineClose(worldAffine(survivors, survEdges, "C"), before), fmt(worldAffine(survivors, survEdges, "C")));
  check("delete parent: nothing jumped", res.jumped.length === 0);
}

// ── Duplicate / split ───────────────────────────────────────────────────
{
  const edges = [parentEdge("P", "C"), parentEdge("C", "K")];
  const carried = carriedParentEdges(edges, new Map([["C", "C2"]]));
  check("duplicate: the clone keeps an outside parent", carried.length === 1 && carried[0].source === "P" && carried[0].target === "C2");
  const both = carriedParentEdges(edges, new Map([["C", "C2"], ["K", "K2"]]));
  check("duplicate: a parent cloned alongside isn't re-carried", both.length === 1 && both[0].target === "C2");
  // Review fix: a NON-layer parent (hand-wired Gizmo) duplicated alongside
  // its child must not be re-carried — the filter picks targets, the full
  // map decides "outside".
  const gz = [{ ...parentEdge("G", "C"), id: "gz" }];
  const withGizmo = carriedParentEdges(gz, new Map([["G", "G2"], ["C", "C2"]]), (orig) => orig !== "G");
  check("duplicate: a non-layer parent cloned alongside isn't re-carried", withGizmo.length === 0, JSON.stringify(withGizmo));
  const onlyChild = carriedParentEdges(gz, new Map([["C", "C2"]]), (orig) => orig !== "G");
  check("duplicate: the carry filter still carries an outside parent", onlyChild.length === 1 && onlyChild[0].source === "G");
}
{
  const nodes = [layer("C", Cp), layer("P", P), layer("K"), { id: "O", position: { x: 0, y: 0 }, data: { defType: "output", params: {} } }];
  const edges = [stackEdge("C", "P"), { id: "o", source: "P", sourceHandle: "out:primary", target: "O", targetHandle: "in:image" }, parentEdge("P", "C"), parentEdge("C", "K")];
  const r = splitLayer(nodes as any, edges as any, "C", 500, 1000);
  check("split: succeeds", !!r);
  if (r) {
    const clone = r.newLayerId;
    check("split: children stay on the original half", layerParentOf(r.nodes as any, r.edges as any, "K")?.id === "C");
    check("split: the second half keeps the original's parent", layerParentOf(r.nodes as any, r.edges as any, clone)?.id === "P");
    check("split: the original keeps its parent", layerParentOf(r.nodes as any, r.edges as any, "C")?.id === "P");
  }
}

// ── MCP: get_graph root carries parentLayerId ──────────────────────────
{
  const { graphToSpec } = await import("@/state/recipe-edit");
  const nodes = [layer("C"), layer("P"), layer("Q"), { id: "O", type: "effect", position: { x: 0, y: 0 }, data: { defType: "output", name: "Output", params: {} } }];
  const edges = [stackEdge("C", "P"), stackEdge("P", "Q"), parentEdge("P", "C")];
  const spec = graphToSpec(nodes as any, edges as any);
  const row = (id: string) => spec.nodes.find((n) => n.id === id);
  check("mcp: a parented root layer reports parentLayerId", row("C")?.parentLayerId === "P");
  check("mcp: unparented layers and non-layers carry no parentLayerId", row("P")?.parentLayerId === undefined && row("O")?.parentLayerId === undefined);
}

// ── Cross-check against the engine ──────────────────────────────────────
{
  const W = 16;
  const H = 9;
  const img = () => ({ kind: "image", texture: {}, width: W, height: H });
  const ctx = {
    gl: {}, width: W, height: H, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 30, playing: false, offline: true,
    cursor: { x: 0, y: 0, active: false }, state: {} as Record<string, unknown>,
    allocImage: img, allocMask: img, allocUv: img, releaseTexture: () => {}, clearTarget: () => {},
    getShader: () => ({}), drawFullscreen: () => {},
  } as any;
  let b = emptyAnimationBlock();
  b = upsertKeyframe(b, 0, 0, "linear");
  b = upsertKeyframe(b, 3000, 90, "linear");
  const nodes = [
    layer("A", { translateX: 0.25 }),
    layer("B", {}, { animation: { rotate: { ...b, animated: true } } }),
    layer("C", { translateY: 0.1, scaleX: 2, scaleY: 2 }),
  ];
  const edges = [stackEdge("A", "B"), stackEdge("B", "C"), parentEdge("B", "A"), parentEdge("C", "B")];
  const engineNodes = nodes.map((n: N) => ({ id: n.id, type: n.data.defType, params: n.data.params, animation: n.data.animation }));
  const tick = 1500;
  ctx.tick = tick;
  const res = evaluateGraph(engineNodes as any, edges as any, ctx, new Map(), null, undefined, null, {
    extraTargets: [layerXformId("A")],
  });
  const engineOps = (res.outputs.get(layerXformId("A"))?.primary as any)?.ops;
  const mine = worldAffine(nodes, edges, "A", tick);
  check(
    "engine: worldOpsAt matches the layer-xform evaluation (3 levels, keyed rotate)",
    !!engineOps && affineClose(composeOpsToAffine(engineOps), mine),
    `${engineOps ? fmt(composeOpsToAffine(engineOps)) : "no engine output"} vs ${fmt(mine)}`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall layer-parenting checks passed");
