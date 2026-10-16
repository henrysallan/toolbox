// check-layer-transform: the M1 engine contract for layer transforms
// (specdocs/101526_layer-transforms-parenting.md §2–§3), on a GL-free stub
// context that records which blend shader each layer drew with and the
// uniforms it bound.
//
//   - Parity: a layer that doesn't use its transform gets no layer-xform
//     node, no __xform edge, and still draws with Merge's pairwise blend
//     (or returns its content untouched as the bottom layer).
//   - A transformed layer samples its content through the inverse canvas
//     affine (aspect-rigid, translateY width-relative).
//   - Parenting through the flatten split: a child stacked BELOW its parent
//     evaluates without a cycle; a gated or bypassed parent still drives
//     its child; three-level chains compose child → parent → grandparent;
//     TRS keyframes drive the transform with identity static params.
//
//   npx tsx scripts/check-layer-transform.mts
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
const { flattenGraph } = await import("@/engine/flatten");
const { layerNode } = await import("@/nodes/group/layer");
const { layerXformNode } = await import("@/nodes/group/layer-xform");
const { groupOutputNode } = await import("@/nodes/group/group-output");
const { groupInputNode } = await import("@/nodes/group/group-input");
const { outputNode } = await import("@/nodes/output/output");
const {
  LAYER_INPUT_SOCKETS,
  LAYER_OUTPUT_SOCKETS,
  LAYER_XFORM_TYPE,
  layerXformId,
} = await import("@/engine/groups");
const { composeOpsToCanvasAffine, invertAffine, opFromParams } = await import(
  "@/engine/transform-value"
);
const { defaultClip } = await import("@/engine/clips");
const { emptyAnimationBlock, upsertKeyframe } = await import("@/engine/keyframes");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
}
const close = (a: number | undefined, b: number, eps = 1e-6) =>
  a !== undefined && Math.abs(a - b) < eps;

registerNode(layerNode);
registerNode(layerXformNode);
registerNode(groupOutputNode);
registerNode(groupInputNode);
registerNode(outputNode);
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

