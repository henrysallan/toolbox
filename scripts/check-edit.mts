// Milestone-1 proof for Edit-with-AI (strategy B): patch a real group and
// confirm preservation + validity.
//   - groupToSpec exposes the interior (settable params, edges, interface).
//   - a realistic patch (retune a param, insert a node into the output chain)
//     applies cleanly, the result still validates, and the change took effect.
//   - a bad patch (type-mismatched wire) applies structurally but the validator
//     rejects it — i.e. it would feed the repair loop.
//
//   npx tsx scripts/check-edit.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
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
const { groupToSpec, graphToSpec, applyRecipeEdit } = await import("@/state/recipe-edit");
const { buildRecipe } = await import("@/state/recipe-builder");
const { validateGraph } = await import("@/engine/graph-validation");
const { readBoundarySockets, readGroupInterface, readInputValues, VIRTUAL_SOCKET } = await import("@/engine/groups");

const adapt = (nodes: any[], edges: any[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
  edges: edges.map((e) => ({
    id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
  })),
});
const validate = (r: { nodes: any[]; edges: any[] }) =>
  validateGraph(adapt(r.nodes, r.edges).nodes, adapt(r.nodes, r.edges).edges);

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

const frag = PRESETS.find((p) => p.id === "cover-envelope")!.build();
const id = (t: string) => frag.nodes.find((n) => n.data.defType === t)!.id;
const groupId = id("node-group");
const outId = id("group-output");
const popId = id("points-on-path");
const strokeId = id("spline-stroke");

// --- groupToSpec sanity ---
{
  const spec = groupToSpec(groupId, frag.nodes, frag.edges);
  const pop = spec.nodes.find((n) => n.id === popId);
  check("groupToSpec lists interior nodes with settable params", !!pop && pop.params?.count === 160, JSON.stringify(pop));
  check("groupToSpec reports the group interface", spec.interface.outputs.some((o) => o.name === "image"));
  check("groupToSpec exposes the output boundary id", spec.interface.outputNodeId === outId);
}

// --- a realistic patch: retune count + insert a transform before the image output ---
{
  const r = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    summary: "double the points and add a transform before the output",
    ops: [
      { op: "set_param", node: popId, param: "count", value: 320 },
      { op: "add_node", id: "t1", type: "transform", params: { scaleX: 1.2, scaleY: 1.2 } },
      { op: "remove_edge", from: `${strokeId}:out`, to: `${outId}:in:image` },
      { op: "add_edge", from: `${strokeId}:out`, to: "t1:in:image" },
      { op: "add_edge", from: "t1:out", to: `${outId}:in:image` },
    ],
  });
  const v = validate(r);
  const errs = v.issues.filter((i) => i.severity === "error");
  const pop = r.nodes.find((n) => n.id === popId);
  const transform = r.nodes.find((n) => n.data.defType === "transform");
  const oldEdgeGone = !r.edges.some((e) => e.source === strokeId && e.target === outId);
  const newWired =
    !!transform &&
    r.edges.some((e) => e.source === strokeId && e.target === transform.id) &&
    r.edges.some((e) => e.source === transform.id && e.target === outId);

  console.log(`\n[patch] build issues: ${r.issues.length}, validator errors: ${errs.length}`);
  check(
    "patch applies (PARAM_EXPOSED warning on the already-exposed count)",
    r.issues.every((i) => i.code === "PARAM_EXPOSED") && r.issues.length === 1,
    JSON.stringify(r.issues)
  );
  check("patched group still validates", v.ok && errs.length === 0, errs.map((e) => e.code).join(","));
  check("set_param took effect (count 160 → 320)", (pop?.data.params as any)?.count === 320);
  check("inserted node + rewired the output chain", oldEdgeGone && newWired);
  // The original interior nodes keep their identity (preservation).
  check("untouched interior node ids preserved", r.nodes.some((n) => n.id === strokeId));
  check("add_node returns local→live ids", r.ids.t1 === transform?.id, JSON.stringify(r.ids));
}

// --- bad patches ---
{
  // type-mismatched wire: circle (spline) → group image output. Applies
  // structurally, but the validator must reject it (→ repair loop).
  const r = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "add_edge", from: `${id("circle")}:out`, to: `${outId}:in:image` }],
  });
  const codes = validate(r).issues.filter((i) => i.severity === "error").map((i) => i.code);
  check("validator catches a type-mismatched patch", codes.includes("EDGE_TYPE_MISMATCH"), codes.join(","));

  // op against a non-existent node → a build issue (would feed the repair loop).
  const r2 = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "set_param", node: "ghost-node", param: "count", value: 5 }],
  });
  check("op on a missing node is reported", r2.issues.some((i) => i.code === "UNKNOWN_NODE"), JSON.stringify(r2.issues));

  // structural nodes are protected.
  const r3 = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "remove_node", node: outId }],
  });
  check("structural (boundary) nodes are protected", r3.issues.some((i) => i.code === "PROTECTED_NODE"));
}

