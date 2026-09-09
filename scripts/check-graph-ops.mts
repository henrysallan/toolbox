// check-graph-ops: guards composition scoping in the pure structural ops
// (createLayer / reorderLayers). Before the 072226 fix these found "the" root
// Output over the WHOLE node array, so in a multi-composition project "Add
// layer" / reorder could silently rewire ANOTHER composition's Output. Each
// test puts the WRONG composition's Output FIRST in the array, so an unscoped
// regression is caught (it would pick the first one).
//
// Also covers makeSplineEditable (right-click "Make Editable" bake): edge
// migration, styling copy vs. trim non-copy, cornerRadius stripping, and
// the bypass/active/selection handoff.
//
// Also covers combineSelection (right-click "Combine Nodes"): same-family
// multi-select wrap into a Combine, slot sizing, wire order, mixed-type
// refusal.
//
//   npx tsx scripts/check-graph-ops.mts
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
registerAllNodes(); // createLayer mints nodes via the registry (makeInstanceNode)
const {
  createLayer,
  reorderLayers,
  reorderGroupSockets,
  makeInstanceNode,
  makeLayerNodes,
  makeSplineEditable,
  applyIncomingWireToTarget,
  combineSelection,
  connectedTypesFromEdges,
  connectGroupToEmptyScopeOutput,
  connectToVirtualSocket,
  resolveInsertParent,
  renameGroupSocket,
  removeGroupSocket,
  listGroupShellControls,
  withUpdatedParams,
} = await import("@/state/graph-ops");
const {
  LAYER_TYPE,
  GROUP_TYPE,
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  readBoundarySockets,
  readGroupInterface,
  readInputValues,
  groupInputControlDef,
  withInputValues,
  VIRTUAL_SOCKET,
} = await import("@/engine/groups");
const { flattenGraph } = await import("@/engine/flatten");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const node = (id: string, defType: string, compositionId: string, extra: any = {}): any => ({
  id,
  position: { x: 0, y: 0 },
  selected: false,
  data: { defType, compositionId, ...extra },
});
const edge = (id: string, source: string, target: string, targetHandle: string): any => ({
  id,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle,
});
const intoImageEdge = (edges: any[], source: string) =>
  edges.find((e) => e.source === source && e.targetHandle === "in:image");
const newLayerNode = (before: any[], after: any[]) => {
  const ids = new Set(before.map((n) => n.id));
  return after.find((n) => n.data.defType === LAYER_TYPE && !ids.has(n.id));
};

// --- 1. createLayer into compB wires into compB's Output (outA listed FIRST) ---
{
  const outA = node("outA", "output", "compA");
  const layA1 = node("layA1", LAYER_TYPE, "compA");
  const outB = node("outB", "output", "compB");
  const nodes = [outA, layA1, outB];
  const edges = [edge("eA", "layA1", "outA", "in:image")];

  const res = createLayer(nodes, edges, undefined, "compB");
  const nl = newLayerNode(nodes, res.nodes);
  const toOut = nl ? intoImageEdge(res.edges, nl.id) : undefined;
  check("createLayer(compB) wires into compB's Output, not the first one", toOut?.target === "outB", toOut?.target);
  check("new layer is tagged into compB", nl?.data.compositionId === "compB");
  check("compA's Output edge is untouched", res.edges.some((e) => e.id === "eA" && e.target === "outA"));
  check("compB add creates no edge into compA's Output", !res.edges.some((e) => e.target === "outA" && e.source === nl?.id));
}

// --- 2. createLayer into compA splices into compA's chain (outB listed FIRST) ---
{
  const outB = node("outB", "output", "compB");
  const outA = node("outA", "output", "compA");
  const layA1 = node("layA1", LAYER_TYPE, "compA");
  const nodes = [outB, outA, layA1];
  const edges = [edge("eA", "layA1", "outA", "in:image")];

  const res = createLayer(nodes, edges, undefined, "compA");
  const nl = newLayerNode(nodes, res.nodes);
  const toOut = nl ? intoImageEdge(res.edges, nl.id) : undefined;
  check("createLayer(compA) wires into compA's Output", toOut?.target === "outA", toOut?.target);
  check("splice removes the old top→Output edge", !res.edges.some((e) => e.id === "eA"));
  check("previous top feeds the new layer's stack", res.edges.some((e) => e.source === "layA1" && e.target === nl?.id && e.targetHandle === "in:stack"));
  check("compB's Output receives no new edge", !res.edges.some((e) => e.target === "outB"));
}

