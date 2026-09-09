// Guards the expression channel kinds
// (specdocs/090426_expression-channel-kinds.md): the scanner + Sync for
// ch / pick / toggle / color / ramp / curve in both the JS call form and the
// GLSL comment form, Point Expression's reads (seeds, rows, wires, and the
// factory-scoped kernel that lets `let color = …` shadow the env), the GLSL
// template's per-kind declarations, recipe name resolution / expose /
// set_param-by-channel, get_graph's channel listing, and the LUT builders.
//
//   npx tsx scripts/check-expression-channels.mts

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
const { getNodeDef } = await import("@/engine/registry");
const { coerceValue } = await import("@/engine/coerce");
const { makePoints } = await import("@/engine/points");
const EC = await import("@/engine/expr-channels");
const { pointExpressionNode } = await import("@/nodes/effect/point-expression");
const { glslExpressionNode, glslExpressionSource, glslExpressionPreludeLines, splitGlslUserSource } = await import(
  "@/nodes/effect/glsl-expression"
);
const { buildRecipe, resolveChannelHandle } = await import("@/state/recipe-builder");
const { graphToSpec, applyRecipeEdit } = await import("@/state/recipe-edit");
const { readBoundarySockets } = await import("@/engine/groups");
type PointsValue = import("@/engine/types").PointsValue;
type RenderContext = import("@/engine/types").RenderContext;
type NodeOutput = import("@/engine/types").NodeOutput;
type SocketValue = import("@/engine/types").SocketValue;
type ExprInput = import("@/engine/types").ExprInput;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
{
  const refs = EC.scanChannelRefs(`
const k = ch("k", 0.1, 0, 1);
const bare = ch("bare");
const expr = ch("expr", 60*10);
const mode = pick("mode", "a", "b", "c");
const on = toggle("on", true);
const off = toggle("off", 0);
const tint = color("tint", "#F80");
const c = ramp("ink", clamp(t * 2.0, 0.0, 1.0), "#000000", "#ffffff", "#ff0000");
const f = curve("falloff", x, 1, 0);
const single = curve("single", 0.5);
const again = ch("k", 99);
`);
  const by: Record<string, (typeof refs)[number]> = Object.fromEntries(refs.map((r) => [r.name, r]));
  check(
    "ch positional default/min/max",
    by.k?.kind === "scalar" && by.k.default === 0.1 && by.k.min === 0 && by.k.max === 1
  );
  check("ch without literal args has no default", by.bare?.default === undefined && by.expr?.default === undefined);
  check(
    "pick collects string options (first = default)",
    by.mode?.kind === "enum" && by.mode.options?.join() === "a,b,c" && by.mode.default === "a"
  );
  check("toggle reads bool / number seeds", by.on?.default === true && by.off?.default === false);
  check("color normalizes 3-digit hex", by.tint?.kind === "color" && by.tint.default === "#ff8800");
  check(
    "ramp skips the runtime arg (nested parens) and seeds 3 evenly spaced stops",
    by.ink?.kind === "ramp" &&
      by.ink.stops?.length === 3 &&
      near(by.ink.stops[1].position, 0.5) &&
      by.ink.stops[2].color === "#ff0000",
    JSON.stringify(by.ink)
  );
  check(
    "curve seeds its y list",
    by.falloff?.kind === "curve" &&
      by.falloff.points?.length === 2 &&
      by.falloff.points[0].y === 1 &&
      by.falloff.points[1].y === 0
  );
  check(
    "curve with a single literal stays identity",
    by.single?.points?.length === 2 && by.single.points[0].y === 0 && by.single.points[1].y === 1
  );
  check("first occurrence of a name wins", by.k.default === 0.1 && refs.filter((r) => r.name === "k").length === 1);
}
{
  const refs = EC.scanChannelRefs(
    `// ramp("ink", "#000000", "#ffffff")\n// curve("fall", 1, 0.5, 0)\n// toggle("inv", false)\n// ch("k", 1\nfragColor = vec4(k);`
  );
  const by: Record<string, (typeof refs)[number]> = Object.fromEntries(refs.map((r) => [r.name, r]));
  check("GLSL comment ramp seeds 2 stops", by.ink?.stops?.length === 2 && by.ink.stops[1].position === 1);
  check("GLSL comment curve seeds 3 points", by.fall?.points?.length === 3 && near(by.fall.points[1].x, 0.5));
  check("GLSL comment toggle", by.inv?.kind === "toggle" && by.inv.default === false);
  check("unterminated declaration stops at the line", by.k?.default === 1 && refs.length === 4);
}