// --- nested node-groups are removable (interior goes with the shell) ---
{
  const stub = (id: string, defType: string, parentId?: string) =>
    ({
      id,
      type: "effectNode",
      position: { x: 0, y: 0 },
      data: { defType, params: {}, parentId },
    }) as any;
  const nested = [
    stub("g", "node-group"),
    stub("gi", "group-input", "g"),
    stub("go", "group-output", "g"),
    stub("ng", "node-group", "g"),
    stub("ngi", "group-input", "ng"),
    stub("ngo", "group-output", "ng"),
    stub("circ", "circle", "ng"),
    stub("keep", "circle", "g"),
  ];
  const gone = applyRecipeEdit("g", nested, [], {
    ops: [{ op: "remove_node", node: "ng" }],
  });
  const ids = new Set(gone.nodes.map((n) => n.id));
  check(
    "nested group can be removed",
    gone.issues.length === 0 && !ids.has("ng"),
    JSON.stringify(gone.issues)
  );
  check(
    "removing a group cascades to its interior",
    !ids.has("ngi") && !ids.has("ngo") && !ids.has("circ")
  );
  check("sibling of the nested group survives", ids.has("keep") && ids.has("gi") && ids.has("go"));

  const self = applyRecipeEdit("g", nested, [], {
    ops: [{ op: "remove_node", node: "g" }],
  });
  check(
    "the group being edited still can't delete itself",
    self.issues.some((i) => i.code === "PROTECTED_NODE")
  );

  const missing = applyRecipeEdit("g", nested, [], {
    ops: [{ op: "add_edge", from: "keep:out", to: "other-layer-group:in:image" }],
  });
  check(
    "add_edge to a node not in this scope is EDGE_NODE_MISSING",
    missing.issues.some((i) => i.code === "EDGE_NODE_MISSING") && missing.edges.length === 0,
    JSON.stringify(missing.issues)
  );

  const hidden = applyRecipeEdit("g", nested, [], {
    ops: [{ op: "add_edge", from: "keep:out", to: "circ:in:image" }],
  });
  check(
    "add_edge into a nested group's interior is EDGE_OUT_OF_SCOPE",
    hidden.issues.some((i) => i.code === "EDGE_OUT_OF_SCOPE") &&
      hidden.issues.some((i) => i.message.includes("ng")) &&
      hidden.edges.length === 0,
    JSON.stringify(hidden.issues)
  );

  const shellWire = applyRecipeEdit("g", nested, [], {
    ops: [{ op: "add_edge", from: "keep:out", to: "ng:in:image" }],
  });
  check(
    "add_edge to a nested group SHELL is in scope",
    !shellWire.issues.some((i) => i.code === "EDGE_OUT_OF_SCOPE" || i.code === "EDGE_NODE_MISSING"),
    JSON.stringify(shellWire.issues)
  );
}

// --- expose / unexpose a param on the group interface (M4) ---
{
  const circleId = id("circle");
  const giId = id("group-input");
  const r = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "expose_param", node: circleId, param: "radiusX", label: "Radius" }],
  });
  const v = validate(r);
  const gi = r.nodes.find((n) => n.id === giId);
  const giSockets = ((gi?.data.params as any)?.sockets ?? []) as any[];
  const shell = r.nodes.find((n) => n.id === groupId);
  const ifaceInputs = ((shell?.data.params as any)?.interface?.inputs ?? []) as any[];
  const circle = r.nodes.find((n) => n.id === circleId);
  const promoteEdge = r.edges.some(
    (e) => e.source === giId && e.sourceHandle === "out:aux:Radius" && e.target === circleId && e.targetHandle === "in:param:radiusX"
  );

  console.log("");
  check("expose: patch applies clean", r.issues.length === 0, JSON.stringify(r.issues));
  check("expose: group still validates", v.ok && v.issues.filter((i) => i.severity === "error").length === 0);
  check("expose: group-input gains the socket", giSockets.some((s) => s.name === "Radius"));
  check("expose: shell interface gains the input", ifaceInputs.some((s) => s.name === "Radius"));
  check("expose: promote edge + exposedParams set", promoteEdge && (circle?.data.exposedParams ?? []).includes("radiusX"), JSON.stringify({ promoteEdge, exp: circle?.data.exposedParams }));

  // unexpose reverses it.
  const r2 = applyRecipeEdit(groupId, r.nodes, r.edges, {
    ops: [{ op: "unexpose_param", node: circleId, param: "radiusX" }],
  });
  const gi2Sockets = ((r2.nodes.find((n) => n.id === giId)?.data.params as any)?.sockets ?? []) as any[];
  const circle2 = r2.nodes.find((n) => n.id === circleId);
  const promoteGone = !r2.edges.some((e) => e.target === circleId && e.targetHandle === "in:param:radiusX");
  check(
    "unexpose: removes socket + edge + flag",
    !gi2Sockets.some((s) => s.name === "Radius") && promoteGone && !(circle2?.data.exposedParams ?? []).includes("radiusX")
  );
  check("unexpose: group still validates", validate(r2).ok);
  // unexposing a param that was never exposed is reported (would feed repair).
  const r3 = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "unexpose_param", node: circleId, param: "radiusX" }],
  });
  check("unexpose of an unexposed param is reported", r3.issues.some((i) => i.code === "NOT_EXPOSED"));
}