// --- 3. reorderLayers only touches the scoped composition's Output (outB FIRST) ---
{
  const outB = node("outB", "output", "compB");
  const layB1 = node("layB1", LAYER_TYPE, "compB");
  const outA = node("outA", "output", "compA");
  const layA1 = node("layA1", LAYER_TYPE, "compA");
  const layA2 = node("layA2", LAYER_TYPE, "compA");
  const nodes = [outB, layB1, outA, layA1, layA2];
  const edges = [
    edge("eB", "layB1", "outB", "in:image"),
    edge("eA", "layA2", "outA", "in:image"),
  ];

  const res = reorderLayers(nodes, edges, ["layA2", "layA1"], "compA");
  check("reorderLayers(compA) leaves compB's Output edge intact", res.edges.some((e) => e.source === "layB1" && e.target === "outB" && e.targetHandle === "in:image"));
  check("reorderLayers(compA) rewires compA's Output to the new top", res.edges.some((e) => e.source === "layA1" && e.target === "outA" && e.targetHandle === "in:image"));
  check("reorderLayers(compA) never wires a compA layer into compB's Output", !res.edges.some((e) => e.target === "outB" && (e.source === "layA1" || e.source === "layA2")));
}

// --- 4. makeSplineEditable: bake a Circle into an editable Spline Draw ---
{
  const circle = makeInstanceNode("circle", { x: 100, y: 100 }) as any;
  circle.id = "circ";
  circle.data.compositionId = "compA";
  circle.data.params.stroke_color = "#ff0000";
  circle.data.params.trim_end = 0.5; // must NOT copy — bake is post-trim
  const consumer = node("cons", "stroke", "compA", { active: true });
  consumer.selected = true;
  const fillSrc = node("fillSrc", "image-source", "compA");
  const nodes = [circle, consumer, fillSrc];
  const edges = [
    edge("eSpline", "circ", "cons", "in:spline"),
    { ...edge("eImg", "circ", "cons", "in:image"), sourceHandle: "out:aux:image" },
    { ...edge("eEl", "circ", "cons", "in:element"), sourceHandle: "out:aux:element" },
    edge("eFill", "fillSrc", "circ", "in:fill"),
  ];
  const subpaths = [
    {
      anchors: [
        { pos: [0.2, 0.2], cornerRadius: 0.05 },
        { pos: [0.8, 0.2] },
        { pos: [0.5, 0.8], inHandle: [-0.1, 0], outHandle: [0.1, 0] },
      ],
      closed: true,
    },
  ] as any;

  const res = makeSplineEditable(nodes, edges, "circ", "out:primary", subpaths);
  const draw = res?.nodes.find((n) => n.id === res.newNodeId);
  check("bake returns a Spline Draw node", draw?.data.defType === "spline-draw");
  const sp = (draw?.data.params.spline as any)?.subpaths;
  check("baked geometry copied (3 anchors, closed)", sp?.[0]?.anchors?.length === 3 && sp?.[0]?.closed === true);
  check("baked geometry is a deep copy", sp !== subpaths && sp?.[0]?.anchors?.[0] !== subpaths[0].anchors[0]);
  check("cornerRadius stripped from baked anchors", sp?.[0]?.anchors?.[0]?.cornerRadius === undefined);
  check("styling copied from the raster family", draw?.data.params.stroke_color === "#ff0000");
  check("trim params NOT copied", draw?.data.params.trim_end === 1);
  check("spline out-wire moved to the new node", !!res?.edges.some((e) => e.id === "eSpline" && e.source === draw?.id && e.sourceHandle === "out:primary"));
  check("image aux out-wire moved to the new node", !!res?.edges.some((e) => e.id === "eImg" && e.source === draw?.id && e.sourceHandle === "out:aux:image"));
  check("element aux out-wire stays on the original", !!res?.edges.some((e) => e.id === "eEl" && e.source === "circ"));
  check("fill in-wire moved to the new node", !!res?.edges.some((e) => e.id === "eFill" && e.target === draw?.id && e.targetHandle === "in:fill"));
  const orig = res?.nodes.find((n) => n.id === "circ");
  check("original is bypassed", orig?.data.bypassed === true);
  check("new node is viewport-active + selected", draw?.data.active === true && draw?.selected === true);
  check("active cleared elsewhere (exclusive)", res?.nodes.find((n) => n.id === "cons")?.data.active === false);
  check("selection cleared elsewhere", res?.nodes.find((n) => n.id === "cons")?.selected === false);
  check("composition + scope carried over", draw?.data.compositionId === "compA");
  check("non-spline handle is refused", makeSplineEditable(nodes, edges, "circ", "out:aux:image", subpaths) === null);
}