// ---------------------------------------------------------------------------
// Sync + row model
// ---------------------------------------------------------------------------
const ALL_KINDS_SRC =
  'ch("k", 0.5, 0, 1); toggle("on", true); color("tint", "#ff0000"); ' +
  'ramp("ink", t, "#000000", "#ffffff"); curve("f", x, 1, 0); pick("m", "a", "b")';
const first = EC.syncChannelInputs([], ALL_KINDS_SRC);
{
  const kinds = first.map((e) => `${e.name}:${EC.channelKind(e)}`).join(",");
  check("sync mints every kind", kinds === "k:scalar,on:toggle,tint:color,ink:ramp,f:curve,m:enum", kinds);
  const socks = first.map((e) => `${e.name}:${EC.channelSocketType(e)}`).join(",");
  check(
    "socket types by kind",
    socks === "k:scalar,on:scalar,tint:vec4,ink:color_ramp,f:null,m:null",
    socks
  );
  const same = EC.syncChannelInputs(first, 'ch("k", 9); toggle("on", false)');
  check("sync is add-only and referentially stable when nothing is new", same === first);
  const more = EC.syncChannelInputs(first, `${ALL_KINDS_SRC}; ch("n", 2)`);
  check(
    "sync appends only new names, ids kept",
    more.length === first.length + 1 && more[0].id === first[0].id && more[6].name === "n"
  );
  check(
    "legacy rows derive their kind",
    EC.channelKind({ id: "a", name: "a", default: 1 }) === "scalar" &&
      EC.channelKind({ id: "b", name: "b", default: "x", options: ["x"] }) === "enum"
  );
  const m = first.find((e) => e.name === "m")!;
  check(
    "pick ≤ 3 options renders segmented, more a dropdown",
    EC.channelParamDef(m).control === "segmented" &&
      EC.channelParamDef({ ...m, options: ["a", "b", "c", "d"] }).control === undefined
  );
  check(
    "row ParamDef types",
    ["scalar", "boolean", "color", "color_ramp", "float_curve", "enum"].join() ===
      first.map((e) => EC.channelParamDef(e).type).join()
  );
}

// ---------------------------------------------------------------------------
// set_param by channel name (vetting)
// ---------------------------------------------------------------------------
{
  const def = getNodeDef("point-expression")!;
  const params = { inputs: first, expression: ALL_KINDS_SRC };
  const set = (name: string, v: unknown) => EC.setExprChannelValue(def, params, name, v);
  const val = (r: ReturnType<typeof set>, name: string) =>
    r.ok ? (r.params.inputs as ExprInput[]).find((e) => e.name === name)!.default : undefined;
  check("scalar rejects text, accepts number, clamps to ch range", !set("k", "abc").ok && val(set("k", 0.7), "k") === 0.7 && val(set("k", 5), "k") === 1);
  check("toggle accepts boolean and 0/1", val(set("on", false), "on") === false && val(set("on", 1), "on") === true);
  check("color accepts hex, rejects junk", val(set("tint", "#00FF00"), "tint") === "#00ff00" && !set("tint", "nope").ok);
  const ramp = set("ink", [
    { position: 0, color: "#ff0000" },
    { position: 1, color: "#0000ff", alpha: 0.5 },
  ]);
  const stops = val(ramp, "ink") as { id: string; position: number; color: string; alpha?: number }[];
  check(
    "ramp accepts [{position,color,alpha?}] and mints ids",
    ramp.ok && stops.length === 2 && !!stops[0].id && stops[1].alpha === 0.5 && stops[1].color === "#0000ff",
    JSON.stringify(ramp)
  );
  check("ramp rejects empty / bad stops", !set("ink", []).ok && !set("ink", [{ position: 2, color: "#fff" }]).ok);
  const curve = set("f", [
    { x: 0, y: 0.2 },
    { x: 1, y: 0.8 },
  ]);
  const pts = val(curve, "f") as { x: number; y: number }[];
  check("curve accepts [{x,y}]", curve.ok && pts.length === 2 && pts[1].y === 0.8);
  check("curve rejects a single point", !set("f", [{ x: 0, y: 0 }]).ok);
  check("enum accepts an option, rejects others", val(set("m", "b"), "m") === "b" && !set("m", "z").ok);
  check("unknown channel is refused", !set("nope", 1).ok);
  check("setting never touches the source list", (params.inputs as ExprInput[]).find((e) => e.name === "k")!.default === 0.5);
}