// Exposed knobs are keyed by socket name, never by list position. Unexpose
// copies the group value back onto the interior so a later re-expose
// reseeds that value — not a sibling's (the N→14 bug).
{
  const built = buildRecipe({
    name: "Exposed pair",
    nodes: [
      { id: "a", type: "constant", params: { value: 160 } },
      { id: "b", type: "constant", params: { value: 14 } },
    ],
    exposed: [
      { name: "N", node: "a", param: "value" },
      { name: "Other", node: "b", param: "value" },
    ],
    outputs: [{ name: "out", from: "a:out", type: "scalar" }],
  });
  const gid = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const a = built.nodes.find(
    (n) => n.data.defType === "constant" && n.data.params.value === 160
  )!;
  const b = built.nodes.find(
    (n) => n.data.defType === "constant" && n.data.params.value === 14
  )!;
  const tuned = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      { op: "set_param", node: gid, param: "N", value: 99 },
      { op: "set_param", node: gid, param: "Other", value: 14 },
    ],
  });
  check(
    "group shell stores N and Other by name",
    readInputValues(tuned.nodes.find((n) => n.id === gid)!.data.params).N === 99 &&
      readInputValues(tuned.nodes.find((n) => n.id === gid)!.data.params).Other === 14,
    JSON.stringify(readInputValues(tuned.nodes.find((n) => n.id === gid)!.data.params))
  );
  const unexp = applyRecipeEdit(gid, tuned.nodes, tuned.edges, {
    ops: [{ op: "unexpose_param", node: a.id, param: "value" }],
  });
  const ivU = readInputValues(unexp.nodes.find((n) => n.id === gid)!.data.params);
  const aU = unexp.nodes.find((n) => n.id === a.id)!;
  const bU = unexp.nodes.find((n) => n.id === b.id)!;
  check(
    "unexpose N keeps Other=14 by name (does not slide onto remaining slot)",
    ivU.Other === 14 && !("N" in ivU),
    JSON.stringify(ivU)
  );
  check(
    "unexpose N writes 99 back onto interior a (not the sibling 14)",
    aU.data.params.value === 99 && bU.data.params.value === 14,
    JSON.stringify({ a: aU.data.params.value, b: bU.data.params.value })
  );
  const reexp = applyRecipeEdit(gid, unexp.nodes, unexp.edges, {
    ops: [{ op: "expose_param", node: a.id, param: "value", label: "N" }],
  });
  const ivR = readInputValues(reexp.nodes.find((n) => n.id === gid)!.data.params);
  check(
    "re-expose N reseeds 99, Other stays 14",
    ivR.N === 99 && ivR.Other === 14,
    JSON.stringify(ivR)
  );
}