// --- 5. combineSelection: wrap same-family primaries in a Combine node ---
{
  const a = makeInstanceNode("circle", { x: 0, y: 10 }) as any;
  a.id = "ca";
  a.selected = true;
  a.data.compositionId = "compA";
  a.data.parentId = "layer1";
  const b = makeInstanceNode("circle", { x: 80, y: 40 }) as any;
  b.id = "cb";
  b.selected = true;
  b.data.compositionId = "compA";
  b.data.parentId = "layer1";
  const c = makeInstanceNode("circle", { x: 40, y: 0 }) as any;
  c.id = "cc";
  c.selected = true;
  c.data.compositionId = "compA";
  c.data.parentId = "layer1";
  const bystander = makeInstanceNode("circle", { x: 200, y: 0 }) as any;
  bystander.id = "by";
  bystander.selected = true; // selected but not in the id list — ignored
  const consumer = node("cons", "stroke", "compA");
  const existing = {
    id: "eKeep",
    source: "ca",
    sourceHandle: "out:primary",
    target: "cons",
    targetHandle: "in:spline",
  };
  const res = combineSelection([a, b, c, bystander, consumer], [existing], [
    "ca",
    "cb",
    "cc",
  ]);
  const combine = res?.nodes.find((n) => n.id === res.combineId);
  check("combine returns a Combine node", combine?.data.defType === "collect");
  check("combine mode follows spline family", combine?.data.params.mode === "spline");
  check("combine output stays spline", combine?.data.primaryOutput === "spline");
  const slots = combine?.data.params.slots as string[] | undefined;
  check("slots are a,b,c plus a spare", !!slots && slots.length === 4 && slots[0] === "a" && slots[3] === "d");
  const wires = res?.edges.filter((e) => e.target === combine?.id) ?? [];
  check("three primary wires into Combine", wires.length === 3);
  check(
    "left-to-right then top-to-bottom order",
    wires[0]?.source === "ca" &&
      wires[0]?.targetHandle === "in:a" &&
      wires[1]?.source === "cc" &&
      wires[1]?.targetHandle === "in:b" &&
      wires[2]?.source === "cb" &&
      wires[2]?.targetHandle === "in:c"
  );
  check("existing downstream wire is kept", !!res?.edges.some((e) => e.id === "eKeep" && e.source === "ca"));
  check("combine is selected", combine?.selected === true);
  check("sources are deselected", res?.nodes.filter((n) => n.id === "ca" || n.id === "cb" || n.id === "cc").every((n) => !n.selected) === true);
  check("scope + composition carried over", combine?.data.parentId === "layer1" && combine?.data.compositionId === "compA");
  check("placed to the right of the selection", (combine?.position.x ?? 0) > 80);

  const one = combineSelection([a], [], ["ca"]);
  check("single node is refused", one === null);

  const img = makeInstanceNode("image-source", { x: 0, y: 0 }) as any;
  img.id = "img";
  img.data.primaryOutput = "image";
  const mixed = combineSelection([a, img], [], ["ca", "img"]);
  check("mixed families are refused", mixed === null);

  const imgA = makeInstanceNode("image-source", { x: 0, y: 0 }) as any;
  imgA.id = "ia";
  const imgB = makeInstanceNode("image-source", { x: 40, y: 0 }) as any;
  imgB.id = "ib";
  imgB.data.primaryOutput = "mask";
  const family = combineSelection([imgA, imgB], [], ["ia", "ib"]);
  const famNode = family?.nodes.find((n) => n.id === family.combineId);
  check("image+mask share the image family", famNode?.data.params.mode === "image");
  check("image-mode Combine outputs image_group", famNode?.data.primaryOutput === "image_group");

  const cube = makeInstanceNode("cube-3d", { x: 0, y: 0 }) as any;
  cube.id = "cube";
  const merge3d = makeInstanceNode("scene-merge", { x: 40, y: 0 }) as any;
  merge3d.id = "sm";
  const objFam = combineSelection([cube, merge3d], [], ["cube", "sm"]);
  check(
    "geometry+object3d share the object family",
    objFam?.nodes.find((n) => n.id === objFam.combineId)?.data.params.mode === "object"
  );
}

// --- incoming-wire autocoerce (add-menu into-target path) ---
{
  const xf = makeInstanceNode("transform", { x: 0, y: 0 });
  check(
    "fresh Transform source socket is image",
    xf.data.inputs.find((i) => i.name === "image")?.type === "image"
  );
  const xfNext = applyIncomingWireToTarget(xf, "in:image", "spline", {
    image: "spline",
  });
  check(
    "Transform autocoerces input to spline",
    xfNext.data.inputs.find((i) => i.name === "image")?.type === "spline"
  );
  check("Transform output follows spline", xfNext.data.primaryOutput === "spline");
}