// ---------------------------------------------------------------------------
// LUT builders
// ---------------------------------------------------------------------------
{
  const lut = EC.buildRampLut(EC.rampStopsFromHexes(["#000000", "#ffffff"]));
  const n = EC.CHANNEL_LUT_SIZE;
  check(
    "ramp LUT black→white endpoints + midpoint",
    lut.length === n * 4 && lut[0] === 0 && lut[3] === 1 && near(lut[(n - 1) * 4], 1) && near(lut[128 * 4], 128 / (n - 1), 0.01)
  );
  const clut = EC.buildCurveLut(EC.curvePointsFromYs([1, 0]));
  check("curve LUT 1→0 endpoints", near(clut[0], 1) && near(clut[(n - 1) * 4], 0) && clut[3] === 1);
  const s = EC.makeRampSampler([
    { id: "a", position: 0.25, color: "#ff0000" },
    { id: "b", position: 0.75, color: "#0000ff", alpha: 0 },
  ]);
  const mid = s(0.5);
  check("ramp sampler brackets + lerps straight alpha", near(mid[0], 0.5) && near(mid[2], 0.5) && near(mid[3], 0.5) && s(0)[0] === 1);
}

// ---------------------------------------------------------------------------
// Point Expression runtime
// ---------------------------------------------------------------------------
function makeCtx(): RenderContext {
  return { time: 0, frame: 0, fps: 60, playing: true, state: {}, width: 1920, height: 1080 } as unknown as RenderContext;
}
function seed(count: number): PointsValue {
  const pts = makePoints(count, { withScales: true, withRotations: true });
  for (let i = 0; i < count; i++) {
    pts.positions[i * 2] = i / Math.max(1, count - 1);
    pts.positions[i * 2 + 1] = 0.5;
    pts.scales![i * 2] = 1;
    pts.scales![i * 2 + 1] = 1;
    pts.rotations![i] = 0;
  }
  return pts;
}
function evalPE(
  pts: PointsValue,
  expression: string,
  inputsParam: ExprInput[],
  wired: Record<string, SocketValue> = {}
): PointsValue {
  const ctx = makeCtx();
  const out = pointExpressionNode.compute({
    inputs: { points: coerceValue(pts, "points", ctx), ...wired },
    auxIn: {},
    params: { target: "points", inputs: inputsParam, expression, on_error: "passthrough" },
    ctx,
    nodeId: "pex",
  }) as NodeOutput;
  if (out.primary?.kind !== "points") return { kind: "points", count: 0, positions: new Float32Array(0), points: [] } as PointsValue;
  return out.primary;
}
{
  const src = `const c = ramp("ink", index / (count - 1), "#000000", "#ffffff");
const col = color("tint", "#ff0000");
x = c[0];
y = curve("fall", index / (count - 1), 1, 0);
sy = 1 + col[0];
keep = toggle("on", true);
let step = 3; // shadows the built-in step() — must compile (env is one scope up)
sx = step;`;
  const out = evalPE(seed(5), src, []);
  check(
    "seeded ramp / curve / color / toggle read without rows",
    out.count === 5 && near(out.positions[0], 0) && near(out.positions[8], 1) && near(out.positions[1], 1) && near(out.positions[9], 0),
    `count ${out.count} pos ${Array.from(out.positions).map((v) => v.toFixed(2)).join(",")}`
  );
  check("let step shadows the env (factory-scoped kernel)", near(out.scales![0], 3) && near(out.scales![1], 2), `scales ${Array.from(out.scales ?? [])}`);

  const rows: ExprInput[] = [
    { id: "r1", name: "ink", kind: "ramp", default: EC.rampStopsFromHexes(["#ff0000", "#0000ff"]) },
    { id: "t1", name: "on", kind: "toggle", default: false },
    { id: "c1", name: "tint", kind: "color", default: "#00ff00" },
    { id: "f1", name: "fall", kind: "curve", default: EC.curvePointsFromYs([0, 1]) },
  ];
  const culled = evalPE(seed(5), src, rows);
  check("toggle row false culls every point", culled.count === 0);
  const on = evalPE(seed(5), src, rows, { "in:t1": { kind: "scalar", value: 1 } });
  check(
    "wired scalar drives the toggle; rows replace seeds (ramp red→blue, curve 0→1, green tint)",
    on.count === 5 && near(on.positions[0], 1) && near(on.positions[8], 0) && near(on.positions[9], 1) && near(on.scales![1], 1),
    `count ${on.count} pos ${Array.from(on.positions).map((v) => v.toFixed(2)).join(",")} sy ${on.scales?.[1]}`
  );
  const wiredMore = evalPE(seed(5), src, rows, {
    "in:t1": { kind: "scalar", value: 1 },
    "in:c1": { kind: "vec4", value: [0.25, 0, 0, 1] },
    "in:r1": { kind: "color_ramp", stops: EC.rampStopsFromHexes(["#000000", "#ffffff"]), interp: "linear" },
  });
  check(
    "wired vec4 → color and color_ramp → ramp win over the rows",
    near(wiredMore.scales![1], 1.25) && near(wiredMore.positions[0], 0) && near(wiredMore.positions[8], 1),
    `sy ${wiredMore.scales?.[1]} x0 ${wiredMore.positions[0]} x4 ${wiredMore.positions[8]}`
  );
  check("validateParams smoke-runs the new env", pointExpressionNode.validateParams!({ expression: src }).length === 0);
  check(
    "validateParams accepts a temp named after a built-in",
    pointExpressionNode.validateParams!({ expression: "let step = 2;\nx = px + step * 0.01;" }).length === 0
  );
  check(
    "validateParams still catches undeclared temps",
    pointExpressionNode.validateParams!({ expression: "foo = 1;\nx = px;" }).length === 1
  );
  const sockets = pointExpressionNode.resolveInputs!({ inputs: rows, target: "points" }).map((s) => `${s.name}:${s.type}`);
  check(
    "Point Expression sockets by kind",
    sockets.includes("in:r1:color_ramp") && sockets.includes("in:t1:scalar") && sockets.includes("in:c1:vec4") && !sockets.some((s) => s.startsWith("in:f1")),
    sockets.join(",")
  );
}