// --- zone interiors are visible to get_graph / groupToSpec ---
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
  const groupId = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const spec = graphToSpec(built.nodes, built.edges, groupId);
  const byType = (t: string) => spec.nodes.filter((n) => n.type === t);
  const rpt = byType("repeat")[0];
  const rptIn = byType("repeat-input")[0];
  const fe = byType("foreach")[0];
  const feIn = byType("foreach-input")[0];
  console.log("");
  check("get_graph lists Repeat Input inside the wrapping group", !!rptIn, spec.nodes.map((n) => n.type).join(","));
  check("get_graph lists nested For Each + its Input", !!fe && !!feIn);
  check("Repeat Input parent is the Repeat shell", !!rpt && rptIn?.parent === rpt.id);
  check("For Each parent is the Repeat shell", !!rpt && fe?.parent === rpt.id);
  check("For Each Input parent is the For Each shell", !!fe && feIn?.parent === fe.id);
  check(
    "zone-interior edges are listed",
    spec.edges.some((e) => e.from === `${rptIn?.id}:aux:spline` && e.to === `${fe?.id}:in:geometry`) &&
      spec.edges.some((e) => e.from === `${feIn?.id}:aux:element` && e.to === `${fe?.id}:in:spline`)
  );

  const zoneSpec = graphToSpec(built.nodes, built.edges, rpt.id);
  check(
    "get_graph scoped to a Repeat lists nested For Each members",
    zoneSpec.nodes.some((n) => n.id === feIn?.id) && zoneSpec.nodes.some((n) => n.id === fe?.id)
  );

  const patched = applyRecipeEdit(groupId, built.nodes, built.edges, {
    ops: [{ op: "set_param", node: rptIn!.id, param: "count", value: 5 }],
  });
  const rptInAfter = patched.nodes.find((n) => n.id === rptIn!.id);
  check(
    "edit_group can set_param on a zone member",
    patched.issues.length === 0 && (rptInAfter?.data.params as any)?.count === 5,
    JSON.stringify(patched.issues)
  );

  // Nested group interiors stay behind their own scope.
  const stub = (id: string, defType: string, parentId?: string) =>
    ({
      id,
      type: "effectNode",
      position: { x: 0, y: 0 },
      data: { defType, params: {}, parentId },
    }) as any;
  const nestedGraph = [
    stub("g", "node-group"),
    stub("gi", "group-input", "g"),
    stub("go", "group-output", "g"),
    stub("ng", "node-group", "g"),
    stub("secret", "circle", "ng"),
    stub("rpt", "repeat", "g"),
    stub("rptIn", "repeat-input", "rpt"),
  ];
  const nestedSpec = graphToSpec(nestedGraph, [], "g");
  check(
    "nested group interiors stay hidden; zone members do not",
    !nestedSpec.nodes.some((n) => n.id === "secret") &&
      nestedSpec.nodes.some((n) => n.id === "ng") &&
      nestedSpec.nodes.some((n) => n.id === "rptIn")
  );
}

// --- set_param expression mints ch() channels (edit_group / MCP contract) ---
{
  const built = buildRecipe({
    name: "Pex",
    nodes: [
      { id: "g", type: "grid" },
      {
        id: "pex",
        type: "point-expression",
        params: { expression: "x = px;\ny = py;" },
      },
    ],
    edges: [{ from: "g:out", to: "pex:in:points" }],
    outputs: [{ name: "points", from: "pex:out", type: "points" }],
  });
  const groupId = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const pex = built.nodes.find((n) => n.data.defType === "point-expression")!;
  const patched = applyRecipeEdit(groupId, built.nodes, built.edges, {
    summary: "add a channel",
    ops: [
      {
        op: "set_param",
        node: pex.id,
        param: "expression",
        value: 'ch("k", 0.1, 0, 1);\nx = px + ch("k");\ny = py;',
      },
    ],
  });
  const after = patched.nodes.find((n) => n.id === pex.id)!;
  const channels = ((after.data.params as any).inputs as { name: string; id: string }[]) ?? [];
  const chan = channels.find((i) => i.name === "k");
  const sockets = (after.data.inputs ?? []).map((s: any) => s.name);
  check(
    "edit_group set_param expression mints channels",
    patched.issues.length === 0 && !!chan,
    JSON.stringify(patched.issues)
  );
  check(
    "minted channel appears as a socket",
    !!chan && sockets.includes(`in:${chan.id}`)
  );
}