{
  const ctp = makeInstanceNode("copy-to-points", { x: 0, y: 0 });
  const next = applyIncomingWireToTarget(ctp, "in:instance", "spline", {
    instance: "spline",
  });
  check("Copy-to-Points mode flips to spline", next.data.params.mode === "spline");
  check(
    "Copy-to-Points instance socket is spline",
    next.data.inputs.find((i) => i.name === "instance")?.type === "spline"
  );
}

{
  const sw = makeInstanceNode("switch", { x: 0, y: 0 });
  check(
    "fresh Switch slot is scalar",
    sw.data.inputs.find((i) => i.name === "in0")?.type === "scalar"
  );
  const next = applyIncomingWireToTarget(sw, "in:in0", "image", { in0: "image" });
  check(
    "Switch autocoerces slots to image",
    next.data.inputs.find((i) => i.name === "in0")?.type === "image"
  );
  check("Switch output follows image", next.data.primaryOutput === "image");
}

{
  const col = makeInstanceNode("collect", { x: 0, y: 0 });
  check(
    "fresh Combine slot is image",
    col.data.inputs.find((i) => i.name === "a")?.type === "image"
  );
  const next = applyIncomingWireToTarget(col, "in:a", "spline", { a: "spline" });
  check("Combine mode flips to spline", next.data.params.mode === "spline");
  check(
    "Combine slot autocoerces to spline",
    next.data.inputs.find((i) => i.name === "a")?.type === "spline"
  );
  check("Combine output follows spline", next.data.primaryOutput === "spline");
}

{
  const bb = makeInstanceNode("bounding-box", { x: 0, y: 0 });
  const next = applyIncomingWireToTarget(bb, "in:source", "points", {
    source: "points",
  });
  check(
    "Bounding Box autocoerces source to points",
    next.data.inputs.find((i) => i.name === "source")?.type === "points"
  );
}

{
  const producer = makeInstanceNode("spline-draw", { x: 0, y: 0 });
  const xf = makeInstanceNode("transform", { x: 100, y: 0 });
  const ct = connectedTypesFromEdges(
    xf.id,
    [producer, xf],
    [],
    { targetHandle: "in:image", srcType: "spline" }
  );
  check("connectedTypesFromEdges extra types the target input", ct.image === "spline");
}

{
  const acc = makeInstanceNode("accumulator", { x: 0, y: 0 });
  check(
    "fresh Accumulator input is scalar",
    acc.data.inputs.find((i) => i.name === "input")?.type === "scalar"
  );
  check("fresh Accumulator output is scalar", acc.data.primaryOutput === "scalar");
  const next = applyIncomingWireToTarget(acc, "in:input", "points", {
    input: "points",
  });
  check("Accumulator type flips to points", next.data.params.type === "points");
  check(
    "Accumulator input autocoerces to points",
    next.data.inputs.find((i) => i.name === "input")?.type === "points"
  );
  check("Accumulator output follows points", next.data.primaryOutput === "points");

  const splineNext = applyIncomingWireToTarget(acc, "in:input", "spline", {
    input: "spline",
  });
  check(
    "Accumulator type flips to spline on a spline wire",
    splineNext.data.params.type === "spline"
  );
  check(
    "Accumulator input stays spline",
    splineNext.data.inputs.find((i) => i.name === "input")?.type === "spline"
  );
  check(
    "Accumulator output is spline for a spline wire",
    splineNext.data.primaryOutput === "spline"
  );
}

