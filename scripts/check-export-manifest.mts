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

// --- 6. Per-layer Merge controls (mlayer:<param>:<layerId>) ---
// One toggled layer → a blend-mode enum + an opacity scalar, each under a
// virtual paramName carrying the layer's current value as default. A legacy
// literal "layers" entry expands to every layer; a stale layer id warns.
{
  const { mergeLayerKey, mergeLayerModeKey, mergeLayerOpacityKey } = await import(
    "@/engine/conventions"
  );
  const { newLayerId } = await import("@/nodes/effect/merge");
  const out2 = makeInstanceNode("output", { x: 400, y: 600 });
  const merge = makeInstanceNode("merge", { x: 200, y: 600 });
  const src = makeInstanceNode("constant", { x: 0, y: 600 });
  const first = (merge.data.params.layers as any[])[0];
  const second = { id: newLayerId(), mode: "screen", opacity: 0.25 };
  merge.data.params = { ...merge.data.params, layers: [first, second] };
  const mNodes = [out2, merge, src];
  const mEdges = [
    edge("e-m-o", merge.id, out2.id, "in:image"),
    edge("e-s-m", src.id, merge.id, "in:base"),
  ];
  const buildMerge = (controlParams: string[]) =>
    buildExportManifest({
      nodes: mNodes.map((n) =>
        n.id === merge.id ? { ...n, data: { ...n.data, controlParams } } : n
      ),
      edges: mEdges,
      appName: "t",
      outputNodeId: out2.id,
      canvasRes: [64, 64],
    });

  const one = buildMerge([mergeLayerKey("layers", second.id)]);
  const names = one.manifest.controls.map((c) => c.paramName).sort();
  check(
    "one toggled layer → blend + opacity controls under the virtual names",
    JSON.stringify(names) ===
      JSON.stringify(
        [mergeLayerModeKey("layers", second.id), mergeLayerOpacityKey("layers", second.id)].sort()
      ),
    JSON.stringify(names)
  );
  const modeCtl = one.manifest.controls.find((c) => c.paramName === mergeLayerModeKey("layers", second.id))!;
  const opCtl = one.manifest.controls.find((c) => c.paramName === mergeLayerOpacityKey("layers", second.id))!;
  check(
    "blend control is an enum over the blend modes, defaulting to the layer's mode",
    modeCtl.paramType === "enum" &&
      Array.isArray(modeCtl.def.options) &&
      modeCtl.def.options.includes("screen") &&
      modeCtl.def.default === "screen" &&
      modeCtl.label === "Layer 2 · blend",
    JSON.stringify({ type: modeCtl.paramType, def: modeCtl.def.default, label: modeCtl.label })
  );
  check(
    "opacity control is a 0..1 scalar defaulting to the layer's opacity",
    opCtl.paramType === "scalar" && opCtl.def.min === 0 && opCtl.def.max === 1 && opCtl.def.default === 0.25,
    JSON.stringify({ type: opCtl.paramType, min: opCtl.def.min, max: opCtl.def.max, def: opCtl.def.default })
  );
  check(
    "the untoggled layer contributes no controls",
    !names.some((n) => n.endsWith(":" + first.id)),
    JSON.stringify(names)
  );

  const legacy = buildMerge(["layers"]);
  const legacyNames = legacy.manifest.controls.map((c) => c.paramName).sort();
  check(
    "legacy literal 'layers' control expands to every layer's blend + opacity",
    JSON.stringify(legacyNames) ===
      JSON.stringify(
        [
          mergeLayerModeKey("layers", first.id),
          mergeLayerOpacityKey("layers", first.id),
          mergeLayerModeKey("layers", second.id),
          mergeLayerOpacityKey("layers", second.id),
        ].sort()
      ),
    JSON.stringify(legacyNames)
  );

  const stale = buildMerge([mergeLayerKey("layers", "lyr-gone")]);
  check(
    "a toggle on a removed layer → control-on-missing-param warning, no control",
    stale.manifest.controls.length === 0 &&
      stale.warnings.some((w) => w.kind === "control-on-missing-param"),
    JSON.stringify(stale.warnings.map((w) => w.kind))
  );
}