// --- group-boundary channel exposure (no re-insert) ---
{
  const built = buildRecipe({
    name: "Ink",
    nodes: [
      { id: "g", type: "grid" },
      {
        id: "pex",
        type: "point-expression",
        params: { expression: 'ch("ink", 0.5, 0, 1);\nx = px;\ny = py;' },
      },
    ],
    edges: [{ from: "g:out", to: "pex:in:points" }],
    outputs: [{ name: "points", from: "pex:out", type: "points" }],
  });
  const gid = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const gi = built.nodes.find((n) => n.data.defType === "group-input")!;
  const pex = built.nodes.find((n) => n.data.defType === "point-expression")!;
  const ink = ((pex.data.params as any).inputs as { name: string; id: string }[]).find(
    (i) => i.name === "ink"
  )!;
  check("fixture has an ink channel", !!ink);

  const named = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "add_edge", from: `${gi.id}:aux:ink`, to: `${pex.id}:in:ink` }],
  });
  const namedGi = named.nodes.find((n) => n.id === gi.id)!;
  const namedShell = named.nodes.find((n) => n.id === gid)!;
  const namedWire = named.edges.find(
    (e) =>
      e.source === gi.id &&
      e.sourceHandle === "out:aux:ink" &&
      e.target === pex.id &&
      e.targetHandle === `in:in:${ink.id}`
  );
  check(
    "add_edge gi:aux:ink mints the group input",
    named.issues.length === 0 &&
      readBoundarySockets(namedGi.data.params).some((s) => s.name === "ink" && s.type === "scalar"),
    JSON.stringify(named.issues)
  );
  check(
    "minted input appears on the group shell",
    readGroupInterface(namedShell.data.params as Record<string, unknown>).inputs.some(
      (s) => s.name === "ink"
    )
  );
  check("named add_edge lands on the channel socket", !!namedWire);
  const spec = graphToSpec(named.nodes, named.edges, gid);
  const pexSpec = spec.nodes.find((n) => n.id === pex.id)!;
  check(
    "get_graph lists the channel NAME as the wireable handle",
    !!(
      pexSpec.inputs?.some((i) => i.name === "ink" && i.id === ink.id && i.type === "scalar") &&
      !pexSpec.inputs?.some((i) => i.name === `in:${ink.id}`)
    ),
    JSON.stringify(pexSpec.inputs)
  );
  check(
    "get_graph edges print the channel name, not in:in:ein-…",
    spec.edges.some((e) => e.to === `${pex.id}:in:ink`) &&
      !spec.edges.some((e) => e.to.includes(`in:in:${ink.id}`)),
    JSON.stringify(spec.edges.filter((e) => e.to.includes(pex.id)))
  );
  const byEin = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "add_edge", from: `${gi.id}:aux:ink`, to: `${pex.id}:in:${ink.id}` }],
  });
  check(
    "add_edge accepts in:<ein-id> the same as in:<name>",
    byEin.issues.length === 0 &&
      byEin.edges.some(
        (e) =>
          e.source === gi.id &&
          e.target === pex.id &&
          e.targetHandle === `in:in:${ink.id}`
      ),
    JSON.stringify(byEin.issues)
  );
  const bySock = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "add_edge", from: `${gi.id}:aux:ink`, to: `${pex.id}:in:in:${ink.id}` }],
  });
  check(
    "add_edge accepts in:in:<ein-id> (verbatim old listing)",
    bySock.issues.length === 0 &&
      bySock.edges.some(
        (e) => e.target === pex.id && e.targetHandle === `in:in:${ink.id}`
      ),
    JSON.stringify(bySock.issues)
  );
  check(
    "no leftover __virtual__ edge after named mint",
    !named.edges.some((e) => (e.sourceHandle ?? "").includes(VIRTUAL_SOCKET))
  );

  const virt = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      {
        op: "add_edge",
        from: `${gi.id}:aux:${VIRTUAL_SOCKET}`,
        to: `${pex.id}:in:ink`,
      },
    ],
  });
  const virtGi = virt.nodes.find((n) => n.id === gi.id)!;
  const virtWire = virt.edges.find(
    (e) => e.source === gi.id && e.target === pex.id && e.targetHandle === `in:in:${ink.id}`
  );
  check(
    "add_edge from __virtual__ mints a named socket (not virtual)",
    virt.issues.length === 0 &&
      readBoundarySockets(virtGi.data.params).some((s) => s.name === "ink") &&
      virtWire?.sourceHandle === "out:aux:ink" &&
      !virt.edges.some((e) => (e.sourceHandle ?? "").includes(VIRTUAL_SOCKET)),
    JSON.stringify(virt.issues)
  );

  const dead = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      {
        op: "add_edge",
        from: `${gi.id}:aux:${VIRTUAL_SOCKET}`,
        to: `${pex.id}:in:nope`,
      },
    ],
  });
  check(
    "dead __virtual__ add_edge is an error, not a silent ok",
    dead.issues.some((i) => i.code === "BAD_ENDPOINT") &&
      !dead.edges.some((e) => (e.sourceHandle ?? "").includes(VIRTUAL_SOCKET)),
    JSON.stringify(dead.issues)
  );

  const exposed = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "expose_param", node: pex.id, param: "ink" }],
  });
  const expGi = exposed.nodes.find((n) => n.id === gi.id)!;
  const expWire = exposed.edges.find(
    (e) =>
      e.source === gi.id &&
      e.target === pex.id &&
      e.targetHandle === `in:in:${ink.id}`
  );
  check(
    "expose_param ink mints a group input onto the channel",
    !exposed.issues.some((i) => i.code !== "CHANNEL_EXPOSE") &&
      readBoundarySockets(expGi.data.params).some((s) => s.name === "ink") &&
      !!expWire,
    JSON.stringify(exposed.issues)
  );
  check(
    "expose_param on a channel warns it is socket-only",
    exposed.issues.some(
      (i) =>
        i.code === "CHANNEL_EXPOSE" &&
        /promoted as socket only; no shell value \(channel is not a param\)/.test(i.message)
    ),
    JSON.stringify(exposed.issues)
  );

  const gone = applyRecipeEdit(gid, exposed.nodes, exposed.edges, {
    ops: [{ op: "unexpose_param", node: pex.id, param: "ink" }],
  });
  const goneGi = gone.nodes.find((n) => n.id === gi.id)!;
  check(
    "unexpose_param ink removes the boundary socket",
    gone.issues.length === 0 &&
      !readBoundarySockets(goneGi.data.params).some((s) => s.name === "ink"),
    JSON.stringify(gone.issues)
  );
}

