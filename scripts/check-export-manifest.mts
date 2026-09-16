// check-export-manifest: guards buildExportManifest's reachability seed.
//
// The live link (/live/[slug]) and the exported app render whatever terminal
// is viewport-active, and the manifest builder only emits controls on nodes
// reachable from that terminal. A Layer's Group Output can be that terminal
// (the author was previewing inside the layer when they saved) — but flatten
// DISSOLVES Group Output boundary nodes, so seeding computeNeededSet with its
// id reached nothing: every control vanished from the panel while the canvas
// kept rendering (evaluateGraph remaps structural targets before its own
// flatten; the builder didn't). Reported 2026-09-15 as "marking constants as
// live controls makes all the controls disappear".
//
// It also guards the per-node slider range overrides (right-click "Slider
// range" on a scalar → node.data.paramOverrides min / max / softMax). The
// live viewer's ControlPanel renders ParamControl from `control.def` ALONE —
// no `rangeOverride` prop — so the builder must bake the override into the
// cloned def or the live link / exported app keeps the node def's stock
// range (reported 2026-09-15: editing min/max/soft max didn't change the
// live link's sliders).
//
//   npx tsx scripts/check-export-manifest.mts
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
registerAllNodes(); // makeInstanceNode mints nodes via the registry
const { makeInstanceNode, makeLayerNodes } = await import("@/state/graph-ops");
const { buildExportManifest } = await import("@/lib/export-manifest");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const edge = (id: string, source: string, target: string, targetHandle: string): any => ({
  id,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});

// Fixture — the shape of the reported project, minimized:
//
//   root:   Layer ──▶ Output
//   layer:  Constant(value, CONTROL) ──▶ Transform.param:scaleX ──▶ Group Output.image
//
// with the Layer's Group Output as the viewport-active terminal (the
// composition Output is NOT active).
const output = makeInstanceNode("output", { x: 800, y: 0 });
const { layer, groupInput, groupOutput } = makeLayerNodes("Layer 1", { x: 400, y: 0 });
const constant = makeInstanceNode("constant", { x: 0, y: 0 });
const transform = makeInstanceNode("transform", { x: 200, y: 0 });
constant.data.parentId = layer.id;
transform.data.parentId = layer.id;
constant.data.controlParams = ["value"];
transform.data.exposedParams = ["scaleX"];
transform.data.controlParams = ["rotate"];
output.data.active = false;
groupOutput.data.active = true;

const nodes: any[] = [output, layer, groupInput, groupOutput, constant, transform];
const edges: any[] = [
  edge("e-layer-out", layer.id, output.id, "in:image"),
  edge("e-xf-go", transform.id, groupOutput.id, "in:image"),
  edge("e-c-xf", constant.id, transform.id, "in:param:scaleX"),
];

const build = (outputNodeId: string) =>
  buildExportManifest({ nodes, edges, appName: "t", outputNodeId, canvasRes: [64, 64] });
const keys = (m: { controls: { nodeId: string; paramName: string }[] }) =>
  m.controls.map((c) => `${c.nodeId}::${c.paramName}`).sort();
const want = [`${constant.id}::value`, `${transform.id}::rotate`].sort();

// --- 1. The regression: a Layer's Group Output as the active terminal ---
{
  const { manifest, warnings } = build(groupOutput.id);
  check(
    "Group Output terminal reaches the layer's interior controls",
    JSON.stringify(keys(manifest)) === JSON.stringify(want),
    JSON.stringify(keys(manifest))
  );
  check("no 'no-controls' warning", !warnings.some((w) => w.kind === "no-controls"));
  check(
    "manifest.outputNodeId keeps the ORIGINAL id (the viewer remaps it itself)",
    manifest.outputNodeId === groupOutput.id,
    manifest.outputNodeId
  );
}

// --- 2. The composition Output as terminal still sees the same controls ---
{
  const { manifest } = build(output.id);
  check(
    "composition Output terminal reaches the same controls",
    JSON.stringify(keys(manifest)) === JSON.stringify(want),
    JSON.stringify(keys(manifest))
  );
}

// --- 3. A control OUTSIDE the active branch stays out of the manifest ---
{
  const stray = makeInstanceNode("constant", { x: 0, y: 300 });
  stray.data.parentId = layer.id;
  stray.data.controlParams = ["value"];
  const { manifest } = buildExportManifest({
    nodes: [...nodes, stray],
    edges,
    appName: "t",
    outputNodeId: groupOutput.id,
    canvasRes: [64, 64],
  });
  check(
    "an unwired controlled node is not reachable → not a control",
    !keys(manifest).includes(`${stray.id}::value`),
    JSON.stringify(keys(manifest))
  );
}

// --- 4. Unwired Group Output: nothing reachable, but no throw ---
{
  const { manifest, warnings } = buildExportManifest({
    nodes,
    edges: edges.filter((e) => e.id !== "e-xf-go"),
    appName: "t",
    outputNodeId: groupOutput.id,
    canvasRes: [64, 64],
  });
  check("unwired Group Output → zero controls + no-controls warning",
    manifest.controls.length === 0 && warnings.some((w) => w.kind === "no-controls"));
}

// --- 5. Custom slider ranges (paramOverrides) reach the control def ---
// Each field overrides independently, the rest stays at the def's value,
// and the registry def itself must not be mutated (the control is a clone).
{
  const { getNodeDef } = await import("@/engine/registry");
  const stockValue = getNodeDef("constant")!.params.find((p) => p.name === "value")!;
  const stockRotate = getNodeDef("transform")!.params.find((p) => p.name === "rotate")!;
  const stockBefore = JSON.stringify([stockValue.min, stockValue.max, stockValue.softMax]);
  const withOverrides = nodes.map((n) => {
    if (n.id === constant.id) {
      return { ...n, data: { ...n.data, paramOverrides: { value: { min: -2, max: 8, softMax: 4 } } } };
    }
    if (n.id === transform.id) {
      return { ...n, data: { ...n.data, paramOverrides: { rotate: { softMax: 720 } } } };
    }
    return n;
  });
  const { manifest } = buildExportManifest({
    nodes: withOverrides,
    edges,
    appName: "t",
    outputNodeId: groupOutput.id,
    canvasRes: [64, 64],
  });
  const defOf = (nodeId: string, paramName: string) =>
    manifest.controls.find((c) => c.nodeId === nodeId && c.paramName === paramName)!.def;
  const value = defOf(constant.id, "value");
  const rotate = defOf(transform.id, "rotate");
  check(
    "full override (min / max / softMax) lands on the control def",
    value.min === -2 && value.max === 8 && value.softMax === 4,
    JSON.stringify({ min: value.min, max: value.max, softMax: value.softMax })
  );
  check(
    "partial override (softMax only) keeps the def's min / max",
    rotate.softMax === 720 && rotate.min === stockRotate.min && rotate.max === stockRotate.max,
    JSON.stringify({ min: rotate.min, max: rotate.max, softMax: rotate.softMax })
  );
  check(
    "registry def is untouched by the override",
    JSON.stringify([stockValue.min, stockValue.max, stockValue.softMax]) === stockBefore
  );
  const plain = build(groupOutput.id).manifest.controls.find(
    (c) => c.nodeId === constant.id && c.paramName === "value"
  )!.def;
  check(
    "no override → control def carries the stock range",
    plain.min === stockValue.min && plain.max === stockValue.max && plain.softMax === stockValue.softMax,
    JSON.stringify({ min: plain.min, max: plain.max, softMax: plain.softMax })
  );
}

console.log(failures === 0 ? "\ncheck-export-manifest: all passed" : `\ncheck-export-manifest: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