// --- 7. Switch: param-driven scalar hints bake into the control def ---
// maxFrom / controlFrom / optionLabelsFrom are functions, so the JSON clone
// drops them, and the live panel renders the def with no sibling params to
// feed them — the builder must evaluate them at build time. Slider mode:
// max = live slot count − 1 (the static fallback is SWITCH_COUNT_CAP − 1,
// which is the 0…255 slider /live used to show). Toggle mode: control
// "segmented", max = wired inputs − 1 (the auto-grow spare excluded), option
// labels from the per-slot names keyed by the index value each state picks.
{
  const { getNodeDef } = await import("@/engine/registry");
  const { SWITCH_COUNT_CAP } = await import("@/engine/graph-helpers");
  const out3 = makeInstanceNode("output", { x: 400, y: 900 });
  const sw = makeInstanceNode("switch", { x: 200, y: 900 });
  const a = makeInstanceNode("constant", { x: 0, y: 880 });
  const b = makeInstanceNode("constant", { x: 0, y: 900 });
  const c = makeInstanceNode("constant", { x: 0, y: 920 });
  // Three wired inputs plus the trailing spare — the `slots` EffectsApp's
  // auto-grow reconciler leaves for this wiring.
  sw.data.params = { ...sw.data.params, slots: ["in0", "in1", "in2", "in3"] };
  sw.data.controlParams = ["index"];
  const sNodes = [out3, sw, a, b, c];
  const sEdges = [
    edge("e-sw-o", sw.id, out3.id, "in:image"),
    edge("e-a-sw", a.id, sw.id, "in:in0"),
    edge("e-b-sw", b.id, sw.id, "in:in1"),
    edge("e-c-sw", c.id, sw.id, "in:in2"),
  ];
  const buildSwitch = (params: Record<string, unknown>, data: Record<string, unknown> = {}) =>
    buildExportManifest({
      nodes: sNodes.map((n) =>
        n.id === sw.id
          ? { ...n, data: { ...n.data, ...data, params: { ...n.data.params, ...params } } }
          : n
      ),
      edges: sEdges,
      appName: "t",
      outputNodeId: out3.id,
      canvasRes: [64, 64],
    });
  const indexDef = (m: { manifest: { controls: any[] } }) =>
    m.manifest.controls.find((c) => c.nodeId === sw.id && c.paramName === "index")!.def;

  const slider = indexDef(buildSwitch({}));
  check(
    "slider mode: index max follows the live slot list, not the static cap",
    slider.max === 3 && slider.control === undefined && slider.optionLabels === undefined,
    JSON.stringify({ max: slider.max, control: slider.control })
  );

  const toggle = indexDef(
    buildSwitch({ mode: "toggle", labels: { in0: "Day", in1: "", in2: " Dusk " } })
  );
  check(
    "toggle mode: segmented pick over the wired inputs (spare excluded)",
    toggle.control === "segmented" && toggle.max === 2 && toggle.min === 0 && toggle.step === 1,
    JSON.stringify({ control: toggle.control, min: toggle.min, max: toggle.max })
  );
  check(
    "toggle mode: names bake in keyed by index value; blank names fall back to the number",
    JSON.stringify(toggle.optionLabels) === JSON.stringify({ "0": "Day", "2": "Dusk" }),
    JSON.stringify(toggle.optionLabels)
  );

  const stockIndex = getNodeDef("switch")!.params.find((p) => p.name === "index")!;
  check(
    "registry def keeps its static fallback and its hint functions",
    stockIndex.max === SWITCH_COUNT_CAP - 1 &&
      stockIndex.control === undefined &&
      stockIndex.optionLabels === undefined &&
      typeof stockIndex.maxFrom === "function" &&
      typeof stockIndex.controlFrom === "function",
    JSON.stringify({ max: stockIndex.max, control: stockIndex.control })
  );

  const overridden = indexDef(
    buildSwitch({ mode: "toggle" }, { paramOverrides: { index: { max: 1 } } })
  );
  check(
    "a per-node range override still beats the baked maxFrom",
    overridden.max === 1 && overridden.control === "segmented",
    JSON.stringify({ max: overridden.max, control: overridden.control })
  );

  const named = buildSwitch({ mode: "toggle" }, { controlParams: ["index", "labels"] });
  check(
    "the names param itself is not a viewer control (unsupported-type warning)",
    named.manifest.controls.every((c) => c.paramName !== "labels") &&
      named.warnings.some(
        (w) => w.kind === "control-on-unsupported-type" && w.paramName === "labels"
      ),
    JSON.stringify(named.warnings.map((w) => `${w.kind}:${w.paramName}`))
  );
}