// ── Stub context: records each draw by its target texture ──────────────
const W = 16;
const H = 9;
type Draw = { key: string; u: Record<string, number[]> };
const draws = new Map<unknown, Draw>();
const img = () => ({ kind: "image", texture: {}, width: W, height: H });
const ctx = {
  gl: {},
  width: W,
  height: H,
  time: 0,
  frame: 0,
  tick: 0,
  ticksPerFrame: 1000,
  fps: 30,
  playing: false,
  offline: true,
  cursor: { x: 0, y: 0, active: false },
  state: {} as Record<string, unknown>,
  allocImage: img,
  allocMask: () => ({ ...img(), kind: "mask" }),
  allocUv: () => ({ ...img(), kind: "uv" }),
  releaseTexture: () => {},
  clearTarget: () => {},
  getShader: (key: string) => ({ key }),
  drawFullscreen: (prog: { key: string }, target: unknown, setup: (gl: any) => void) => {
    const rec: Draw = { key: prog.key, u: {} };
    const put = (loc: string, ...v: number[]) => {
      rec.u[loc] = v;
    };
    setup({
      TEXTURE0: 0,
      TEXTURE1: 1,
      TEXTURE_2D: 0,
      activeTexture() {},
      bindTexture() {},
      getUniformLocation: (_p: unknown, name: string) => name,
      uniform1i: put,
      uniform1f: put,
      uniform2f: put,
      uniform4f: put,
    });
    draws.set(target, rec);
  },
} as any;

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id: `${source}-${sourceHandle}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle }) as any;

// Layers listed BOTTOM → TOP; each holds one image source as its content.
function stackGraph(
  layers: { id: string; params?: Record<string, unknown>; extra?: Record<string, unknown> }[],
  parents: [child: string, parent: string][] = []
) {
  const nodes: any[] = [{ id: "O", type: "output", params: {} }];
  const edges: any[] = [];
  let below: string | null = null;
  for (const l of layers) {
    nodes.push(
      { id: l.id, type: "layer", params: { ...(l.params ?? {}) }, ...(l.extra ?? {}) },
      { id: `${l.id}.in`, type: "group-input", params: { sockets: [...LAYER_INPUT_SOCKETS], reserved: ["backdrop"] }, parentId: l.id },
      { id: `${l.id}.out`, type: "group-output", params: { sockets: [...LAYER_OUTPUT_SOCKETS], fixed: true }, parentId: l.id },
      { id: `${l.id}.src`, type: "test-img-src", params: {}, parentId: l.id }
    );
    edges.push(edge(`${l.id}.src`, "out:primary", `${l.id}.out`, "in:image"));
    if (below) edges.push(edge(below, "out:primary", l.id, "in:stack"));
    below = l.id;
  }
  if (below) edges.push(edge(below, "out:primary", "O", "in:image"));
  for (const [child, parent] of parents) {
    edges.push(edge(parent, "out:aux:transform", child, "in:transform"));
  }
  return { nodes, edges };
}

function run(graph: { nodes: any[]; edges: any[] }, tick = 0) {
  draws.clear();
  ctx.state = {};
  ctx.tick = tick;
  ctx.frame = Math.floor(tick / ctx.ticksPerFrame);
  ctx.time = tick / (ctx.ticksPerFrame * ctx.fps);
  const res = evaluateGraph(graph.nodes, graph.edges, ctx, new Map());
  const drawOf = (id: string) => draws.get(res.outputs.get(id)?.primary);
  return { res, drawOf };
}

// Expected inverse translation for a list of authored-space ops.
function expectedInv(opsParams: Record<string, unknown>[]) {
  const m = composeOpsToCanvasAffine(opsParams.map((p) => opFromParams(p)), W / H);
  return invertAffine(m)!;
}

// ── Parity: no transform in use ─────────────────────────────────────────
{
  const graph = stackGraph([{ id: "A" }, { id: "B" }]);
  const flat = flattenGraph(graph.nodes, graph.edges);
  check(
    "parity: no layer-xform nodes when no layer uses its transform",
    !flat.nodes.some((n) => n.type === LAYER_XFORM_TYPE)
  );
  check(
    "parity: no __xform edges when no layer uses its transform",
    !flat.edges.some((e) => e.targetHandle === "in:__xform")
  );
  const { res, drawOf } = run(graph);
  check("parity: evaluates without errors", Object.keys(res.errors).length === 0, JSON.stringify(res.errors));
  check(
    "parity: bottom layer (normal, opacity 1) returns its content untouched",
    res.outputs.get("A")?.primary === res.outputs.get("A.src")?.primary
  );
  check("parity: top layer draws with Merge's pairwise blend", drawOf("B")?.key === "merge/blend-v3", drawOf("B")?.key);
  check("parity: pairwise blend binds no transform uniforms", !!drawOf("B") && !("u_invA" in drawOf("B")!.u));
}

{
  // Pivot alone moves nothing — still parity.
  const graph = stackGraph([{ id: "A", params: { pivotX: 0.2, pivotY: 0.9 } }, { id: "B" }]);
  const flat = flattenGraph(graph.nodes, graph.edges);
  check("parity: a pivot-only change doesn't split the layer", !flat.nodes.some((n) => n.type === LAYER_XFORM_TYPE));
}

// ── A transformed layer ─────────────────────────────────────────────────
{
  const graph = stackGraph([{ id: "A", params: { translateX: 0.1, translateY: 0.1 } }, { id: "B" }]);
  const flat = flattenGraph(graph.nodes, graph.edges);
  const xa = flat.nodes.find((n) => n.id === layerXformId("A"));
  check("transform: a non-identity TRS splits the layer", xa?.type === LAYER_XFORM_TYPE);
  check(
    "transform: the layer-xform node shares the layer's params by reference",
    xa?.params === flat.nodes.find((n) => n.id === "A")?.params
  );
  check(
    "transform: only the transformed layer splits",
    !flat.nodes.some((n) => n.id === layerXformId("B"))
  );
  const { res, drawOf } = run(graph);
  check("transform: evaluates without errors", Object.keys(res.errors).length === 0, JSON.stringify(res.errors));
  const d = drawOf("A");
  check("transform: bottom layer skips the passthrough shortcut and draws", d?.key === "layer/blend-xform-v1", d?.key);
  const inv = expectedInv([{ translateX: 0.1, translateY: 0.1 }]);
  check(
    "transform: inverse translation is width-relative (y × W/H)",
    close(d?.u.u_invT?.[0], -0.1) && close(d?.u.u_invT?.[1], -0.1 * (W / H)) &&
      close(d?.u.u_invT?.[0], inv.tx) && close(d?.u.u_invT?.[1], inv.ty),
    JSON.stringify(d?.u.u_invT)
  );
  check(
    "transform: content size is bound for the edge antialias",
    close(d?.u.u_res?.[0], W) && close(d?.u.u_res?.[1], H),
    JSON.stringify(d?.u.u_res)
  );
  check("transform: the untransformed layer above keeps the pairwise blend", drawOf("B")?.key === "merge/blend-v3");
}

{
  // 45° rotation on 16:9: the bound inverse is the aspect-conjugated one.
  const graph = stackGraph([{ id: "A", params: { rotate: 45 } }]);
  const { drawOf } = run(graph);
  const inv = expectedInv([{ rotate: 45 }]);
  const u = drawOf("A")?.u.u_invA;
  check(
    "transform: rotation binds the aspect-rigid inverse",
    !!u && close(u[0], inv.a) && close(u[1], inv.b) && close(u[2], inv.c) && close(u[3], inv.d),
    JSON.stringify(u)
  );
}

// ── Parenting ───────────────────────────────────────────────────────────
{
  // Child A sits BELOW parent B: A → B.stack and B.transform → A.
  const graph = stackGraph(
    [{ id: "A" }, { id: "B", params: { translateX: 0.2 } }],
    [["A", "B"]]
  );
  const flat = flattenGraph(graph.nodes, graph.edges);
  check(
    "parenting: the parent's aux:transform edge now sources from its layer-xform node",
    flat.edges.some((e) => e.source === layerXformId("B") && e.target === layerXformId("A") && e.targetHandle === "in:parent")
  );
  check(
    "parenting: no raw transform edge between the layer shells survives",
    !flat.edges.some((e) => e.sourceHandle === "out:aux:transform" || (e.targetHandle === "in:transform" && e.target === "A"))
  );
  const { res, drawOf } = run(graph);
  check(
    "parenting: a child below its parent evaluates (no cycle)",
    Object.keys(res.errors).length === 0,
    JSON.stringify(res.errors)
  );
  check(
    "parenting: the child inherits the parent's translation",
    drawOf("A")?.key === "layer/blend-xform-v1" && close(drawOf("A")?.u.u_invT?.[0], -0.2),
    JSON.stringify(drawOf("A"))
  );
  check("parenting: the parent moves its own content too", close(drawOf("B")?.u.u_invT?.[0], -0.2));
}

{
  // Gated parent (outside its clip window) still drives its child.
  const graph = stackGraph(
    [{ id: "A" }, { id: "B", params: { translateX: 0.2 }, extra: { clips: [defaultClip(9_000_000, 9_900_000)] } }],
    [["A", "B"]]
  );
  const { res, drawOf } = run(graph, 0);
  check("parenting: a gated parent passes the stack through", res.outputs.get("B")?.primary === res.outputs.get("A")?.primary);
  check(
    "parenting: a gated parent still drives its child",
    close(drawOf("A")?.u.u_invT?.[0], -0.2),
    JSON.stringify(drawOf("A"))
  );
}

{
  // Bypassed (eye off) parent still drives its child.
  const graph = stackGraph(
    [{ id: "A" }, { id: "B", params: { translateX: 0.2 }, extra: { bypassed: true } }],
    [["A", "B"]]
  );
  const { drawOf } = run(graph);
  check("parenting: a bypassed parent still drives its child", close(drawOf("A")?.u.u_invT?.[0], -0.2), JSON.stringify(drawOf("A")));
}

{
  // A gated child stops pulling its own transform; nothing else needs it.
  const graph = stackGraph([
    // Far past the pre-roll window, which deliberately keeps an upcoming
    // layer's interior warm.
    { id: "A", params: { translateX: 0.1 }, extra: { clips: [defaultClip(9_000_000, 9_900_000)] } },
    { id: "B" },
  ]);
  const { res } = run(graph, 0);
  check(
    "gating: a gated layer's own layer-xform isn't evaluated",
    !res.outputs.has(layerXformId("A"))
  );
}

{
  // Three levels: A (child) → B (parent, rotates 90) → C (grandparent,
  // translates). World for A = C ∘ B ∘ A.
  const pa = { translateX: 0.25 };
  const pb = { rotate: 90 };
  const pc = { translateX: 0.1 };
  const graph = stackGraph(
    [{ id: "A", params: pa }, { id: "B", params: pb }, { id: "C", params: pc }],
    [["A", "B"], ["B", "C"]]
  );
  const { res, drawOf } = run(graph);
  const ops = (res.outputs.get(layerXformId("A"))?.primary as any)?.ops ?? [];
  check(
    "chain: the child's world ops run child → parent → grandparent",
    ops.length === 3 && close(ops[0].translateX, 0.25) && close(ops[1].rotateDeg, 90) && close(ops[2].translateX, 0.1),
    JSON.stringify(ops)
  );
  const inv = expectedInv([pa, pb, pc]);
  const d = drawOf("A")?.u;
  check(
    "chain: the child binds the inverse of the composed canvas affine",
    !!d && close(d.u_invA[0], inv.a) && close(d.u_invA[1], inv.b) && close(d.u_invA[2], inv.c) &&
      close(d.u_invA[3], inv.d) && close(d.u_invT[0], inv.tx) && close(d.u_invT[1], inv.ty),
    JSON.stringify(d)
  );
}

{
  // A parenting loop (hand-mangled): the evaluator's topo sort would drop
  // every node on/downstream of the cycle — a blank frame. Flatten cuts
  // the link that closes the loop, so the frame still renders.
  const graph = stackGraph(
    [{ id: "A", params: { translateX: 0.1 } }, { id: "B", params: { translateX: 0.2 } }],
    [["A", "B"], ["B", "A"]]
  );
  const flat = flattenGraph(graph.nodes, graph.edges);
  const links = flat.edges.filter((e) => e.targetHandle === "in:parent");
  check("loop: exactly one parent link of a two-layer loop is cut", links.length === 1, JSON.stringify(links));
  const { res } = run(graph);
  check("loop: the frame still renders (Output computes)", res.outputs.has("O"), JSON.stringify(res.errors));
  const three = stackGraph(
    [{ id: "A", params: { rotate: 10 } }, { id: "B" }, { id: "C" }],
    [["A", "B"], ["B", "C"], ["C", "A"]]
  );
  const flat3 = flattenGraph(three.nodes, three.edges);
  check(
    "loop: a three-layer loop keeps two of its three links",
    flat3.edges.filter((e) => e.targetHandle === "in:parent").length === 2
  );
  check("loop: a three-layer loop still renders", run(three).res.outputs.has("O"));
}

// ── Keyframes ───────────────────────────────────────────────────────────
{
  let block = emptyAnimationBlock();
  block = upsertKeyframe(block, 0, 0, "linear");
  block = upsertKeyframe(block, 30000, 0.3, "linear");
  block = { ...block, animated: true };
  const graph = stackGraph([{ id: "A", extra: { animation: { translateX: block } } }]);
  const flat = flattenGraph(graph.nodes, graph.edges);
  check(
    "keyframes: TRS keys split the layer even with identity static params",
    flat.nodes.some((n) => n.id === layerXformId("A"))
  );
  const mid = run(graph, 15000).drawOf("A");
  check(
    "keyframes: the transform follows the keyed value (midpoint 0.15)",
    mid?.key === "layer/blend-xform-v1" && close(mid?.u.u_invT?.[0], -0.15),
    JSON.stringify(mid)
  );
  const start = run(graph, 0);
  check(
    "keyframes: at the identity key the bottom layer is untouched again",
    start.res.outputs.get("A")?.primary === start.res.outputs.get("A.src")?.primary
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall layer-transform checks passed");
