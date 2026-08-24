// check-time-offset: guards collectTimeOffsetClosures + isTimeOffsetBoundary
// (src/engine/time-offset.ts), the pure closure walk behind the Time Offset
// node (specdocs/081426_time-offset.md).
//
// The walk decides WHAT re-evaluates at the shifted clock, WHERE the
// boundary feeds sit, and WHEN a chained shell must error. A wrong answer
// here is invisible to typecheck and shows up as either a branch silently
// evaluating at the wrong time, a sim's state corrupted from two clock
// domains, or a needed-set hole that blanks part of the graph. Covers:
// direction (only UPSTREAM of the `in` edge), boundary classification
// (simulation:true / retimeable:false / Iterate shells), the
// tap-is-boundary passthrough, chained-shell rejection, param-wire
// traversal, diamond dedupe, and the no-shell fast path.
//
//   npx tsx scripts/check-time-offset.mts
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
const { allNodeDefs } = await import("@/engine/registry");
const {
  collectTimeOffsetClosures,
  isTimeOffsetBoundary,
  feedInputName,
  TIME_OFFSET_EDGE_PREFIX,
  TIME_OFFSET_TYPE,
} = await import("@/engine/time-offset");
const { ITERATE_TYPE } = await import("@/engine/groups");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
  );
}

const node = (id: string, type: string) => ({ id, type, params: {} });
const edge = (
  id: string,
  source: string,
  target: string,
  targetHandle = "in:in",
  sourceHandle = "out:primary"
) => ({ id, source, sourceHandle, target, targetHandle });

// A registered def with simulation:true (exact type string doesn't matter
// — any sim is a boundary by the same rule).
const simType = allNodeDefs().find((d) => d.simulation === true)?.type;
if (!simType) {
  console.log("FAIL no simulation:true def registered");
  failures++;
}

// --- boundary classification ---------------------------------------------
check("boundary: video-source (retimeable:false)", isTimeOffsetBoundary("video-source"), true);
check("boundary: webcam (retimeable:false)", isTimeOffsetBoundary("webcam"), true);
check(`boundary: ${simType} (simulation:true)`, isTimeOffsetBoundary(simType!), true);
check("boundary: iterate shell", isTimeOffsetBoundary(ITERATE_TYPE), true);
check("boundary: unknown type fails closed", isTimeOffsetBoundary("no-such-def"), true);
check("not boundary: constant", isTimeOffsetBoundary("constant"), false);
check("not boundary: scene-time (pure stable:false)", isTimeOffsetBoundary("scene-time"), false);
check("not boundary: math", isTimeOffsetBoundary("math"), false);

// --- no shells → null fast path ------------------------------------------
check(
  "no shells: null",
  collectTimeOffsetClosures([node("a", "constant")], []),
  null
);

// --- simple chain: constant → math → shell -------------------------------
{
  const nodes = [node("c", "constant"), node("m", "math"), node("t", TIME_OFFSET_TYPE)];
  const edges = [edge("e1", "c", "m", "in:a"), edge("e2", "m", "t", "in:in")];
  const c = collectTimeOffsetClosures(nodes, edges)!.get("t")!;
  check("chain: closure ids", c.nodes.map((n) => n.id).sort(), ["c", "m"]);
  check("chain: closure edges", c.edges.map((e) => e.id), ["e1"]);
  check("chain: tap", c.tap, { producerId: "m", sourceHandle: "out:primary" });
  check("chain: no feeds", c.feeds.length, 0);
  check("chain: not chained", c.chained, false);
  check("chain: tap not boundary", c.tapIsBoundary, false);
}

// --- only UPSTREAM counts; param wires traverse; diamonds dedupe ---------
{
  const nodes = [
    node("c", "constant"),
    node("lfo", "scene-time"),
    node("m", "math"),
    node("t", TIME_OFFSET_TYPE),
    node("down", "math"),
  ];
  const edges = [
    edge("e1", "c", "m", "in:a"),
    // Exposed-param wire — its producer is part of the branch's animation.
    edge("e2", "lfo", "m", "in:param:b"),
    // Diamond: lfo also feeds the same node's data input.
    edge("e3", "lfo", "m", "in:b"),
    edge("e4", "m", "t", "in:in"),
    // Downstream of the shell — must NOT join the closure.
    edge("e5", "t", "down", "in:a"),
  ];
  const c = collectTimeOffsetClosures(nodes, edges)!.get("t")!;
  check("upstream only: closure ids", c.nodes.map((n) => n.id).sort(), ["c", "lfo", "m"]);
  check("upstream only: edges deduped", c.edges.map((e) => e.id).sort(), ["e1", "e2", "e3"]);
}