// --- 8. Active-branch filter: which rows SHOW follows the Switch's pick ---
// engine/active-branch.ts is the manifest walk with one change — at a
// Switch only the picked slot's upstream counts — and the live panel hides
// rows whose node isn't in the set. Two Color Ramps behind a Switch: the
// pick decides which ramp's rows show. Conservative where the pick isn't a
// hand-set value: a wired, keyframed or bypassed Switch shows everything.
{
  const { computeActiveNodeSet } = await import("@/engine/active-branch");
  const toGraph = (ns: any[], es: any[]) => ({
    nodes: ns.map((n) => ({
      id: n.id,
      type: n.data.defType,
      parentId: n.data.parentId,
      params: n.data.params,
      exposedParams: n.data.exposedParams,
      animation: n.data.animation,
      clips: n.data.clips,
      bypassed: n.data.bypassed,
    })),
    edges: es.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "",
      target: e.target,
      targetHandle: e.targetHandle ?? "",
    })),
  });
  const out4 = makeInstanceNode("output", { x: 400, y: 1200 });
  const sw2 = makeInstanceNode("switch", { x: 200, y: 1200 });
  const rampA = makeInstanceNode("constant", { x: 0, y: 1180 });
  const rampB = makeInstanceNode("constant", { x: 0, y: 1220 });
  // Feeds BOTH branches — must stay whichever is picked.
  const shared = makeInstanceNode("constant", { x: -200, y: 1200 });
  sw2.data.params = { ...sw2.data.params, slots: ["in0", "in1", "in2"], index: 0 };
  const base: any[] = [out4, sw2, rampA, rampB, shared];
  const baseEdges: any[] = [
    edge("e-sw2-o", sw2.id, out4.id, "in:image"),
    edge("e-a-sw2", rampA.id, sw2.id, "in:in0"),
    edge("e-b-sw2", rampB.id, sw2.id, "in:in1"),
    edge("e-sh-a", shared.id, rampA.id, "in:param:value"),
    edge("e-sh-b", shared.id, rampB.id, "in:param:value"),
  ];
  const active = (ns: any[] = base, es: any[] = baseEdges, opts?: any) => {
    const g = toGraph(ns, es);
    return computeActiveNodeSet(g.nodes, g.edges, out4.id, opts);
  };
  const ids = (s: Set<string>) => [...s].sort().join(",");

  const at0 = active();
  check(
    "index 0: branch A shows, branch B hides; the Switch and Output stay",
    at0.has(rampA.id) && !at0.has(rampB.id) && at0.has(sw2.id) && at0.has(out4.id),
    ids(at0)
  );
  const at1 = active(base, baseEdges, {
    indexOf: (id: string) => (id === sw2.id ? 1 : undefined),
  });
  check(
    "a live index of 1 (the viewer's pill) flips it: B shows, A hides",
    at1.has(rampB.id) && !at1.has(rampA.id),
    ids(at1)
  );
  check(
    "a node feeding BOTH branches stays whichever is picked",
    at0.has(shared.id) && at1.has(shared.id),
    JSON.stringify({ at0: at0.has(shared.id), at1: at1.has(shared.id) })
  );
  const spare = active(base, baseEdges, {
    indexOf: (id: string) => (id === sw2.id ? 2 : undefined),
  });
  check(
    "picking the empty spare hides both branches (nothing is rendering from the Switch)",
    !spare.has(rampA.id) && !spare.has(rampB.id) && spare.has(sw2.id),
    ids(spare)
  );

  const idxSrc = makeInstanceNode("constant", { x: 0, y: 1260 });
  const wired = active(
    [...base, idxSrc],
    [...baseEdges, edge("e-i-sw2", idxSrc.id, sw2.id, "in:index")]
  );
  check(
    "a wire-driven index shows both branches (no per-frame flicker)",
    wired.has(rampA.id) && wired.has(rampB.id) && wired.has(idxSrc.id),
    ids(wired)
  );
  const exposed = active(
    [...base, idxSrc],
    [...baseEdges, edge("e-ip-sw2", idxSrc.id, sw2.id, "in:param:index")]
  );
  check(
    "an index driven through the exposed param socket shows both branches",
    exposed.has(rampA.id) && exposed.has(rampB.id),
    ids(exposed)
  );
  const withAnim = (animated: boolean) =>
    base.map((n) =>
      n.id === sw2.id
        ? {
            ...n,
            data: {
              ...n.data,
              animation: {
                index: { animated, trackVisible: true, keyframes: [{ tick: 0, value: 1 }] },
              },
            },
          }
        : n
    );
  const keyed = active(withAnim(true));
  check(
    "a keyframed index (animation on) shows both branches",
    keyed.has(rampA.id) && keyed.has(rampB.id),
    ids(keyed)
  );
  const keysOff = active(withAnim(false));
  check(
    "keyframes with animation switched off count as hand-set (index 0 → A only)",
    keysOff.has(rampA.id) && !keysOff.has(rampB.id),
    ids(keysOff)
  );
  const bypassed = active(
    base.map((n) => (n.id === sw2.id ? { ...n, data: { ...n.data, bypassed: true } } : n))
  );
  check(
    "a bypassed Switch shows both branches",
    bypassed.has(rampA.id) && bypassed.has(rampB.id),
    ids(bypassed)
  );

  // Inside a Layer, seeded from its Group Output (the structural-terminal
  // case section 1 guards for the builder): remap + flatten first.
  const { layer: L2, groupInput: LI2, groupOutput: LO2 } = makeLayerNodes("Layer 2", { x: 400, y: 1400 });
  const out5 = makeInstanceNode("output", { x: 800, y: 1400 });
  const sw3 = makeInstanceNode("switch", { x: 200, y: 1400 });
  const a3 = makeInstanceNode("constant", { x: 0, y: 1380 });
  const b3 = makeInstanceNode("constant", { x: 0, y: 1420 });
  sw3.data.params = { ...sw3.data.params, slots: ["in0", "in1", "in2"], index: 1 };
  for (const n of [sw3, a3, b3]) n.data.parentId = L2.id;
  out5.data.active = false;
  LO2.data.active = true;
  const g = toGraph(
    [out5, L2, LI2, LO2, sw3, a3, b3],
    [
      edge("e-L2-o5", L2.id, out5.id, "in:image"),
      edge("e-sw3-LO2", sw3.id, LO2.id, "in:image"),
      edge("e-a3-sw3", a3.id, sw3.id, "in:in0"),
      edge("e-b3-sw3", b3.id, sw3.id, "in:in1"),
    ]
  );
  const inLayer = computeActiveNodeSet(g.nodes, g.edges, LO2.id);
  check(
    "inside a Layer, seeded from its Group Output: index 1 keeps B, hides A",
    inLayer.has(b3.id) && !inLayer.has(a3.id) && inLayer.has(sw3.id),
    ids(inLayer)
  );
}

