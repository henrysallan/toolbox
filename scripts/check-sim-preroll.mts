// check-sim-preroll: guards outputNeedsSimPreroll (src/lib/sim-preroll.ts),
// the predicate the still-image export drivers use to decide whether a
// capture has to re-step the sims from frame 0.
//
// It matters in both directions. A false negative ships the bug this was
// written for: switching to the export resolution recreates the engine
// backend, which wipes ctx.state, so the still is captured from a
// freshly-seeded sim (or a blank frame, for the solvers that publish their
// readback one frame late). A false positive makes every still export of a
// sim-free graph pay for a pointless frame-0-to-N re-render.
//
// Covers: direction (only UPSTREAM of the Output counts), reachability
// (a sim on a branch that doesn't feed the Output doesn't force a pre-roll),
// flattening (a sim nested in a layer/group still counts), and bypass.
//
//   npx tsx scripts/check-sim-preroll.mts
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
const { outputNeedsSimPreroll } = await import("@/lib/sim-preroll");
const { getNodeDef, allNodeDefs } = await import("@/engine/registry");
const { LAYER_TYPE } = await import("@/engine/groups");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${actual}, want ${expected}`}`);
}

const node = (
  id: string,
  defType: string,
  extra: Record<string, unknown> = {}
) =>
  ({
    id,
    position: { x: 0, y: 0 },
    data: { defType, params: {}, ...extra },
  }) as any;

const edge = (
  source: string,
  target: string,
  sourceHandle = "out:primary",
  targetHandle = "in:image"
) => ({ id: `${source}->${target}`, source, target, sourceHandle, targetHandle }) as any;

// ---------------------------------------------------------------------
// The flag itself — a set of node types the drivers rely on being marked.
// Not exhaustive (new sims should add themselves), but a rename or a
// dropped flag on any of these silently reintroduces the export bug.
// ---------------------------------------------------------------------
const MUST_BE_SIMS = [
  "matter-simulator",
  "fluid-simulator",
  "particle-simulator",
  "rigid-body-simulator",
  "rope-simulator",
  "physarum",
  "reaction-diffusion",
  "watercolor-ink",
  "differential-growth",
  "behavioral-growth",
  "advect-points",
  "accumulator",
  "trails",
  "datamosh",
  "smooth",
  "shortest-path",
  "simulation-start",
  "simulation-end",
];
for (const type of MUST_BE_SIMS) {
  check(`${type} is marked simulation`, !!getNodeDef(type)?.simulation, true);
}
// Stateless nodes must NOT be marked — a stray flag taxes every export.
for (const type of ["blur", "output", "transform"]) {
  const def = getNodeDef(type);
  if (def) check(`${type} is not marked simulation`, !!def.simulation, false);
}
console.log(
  `    (${allNodeDefs().filter((d) => d.simulation).length} node types marked simulation)`
);

// ---------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------
{
  // sim → blur → output
  const nodes = [
    node("sim", "reaction-diffusion"),
    node("blur", "blur"),
    node("out", "output"),
  ];
  const edges = [edge("sim", "blur"), edge("blur", "out")];
  check("sim upstream of the Output", outputNeedsSimPreroll(nodes, edges, "out"), true);
}

{
  // No sim anywhere — the fast path.
  const nodes = [node("blur", "blur"), node("out", "output")];
  check(
    "sim-free graph",
    outputNeedsSimPreroll(nodes, [edge("blur", "out")], "out"),
    false
  );
}

{
  // A sim exists, but on a branch feeding a DIFFERENT Output. Exporting
  // `out` must not pay for it.
  const nodes = [
    node("sim", "physarum"),
    node("otherOut", "output"),
    node("blur", "blur"),
    node("out", "output"),
  ];
  const edges = [edge("sim", "otherOut"), edge("blur", "out")];
  check(
    "sim on an unrelated branch",
    outputNeedsSimPreroll(nodes, edges, "out"),
    false
  );
}

{
  // Direction: the sim is DOWNSTREAM of the Output being exported. It
  // can't affect that Output's image, so no pre-roll.
  const nodes = [
    node("blur", "blur"),
    node("out", "output"),
    node("sim", "trails"),
  ];
  const edges = [edge("blur", "out"), edge("out", "sim")];
  check(
    "sim downstream of the Output",
    outputNeedsSimPreroll(nodes, edges, "out"),
    false
  );
}

{
  // Bypassed sims contribute nothing to the render.
  const nodes = [
    node("sim", "reaction-diffusion", { bypassed: true }),
    node("out", "output"),
  ];
  check(
    "bypassed sim",
    outputNeedsSimPreroll(nodes, [edge("sim", "out")], "out"),
    false
  );
}

{
  // Nested in a layer: flattenGraph dissolves the container into plain
  // edges, so the walk still reaches the sim. This is the case a naive
  // top-level scan would miss.
  const nodes = [
    node("layer", LAYER_TYPE),
    node("sim", "reaction-diffusion", { parentId: "layer" }),
    node("out", "output"),
  ];
  const edges = [edge("sim", "layer"), edge("layer", "out")];
  check(
    "sim nested inside a layer",
    outputNeedsSimPreroll(nodes, edges, "out"),
    true
  );
}

console.log(failures === 0 ? "\nALL GREEN ✅" : `\n${failures} FAILURE(S) ❌`);
process.exit(failures === 0 ? 0 : 1);
