// Milestone-3 proof: hand-written RecipeGraph → buildRecipe → validateGraph.
// A well-formed recipe must build clean AND validate green (the round trip);
// a bad-wiring recipe must build into something the validator rejects; a
// malformed recipe must surface build issues without crashing.
//
//   npx tsx scripts/check-builder.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RecipeGraph } from "@/state/recipe-builder";

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
const { applySyncedExpression, buildRecipe } = await import("@/state/recipe-builder");
const { getNodeDef } = await import("@/engine/registry");
const { validateGraph } = await import("@/engine/graph-validation");

const adapt = (built: { nodes: any[]; edges: any[] }) => ({
  nodes: built.nodes.map((n) => ({ id: n.id, defType: n.data.defType, params: n.data.params })),
  edges: built.edges.map((e) => ({
    id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle,
  })),
});

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  — ${detail}`}`);
};

// --- 1. Well-formed recipe: image in → two transforms → image out, one knob.
const good: RecipeGraph = {
  name: "Double Transform",
  nodes: [
    { id: "t1", type: "transform", params: { scaleX: 1.5, scaleY: 1.5 } },
    { id: "t2", type: "transform", params: { rotate: 45 } },
  ],
  edges: [{ from: "t1:out", to: "t2:in:image" }],
  inputs: [{ name: "image", from: "t1:in:image", type: "image" }],
  outputs: [{ name: "image", from: "t2:out", type: "image" }],
  exposed: [{ name: "Spin", node: "t2", param: "rotate" }],
};
{
  const built = buildRecipe(good);
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  const errs = r.issues.filter((i) => i.severity === "error");
  console.log(`\n[good]  build issues: ${built.issues.length}, nodes: ${built.nodes.length}, edges: ${built.edges.length}, validator errors: ${errs.length}`);
  check("well-formed recipe builds clean", built.issues.length === 0, JSON.stringify(built.issues));
  check("well-formed recipe validates green", r.ok && errs.length === 0, errs.map((e) => e.code).join(","));
  // group wrapper present?
  const types = new Set(built.nodes.map((n) => n.data.defType));
  check("group wrapper synthesized", types.has("node-group") && types.has("group-input") && types.has("group-output"));
  check("group shell marked aiAuthored (gets the star button)", built.nodes.some((n) => n.data.defType === "node-group" && n.data.aiAuthored === true));
  // exposed param recorded?
  const t2 = built.nodes.find((n) => n.data.defType === "transform" && (n.data.params as any).rotate === 45);
  check("exposed param added to exposedParams", !!t2 && (t2.data.exposedParams ?? []).includes("rotate"));
  check("buildRecipe returns local→minted ids", built.ids.t1 === (built.nodes.find((n) => n.data.defType === "transform" && (n.data.params as any).scaleX === 1.5)?.id) && built.ids.t2 === t2?.id, JSON.stringify(built.ids));
}

// --- 2. Bad-wiring recipe: gradient image → spline-stroke path (mismatch).
const badWire: RecipeGraph = {
  name: "Bad Wire",
  nodes: [
    { id: "g", type: "gradient", params: { mode: "radial" } },
    { id: "s", type: "spline-stroke" },
  ],
  edges: [{ from: "g:out", to: "s:in:path" }],
  outputs: [{ name: "image", from: "s:out", type: "image" }],
};
{
  const built = buildRecipe(badWire);
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  const codes = r.issues.filter((i) => i.severity === "error").map((i) => i.code);
  console.log(`\n[bad-wire]  build issues: ${built.issues.length}, validator error codes: [${codes.join(", ")}]`);
  check("bad wiring builds (trust boundary)", built.issues.length === 0, JSON.stringify(built.issues));
  check("bad wiring rejected by validator", codes.includes("EDGE_TYPE_MISMATCH"), `[${codes.join(",")}]`);
}