// --- 7. On-canvas handles (091726_live-gizmos.md) -------------------------
// The node-level Control toggle (`controlGizmo`) ships a node's GUI as a
// manifest gizmo. The builder must apply the editor's own eligibility and
// wired-away rules (lib/live-gizmo.ts), name the gizmo through the same
// counter as the node's knobs, and skip what the terminal doesn't reach.
{
  const { liveGizmoKind } = await import("@/lib/live-gizmo");
  check("eligibility: Transform → transform gizmo", liveGizmoKind("transform") === "transform");
  check("eligibility: Gizmo node → transform gizmo", liveGizmoKind("gizmo") === "transform");
  check("eligibility: Circle → primitive handles", liveGizmoKind("circle") === "primitive");
  check("eligibility: Gradient → gradient handles", liveGizmoKind("gradient") === "gradient");
  check("eligibility: Spline Draw (the pen suite) never ships", liveGizmoKind("spline-draw") === null);
  check("eligibility: Constant has no GUI", liveGizmoKind("constant") === null);

  //   circleA ──▶ xf (Transform) ──▶ Output.image
  //   circleB ──▶ xf2 (Transform) ──▶ Output.spline
  //   giz (Gizmo) ──▶ xf2.transform  and  ──▶ circleB.transform   (wired away)
  //   const7 ──▶ xf.param:rotate                                  (reachable, no GUI)
  //   stray (Transform)                                           (unreachable)
  const out7 = makeInstanceNode("output", { x: 800, y: 2000 });
  const xf = makeInstanceNode("transform", { x: 400, y: 2000 });
  const xf2 = makeInstanceNode("transform", { x: 400, y: 2100 });
  const circleA = makeInstanceNode("circle", { x: 0, y: 2000 });
  const circleB = makeInstanceNode("circle", { x: 0, y: 2100 });
  const giz = makeInstanceNode("gizmo", { x: 0, y: 2200 });
  const const7 = makeInstanceNode("constant", { x: 0, y: 2300 });
  const stray = makeInstanceNode("transform", { x: 0, y: 2400 });
  out7.data.active = true;
  for (const n of [xf, xf2, circleA, circleB, giz, const7, stray]) n.data.controlGizmo = true;
  xf.data.exposedParams = ["rotate"];
  xf.data.controlParams = ["scaleX"];
  const nodes7: any[] = [out7, xf, xf2, circleA, circleB, giz, const7, stray];
  const edges7: any[] = [
    edge("e7-ca-xf", circleA.id, xf.id, "in:image"),
    edge("e7-xf-out", xf.id, out7.id, "in:image"),
    edge("e7-cb-xf2", circleB.id, xf2.id, "in:image"),
    edge("e7-xf2-out", xf2.id, out7.id, "in:spline"),
    edge("e7-giz-xf2", giz.id, xf2.id, "in:transform"),
    edge("e7-giz-cb", giz.id, circleB.id, "in:transform"),
    edge("e7-const-xf", const7.id, xf.id, "in:param:rotate"),
  ];
  const { manifest: m7, warnings: w7 } = buildExportManifest({
    nodes: nodes7,
    edges: edges7,
    appName: "t",
    outputNodeId: out7.id,
    canvasRes: [64, 64],
  });
  const gz = (m7.gizmos ?? []).map((g) => `${g.nodeId}:${g.kind}`).sort();
  const wantGz = [`${xf.id}:transform`, `${circleA.id}:primitive`, `${giz.id}:transform`].sort();
  check(
    "flagged + reachable + eligible + unwired nodes ship (Transform, Circle, Gizmo)",
    JSON.stringify(gz) === JSON.stringify(wantGz),
    JSON.stringify(gz)
  );
  check("a Transform with its transform input wired ships no gizmo", !gz.some((k) => k.startsWith(xf2.id)));
  check("a Circle with its transform input wired ships no gizmo", !gz.some((k) => k.startsWith(circleB.id)));
  check("a flagged node with no GUI (Constant) ships nothing", !gz.some((k) => k.startsWith(const7.id)));
  check("a flagged node the terminal doesn't reach ships nothing", !gz.some((k) => k.startsWith(stray.id)));
  const wiredAway = w7
    .filter((w) => w.kind === "gizmo-hidden-by-wiring")
    .map((w) => w.nodeId)
    .sort();
  check(
    "both wired-away gizmos warn gizmo-hidden-by-wiring (and nothing else does)",
    JSON.stringify(wiredAway) === JSON.stringify([xf2.id, circleB.id].sort()),
    JSON.stringify(wiredAway)
  );
  const xfGizmo = (m7.gizmos ?? []).find((g) => g.nodeId === xf.id);
  const xfControl = m7.controls.find((c) => c.nodeId === xf.id);
  check(
    "a node's gizmo and its knobs share one node name",
    !!xfGizmo && !!xfControl && xfGizmo.nodeName === xfControl.nodeName,
    `${xfGizmo?.nodeName} vs ${xfControl?.nodeName}`
  );
  check(
    "the gizmo's defType is the node's",
    xfGizmo?.defType === "transform" && (m7.gizmos ?? []).find((g) => g.nodeId === circleA.id)?.defType === "circle"
  );
  // A link with handles but no knobs is not "no controls".
  const gizmoOnly = buildExportManifest({
    nodes: [out7, xf2, giz],
    edges: [
      edge("e7b-giz-xf2", giz.id, xf2.id, "in:transform"),
      edge("e7b-xf2-out", xf2.id, out7.id, "in:image"),
    ],
    appName: "t",
    outputNodeId: out7.id,
    canvasRes: [64, 64],
  });
  check(
    "a gizmo-only manifest doesn't warn no-controls",
    (gizmoOnly.manifest.gizmos ?? []).length === 1 &&
      !gizmoOnly.warnings.some((w) => w.kind === "no-controls"),
    JSON.stringify(gizmoOnly.warnings.map((w) => w.kind))
  );
  // The flag is off by default: nothing flagged → no gizmos, no warnings.
  const unflagged = buildExportManifest({
    nodes: nodes7.map((n) => ({ ...n, data: { ...n.data, controlGizmo: undefined } })),
    edges: edges7,
    appName: "t",
    outputNodeId: out7.id,
    canvasRes: [64, 64],
  });
  check(
    "unflagged nodes ship no gizmos and no gizmo warnings",
    (unflagged.manifest.gizmos ?? []).length === 0 &&
      !unflagged.warnings.some((w) => w.kind === "gizmo-hidden-by-wiring")
  );
}