// --- get_graph compactness + group-shell params + exposed-set warning ---
{
  const built = buildRecipe({
    name: "Spin Box",
    nodes: [
      { id: "r", type: "rectangle", params: { width: 0.4 } },
      { id: "s", type: "spline-stroke", params: { thickness: 0.02 } },
    ],
    edges: [{ from: "r:out", to: "s:in:path" }],
    outputs: [{ name: "image", from: "s:out", type: "image" }],
    exposed: [{ name: "Weight", node: "s", param: "thickness" }],
  });
  const gid = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const stroke = built.nodes.find((n) => n.data.defType === "spline-stroke")!;
  const full = graphToSpec(built.nodes, built.edges, gid);
  const ids = graphToSpec(built.nodes, built.edges, gid, { verbosity: "ids" });
  const slim = graphToSpec(built.nodes, built.edges, gid, { params: "non_default" });
  const strokeFull = full.nodes.find((n) => n.id === stroke.id)!;
  const strokeIds = ids.nodes.find((n) => n.id === stroke.id)!;
  const strokeSlim = slim.nodes.find((n) => n.id === stroke.id)!;
  check(
    "verbosity=ids omits param dumps",
    Object.keys(strokeIds.params ?? {}).length === 0 &&
      !strokeIds.exposed &&
      strokeIds.id === stroke.id &&
      strokeIds.type === "spline-stroke",
    JSON.stringify(strokeIds)
  );
  const fullParams = strokeFull.params ?? {};
  const slimParams = strokeSlim.params ?? {};
  check(
    "full graph dumps many spline-stroke params",
    Object.keys(fullParams).length > 10,
    String(Object.keys(fullParams).length)
  );
  check(
    "non_default keeps authored thickness and drops catalog defaults",
    slimParams.thickness === 0.02 &&
      Object.keys(slimParams).length < Object.keys(fullParams).length,
    JSON.stringify(slimParams)
  );
  const parent = graphToSpec(built.nodes, built.edges);
  const shell = parent.nodes.find((n) => n.id === gid);
  check(
    "parent-scope get_graph shows group exposed value",
    shell?.params?.Weight === 0.02,
    JSON.stringify(shell?.params)
  );
  const scoped = graphToSpec(built.nodes, built.edges, gid);
  check(
    "scoped get_graph lists interface.values",
    scoped.interface.values?.Weight === 0.02,
    JSON.stringify(scoped.interface)
  );
  const shadowed = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "set_param", node: stroke.id, param: "thickness", value: 0.08 }],
  });
  check(
    "set_param on an exposed interior param warns that group value wins",
    shadowed.issues.some((i) => i.code === "PARAM_EXPOSED" && /group value wins/.test(i.message)) &&
      shadowed.nodes.find((n) => n.id === stroke.id)?.data.params.thickness === 0.08,
    JSON.stringify(shadowed.issues)
  );
  const retuned = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "set_param", node: gid, param: "Weight", value: 0.11 }],
  });
  const shellAfter = retuned.nodes.find((n) => n.id === gid)!;
  check(
    "set_param on the group shell writes inputValues by exposed label",
    retuned.issues.length === 0 &&
      readInputValues(shellAfter.data.params).Weight === 0.11,
    JSON.stringify(retuned.issues)
  );
}