// --- reorderGroupSockets: name-addressed handles, reserved/fixed gates ---
{
  const group = makeInstanceNode(GROUP_TYPE, { x: 0, y: 0 });
  const gi = makeInstanceNode(GROUP_INPUT_TYPE, { x: 0, y: 0 });
  const go = makeInstanceNode(GROUP_OUTPUT_TYPE, { x: 0, y: 0 });
  gi.data.parentId = group.id;
  go.data.parentId = group.id;
  gi.data.params = {
    sockets: [
      { name: "a", type: "image" },
      { name: "b", type: "scalar" },
      { name: "c", type: "spline" },
    ],
  };
  go.data.params = {
    sockets: [
      { name: "out1", type: "image" },
      { name: "out2", type: "spline" },
    ],
  };
  const nodes = [group, gi, go];
  const edges = [
    {
      id: "e-in",
      source: gi.id,
      sourceHandle: "out:aux:b",
      target: "consumer",
      targetHandle: "in:value",
    },
    {
      id: "e-out",
      source: "producer",
      sourceHandle: "out:primary",
      target: go.id,
      targetHandle: "in:out2",
    },
    {
      id: "e-shell",
      source: "outside",
      sourceHandle: "out:primary",
      target: group.id,
      targetHandle: "in:a",
    },
  ];

  const moved = reorderGroupSockets(nodes, edges, gi.id, "a", "c");
  check("reorderGroupSockets returns a result", !!moved);
  const nextGi = moved?.nodes.find((n) => n.id === gi.id);
  const nextGroup = moved?.nodes.find((n) => n.id === group.id);
  const names = readBoundarySockets(nextGi?.data.params ?? {}).map((s) => s.name);
  check(
    "Group Input sockets move a to c's slot (a,b,c → b,c,a)",
    names.join(",") === "b,c,a",
    names.join(",")
  );
  const iface = readGroupInterface(nextGroup?.data.params ?? {});
  check(
    "group shell interface.inputs follow the new order",
    iface.inputs.map((s) => s.name).join(",") === "b,c,a",
    iface.inputs.map((s) => s.name).join(",")
  );
  check(
    "interior edge still names the moved socket",
    moved?.edges.some(
      (e) => e.id === "e-in" && e.sourceHandle === "out:aux:b"
    ) === true
  );
  check(
    "exterior shell edge still names the moved socket",
    moved?.edges.some(
      (e) => e.id === "e-shell" && e.targetHandle === "in:a"
    ) === true
  );

  const outMoved = reorderGroupSockets(nodes, edges, go.id, "out2", "out1");
  const outNames = readBoundarySockets(
    outMoved?.nodes.find((n) => n.id === go.id)?.data.params ?? {}
  ).map((s) => s.name);
  check(
    "Group Output sockets reorder (out1,out2 → out2,out1)",
    outNames.join(",") === "out2,out1",
    outNames.join(",")
  );
  check(
    "Group Output interior edge still names the socket",
    outMoved?.edges.some(
      (e) => e.id === "e-out" && e.targetHandle === "in:out2"
    ) === true
  );

  check(
    "same-name reorder is a no-op",
    reorderGroupSockets(nodes, edges, gi.id, "a", "a") === null
  );
  check(
    "unknown socket name is a no-op",
    reorderGroupSockets(nodes, edges, gi.id, "nope", "a") === null
  );

  const reservedGi = {
    ...gi,
    data: {
      ...gi.data,
      params: {
        sockets: [
          { name: "backdrop", type: "image" },
          { name: "foo", type: "scalar" },
        ],
        reserved: ["backdrop"],
      },
    },
  };
  const reservedNodes = [group, reservedGi, go];
  check(
    "reserved socket cannot be the drag source",
    reorderGroupSockets(reservedNodes, edges, gi.id, "backdrop", "foo") === null
  );
  const pastReserved = reorderGroupSockets(
    reservedNodes,
    edges,
    gi.id,
    "foo",
    "backdrop"
  );
  const pastNames = readBoundarySockets(
    pastReserved?.nodes.find((n) => n.id === gi.id)?.data.params ?? {}
  ).map((s) => s.name);
  check(
    "user socket can drop onto a reserved row (foo slides before backdrop)",
    pastNames.join(",") === "foo,backdrop",
    pastNames.join(",")
  );

  const fixedGo = {
    ...go,
    data: { ...go.data, params: { ...go.data.params, fixed: true } },
  };
  check(
    "fixed boundary refuses reorder",
    reorderGroupSockets([group, gi, fixedGo], edges, go.id, "out2", "out1") ===
      null
  );
}