// ---------------------------------------------------------------------------
// GLSL template
// ---------------------------------------------------------------------------
{
  const rows: ExprInput[] = [
    { id: "1", name: "k", default: 0.5 },
    { id: "2", name: "on", kind: "toggle", default: true },
    { id: "3", name: "mode", kind: "enum", default: "soft", options: ["soft", "hard edge", "3", "hard edge"] },
    { id: "4", name: "tint", kind: "color", default: "#ff8800" },
    { id: "5", name: "ink", kind: "ramp", default: [] },
    { id: "6", name: "fall", kind: "curve", default: [] },
    { id: "7", name: "u_bad", default: 1 },
    { id: "8", name: "bad name", default: 1 },
    { id: "9", name: "dbl__under", default: 1 },
  ];
  const params = { inputs: rows, expression: "fragColor = vec4(1.0);" };
  const src = glslExpressionSource(params);
  const has = (s: string) => src.includes(s);
  check(
    "GLSL declarations per kind",
    has("uniform float k;") &&
      has("uniform bool on;") &&
      has("uniform int mode;") &&
      has("const int mode_soft = 0;") &&
      has("const int mode_hard_edge = 1;") &&
      has("const int mode_3 = 2;") &&
      has("uniform vec4 tint;") &&
      has("uniform sampler2D u_ramp_ink;") &&
      has("vec4 ink(float t)") &&
      has("uniform sampler2D u_curve_fall;") &&
      has("float fall(float t)"),
    src
  );
  check("duplicate option idents emitted once", src.split("const int mode_hard_edge").length === 2);
  check("u_-prefixed, double-underscore and invalid names are skipped", !has("u_bad") && !has("bad name") && !has("dbl__under"));
  const prelude = glslExpressionPreludeLines(params);
  const bodyLine = src.split("\n").findIndex((l) => l === "fragColor = vec4(1.0);");
  check("prelude line count matches the template", prelude === bodyLine, `prelude ${prelude} body at ${bodyLine}`);
  const sockets = glslExpressionNode.resolveInputs!(params).map((s) => `${s.name}:${s.type}`);
  check(
    "GLSL sockets by kind",
    sockets.includes("in:1:scalar") && sockets.includes("in:2:scalar") && sockets.includes("in:4:vec4") && sockets.includes("in:5:color_ramp") && !sockets.some((s) => s.startsWith("in:3") || s.startsWith("in:6")),
    sockets.join(",")
  );
}