// --- malformed ops reject; local ids resolve for rename_node; expression hash ---
{
  const nested = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ remove_node: { node: popId } } as any],
  });
  check(
    "nested op shape is MALFORMED_OP and applies nothing",
    nested.applied === 0 &&
      nested.issues.some((i) => i.code === "MALFORMED_OP" && /nested \{remove_node/.test(i.message)) &&
      nested.nodes.length === frag.nodes.length,
    JSON.stringify(nested.issues)
  );
  const noop = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [{ op: "noop" } as any],
  });
  check(
    "unknown op is UNKNOWN_OP and applies nothing",
    noop.applied === 0 &&
      noop.issues.some((i) => i.code === "UNKNOWN_OP" && /unknown op "noop"/.test(i.message)),
    JSON.stringify(noop.issues)
  );
  const mixed = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [
      { op: "noop" } as any,
      { op: "set_param", node: popId, param: "count", value: 1 },
    ],
  });
  check(
    "a bad op in the batch blocks the rest (nothing committed-shaped)",
    mixed.applied === 0 &&
      mixed.ops.length === 1 &&
      !mixed.ops.some((o) => o.op === "set_param"),
    JSON.stringify(mixed.ops)
  );
  const renamed = applyRecipeEdit(groupId, frag.nodes, frag.edges, {
    ops: [
      { op: "add_node", id: "c_rows", type: "circle" },
      { op: "rename_node", node: "c_rows", name: "Rows" },
    ],
  });
  const minted = renamed.ops.find((o) => o.op === "add_node")?.node;
  const circle = renamed.nodes.find((n) => n.id === minted);
  check(
    "rename_node resolves add_node local id in the same batch",
    renamed.applied === 2 &&
      renamed.issues.length === 0 &&
      circle?.data.name === "Rows" &&
      renamed.ops.some((o) => o.op === "rename_node" && o.ok && o.node === minted),
    JSON.stringify({ issues: renamed.issues, ops: renamed.ops, name: circle?.data.name })
  );
  const longExpr = `${"x = px;\n".repeat(30)}y = py;`;
  const exprBuilt = buildRecipe({
    name: "Expr",
    nodes: [
      { id: "g", type: "grid" },
      { id: "pex", type: "point-expression", params: { expression: longExpr } },
    ],
    edges: [{ from: "g:out", to: "pex:in:points" }],
    outputs: [{ name: "points", from: "pex:out", type: "points" }],
  });
  const egid = exprBuilt.nodes.find((n) => n.data.defType === "node-group")!.id;
  const hashed = graphToSpec(exprBuilt.nodes, exprBuilt.edges, egid, {
    params: "non_default",
    expressions: "hash",
  });
  const pexH = hashed.nodes.find((n) => n.type === "point-expression")!;
  const digest = pexH.params?.expression as { hash?: string; chars?: number } | string;
  check(
    "compact get_graph hashes long expressions",
    typeof digest === "object" &&
      typeof digest.hash === "string" &&
      digest.hash.length === 8 &&
      digest.chars === longExpr.length,
    JSON.stringify(digest)
  );
  const fullExpr = graphToSpec(exprBuilt.nodes, exprBuilt.edges, egid, { params: "all" });
  const pexF = fullExpr.nodes.find((n) => n.type === "point-expression")!;
  check(
    "params=all keeps the full expression",
    pexF.params?.expression === longExpr
  );
}

{
  const { inspectSocketValue, pickInspectSocket } = await import("@/engine/socket-inspect");
  const { pointsFromArray } = await import("@/engine/points");
  const pts = pointsFromArray([
    { pos: [0.1, 0.2] },
    { pos: [0.8, 0.9], rotation: 1.2 },
    { pos: [0.5, 0.5] },
  ]);
  const dump = inspectSocketValue(pts, 2);
  check(
    "inspect points reports Y-down bounds and truncates",
    dump.kind === "points" &&
      dump.space === "normalized [0,1]² Y-down (row 0 at top)" &&
      dump.count === 3 &&
      dump.truncated === true &&
      (dump.points as unknown[]).length === 2 &&
      (dump.bounds as { min: number[] }).min[0] === 0.1 &&
      (dump.bounds as { max: number[] }).max[1] === 0.9,
    JSON.stringify(dump)
  );
  const spline = inspectSocketValue({
    kind: "spline",
    subpaths: [
      {
        closed: true,
        anchors: [
          { pos: [0.2, 0.3], attrs: { w: 2 } },
          { pos: [0.4, 0.1] },
        ],
      },
    ],
  }, 8);
  check(
    "inspect spline dumps anchors + attrs",
    spline.kind === "spline" &&
      spline.anchorCount === 2 &&
      (spline.subpaths as { anchors: { attrs?: { w: number } }[] }[])[0].anchors[0].attrs?.w === 2,
    JSON.stringify(spline)
  );
  const picked = pickInspectSocket(
    { aux: { path: { kind: "spline", subpaths: [] } } },
    undefined
  );
  check("pickInspectSocket prefers spline aux when primary is empty", picked.socket === "aux:path");
}