// --- 3. Malformed recipe: unknown type, non-settable param, dangling edge.
const malformed: RecipeGraph = {
  name: "Malformed",
  nodes: [
    { id: "cc", type: "color-correction", params: { curves: "nope", opacity: 0.5 } }, // curves not settable
    { id: "bogus", type: "not-a-real-node" },
  ],
  edges: [{ from: "cc:out", to: "ghost:in:image" }], // ghost is not a node
  outputs: [{ name: "image", from: "cc:out", type: "image" }],
};
{
  const built = buildRecipe(malformed);
  const codes = built.issues.map((i) => i.code);
  console.log(`\n[malformed]  build issue codes: [${codes.join(", ")}]`);
  check("rejects non-settable param", codes.includes("PARAM_NOT_SETTABLE"), `[${codes.join(",")}]`);
  check("skips unknown node type", codes.includes("UNKNOWN_TYPE"));
  check("drops dangling edge", codes.includes("BAD_EDGE"));
  // It still produced a usable group from the one good node.
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  check("survivor graph still validates", r.ok, r.issues.filter((i) => i.severity === "error").map((e) => e.code).join(","));
}

// --- 4. Param VALUE vetting: bad values are rejected (BAD_PARAM_VALUE, a
// blocking code → repair turn); out-of-hard-range scalars clamp like the UI.
const badValues: RecipeGraph = {
  name: "Bad Values",
  nodes: [
    {
      id: "t",
      type: "transform",
      params: { rotate: "abc", scaleX: Infinity, translateX: 0.25 },
    },
    { id: "g", type: "gradient", params: { mode: "bogus-mode" } },
    { id: "t2", type: "transform", params: { rotate: 720 } },
  ],
  edges: [{ from: "g:out", to: "t:in:image" }],
  outputs: [{ name: "image", from: "t:out", type: "image" }],
};
{
  const built = buildRecipe(badValues);
  const bad = built.issues.filter((i) => i.code === "BAD_PARAM_VALUE");
  console.log(`\n[bad-values]  BAD_PARAM_VALUE issues: ${bad.length}`);
  check("string into scalar rejected", bad.some((i) => i.message.includes("t.rotate")), JSON.stringify(built.issues));
  check("Infinity into scalar rejected", bad.some((i) => i.message.includes("t.scaleX")));
  check("non-option enum rejected", bad.some((i) => i.message.includes("g.mode")));
  const t = built.nodes.find((n) => n.data.defType === "transform");
  check("valid sibling value still lands", (t?.data.params as any)?.translateX === 0.25);
  check("rejected values left at default", (t?.data.params as any)?.rotate !== "abc" && (t?.data.params as any)?.scaleX !== Infinity);
  const t2 = built.nodes.find(
    (n) => n.data.defType === "transform" && (n.data.params as any).translateX !== 0.25
  );
  check("out-of-range scalar clamps to hard max", (t2?.data.params as any)?.rotate === 360, `rotate=${(t2?.data.params as any)?.rotate}`);
  const r = validateGraph(adapt(built).nodes, adapt(built).edges);
  check("vetted graph still validates", r.ok, r.issues.filter((i) => i.severity === "error").map((e) => e.code).join(","));
}