// ---------------------------------------------------------------------------
// Recipes: name resolution, expose, set_param by channel, get_graph channels
// ---------------------------------------------------------------------------
{
  const built = buildRecipe({
    name: "Chan",
    nodes: [
      { id: "g", type: "grid" },
      {
        id: "pex",
        type: "point-expression",
        params: {
          expression:
            'const c = ramp("ink", px, "#000000", "#ffffff");\nconst t = color("tint", "#ff0000");\nx = px + curve("fall", py, 1, 0) * 0.01;\ny = py;\nkeep = toggle("on", true);',
        },
      },
    ],
    edges: [{ from: "g:out", to: "pex:in:points" }],
    outputs: [{ name: "points", from: "pex:out", type: "points" }],
  });
  const gid = built.nodes.find((n) => n.data.defType === "node-group")!.id;
  const gi = built.nodes.find((n) => n.data.defType === "group-input")!;
  const pex = built.nodes.find((n) => n.data.defType === "point-expression")!;
  const def = getNodeDef("point-expression")!;
  const rows = (pex.data.params as any).inputs as ExprInput[];
  const kinds = rows.map((e) => `${e.name}:${EC.channelKind(e)}`).join(",");
  check("buildRecipe mints every kind from the authored expression", kinds === "ink:ramp,tint:color,fall:curve,on:toggle", kinds);
  const ink = rows.find((e) => e.name === "ink")!;
  check(
    "resolveChannelHandle: socketed kinds resolve, curve passes through",
    resolveChannelHandle(def, pex.data.params, "in:ink") === `in:in:${ink.id}` &&
      resolveChannelHandle(def, pex.data.params, `in:${ink.id}`) === `in:in:${ink.id}` &&
      resolveChannelHandle(def, pex.data.params, `in:in:${ink.id}`) === `in:in:${ink.id}` &&
      resolveChannelHandle(def, pex.data.params, "in:fall") === "in:fall"
  );

  const wired = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      { op: "add_edge", from: `${gi.id}:aux:ink`, to: `${pex.id}:in:ink` },
      { op: "add_edge", from: `${gi.id}:aux:tint`, to: `${pex.id}:in:tint` },
    ],
  });
  const bsock = readBoundarySockets(wired.nodes.find((n) => n.id === gi.id)!.data.params);
  check(
    "named add_edge mints boundary sockets of the channel's type",
    wired.issues.length === 0 &&
      bsock.some((s) => s.name === "ink" && s.type === "color_ramp") &&
      bsock.some((s) => s.name === "tint" && s.type === "vec4"),
    JSON.stringify({ issues: wired.issues, bsock })
  );
  const exposeCurve = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "expose_param", node: pex.id, param: "fall" }],
  });
  check("expose_param on a curve channel is refused", JSON.stringify(exposeCurve.issues).includes("PARAM_NOT_EXPOSABLE"));
  const exposeRamp = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "expose_param", node: pex.id, param: "ink" }],
  });
  const rsock = readBoundarySockets(exposeRamp.nodes.find((n) => n.id === gi.id)!.data.params);
  check(
    "expose_param on a ramp channel mints a color_ramp boundary socket",
    !exposeRamp.issues.some((i) => i.code !== "CHANNEL_EXPOSE") &&
      rsock.some((s) => s.name === "ink" && s.type === "color_ramp"),
    JSON.stringify(exposeRamp.issues)
  );

  const tuned = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [
      { op: "set_param", node: pex.id, param: "tint", value: "#00ff00" },
      { op: "set_param", node: pex.id, param: "on", value: false },
      {
        op: "set_param",
        node: pex.id,
        param: "ink",
        value: [
          { position: 0, color: "#123456" },
          { position: 1, color: "#654321" },
        ],
      },
    ],
  });
  const tunedRows = (tuned.nodes.find((n) => n.id === pex.id)!.data.params as any).inputs as ExprInput[];
  check(
    "edit_group set_param by channel name tunes rows in place (ids kept)",
    tuned.issues.length === 0 &&
      tunedRows.find((e) => e.name === "tint")!.default === "#00ff00" &&
      tunedRows.find((e) => e.name === "on")!.default === false &&
      (tunedRows.find((e) => e.name === "ink")!.default as any)[1].color === "#654321" &&
      tunedRows.find((e) => e.name === "ink")!.id === ink.id,
    JSON.stringify(tuned.issues)
  );
  const bad = applyRecipeEdit(gid, built.nodes, built.edges, {
    ops: [{ op: "set_param", node: pex.id, param: "tint", value: "nope" }],
  });
  check("bad channel value is a BAD_PARAM_VALUE issue", JSON.stringify(bad.issues).includes("BAD_PARAM_VALUE"));

  const spec = graphToSpec(tuned.nodes, tuned.edges, gid);
  const sn = spec.nodes.find((n) => n.id === pex.id)!;
  check(
    "get_graph lists channels with kind / value / socket, no ids",
    !!sn.channels &&
      sn.channels.map((c) => `${c.name}:${c.kind}`).join(",") === "ink:ramp,tint:color,fall:curve,on:toggle" &&
      sn.channels.find((c) => c.name === "ink")!.socket === "color_ramp" &&
      sn.channels.find((c) => c.name === "fall")!.socket === undefined &&
      !JSON.stringify(sn.channels).includes('"id"'),
    JSON.stringify(sn.channels)
  );
}

