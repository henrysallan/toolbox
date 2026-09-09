// check-zones: Repeat + For Each Element zone structure (flatten nearest-
// shell extraction, mint helpers, name-matched Repeat feedback overlay).
// Eval of the nested loop needs GL (image copies); this guards the pure
// graph shape that nesting Repeat ⊃ For Each depends on.
//
//   npx tsx scripts/check-zones.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
const stub = () => ({
  getContext: () => null,
  style: {},
  addEventListener() {},
});
g.window ??= g;
g.self ??= g;
g.document ??= {
  createElement: stub,
  createElementNS: stub,
  fonts: { add() {}, forEach() {} },
  body: { appendChild() {} },
  addEventListener() {},
};
g.navigator ??= { userAgent: "node" };
g.HTMLCanvasElement ??= class {};
g.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};
g.WebGL2RenderingContext ??= class {};

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();

const {
  FOREACH_INPUT_TYPE,
  FOREACH_TYPE,
  ITERATE_TYPE,
  REPEAT_INPUT_TYPE,
  REPEAT_TYPE,
  isZoneShell,
  zoneCollectsGrouped,
  zoneInputTypeForShell,
} = await import("@/engine/groups");
const { flattenGraph, resolveInteriorProducer } = await import(
  "@/engine/flatten"
);
const { buildRecipe } = await import("@/state/recipe-builder");
const {
  makeForEachNodes,
  makeIterateNodes,
  makeRepeatNodes,
  applyForeachGeometryType,
} = await import("@/state/graph-ops");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`
  );
}

check("isZoneShell iterate", isZoneShell(ITERATE_TYPE), true);
check("isZoneShell repeat", isZoneShell(REPEAT_TYPE), true);
check("isZoneShell foreach", isZoneShell(FOREACH_TYPE), true);
check("isZoneShell circle", isZoneShell("circle"), false);
check("zoneCollectsGrouped iterate", zoneCollectsGrouped(ITERATE_TYPE), true);
check("zoneCollectsGrouped foreach", zoneCollectsGrouped(FOREACH_TYPE), true);
check("zoneCollectsGrouped repeat", zoneCollectsGrouped(REPEAT_TYPE), false);
check(
  "zoneInputTypeForShell",
  zoneInputTypeForShell(REPEAT_TYPE),
  REPEAT_INPUT_TYPE
);

{
  const { iterate, iterateInput } = makeIterateNodes({ x: 0, y: 0 });
  check("iterate pair: shell type", iterate.data.defType, ITERATE_TYPE);
  check(
    "iterate pair: input parent",
    iterateInput.data.parentId,
    iterate.id
  );
}

{
  const { repeat, repeatInput } = makeRepeatNodes({ x: 0, y: 0 });
  check("repeat pair: shell type", repeat.data.defType, REPEAT_TYPE);
  check("repeat pair: input parent", repeatInput.data.parentId, repeat.id);
  check(
    "repeat pair: count default",
    repeatInput.data.params.count,
    4
  );
}

{
  const { foreach, foreachInput } = makeForEachNodes({ x: 0, y: 0 });
  check("foreach pair: shell type", foreach.data.defType, FOREACH_TYPE);
  check(
    "foreach pair: input parent",
    foreachInput.data.parentId,
    foreach.id
  );
  const geo = foreach.data.inputs.find((s: { name: string }) => s.name === "geometry");
  check("foreach pair: geometry input", geo?.name, "geometry");
}

{
  const { foreach, foreachInput } = makeForEachNodes({ x: 0, y: 0 });
  const next = applyForeachGeometryType(
    [foreach, foreachInput],
    foreach.id,
    "points"
  );
  const input = next.find((n) => n.id === foreachInput.id)!;
  check("foreach domain flip", input.data.params.domain, "points");
}

// Nested Repeat ⊃ For Each: flatten nearest-shell extraction.
{
  const { repeat, repeatInput } = makeRepeatNodes({ x: 0, y: 0 });
  const { foreach, foreachInput } = makeForEachNodes({ x: 200, y: 0 });
  foreach.data.parentId = repeat.id;
  const member = {
    id: "pop",
    type: "points-on-path",
    params: {},
    parentId: foreach.id,
  };
  const nodes = [
    { id: repeat.id, type: repeat.data.defType, params: repeat.data.params, parentId: repeat.data.parentId },
    { id: repeatInput.id, type: repeatInput.data.defType, params: repeatInput.data.params, parentId: repeat.id },
    { id: foreach.id, type: foreach.data.defType, params: foreach.data.params, parentId: repeat.id },
    { id: foreachInput.id, type: foreachInput.data.defType, params: foreachInput.data.params, parentId: foreach.id },
    member,
  ];
  const edges: { id: string; source: string; sourceHandle: string; target: string; targetHandle: string }[] = [
    {
      id: "e-geo",
      source: repeatInput.id,
      sourceHandle: "out:aux:spline",
      target: foreach.id,
      targetHandle: "in:geometry",
    },
    {
      id: "e-el",
      source: foreachInput.id,
      sourceHandle: "out:aux:element",
      target: member.id,
      targetHandle: "in:path",
    },
    {
      id: "e-inner-tap",
      source: member.id,
      sourceHandle: "out:primary",
      target: foreach.id,
      targetHandle: "in:spline",
    },
    {
      id: "e-outer-tap",
      source: foreach.id,
      sourceHandle: "out:aux:spline",
      target: repeat.id,
      targetHandle: "in:spline",
    },
  ];
  const flat = flattenGraph(nodes, edges);
  const interiors = flat.iterateInteriors!;
  const repeatInterior = interiors.get(repeat.id);
  const foreachInterior = interiors.get(foreach.id);
  check(
    "nested: two interiors",
    [!!repeatInterior, !!foreachInterior],
    [true, true]
  );
  const repeatIds = (repeatInterior?.nodes ?? []).map((n) => n.id).sort();
  const foreachIds = (foreachInterior?.nodes ?? []).map((n) => n.id).sort();
  check(
    "nested: foreach shell lives in repeat interior",
    repeatIds.includes(foreach.id),
    true
  );
  check(
    "nested: foreach members stay in foreach interior",
    foreachIds.slice().sort(),
    [foreachInput.id, member.id].sort()
  );
  check(
    "nested: geometry edge stays in repeat interior",
    (repeatInterior?.edges ?? []).some((e) => e.id === "e-geo"),
    true
  );
  check(
    "nested: element edge stays in foreach interior",
    (foreachInterior?.edges ?? []).some((e) => e.id === "e-el"),
    true
  );
  check(
    "nested: outer graph is just the repeat shell",
    flat.nodes.map((n) => n.id),
    [repeat.id]
  );
  check(
    "nested: inner collect tap stays in foreach interior",
    (foreachInterior?.edges ?? []).some((e) => e.id === "e-inner-tap"),
    true
  );
  check(
    "nested: outer collect tap stays in repeat interior",
    (repeatInterior?.edges ?? []).some((e) => e.id === "e-outer-tap"),
    true
  );
  check(
    "nested: inner collect producer resolves",
    resolveInteriorProducer(
      foreachInterior?.nodes ?? [],
      foreachInterior?.edges ?? [],
      foreach.id,
      "spline"
    )?.nodeId,
    member.id
  );
  check(
    "nested: outer collect producer resolves",
    resolveInteriorProducer(
      repeatInterior?.nodes ?? [],
      repeatInterior?.edges ?? [],
      repeat.id,
      "spline"
    )?.nodeId,
    foreach.id
  );
}

// Same nesting via the recipe builder — identity For Each inside Repeat
// (element → collect). This is the graph insert_recipe actually mints.
{
  const built = buildRecipe({
    name: "Repeat ForEach",
    nodes: [
      { id: "rect", type: "rectangle" },
      { id: "rpt", type: "repeat", params: { count: 2 } },
      { id: "fe", type: "foreach", parent: "rpt" },
    ],
    edges: [
      { from: "rect:out", to: "rpt-input:in:spline" },
      { from: "rpt-input:aux:spline", to: "fe:in:geometry" },
      { from: "fe-input:aux:element", to: "fe:in:spline" },
      { from: "fe:aux:spline", to: "rpt:in:spline" },
    ],
    outputs: [{ name: "spline", from: "rpt:aux:spline", type: "spline" }],
  });
  const rpt = built.nodes.find((n) => n.data.defType === "repeat")!;
  const fe = built.nodes.find((n) => n.data.defType === "foreach")!;
  const feIn = built.nodes.find((n) => n.data.defType === "foreach-input")!;
  check("recipe nested: foreach parent is repeat", fe.data.parentId, rpt.id);
  const flat = flattenGraph(
    built.nodes.map((n) => ({
      id: n.id,
      type: n.data.defType,
      params: n.data.params,
      parentId: n.data.parentId,
    })),
    built.edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "",
      target: e.target,
      targetHandle: e.targetHandle ?? "",
    }))
  );
  const feInterior = flat.iterateInteriors?.get(fe.id);
  check(
    "recipe nested: inner collect producer resolves",
    resolveInteriorProducer(
      feInterior?.nodes ?? [],
      feInterior?.edges ?? [],
      fe.id,
      "spline"
    )?.nodeId,
    feIn.id
  );
}

if (failures > 0) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall ok");