// --- boundary mid-branch: video → math → shell ---------------------------
{
  const nodes = [node("v", "video-source"), node("m", "math"), node("t", TIME_OFFSET_TYPE)];
  const edges = [edge("e1", "v", "m", "in:a"), edge("e2", "m", "t", "in:in")];
  const c = collectTimeOffsetClosures(nodes, edges)!.get("t")!;
  check("feed: closure ids", c.nodes.map((n) => n.id), ["m"]);
  check("feed: crossing edge", c.feeds.map((f) => f.edge.id), ["e1"]);
  check("feed: input name", c.feeds[0].inputName, feedInputName("e1"));
  check("feed: prefix", c.feeds[0].inputName.startsWith(TIME_OFFSET_EDGE_PREFIX), true);
  check("feed: boundary types", c.boundaryTypes, ["video-source"]);
}

// --- sim + iterate boundaries classify the same way ----------------------
{
  const nodes = [node("s", simType!), node("it", ITERATE_TYPE), node("m", "math"), node("t", TIME_OFFSET_TYPE)];
  const edges = [
    edge("e1", "s", "m", "in:a"),
    edge("e2", "it", "m", "in:b", "out:aux:collect"),
    edge("e3", "m", "t", "in:in"),
  ];
  const c = collectTimeOffsetClosures(nodes, edges)!.get("t")!;
  check("sim/iterate: feeds", c.feeds.map((f) => f.edge.id).sort(), ["e1", "e2"]);
  check("sim/iterate: aux handle preserved", c.feeds.find((f) => f.edge.id === "e2")!.edge.sourceHandle, "out:aux:collect");
  check("sim/iterate: boundary types", [...c.boundaryTypes].sort(), [ITERATE_TYPE, simType].sort());
}

// --- tap producer itself a boundary: passthrough -------------------------
{
  const nodes = [node("v", "video-source"), node("t", TIME_OFFSET_TYPE)];
  const edges = [edge("e1", "v", "t", "in:in")];
  const c = collectTimeOffsetClosures(nodes, edges)!.get("t")!;
  check("tap boundary: flag", c.tapIsBoundary, true);
  check("tap boundary: tap recorded", c.tap, { producerId: "v", sourceHandle: "out:primary" });
  check("tap boundary: empty closure", c.nodes.length, 0);
}

// --- chained shells reject ------------------------------------------------
{
  const nodes = [
    node("c", "constant"),
    node("t1", TIME_OFFSET_TYPE),
    node("m", "math"),
    node("t2", TIME_OFFSET_TYPE),
  ];
  const edges = [
    edge("e1", "c", "t1", "in:in"),
    edge("e2", "t1", "m", "in:a"),
    edge("e3", "m", "t2", "in:in"),
  ];
  const stash = collectTimeOffsetClosures(nodes, edges)!;
  check("chained: downstream shell flagged", stash.get("t2")!.chained, true);
  check("chained: upstream shell fine", stash.get("t1")!.chained, false);
  // Directly chained (shell → shell) flags too.
  const direct = collectTimeOffsetClosures(
    [node("t1", TIME_OFFSET_TYPE), node("t2", TIME_OFFSET_TYPE)],
    [edge("e1", "t1", "t2", "in:in")]
  )!;
  check("chained: direct", direct.get("t2")!.chained, true);
}

// --- unwired shell --------------------------------------------------------
{
  const c = collectTimeOffsetClosures([node("t", TIME_OFFSET_TYPE)], [])!.get("t")!;
  check("unwired: null tap", c.tap, null);
  check("unwired: empty closure", c.nodes.length, 0);
}

console.log(failures === 0 ? "\ncheck-time-offset: all passed" : `\ncheck-time-offset: ${failures} FAILURES`);
if (failures > 0) process.exit(1);