{
  const hoisted = splitGlslUserSource(`
vec4 darkAt(int col, int row) {
  return vec4(0.0);
}
fragColor = darkAt(0, 0);
`);
  check(
    "auto-hoists a top-level function out of main()",
    hoisted.functions.includes("vec4 darkAt(int col, int row)") &&
      hoisted.functions.includes("return vec4(0.0);") &&
      hoisted.body.includes("fragColor = darkAt(0, 0);") &&
      !hoisted.body.includes("vec4 darkAt"),
    JSON.stringify(hoisted)
  );
  const compiled = glslExpressionSource({
    expression: hoisted.functions ? `${hoisted.functions}\n${hoisted.body}` : "",
    inputs: [],
  });
  const fromSource = glslExpressionSource({
    expression: `vec4 darkAt(int col, int row) {\n  return vec4(0.0);\n}\nfragColor = darkAt(0, 0);`,
    inputs: [],
  });
  check(
    "hoisted function sits above main() in the compiled shader",
    fromSource.includes("vec4 darkAt(int col, int row)") &&
      fromSource.indexOf("vec4 darkAt") < fromSource.indexOf("void main()") &&
      fromSource.indexOf("fragColor = darkAt") > fromSource.indexOf("void main()"),
    fromSource
  );
  void compiled;
  const marked = splitGlslUserSource(`
// functions
float helper(float x) { return x * 2.0; }
// body
fragColor = vec4(helper(0.5));
`);
  check(
    "// functions … // body region is respected",
    marked.functions.includes("float helper(float x)") &&
      marked.body.includes("fragColor = vec4(helper(0.5));") &&
      !marked.body.includes("float helper"),
    JSON.stringify(marked)
  );
  const kept = splitGlslUserSource(`vec4 a = texture(u_a, v_uv);\nfragColor = a;`);
  check(
    "plain body is not mistaken for a function",
    kept.functions === "" && kept.body.includes("fragColor = a;"),
    JSON.stringify(kept)
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall expression-channel checks passed");