// --- 5. Compound zones: Repeat / For Each mint Input+Output, named
// collect/passthrough sockets, and parent nesting.
{
  const zone: RecipeGraph = {
    name: "Repeat Identity",
    nodes: [
      { id: "rect", type: "rectangle" },
      { id: "rpt", type: "repeat", params: { count: 3 } },
    ],
    edges: [
      { from: "rect:out", to: "rpt-input:in:spline" },
      { from: "rpt-input:aux:spline", to: "rpt:in:spline" },
    ],
    outputs: [{ name: "spline", from: "rpt:aux:spline", type: "spline" }],
  };
  const built = buildRecipe(zone);
  const types = built.nodes.map((n) => n.data.defType);
  const rpt = built.nodes.find((n) => n.data.defType === "repeat");
  const rptIn = built.nodes.find((n) => n.data.defType === "repeat-input");
  const grp = built.nodes.find((n) => n.data.defType === "node-group");
  console.log(`\n[repeat-zone]  build issues: ${built.issues.length}, types: ${types.join(",")}`);
  check("repeat recipe builds clean", built.issues.length === 0, JSON.stringify(built.issues));
  check("repeat mints Output + Input", types.includes("repeat") && types.includes("repeat-input"));
  check("repeat count landed on Input", (rptIn?.data.params as any)?.count === 3);
  check(
    "repeat Input stays a zone member (not the wrapping group)",
    !!rpt && !!rptIn && rptIn.data.parentId === rpt.id
  );
  check(
    "repeat Output is a child of the wrapping group",
    !!rpt && !!grp && rpt.data.parentId === grp.id
  );
  const collect = built.edges.find(
    (e) => e.target === rpt?.id && e.targetHandle === "in:spline"
  );
  check("repeat collect socket minted", !!collect);
  const v = validateGraph(adapt(built).nodes, adapt(built).edges);
  const errs = v.issues.filter((i) => i.severity === "error");
  check(
    "repeat recipe validates",
    v.ok && errs.length === 0,
    errs.map((e) => `${e.code}:${e.message}`).join(" | ")
  );
}
{
  const nested: RecipeGraph = {
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
  };
  const built = buildRecipe(nested);
  const rpt = built.nodes.find((n) => n.data.defType === "repeat");
  const fe = built.nodes.find((n) => n.data.defType === "foreach");
  const feIn = built.nodes.find((n) => n.data.defType === "foreach-input");
  console.log(`\n[foreach-nested]  build issues: ${built.issues.length}`);
  check("nested zone recipe builds clean", built.issues.length === 0, JSON.stringify(built.issues));
  check("For Each nests inside Repeat", !!fe && !!rpt && fe.data.parentId === rpt.id);
  check("For Each Input stays a member of For Each", !!fe && !!feIn && feIn.data.parentId === fe.id);
  const v = validateGraph(adapt(built).nodes, adapt(built).edges);
  const errs = v.issues.filter((i) => i.severity === "error");
  check(
    "nested zone recipe validates",
    v.ok && errs.length === 0,
    errs.map((e) => `${e.code}:${e.message}`).join(" | ")
  );
}
{
  const bareInput: RecipeGraph = {
    name: "Bare Input",
    nodes: [{ id: "x", type: "repeat-input" }],
    outputs: [{ name: "image", from: "x:out", type: "image" }],
  };
  const built = buildRecipe(bareInput);
  check(
    "bare repeat-input is rejected",
    built.issues.some((i) => i.code === "UNKNOWN_TYPE"),
    JSON.stringify(built.issues)
  );
}