// --- 9. File inputs are opt-in via the Control toggle (2026-09-21) --------
// Every reachable file param used to ship as a File Inputs picker
// unconditionally, so a bundled image source surfaced as "replace this
// image" on every live link. Now: Control-toggled → File Input (never a
// knob); untoggled → bundled, no row.
{
  const out9 = makeInstanceNode("output", { x: 400, y: 0 });
  const imgA = makeInstanceNode("image-source", { x: 0, y: 0 });
  const imgB = makeInstanceNode("image-source", { x: 0, y: 200 });
  const xf9 = makeInstanceNode("transform", { x: 200, y: 0 });
  imgB.data.controlParams = ["file"];
  xf9.data.controlParams = ["rotate"];
  const nodes9: any[] = [out9, imgA, imgB, xf9];
  const edges9: any[] = [
    edge("e9-a-xf", imgA.id, xf9.id, "in:image"),
    edge("e9-b-xf", imgB.id, xf9.id, "in:param:scaleX"),
    edge("e9-xf-out", xf9.id, out9.id, "in:image"),
  ];
  const { manifest: m9, warnings: w9 } = buildExportManifest({
    nodes: nodes9,
    edges: edges9,
    appName: "t",
    outputNodeId: out9.id,
    canvasRes: [64, 64],
  });
  const fileKeys = m9.fileInputs.map((f) => `${f.nodeId}::${f.paramName}`);
  check(
    "an untoggled file param ships NO file input (bundled)",
    !fileKeys.includes(`${imgA.id}::file`),
    JSON.stringify(fileKeys)
  );
  check(
    "a Control-toggled file param ships as a file input",
    JSON.stringify(fileKeys) === JSON.stringify([`${imgB.id}::file`]),
    JSON.stringify(fileKeys)
  );
  check(
    "a Control-toggled file param is NOT also a knob in controls",
    !m9.controls.some((c) => c.nodeId === imgB.id),
    JSON.stringify(keys(m9))
  );
  check(
    "the only knob is the Transform's rotate",
    JSON.stringify(keys(m9)) === JSON.stringify([`${xf9.id}::rotate`]),
    JSON.stringify(keys(m9))
  );
  check(
    "the file input's paramType is the def's file type",
    m9.fileInputs[0]?.paramType === "file" && m9.fileInputs[0]?.nodeName === "Image Source",
    `${m9.fileInputs[0]?.paramType} / ${m9.fileInputs[0]?.nodeName}`
  );
  check(
    "no unexpected warnings",
    w9.length === 0,
    JSON.stringify(w9.map((w) => w.kind))
  );
  // Only a toggled file picker, nothing else — still not "no controls".
  const fileOnly = buildExportManifest({
    nodes: nodes9.map((n) =>
      n.id === xf9.id ? { ...n, data: { ...n.data, controlParams: [] } } : n
    ),
    edges: edges9,
    appName: "t",
    outputNodeId: out9.id,
    canvasRes: [64, 64],
  });
  check(
    "a file-input-only manifest doesn't warn no-controls",
    fileOnly.manifest.fileInputs.length === 1 &&
      fileOnly.manifest.controls.length === 0 &&
      !fileOnly.warnings.some((w) => w.kind === "no-controls"),
    JSON.stringify(fileOnly.warnings.map((w) => w.kind))
  );
  // Nothing toggled anywhere → no file inputs, and no-controls DOES fire.
  const nothing = buildExportManifest({
    nodes: nodes9.map((n) => ({ ...n, data: { ...n.data, controlParams: [] } })),
    edges: edges9,
    appName: "t",
    outputNodeId: out9.id,
    canvasRes: [64, 64],
  });
  check(
    "with nothing toggled there are no file inputs and no-controls warns",
    nothing.manifest.fileInputs.length === 0 &&
      nothing.warnings.some((w) => w.kind === "no-controls")
  );
}

console.log(failures === 0 ? "\ncheck-export-manifest: all passed" : `\ncheck-export-manifest: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