{
  const { layer, groupInput, groupOutput } = makeLayerNodes("L", { x: 0, y: 0 });
  const group = makeInstanceNode(GROUP_TYPE, { x: 80, y: 0 });
  group.data.parentId = layer.id;
  group.data.params = {
    interface: { inputs: [], outputs: [{ name: "image", type: "image" }] },
  };
  const hooked = connectGroupToEmptyScopeOutput(
    [layer, groupInput, groupOutput, group],
    [],
    group.id,
    layer.id
  );
  check(
    "empty layer output gets the group's aux:image",
    hooked.wired.length === 1 &&
      hooked.wired[0].from === `${group.id}:aux:image` &&
      hooked.wired[0].to === `${groupOutput.id}:in:image` &&
      hooked.edges.some(
        (e) =>
          e.source === group.id &&
          e.sourceHandle === "out:aux:image" &&
          e.target === groupOutput.id &&
          e.targetHandle === "in:image"
      ),
    JSON.stringify(hooked.wired)
  );

  const occupied = connectGroupToEmptyScopeOutput(
    [layer, groupInput, groupOutput, group],
    [
      {
        id: "existing",
        source: groupInput.id,
        sourceHandle: "out:aux:backdrop",
        target: groupOutput.id,
        targetHandle: "in:image",
      },
    ],
    group.id,
    layer.id
  );
  check(
    "occupied image socket is left alone",
    occupied.wired.every((w) => !w.to.endsWith(":in:image")) &&
      occupied.edges.some((e) => e.id === "existing") &&
      occupied.skippedOccupied.some((s) => s.socket === "image")
  );

  const stolen = connectGroupToEmptyScopeOutput(
    [layer, groupInput, groupOutput, group],
    [
      {
        id: "existing",
        source: groupInput.id,
        sourceHandle: "out:aux:backdrop",
        target: groupOutput.id,
        targetHandle: "in:image",
      },
    ],
    group.id,
    layer.id,
    { replaceOccupied: true }
  );
  check(
    "replaceOccupied steals the image socket",
    stolen.wired.some((w) => w.to.endsWith(":in:image")) &&
      !stolen.edges.some((e) => e.id === "existing") &&
      stolen.skippedOccupied.length === 0,
    JSON.stringify(stolen.wired)
  );

  const renamed = makeInstanceNode(GROUP_TYPE, { x: 80, y: 0 });
  renamed.data.parentId = layer.id;
  renamed.data.params = {
    interface: { inputs: [], outputs: [{ name: "result", type: "image" }] },
  };
  const typed = connectGroupToEmptyScopeOutput(
    [layer, groupInput, groupOutput, renamed],
    [],
    renamed.id,
    layer.id
  );
  check(
    "type-only match still wires image",
    typed.wired.some((w) => w.from === `${renamed.id}:aux:result` && w.to.endsWith(":in:image"))
  );
}

// --- insert_recipe scope resolution ---
{
  const layer = node("lay", LAYER_TYPE, "c");
  const grp = node("grp", GROUP_TYPE, "c", { parentId: "lay" });
  const circle = node("circ", "circle", "c", { parentId: "grp" });
  const graph = [layer, grp, circle];

  const omittedAtRoot = resolveInsertParent(undefined, undefined, graph);
  check("omit at root wraps in a new layer", omittedAtRoot.ok && omittedAtRoot.parentId === null);

  const omittedInLayer = resolveInsertParent(undefined, "lay", graph);
  check("omit in a layer stays in that layer", omittedInLayer.ok && omittedInLayer.parentId === "lay");

  const omittedInGroup = resolveInsertParent(undefined, "grp", graph);
  check("omit in a group would nest (MCP refuses this)", omittedInGroup.ok && omittedInGroup.parentId === "grp");

  const beside = resolveInsertParent("parent", "grp", graph);
  check("scope=parent from inside a group is the layer", beside.ok && beside.parentId === "lay");

  const atRoot = resolveInsertParent("root", "grp", graph);
  check("scope=root wraps in a new layer", atRoot.ok && atRoot.parentId === null);

  const explicit = resolveInsertParent("lay", "grp", graph);
  check("scope=layer id inserts into that layer", explicit.ok && explicit.parentId === "lay");

  const nest = resolveInsertParent("grp", "grp", graph);
  check("explicit group id nests (opt-in)", nest.ok && nest.parentId === "grp");

  const bad = resolveInsertParent("circ", "lay", graph);
  check("scope=a circle is rejected", !bad.ok && /circle/.test((bad as { reason: string }).reason));

  const missing = resolveInsertParent("nope", "lay", graph);
  check("unknown scope id is rejected", !missing.ok);

  const stale = resolveInsertParent(undefined, "deleted", graph);
  check("stale current scope falls back to wrap", stale.ok && stale.parentId === null);
}

// --- group input widgets + shell inputValues ---
{
  const scalarDef = {
    name: "value",
    type: "scalar" as const,
    min: -10,
    max: 10,
    softMax: 5,
    step: 0.1,
    default: 0,
  };
  const slider = groupInputControlDef("Amount", "scalar", scalarDef);
  check(
    "scalar socket → slider with target range",
    !!slider &&
      slider.type === "scalar" &&
      slider.min === -10 &&
      slider.softMax === 5 &&
      slider.step === 0.1
  );
  const color = groupInputControlDef("Fill", "vec4", {
    name: "fill",
    type: "vec4",
    default: [1, 0, 0, 1],
  });
  check("vec4 socket → color", !!color && color.type === "color");
  const text = groupInputControlDef("Name", "string", {
    name: "text",
    type: "string",
    default: "",
    placeholder: "hi",
  });
  check(
    "string socket → text",
    !!text && text.type === "string" && text.placeholder === "hi"
  );
  const drop = groupInputControlDef("Mode", "scalar", {
    name: "mode",
    type: "enum",
    options: ["a", "b"],
    default: "a",
  });
  check(
    "enum param → dropdown",
    !!drop && drop.type === "enum" && drop.options?.[0] === "a"
  );
  const bare = groupInputControlDef("Img", "image", scalarDef);
  check("image socket stays a bare port", bare === null);
}