// --- expression channel sync (the MCP set_param expression path) ---
{
  const pex = getNodeDef("point-expression")!;
  const glsl = getNodeDef("glsl-expression")!;
  const cpu = getNodeDef("expression")!;
  const first = applySyncedExpression(
    pex,
    { expression: "x = px;", inputs: [] },
    'ch("k", 0.1, 0, 1);\nx = px + ch("k");'
  );
  const k = (first.params.inputs as { name: string; id: string; default: number }[]).find(
    (i) => i.name === "k"
  );
  check(
    "committed expression write mints ch() channel",
    first.minted.includes("k") && !!k && k.default === 0.1
  );

  const second = applySyncedExpression(
    pex,
    first.params,
    'ch("k", 0.9);\nch("n", 2);\nx = px;'
  );
  const k2 = (second.params.inputs as { name: string; id: string; default: number }[]).find(
    (i) => i.name === "k"
  );
  check(
    "sync is add-only and id-stable",
    second.minted.includes("n") &&
      !second.minted.includes("k") &&
      k2?.id === k?.id &&
      k2?.default === 0.1
  );

  const g = applySyncedExpression(
    glsl,
    { expression: "fragColor = vec4(1.0);", inputs: [] },
    '// ch("amount", 0.5, 0, 1)\nfragColor = vec4(amount);'
  );
  check("GLSL comment ch() mints a uniform channel", g.minted.includes("amount"));

  {
    const {
      glslExpressionSource,
      glslExpressionPreludeLines,
      trimShaderInfoLog,
      inspectGlslExpression,
      attachGlslErrorsToSpec,
    } = await import("@/nodes/effect/glsl-expression");
    const empty = { expression: "fragColor = vec4(1.0);", inputs: [] };
    const withCh = {
      expression: "fragColor = vec4(amount);",
      inputs: [{ id: "c1", name: "amount", default: 0.5 }],
    };
    const withTwo = {
      expression: "fragColor = vec4(a * b);",
      inputs: [
        { id: "c1", name: "a", default: 1 },
        { id: "c2", name: "b", default: 1 },
      ],
    };
    const prelude0 = glslExpressionPreludeLines(empty);
    const prelude1 = glslExpressionPreludeLines(withCh);
    const prelude2 = glslExpressionPreludeLines(withTwo);
    const src = glslExpressionSource(empty);
    const bodyAt = src.slice(0, src.indexOf("fragColor = vec4(1.0);")).split("\n").length - 1;
    check(
      "GLSL prelude counts lines before the user body",
      prelude0 >= 13 && bodyAt === prelude0 && prelude1 === prelude0 && prelude2 === prelude0 + 1,
      `empty=${prelude0} ch1=${prelude1} ch2=${prelude2} bodyAt=${bodyAt}`
    );
    check(
      "trimShaderInfoLog drops the source echo",
      trimShaderInfoLog("Shader compile failed: ERROR: 0:15: foo\n--\n#version 300 es\n...") ===
        "Shader compile failed: ERROR: 0:15: foo"
    );
    const ok = inspectGlslExpression("n1", empty, () => ({ error: null }));
    check("inspect reports ok when tryShader succeeds", ok.ok && !ok.error);
    const badSrc = inspectGlslExpression("n1", empty, () => ({
      error: "Shader compile failed: ERROR: 0:15: 'z' : undeclared identifier\n--\n#version 300 es",
    }));
    check(
      "inspect surfaces the trimmed info log + prelude",
      !badSrc.ok &&
        badSrc.error === "Shader compile failed: ERROR: 0:15: 'z' : undeclared identifier" &&
        badSrc.preludeLines === prelude0,
      JSON.stringify(badSrc)
    );
    const textBad = inspectGlslExpression(
      "n1",
      { expression: "#version 300 es\nvoid main() {}", inputs: [] },
      () => ({ error: null })
    );
    check(
      "inspect still reports text-level problems when GL is fine",
      !textBad.ok &&
        (textBad.problems?.some((p) => p.includes("#version")) ?? false) &&
        (textBad.problems?.some((p) => p.includes("main()")) ?? false),
      JSON.stringify(textBad.problems)
    );
    const spec = attachGlslErrorsToSpec(
      [
        { id: "ok", type: "glsl-expression" },
        { id: "bad", type: "glsl-expression" },
        { id: "circ", type: "circle" },
      ],
      (id) => (id === "circ" ? undefined : empty),
      (key) =>
        key.includes("bad")
          ? { error: "Shader compile failed: boom\n--\nsrc" }
          : { error: null }
    );
    check(
      "get_graph enrichment attaches shaderError only on failures",
      !("shaderError" in spec[0]) &&
        spec[1].shaderError === "Shader compile failed: boom" &&
        spec[1].shaderPreludeLines === prelude0 &&
        !("shaderError" in spec[2]),
      JSON.stringify(spec)
    );
  }

  const c = applySyncedExpression(
    cpu,
    { expression: "out = in;", inputs: [] },
    'ch("k", 1);\nout = in;'
  );
  check("CPU Expression (no channelSync) does not mint", c.minted.length === 0);
}

{
  const built = buildRecipe({
    name: "Merge stack",
    nodes: [
      {
        id: "mg",
        type: "merge",
        params: {
          layers: [
            { mode: "normal", opacity: 1 },
            { mode: "add", opacity: 0.5 },
            { mode: "multiply", opacity: 1 },
            { mode: "screen", opacity: 1 },
            { mode: "overlay", opacity: 1 },
            { mode: "darken", opacity: 1 },
            { mode: "lighten", opacity: 1 },
          ],
        },
      },
    ],
    outputs: [{ name: "image", from: "mg:out", type: "image" }],
  });
  const merge = built.nodes.find((n) => n.data.defType === "merge");
  const layers = (merge?.data.params.layers ?? []) as { id: string }[];
  check(
    "recipe layers replaces the default lyr-initial stack (7 in → 7, no leftover empty)",
    layers.length === 7 && layers.every((l) => l.id !== "lyr-initial"),
    JSON.stringify(layers.map((l) => l.id))
  );
}

console.log(`\n${failures === 0 ? "ALL GREEN ✅" : `${failures} FAILURE(S) ❌`}`);
if (failures) process.exit(1);