// --- Expression edit_group: named sockets + grow + expose seed + dead socket prune + duplicate ---
{
  const built = buildRecipe({
    name: "Pixel",
    nodes: [
      { id: "u", type: "constant", params: { value: 0.3 } },
      { id: "n", type: "constant", params: { value: 1 } },
      { id: "grid", type: "grid", params: { countX: 4 } },
    ],
    edges: [{ from: "u:out", to: "n:param:value" }],
    exposed: [
      { name: "u", node: "u", param: "value" },
      { name: "index", node: "n", param: "value" },
    ],
    outputs: [{ name: "pts", from: "grid:out", type: "points" }],
  });
  const gid = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const iv = readInputValues(built.nodes.find((n) => n.id === gid)!.data.params);
  check(
    "expose/recipe seeds shell from interior 0.3 and 1 (not 0)",
    iv.u === 0.3 && iv.index === 1,
    JSON.stringify(iv)
  );

  const uNode = built.nodes.find(
    (n) => n.data.defType === "constant" && n.data.params.value === 0.3
  )!;
  const nNode = built.nodes.find(
    (n) => n.data.defType === "constant" && n.data.params.value === 1
  )!;
  const grid = built.nodes.find((n) => n.data.defType === "grid")!;

  const viaEdit = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      { op: "add_node", id: "c2", type: "constant", params: { value: 0.7 } },
      { op: "expose_param", node: "c2", param: "value", label: "amt" },
    ],
  });
  const iv2 = readInputValues(viaEdit.nodes.find((n) => n.id === gid)!.data.params);
  check(
    "expose_param in the same batch seeds 0.7 from the new constant",
    viaEdit.issues.filter((i) => i.code !== "PARAM_EXPOSED").length === 0 && iv2.amt === 0.7,
    JSON.stringify({ issues: viaEdit.issues, iv: iv2 })
  );

  const exprEdit = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      { op: "add_node", id: "e", type: "expression", params: { expression: "sin(p)*x" } },
      { op: "add_edge", from: `${uNode.id}:out`, to: "e:in:x" },
      { op: "add_edge", from: `${nNode.id}:out`, to: "e:in:p" },
    ],
  });
  const exprNode = exprEdit.nodes.find((n) => n.data.defType === "expression")!;
  const exprIns = (exprNode?.data.params.inputs as { name: string; id: string }[]) ?? [];
  const exprVal = validate(exprEdit);
  check(
    "edit_group can wire Expression by variable name (default x + grown p)",
    exprEdit.issues.length === 0 &&
      exprVal.ok &&
      exprIns.some((e) => e.name === "x") &&
      exprIns.some((e) => e.name === "p") &&
      exprEdit.edges.some((e) => e.target === exprNode.id && e.targetHandle === `in:in:${exprIns.find((i) => i.name === "x")!.id}`),
    JSON.stringify({ issues: exprEdit.issues, ins: exprIns, val: exprVal.issues.filter((i) => i.severity === "error") })
  );

  const einDefault = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      { op: "add_node", id: "e0", type: "expression" },
      { op: "add_edge", from: `${uNode.id}:out`, to: "e0:in:ein-x0" },
    ],
  });
  const e0 = einDefault.nodes.find((n) => n.data.defType === "expression")!;
  const e0ins = (e0?.data.params.inputs as { id: string }[]) ?? [];
  const e0val = validate(einDefault);
  check(
    "edit_group add_edge to default ein-x0 is accepted",
    einDefault.issues.length === 0 &&
      e0val.ok &&
      einDefault.edges.some(
        (e) => e.target === e0.id && e.targetHandle === `in:in:${e0ins[0]?.id ?? "ein-x0"}`
      ),
    JSON.stringify({ issues: einDefault.issues, val: e0val.issues.filter((i) => i.severity === "error") })
  );

  const removed = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "remove_node", node: nNode.id }],
  });
  const ivR = readInputValues(removed.nodes.find((n) => n.id === gid)!.data.params);
  const giR = removed.nodes.find((n) => n.data.defType === "group-input")!;
  check(
    "remove_node of an exposed constant drops the dead interface socket",
    !("index" in ivR) &&
      !readBoundarySockets(giR.data.params).some((s) => s.name === "index") &&
      ivR.u === 0.3,
    JSON.stringify({ iv: ivR, socks: readBoundarySockets(giR.data.params) })
  );

  const dup = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      {
        op: "duplicate_node",
        node: gid,
        id: "pixel2",
      },
    ],
  });
  check(
    "duplicate_node cannot clone the scope being edited",
    dup.issues.some((i) => i.code === "PROTECTED_NODE"),
    JSON.stringify(dup.issues)
  );

  const layerish = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      {
        op: "duplicate_node",
        node: grid.id,
        id: "g2",
        params: { countX: 8 },
      },
    ],
  });
  const cloneId = dupIds(layerish, "g2");
  const clone = layerish.nodes.find((n) => n.id === cloneId);
  check(
    "duplicate_node clones a node with param overrides",
    layerish.issues.length === 0 &&
      !!clone &&
      clone.data.params.countX === 8 &&
      clone.id !== grid.id &&
      grid.data.params.countX === 4,
    JSON.stringify({ issues: layerish.issues, clone: clone?.id, count: clone?.data.params.countX })
  );
}

function dupIds(r: { ops: { id?: string; node?: string }[] }, local: string): string | undefined {
  return r.ops.find((o) => o.id === local)?.node;
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