{
  const group = makeInstanceNode(GROUP_TYPE, { x: 0, y: 0 });
  const gi = makeInstanceNode(GROUP_INPUT_TYPE, { x: 0, y: 0 });
  gi.data.parentId = group.id;
  const go = makeInstanceNode(GROUP_OUTPUT_TYPE, { x: 0, y: 0 });
  go.data.parentId = group.id;
  const c = makeInstanceNode("constant", { x: 0, y: 0 });
  c.data.parentId = group.id;
  c.data.params = { ...c.data.params, value: 3.5 };
  const minted = connectToVirtualSocket([group, gi, go, c], [], {
    source: gi.id,
    sourceHandle: `out:aux:${VIRTUAL_SOCKET}`,
    target: c.id,
    targetHandle: "in:param:value",
  });
  check("mint param socket succeeds", !!minted);
  const shell = minted?.nodes.find((n) => n.id === group.id);
  const iv = readInputValues(shell?.data.params);
  check("mint seeds inputValues from interior", iv.value === 3.5);
  const interior = minted?.nodes.find((n) => n.id === c.id);
  check(
    "mint leaves interior param untouched",
    interior?.data.params.value === 3.5
  );

  const renamed = minted
    ? renameGroupSocket(minted.nodes, minted.edges, gi.id, "value", "Amount")
    : null;
  check(
    "rename remaps inputValues key",
    readInputValues(
      renamed?.nodes.find((n) => n.id === group.id)?.data.params
    ).Amount === 3.5 &&
      !("value" in
        readInputValues(
          renamed?.nodes.find((n) => n.id === group.id)?.data.params
        ))
  );

  const diverged = renamed
    ? renamed.nodes.map((n) => {
        if (n.id !== group.id) return n;
        return {
          ...n,
          data: {
            ...n.data,
            params: withInputValues(n.data.params, { Amount: 9 }),
          },
        };
      })
    : null;
  const removed =
    renamed && diverged
      ? removeGroupSocket(diverged, renamed.edges, gi.id, "Amount")
      : null;
  check(
    "remove drops inputValues key",
    !("Amount" in
      readInputValues(
        removed?.nodes.find((n) => n.id === group.id)?.data.params
      ))
  );
  check(
    "remove copies group value back onto interior (not a sibling by position)",
    removed?.nodes.find((n) => n.id === c.id)?.data.params.value === 9,
    String(removed?.nodes.find((n) => n.id === c.id)?.data.params.value)
  );
}

{
  const gn = (id: string, type: string, extra: any = {}) => ({
    id,
    type,
    parentId: extra.parentId,
    params: extra.params ?? {},
    exposedParams: extra.exposedParams,
  });
  const ge = (
    id: string,
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string
  ) => ({
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
  });
  const nodes = [
    gn("g", GROUP_TYPE, {
      params: {
        inputValues: { Amount: 0.7 },
        interface: { inputs: [{ name: "Amount", type: "scalar" }], outputs: [] },
      },
    }),
    gn("gi", GROUP_INPUT_TYPE, {
      parentId: "g",
      params: { sockets: [{ name: "Amount", type: "scalar" }] },
    }),
    gn("go", GROUP_OUTPUT_TYPE, { parentId: "g", params: { sockets: [] } }),
    gn("c", "constant", {
      parentId: "g",
      params: { value: 0.25 },
      exposedParams: ["value"],
    }),
  ];
  const edges = [
    ge("e1", "gi", "out:aux:Amount", "c", "in:param:value"),
  ];
  const flat = flattenGraph(nodes, edges);
  const consumer = flat.nodes.find((n) => n.id === "c");
  check(
    "flatten substitutes shell inputValues as param default",
    consumer?.params.value === 0.7
  );
  check(
    "flatten drops the unwired param edge",
    !flat.edges.some((e) => e.target === "c")
  );
  check(
    "flatten does not mutate the original node",
    nodes.find((n) => n.id === "c")?.params.value === 0.25
  );

  const wired = flattenGraph(
    [
      ...nodes,
      gn("src", "lfo", { params: {} }),
    ],
    [
      ...edges,
      ge("e-ext", "src", "out:primary", "g", "in:Amount"),
    ]
  );
  check(
    "wired exterior does not patch interior params",
    wired.nodes.find((n) => n.id === "c")?.params.value === 0.25
  );
  check(
    "wired exterior splices onto the param socket",
    wired.edges.some(
      (e) =>
        e.source === "src" &&
        e.target === "c" &&
        e.targetHandle === "in:param:value"
    )
  );

  const dataIn = flattenGraph(
    [
      gn("g", GROUP_TYPE, {
        params: { inputValues: { Img: 0.7 } },
      }),
      gn("gi", GROUP_INPUT_TYPE, {
        parentId: "g",
        params: { sockets: [{ name: "Img", type: "image" }] },
      }),
      gn("go", GROUP_OUTPUT_TYPE, { parentId: "g", params: { sockets: [] } }),
      gn("blur", "blur", { parentId: "g", params: {} }),
    ],
    [ge("e1", "gi", "out:aux:Img", "blur", "in:image")]
  );
  check(
    "data-socket group input is not patched from inputValues",
    dataIn.nodes.find((n) => n.id === "blur")?.params.Img === undefined
  );
}

{
  const gn = (id: string, type: string, extra: any = {}) => ({
    id,
    type,
    parentId: extra.parentId,
    params: extra.params ?? {},
    exposedParams: extra.exposedParams,
  });
  const ge = (
    id: string,
    source: string,
    sourceHandle: string,
    target: string,
    targetHandle: string
  ) => ({
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
  });
  const nodes = [
    gn("g", GROUP_TYPE, {
      params: {
        inputValues: { rows: 60 },
        interface: { inputs: [{ name: "rows", type: "scalar" }], outputs: [] },
      },
    }),
    gn("gi", GROUP_INPUT_TYPE, {
      parentId: "g",
      params: { sockets: [{ name: "rows", type: "scalar" }] },
    }),
    gn("go", GROUP_OUTPUT_TYPE, { parentId: "g", params: { sockets: [] } }),
    gn("glsl", "glsl-expression", {
      parentId: "g",
      params: {
        inputs: [{ id: "ein-rows", name: "rows", default: 8, min: 8, max: 200 }],
        expression: "fragColor = vec4(1.0);",
      },
    }),
  ];
  const edges = [ge("e1", "gi", "out:aux:rows", "glsl", "in:in:ein-rows")];
  const flat = flattenGraph(nodes, edges);
  const consumer = flat.nodes.find((n) => n.id === "glsl");
  check(
    "flatten patches widget-typed data sockets from inputValues",
    consumer?.inputOverrides?.["in:ein-rows"] === 60,
    JSON.stringify(consumer?.inputOverrides)
  );
  check(
    "flatten does not rewrite the channel row default",
    (consumer?.params.inputs as { default: number }[])?.[0]?.default === 8
  );

  const group = makeInstanceNode(GROUP_TYPE, { x: 0, y: 0 });
  const gi = makeInstanceNode(GROUP_INPUT_TYPE, { x: 0, y: 0 });
  gi.data.parentId = group.id;
  const go = makeInstanceNode(GROUP_OUTPUT_TYPE, { x: 0, y: 0 });
  go.data.parentId = group.id;
  const glsl0 = makeInstanceNode("glsl-expression", { x: 0, y: 0 });
  const glsl = withUpdatedParams(glsl0, {
    ...glsl0.data.params,
    inputs: [
      { id: "ein-rows", name: "rows", kind: "scalar", default: 60, min: 8, max: 200 },
    ],
  });
  glsl.data.parentId = group.id;
  const minted = connectToVirtualSocket([group, gi, go, glsl], [], {
    source: gi.id,
    sourceHandle: `out:aux:${VIRTUAL_SOCKET}`,
    target: glsl.id,
    targetHandle: "in:in:ein-rows",
  });
  check("mint channel socket succeeds", !!minted);
  const shell = minted?.nodes.find((n) => n.id === group.id);
  const iv = readInputValues(shell?.data.params);
  check(
    "mint seeds inputValues from channel default",
    iv.rows === 60,
    JSON.stringify(iv)
  );
  const controls = minted
    ? listGroupShellControls(
        minted.nodes.find((n) => n.id === group.id)!,
        minted.nodes,
        minted.edges
      )
    : [];
  const rowsCtrl = controls.find((c) => c.socketName === "rows");
  check(
    "shell slider inherits ch() min/max",
    !!rowsCtrl &&
      rowsCtrl.controlDef.type === "scalar" &&
      rowsCtrl.controlDef.min === 8 &&
      rowsCtrl.controlDef.max === 200 &&
      rowsCtrl.value === 60,
    JSON.stringify(rowsCtrl)
  );
}

if (failures === 0) console.log("\nALL GREEN ✅");
process.exit(failures ? 1 : 0);
