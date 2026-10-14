// check-skia-library: the SkSL library + fuser gate (specdocs/101326_skia-target.md
// §3.3, lane L2). CanvasKit in Node, CPU raster surfaces, no GPU:
//
//   1. every registered library function and helper is well-formed, compiles
//      inside a minimal fused program, and all of them compile together in
//      ONE program (no name clashes across the library);
//   2. fused fixtures — pure chain, gather chain (gather of gather, one
//      gather function on two upstreams, a shared subexpression), leaf
//      child, program child — compile, render what they should, are
//      deterministic, and declare exactly the uniforms their binds supply;
//   3. the fuser reports bad input (unknown function, missing / extra
//      input or param, wrong bind shape, a node fused twice with different
//      content, an invalid library function) instead of throwing;
//   4. the reference ports match the engine: Noise (Skia) against the CPU
//      simplex fBm, Color Ramp (Skia) against makeColorRampSampler for every
//      ported interpolation × space, and Noise (Skia) → Color Ramp (Skia),
//      fused, against M0's hand port aurora.sksl with equal params;
//   5. the node defs mirror their originals' params, report unsupported
//      params, emit the unwired output their mirror does, and gate the
//      preview on consumption.
//
//   npx tsx scripts/check-skia-library.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const lib = await import("@/engine/skia/library");
const { fuseShader, estimateShaderCost, skslNodeIdent, skslUniformName } = await import("@/engine/skia/fuse");
const { buildSkslProgram, compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { syncChannelInputs } = await import("@/engine/expr-channels");
const { bindStatic, bindParam } = await import("@/engine/skia/scene-ir");
const { makeColorRampSampler, COLOR_RAMP_INTERP_OPTIONS, COLOR_RAMP_SPACE_OPTIONS } = await import("@/engine/color-ramp");
const { fbmWithW, noiseFnFor } = await import("@/engine/noise");
const fx = await import("./fixtures/skia/aurora.ts");
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { ShaderIR, SkslProgramIR } from "@/engine/skia/scene-ir";

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}

// ---- rendering on CanvasKit CPU surfaces ------------------------------------------

function childShader(s: ShaderIR): any {
  if (s.k === "color") return CK.Shader.MakeColor(CK.Color4f(...s.color.v), CK.ColorSpace.SRGB);
  if (s.k === "runtime") return programShader(s.program);
  throw new Error(`gate renders color / runtime children only, got ${s.k}`);
}

function programShader(p: SkslProgramIR): any {
  const r = compileSksl(CK, p.sksl);
  if (!r.effect) throw new Error(r.error);
  const values: Record<string, number | number[]> = {};
  for (const [k, b] of Object.entries(p.uniforms)) values[k] = b.v;
  const u = packUniforms(r.effect, values);
  return p.children.length ? r.effect.makeShaderWithChildren(u, p.children.map((c) => childShader(c.shader))) : r.effect.makeShader(u);
}

// Straight-alpha RGBA8, row 0 = top.
function renderShader(shader: any, w: number, h: number): Uint8Array {
  const surf = CK.MakeSurface(w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const paint = new CK.Paint();
  paint.setShader(shader);
  paint.setBlendMode(CK.BlendMode.Src);
  canvas.drawPaint(paint);
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: w,
    height: h,
    colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Unpremul,
    colorSpace: CK.ColorSpace.SRGB,
  }) as Uint8Array;
  img.delete();
  paint.delete();
  shader.delete();
  surf.delete();
  return px;
}

function renderProgram(p: SkslProgramIR, w: number, h: number): Uint8Array {
  return renderShader(programShader(p), w, h);
}

function diff(a: Uint8Array, b: Uint8Array, channels = [0, 1, 2, 3]) {
  let max = 0;
  let sum = 0;
  let n = 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (const c of channels) {
      const d = Math.abs(a[i + c] - b[i + c]);
      px = Math.max(px, d);
      sum += d;
      n++;
    }
    max = Math.max(max, px);
    if (px === 0) same++;
  }
  return { max, mean: sum / n, identical: same / (a.length / 4) };
}

function uniformNames(sksl: string): Set<string> {
  const r = compileSksl(CK, sksl);
  const out = new Set<string>();
  if (!r.effect) return out;
  for (let i = 0; i < r.effect.getUniformCount(); i++) out.add(r.effect.getUniformName(i));
  return out;
}

function fused(expr: ShaderExpr, w = 64, h = 64): SkslProgramIR {
  const r = fuseShader(expr, { resolution: [w, h], time: 0 });
  if (!r.shader || r.shader.k !== "runtime") throw new Error(`fuse failed: ${r.problems.join(" | ")}`);
  return r.shader.program;
}

function declaresExactlyItsBinds(name: string, p: SkslProgramIR) {
  const declared = uniformNames(p.sksl);
  const supplied = new Set(Object.keys(p.uniforms));
  const missing = [...declared].filter((n) => !supplied.has(n));
  const extra = [...supplied].filter((n) => !declared.has(n));
  check(`${name}: declares exactly the uniforms its binds supply`, declared.size > 0 && !missing.length && !extra.length, missing.length || extra.length ? `missing ${missing} extra ${extra}` : `${declared.size} uniforms`);
}

// ---- graph evaluation through the real node defs -------------------------------------

const ctxFor = (w: number, h: number): any => ({
  gl: {}, width: w, height: h, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
});

function defaults(type: string): Record<string, unknown> {
  const def = getNodeDef(type)!;
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

function evalExprs(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number): Map<string, ShaderExpr> {
  const r = evaluateGraph(nodes, edges, ctxFor(w, h), new Map() as EvalCache, null, undefined, null, {
    extraTargets: nodes.map((n) => n.id),
  });
  const out = new Map<string, ShaderExpr>();
  for (const n of nodes) {
    const v = r.outputs.get(n.id)?.primary as any;
    if (v?.kind === "skia_shader") out.set(n.id, v.expr);
  }
  return out;
}

const AURORA_STOPS = [
  { id: "a", position: 0, color: "#0a0f2c" },
  { id: "b", position: 0.45, color: "#3d5afe" },
  { id: "c", position: 0.75, color: "#ff7a45" },
  { id: "d", position: 1, color: "#ffe3c2" },
];

function noiseNode(id: string, over: Record<string, unknown>): GraphNode {
  return { id, type: "skia-noise", params: { ...defaults("skia-noise"), ...over } };
}
function rampNode(id: string, over: Record<string, unknown>): GraphNode {
  return { id, type: "skia-color-ramp", params: { ...defaults("skia-color-ramp"), ...over } };
}
const wire = (source: string, target: string, handle = "in:image"): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle: handle,
});

// Test-only library functions for the gather / multi-input fixtures.
lib.registerSkslFunction({
  id: "test.offset@1",
  entry: "test_offset",
  source: `float4 test_offset_avg(float4 a, float4 b) { return 0.5 * (a + b); }
float4 test_offset(float2 uv, float2 res, float2 amount) {
  return test_offset_avg($src(uv + amount), $src(uv - amount));
}`,
  params: [{ name: "amount", type: "float2" }],
  inputs: [{ name: "src", mode: "gather", taps: 2 }],
  cost: 0.1,
});
lib.registerSkslFunction({
  id: "test.mix@1",
  entry: "test_mix",
  source: `float4 test_mix(float2 uv, float2 res, float k, float4 a, float4 b) { return mix(a, b, k); }`,
  params: [{ name: "k", type: "float" }],
  inputs: [{ name: "a", mode: "pure" }, { name: "b", mode: "pure" }],
});
lib.registerSkslFunction({
  id: "test.uvx@1",
  entry: "test_uvx",
  source: `float4 test_uvx(float2 uv, float2 res) { return float4(uv.x, uv.x, uv.x, 1.0); }`,
  params: [],
  inputs: [],
});

const call = (fn: string, node: string, params: Record<string, any>, inputs: Record<string, ShaderExpr> = {}): ShaderExpr => ({
  k: "call",
  fn,
  node,
  params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, bindParam(v, node, k)])),
  inputs,
});

// ---- 1. the library itself ----------------------------------------------------------
{
  const fns = lib.allSkslFunctions();
  const helpers = lib.allSkslHelpers();
  info(`${fns.length} library functions, ${helpers.length} helpers`);
  const bad = fns.flatMap((f) => lib.validateSkslFunction(f));
  check("every registered library function validates", bad.length === 0, bad.join(" | "));
  const helperProblems = lib.resolveHelpers(helpers.map((h) => h.id)).problems;
  check("every helper's dependencies resolve", helperProblems.length === 0, helperProblems.join(" | "));

  const failed: string[] = [];
  for (const f of fns) {
    const params: Record<string, any> = {};
    for (const p of f.params) {
      const width = p.type === "float" || p.type === "int" ? 1 : p.type === "float2" ? 2 : p.type === "float3" ? 3 : 4;
      params[p.name] = p.count !== undefined || width > 1 ? new Array((p.count ?? 1) * width).fill(0.5) : 0.5;
    }
    const inputs = Object.fromEntries(f.inputs.map((i) => [i.name, lib.constExpr(`in-${i.name}`, [0.5, 0.25, 0.75, 1])]));
    const r = fuseShader(call(f.id, "probe", params, inputs), { resolution: [16, 16], time: 0 });
    if (!r.shader || r.shader.k !== "runtime") {
      failed.push(`${f.id}: ${r.problems.join(" ")}`);
      continue;
    }
    const c = compileSksl(CK, r.shader.program.sksl);
    if (!c.effect) failed.push(`${f.id}: ${c.error.split("\n")[0]}`);
  }
  check(`every library function compiles inside a minimal fused program (${fns.length})`, failed.length === 0, failed.join(" | "));

  // All of it in ONE program: helper / entry / private-helper names must be
  // unique across the library.
  const order = lib.resolveHelpers(helpers.map((h) => h.id)).order;
  const all = [
    // Functions with usesTime read the fused program's iTime uniform.
    "uniform float iTime;",
    "float4 tbx_gate_gather(float2 uv) { return float4(uv, 0.0, 1.0); }",
    ...order.map((h) => h.source),
    ...fns.map((f) => f.source.replace(/\$[A-Za-z_]\w*\s*\(/g, "tbx_gate_gather(")),
    "half4 main(float2 fc) { return half4(1.0); }",
  ].join("\n");
  const together = compileSksl(CK, all);
  check("all helpers and functions compile together in one program", !!together.effect, together.error?.split("\n").slice(0, 3).join(" "));
}

// ---- 2. fused fixtures ----------------------------------------------------------------
const W = 64;
const H = 64;
const NOISE_P = { scale: 3, octaves: 4, persistence: 0.5, lacunarity: 2, offset_x: 0.3, offset_y: -0.2, seed: 0, w: 0, contrast: 1, color_a: [0, 0, 0, 1], color_b: [1, 1, 1, 1], alpha: 1, opacity: 1 };
const noiseCall = (node = "nz", over: Record<string, any> = {}) => call("tbx.noise.simplex@1", node, { ...NOISE_P, ...over });

{
  // Pure chain, through the real node computes.
  const exprs = evalExprs(
    [noiseNode("noise", { scale: 3, offset_x: 0.3 }), rampNode("ramp", { stops: AURORA_STOPS, space: "oklab" })],
    [wire("noise", "ramp")],
    W,
    H
  );
  const rampExpr = exprs.get("ramp")!;
  check("pure chain: Color Ramp (Skia) wraps the upstream Noise (Skia) call", rampExpr?.k === "call" && rampExpr.inputs.src?.k === "call" && (rampExpr.inputs.src as any).node === "noise");
  const p = fused(rampExpr, W, H);
  check("pure chain fuses to ONE program with no children", p.children.length === 0 && p.fused?.join() === "tbx.noise.simplex@1,tbx.color_ramp@1", p.fused?.join());
  check("pure chain compiles", !!compileSksl(CK, p.sksl).effect);
  declaresExactlyItsBinds("pure chain", p);
  const again = fused(rampExpr, W, H).sksl;
  const cloned = fused(JSON.parse(JSON.stringify(rampExpr)), W, H).sksl;
  const moved = fused(
    evalExprs([noiseNode("noise", { scale: 7.5, offset_x: -2, w: 1.5 }), rampNode("ramp", { stops: AURORA_STOPS.slice(0, 3), space: "linear" })], [wire("noise", "ramp")], W, H).get("ramp")!,
    W,
    H
  ).sksl;
  check("deterministic: same expression → byte-identical SkSL (also after a JSON round trip)", again === p.sksl && cloned === p.sksl);
  check("SkSL depends on structure only: other param values → the same program text", moved === p.sksl);
  check("binds carry their refs through to the program uniforms", (p.uniforms[skslUniformName("noise", "scale")] as any)?.ref?.param === "scale" && (p.uniforms[skslUniformName("ramp", "stops_pos")] as any)?.deps?.[0]?.param === "stops");
  check("node ids sanitize to identifiers injectively", skslNodeIdent("noise-3") === "noise_2d3" && skslNodeIdent("a_b") !== skslNodeIdent("a-b") && /^[A-Za-z0-9_]+$/.test(skslNodeIdent("grp/π:1")));
  const cost = estimateShaderCost(rampExpr);
  check("cost: noise (4) + ramp (1) evaluated once each", cost.evaluations === 2 && cost.cost === 5, JSON.stringify(cost));
}

{
  // Gather chains: offset(offset(noise)) and one gather function on two
  // different upstreams, mixed. Verified against shifted renders of noise.
  const N = renderProgram(fused(noiseCall()), W, H);
  const dx = 3 / W;
  const dy = 2 / H;
  const g1 = call("test.offset@1", "o1", { amount: [dx, 0] }, { src: noiseCall() });
  const g2 = call("test.offset@1", "o2", { amount: [0, dy] }, { src: g1 });
  const pg = fused(g2);
  check("gather of gather compiles", !!compileSksl(CK, pg.sksl).effect);
  declaresExactlyItsBinds("gather of gather", pg);
  const G = renderProgram(pg, W, H);
  // uv + (0, dy) is 2 px UP = row j-2 (rows are top-down).
  const at = (img: Uint8Array, x: number, y: number) => img[(y * W + x) * 4];
  let worst = 0;
  for (let y = 4; y < H - 4; y++) {
    for (let x = 6; x < W - 6; x++) {
      const want = (at(N, x + 3, y - 2) + at(N, x - 3, y - 2) + at(N, x + 3, y + 2) + at(N, x - 3, y + 2)) / 4;
      worst = Math.max(worst, Math.abs(at(G, x, y) - want));
    }
  }
  check("gather of gather samples its upstream at the offset uvs", worst <= 2, `max |Δ| ${worst}/255 vs the 4-tap average of shifted noise`);
  const cost = estimateShaderCost(g2);
  const nz = cost.nodes.find((n) => n.node === "nz");
  check("cost: a 2-tap gather of a 2-tap gather evaluates noise 4× per pixel", nz?.evaluations === 4 && Math.abs(cost.cost - (16 + 0.1 * 2 + 0.1)) < 1e-9, JSON.stringify(cost.nodes));

  const twin = call("test.mix@1", "mx", { k: 0.25 }, {
    a: call("test.offset@1", "oa", { amount: [dx, 0] }, { src: noiseCall() }),
    b: call("test.offset@1", "ob", { amount: [dx, 0] }, { src: call("test.uvx@1", "ux", {}) }),
  });
  const pt = fused(twin);
  check("one gather function on two upstreams is emitted twice (a _G1 copy)", /float4 test_offset\(/.test(pt.sksl) && /float4 test_offset_G1\(/.test(pt.sksl) && /float4 test_offset_G1_avg\(/.test(pt.sksl));
  check("gather copies compile", !!compileSksl(CK, pt.sksl).effect);
  const T = renderProgram(pt, W, H);
  worst = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 4; x < W - 4; x++) {
      const off = (at(N, x + 3, y) + at(N, x - 3, y)) / 2;
      const want = off * 0.75 + ((x + 0.5) / W) * 255 * 0.25;
      worst = Math.max(worst, Math.abs(at(T, x, y) - want));
    }
  }
  check("each copy reads its own upstream", worst <= 2, `max |Δ| ${worst}/255`);

  // A shared subexpression is evaluated once; two gathers on the same
  // upstream share one g function.
  const shared = call("test.mix@1", "mx2", { k: 0.5 }, { a: noiseCall(), b: call("test.mix@1", "mx3", { k: 0.5 }, { a: noiseCall(), b: noiseCall() }) });
  const ps = fused(shared);
  const mainBody = ps.sksl.slice(ps.sksl.indexOf("half4 main("));
  check("a shared subexpression is evaluated once per body", (mainBody.match(/tbx_noise_simplex\(/g) ?? []).length === 1);
  const twoGathers = call("test.mix@1", "mx4", { k: 0.5 }, {
    a: call("test.offset@1", "oc", { amount: [dx, 0] }, { src: noiseCall() }),
    b: call("test.offset@1", "od", { amount: [0, dy] }, { src: noiseCall() }),
  });
  const p2 = fused(twoGathers);
  check("two gathers of the same upstream share one g function (and one copy of the gather fn)", (p2.sksl.match(/^float4 g\d+\(float2 uv\) \{/gm) ?? []).length === 1 && !/test_offset_G1/.test(p2.sksl));
}

{
  // Leaf child: a straight (1, .5, 0, .5) color through the ramp. The
  // wrapper must un-premultiply what Skia's color shader hands back.
  const stops = [
    { id: "a", position: 0, color: "#000000" },
    { id: "b", position: 1, color: "#ffffff" },
  ];
  const leaf: ShaderExpr = { k: "leaf", shader: { k: "color", color: bindStatic([1, 0.5, 0, 0.5]) } };
  const ramp = evalExprs([rampNode("r", { stops })], [], W, H).get("r") as any;
  check("unwired Color Ramp (Skia) emits opaque black, like Color Ramp", ramp?.k === "call" && ramp.fn === "tbx.const@1" && ramp.params.color.v.join() === "0,0,0,1");
  // Rebuild with the leaf as the input, through a real wired compute.
  const def = getNodeDef("skia-color-ramp")!;
  const out = def.compute({ inputs: { image: { kind: "skia_shader", expr: leaf } } as any, auxIn: {}, params: { ...defaults("skia-color-ramp"), stops }, ctx: ctxFor(W, H), nodeId: "r", consumedOutputs: new Set(["primary"]) }) as any;
  const pl = fused(out.primary.expr);
  check("leaf child: one `uniform shader s0` + wrapper", pl.children.length === 1 && /uniform shader s0;/.test(pl.sksl) && /float4 c0\(float2 uv\)/.test(pl.sksl));
  declaresExactlyItsBinds("leaf child", pl);
  const px = renderProgram(pl, 4, 4);
  const lum = 1 * 0.2126 + 0.5 * 0.7152;
  const want = Math.round(lum * 255);
  check("leaf child is sampled straight: ramp(luma) with the leaf's alpha", Math.abs(px[0] - want) <= 1 && Math.abs(px[3] - 128) <= 1, `got ${px.slice(0, 4).join(",")} want ${want},${want},${want},128`);
  check("gate: preview is not built when only the shader is consumed", out.aux === undefined);
}

{
  // Program child: M0's Aurora SkSL Shader program feeding the ramp.
  const inputs = syncChannelInputs([], fx.AURORA_SKSL);
  const prog = buildSkslProgram({ expression: fx.AURORA_SKSL, inputs });
  const vals: Record<string, any> = { iResolution: [W, H, 1], iTime: 0, scale: 3, octaves: 4, persistence: 0.5, lacunarity: 2, drift_x: 0, drift_y: 0, contrast: 1.2, c0: [0.04, 0.06, 0.17, 1], c1: [0.24, 0.35, 1, 1], c2: [1, 0.48, 0.27, 1], c3: [1, 0.89, 0.76, 1] };
  const program: SkslProgramIR = { sksl: prog.sksl, uniforms: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, bindStatic(v)])), children: [] };
  const stops = [
    { id: "a", position: 0, color: "#ffffff" },
    { id: "b", position: 1, color: "#000000" },
  ];
  const def = getNodeDef("skia-color-ramp")!;
  const out = def.compute({ inputs: { image: { kind: "skia_shader", expr: { k: "program", program, node: "aurora" } } } as any, auxIn: {}, params: { ...defaults("skia-color-ramp"), stops }, ctx: ctxFor(W, H), nodeId: "r", consumedOutputs: new Set(["primary"]) }) as any;
  const pp = fused(out.primary.expr);
  check("program child: the SkSL Shader program becomes child s0", pp.children.length === 1 && pp.children[0].shader.k === "runtime");
  declaresExactlyItsBinds("program child", pp);
  const A = renderProgram(program, W, H);
  const R = renderProgram(pp, W, H);
  let worst = 0;
  for (let i = 0; i < A.length; i += 4) {
    const l = Math.min(1, Math.max(0, (A[i] * 0.2126 + A[i + 1] * 0.7152 + A[i + 2] * 0.0722) / 255));
    worst = Math.max(worst, Math.abs(R[i] - (1 - l) * 255));
  }
  check("program child renders through the ramp (inverted luma)", worst <= 1.5, `max |Δ| ${worst.toFixed(2)}/255`);
}

// ---- 3. problems, not throws -------------------------------------------------------------
{
  const problems = (e: ShaderExpr) => {
    try {
      const r = fuseShader(e, { resolution: [8, 8], time: 0 });
      return r.shader ? [] : r.problems;
    } catch (err) {
      return [`THREW ${err}`];
    }
  };
  const has = (ps: string[], s: string) => ps.some((p) => p.includes(s)) && !ps.some((p) => p.startsWith("THREW"));
  check("reports an unknown function id", has(problems(call("nope@1", "x", {})), 'unknown library function "nope@1"'));
  check("reports a missing input", has(problems(call("test.mix@1", "x", { k: 1 }, { a: noiseCall() })), 'input "b" is missing'));
  check("reports an unknown input", has(problems(call("test.uvx@1", "x", {}, { a: noiseCall() })), 'unknown input "a"'));
  const { opacity: _o, ...noOpacity } = NOISE_P;
  void _o;
  check("reports a missing param bind", has(problems(call("tbx.noise.simplex@1", "x", noOpacity)), 'param "opacity" has no bind'));
  check("reports an unknown param", has(problems(call("test.uvx@1", "x", { zoom: 1 })), 'unknown param "zoom"'));
  check("reports a bind of the wrong shape", has(problems(call("test.offset@1", "x", { amount: 0.5 }, { src: noiseCall() })), "float2 (2 numbers) but its bind holds number"));
  check("reports a wrong array length", has(problems({ ...(call("tbx.color_ramp@1", "x", { stops_pos: [0, 1], stops_color: new Array(64).fill(0), stops_count: 2, offset: 0, interpolation: 0, space: 0 }, { src: noiseCall() })) }), "float[16] (16 numbers) but its bind holds 2 numbers"));
  check("reports one node fused twice with different content", has(problems(call("test.mix@1", "x", { k: 0.5 }, { a: noiseCall("same", { scale: 2 }), b: noiseCall("same", { scale: 3 }) })), "node same appears twice"));
  lib.registerSkslFunction({ id: "test.bad@1", entry: "test_bad", source: "float4 test_bad(float2 uv, float2 res) { return $img(uv); }", params: [], inputs: [] });
  check("reports an invalid library function ($ token without a gather input)", has(problems(call("test.bad@1", "x", {})), "names no gather input"));
  check("validateSkslFunction flags it for the gate", lib.validateSkslFunction(lib.getSkslFunction("test.bad@1")!).length > 0);
  check("a root leaf / program passes through unfused", (fuseShader({ k: "leaf", shader: { k: "color", color: bindStatic([1, 0, 0, 1]) } }, { resolution: [8, 8], time: 0 }).shader as any)?.k === "color");
}

// ---- 4. ports vs the engine ----------------------------------------------------------------
{
  // Noise (Skia) vs the CPU simplex fBm (engine/noise.ts, NOISE_FS's mirror).
  const simplex = noiseFnFor("simplex");
  let worst = 0;
  const cases = [
    { w: 96, h: 96, p: { scale: 3, octaves: 4, offset_x: 0.3, offset_y: -0.2, seed: 0 } },
    { w: 120, h: 60, p: { scale: 5.5, octaves: 6, persistence: 0.6, lacunarity: 2.3, offset_x: -1.7, offset_y: 2.2, seed: 3, contrast: 1.4 } },
    { w: 60, h: 100, p: { scale: 2, octaves: 2.6, offset_x: 0, offset_y: 0, seed: 11, contrast: 0.7 } },
  ];
  for (const { w, h, p } of cases) {
    const q = { ...NOISE_P, ...p };
    const img = renderProgram(fused(noiseCall("nz", q), w, h), w, h);
    const oct = Math.max(1, Math.min(8, Math.round(q.octaves)));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const v = 1 - (y + 0.5) / h;
        const sx = (u - 0.5) * q.scale + q.offset_x + q.seed * 127.1;
        const sy = ((v - 0.5) * q.scale) / (w / h) + q.offset_y + q.seed * 311.7;
        const n = fbmWithW(simplex, sx, sy, 0, oct, q.persistence, q.lacunarity);
        const t = Math.min(1, Math.max(0, 0.5 + (n * 0.5) * q.contrast));
        worst = Math.max(worst, Math.abs(img[(y * w + x) * 4] - t * 255));
      }
    }
  }
  check("Noise (Skia) matches the CPU simplex fBm (offset, seed, aspect, rounded octaves, contrast)", worst <= 1.5, `max |Δ| ${worst.toFixed(2)}/255 over 3 canvases`);

  // W slice blend: endpoints meet and the midpoint averages the slices.
  const at = (wv: number) => renderProgram(fused(noiseCall("nz", { w: wv }), W, H), W, H);
  const a0 = at(0);
  const a1 = at(1);
  const ah = at(0.5);
  let mid = 0;
  for (let i = 0; i < a0.length; i += 4) mid = Math.max(mid, Math.abs(ah[i] - (a0[i] + a1[i]) / 2));
  const near = diff(at(2.9999), at(3), [0]);
  check("W: w=0.5 is the average of slices 0 and 1", mid <= 1, `max |Δ| ${mid}/255`);
  check("W: the blend reaches the next slice continuously (w=2.9999 ≈ w=3)", near.max <= 1, `max |Δ| ${near.max}/255`);
  check("W: a fractional w is a different field from w=0", diff(a0, ah, [0]).mean > 5);
}

{
  // Color Ramp (Skia) vs makeColorRampSampler — every ported mode, on a
  // horizontal 0..1 input. Constant follows the GL LUT's 1/1024 grid.
  const stops = [
    { id: "a", position: 0.08, color: "#1b2cff" },
    { id: "c", position: 0.62, color: "#ffe3c2", alpha: 0.6 },
    { id: "b", position: 0.3, color: "#ff3d8b" },
    { id: "d", position: 0.91, color: "#00a37a" },
  ];
  const interps = ["linear", "ease", "smoother", "sine", "ease_in", "ease_out", "constant"];
  const spaces = ["srgb", "linear", "oklab"];
  const def = getNodeDef("skia-color-ramp")!;
  const RW = 256;
  let worst = 0;
  let worstAt = "";
  for (const interpolation of interps) {
    for (const space of spaces) {
      for (const offset of [0, 0.35]) {
        const out = def.compute({ inputs: { image: { kind: "skia_shader", expr: call("test.uvx@1", "ux", {}) } } as any, auxIn: {}, params: { stops, offset, interpolation, space }, ctx: ctxFor(RW, 1), nodeId: "r", consumedOutputs: new Set(["primary"]) }) as any;
        const img = renderProgram(fused(out.primary.expr, RW, 1), RW, 1);
        const sample = makeColorRampSampler(stops, { interp: interpolation as any, space: space as any });
        for (let x = 0; x < RW; x++) {
          let t = (x + 0.5) / RW;
          if (Math.abs(offset) > 1e-8) t = t + offset - Math.floor(t + offset);
          if (interpolation === "constant") t = (Math.floor(t * 1024) + 0.5) / 1024;
          const c = sample(t);
          for (let k = 0; k < 4; k++) {
            const d = Math.abs(img[x * 4 + k] - c[k] * 255);
            if (d > worst) {
              worst = d;
              worstAt = `${interpolation}/${space}/offset ${offset} x=${x} ch${k}: ${img[x * 4 + k]} vs ${(c[k] * 255).toFixed(2)}`;
            }
          }
        }
      }
    }
  }
  check(`Color Ramp (Skia) matches makeColorRampSampler (${interps.length} interpolations × ${spaces.length} spaces × 2 offsets)`, worst <= 1.5, `max |Δ| ${worst.toFixed(2)}/255${worst > 0 ? ` at ${worstAt}` : ""}`);
  const silent = [
    ...COLOR_RAMP_INTERP_OPTIONS.filter((o) => interps.includes(o) === (def.validateParams!({ interpolation: o }).length > 0)),
    ...COLOR_RAMP_SPACE_OPTIONS.filter((o) => spaces.includes(o) === (def.validateParams!({ space: o }).length > 0)),
  ];
  check("every Color Ramp option is either verified above or reported unsupported", silent.length === 0, silent.join());
  const edge = (st: unknown[]) => {
    const out = def.compute({ inputs: { image: { kind: "skia_shader", expr: call("test.uvx@1", "ux", {}) } } as any, auxIn: {}, params: { stops: st, offset: 0, interpolation: "linear", space: "srgb" }, ctx: ctxFor(8, 1), nodeId: "r", consumedOutputs: new Set(["primary"]) }) as any;
    return renderProgram(fused(out.primary.expr, 8, 1), 8, 1);
  };
  const one = edge([{ id: "a", position: 0.5, color: "#ff8000" }]);
  const none = edge([]);
  check("one stop is a flat color; no stops is the input's grey", one[0] === 255 && one[28] === 255 && one[29] === 128 && none[0] === 16 && none[28] === 239, `${one.slice(0, 4)} / ${none[0]},${none[28]}`);
}

{
  // Noise (Skia) → Color Ramp (Skia), fused, vs M0's hand port aurora.sksl
  // with equal params (static values from the Aurora fixture's tracks).
  const inputs = syncChannelInputs([], fx.AURORA_SKSL);
  const prog = buildSkslProgram({ expression: fx.AURORA_SKSL, inputs });
  const aurora = compileSksl(CK, prog.sksl);
  check("aurora.sksl compiles", !!aurora.effect, aurora.error ?? undefined);
  const tuple = (hex: string) => lib.parseSkslColor(hex);
  const sets = [
    { scale: 3, contrast: 1.2, drift_x: 0, drift_y: 0, c2: "#ff7a45" },
    { scale: 4.2, contrast: 1.6, drift_x: 0.75, drift_y: 0, c2: "#ff3d8b" },
    { scale: 3.4, contrast: 0.8, drift_x: 1.5, drift_y: -0.4, c2: "#ff5c6a" },
  ];
  const sizes: [number, number][] = [[256, 256], [320, 180]];
  let worst = 0;
  let meanWorst = 0;
  let identMin = 1;
  let rows = 0;
  let differing = 0;
  let pixels = 0;
  for (const [w, h] of sizes) {
    for (const s of sets) {
      const stops = AURORA_STOPS.map((st) => (st.id === "c" ? { ...st, color: s.c2 } : st));
      const exprs = evalExprs(
        [noiseNode("noise", { scale: s.scale, octaves: 4, persistence: 0.5, lacunarity: 2, offset_x: s.drift_x, offset_y: s.drift_y, contrast: s.contrast }), rampNode("ramp", { stops, interpolation: "linear", space: "oklab" })],
        [wire("noise", "ramp")],
        w,
        h
      );
      const ported = renderProgram(fused(exprs.get("ramp")!, w, h), w, h);
      const u = packUniforms(aurora.effect!, {
        iResolution: [w, h, 1], iTime: 0, scale: s.scale, octaves: 4, persistence: 0.5, lacunarity: 2,
        drift_x: s.drift_x, drift_y: s.drift_y, contrast: s.contrast,
        c0: tuple("#0a0f2c"), c1: tuple("#3d5afe"), c2: tuple(s.c2), c3: tuple("#ffe3c2"),
      });
      const ref = renderShader(aurora.effect!.makeShader(u), w, h);
      const d = diff(ported, ref);
      worst = Math.max(worst, d.max);
      meanWorst = Math.max(meanWorst, d.mean);
      identMin = Math.min(identMin, d.identical);
      differing += Math.round((1 - d.identical) * w * h);
      pixels += w * h;
      rows++;
    }
  }
  info(`noise → ramp (fused ports) vs aurora.sksl, ${rows} renders (256², 320×180 × 3 param sets): max |Δ| ${worst}/255, worst mean ${meanWorst.toExponential(2)}/255, ${differing} of ${pixels} pixels differ (worst render ${(identMin * 100).toFixed(4)}% identical)`);
  check("Noise (Skia) → Color Ramp (Skia) matches aurora.sksl within 1/255", worst <= 1, `max |Δ| ${worst}/255`);
}

// ---- 5. node defs ---------------------------------------------------------------------------
{
  for (const [type, mirror] of [["skia-noise", "noise"], ["skia-color-ramp", "color-ramp"]] as const) {
    const def = getNodeDef(type)!;
    const orig = getNodeDef(mirror)!;
    check(`${type}: skia { class: "sksl", mirrors: "${mirror}" }, shader primary + image preview`, def.skia?.class === "sksl" && def.skia.mirrors === mirror && def.primaryOutput === "skia_shader" && def.auxOutputs.some((a) => a.name === "preview" && a.type === "image") && def.gatesOutputs === true);
    const drift = def.params.filter((p) => orig.params.find((o) => o.name === p.name) !== p).map((p) => p.name);
    check(`${type}: every param is the mirror's own ParamDef (names, ranges, defaults)`, drift.length === 0, drift.join());
    const fnId = type === "skia-noise" ? "tbx.noise.simplex@1" : "tbx.color_ramp@1";
    const fn = lib.getSkslFunction(fnId)!;
    const unfed = fn.params.filter((p) => !def.params.some((d) => d.name === p.name) && !p.name.startsWith("stops_")).map((p) => p.name);
    check(`${type}: every lib param is fed by a same-named param (or the stops split)`, unfed.length === 0, unfed.join());
  }
  const noise = getNodeDef("skia-noise")!;
  // Every algorithm and the looping evolution are ported (noise family,
  // check:skia-noise); a type outside the enum is still refused.
  check("skia-noise accepts every algorithm and the looping evolution, rejects unknown types", noise.validateParams!({ type: "voronoi" }).length === 1 && noise.validateParams!({ type: "perlin", animated: true }).length === 0 && noise.validateParams!({ type: "simplex" }).length === 0);
  const ramp = getNodeDef("skia-color-ramp")!;
  check("skia-color-ramp rejects unported interpolations and spaces", ramp.validateParams!({ interpolation: "monotone" }).length === 1 && ramp.validateParams!({ space: "oklch" }).length === 1 && ramp.validateParams!({ interpolation: "ease_out", space: "oklab" }).length === 0);
  const warn = console.warn;
  console.warn = () => {};
  const out = noise.compute({ inputs: {}, auxIn: {}, params: { ...defaults("skia-noise"), type: "voronoi" }, ctx: ctxFor(8, 8), nodeId: "n", consumedOutputs: new Set(["primary"]) }) as any;
  console.warn = warn;
  check("an unsupported setting emits transparent instead of the wrong algorithm", out.primary.expr.fn === "tbx.const@1" && out.primary.expr.params.color.v.join() === "0,0,0,0");
  const ok = noise.compute({ inputs: {}, auxIn: {}, params: { ...defaults("skia-noise"), color_a: "#ff000080" }, ctx: ctxFor(8, 8), nodeId: "n", consumedOutputs: new Set(["primary"]) }) as any;
  const e = ok.primary.expr;
  check("param values bind by name with refs (hex colors → straight RGBA)", e.params.scale.ref?.param === "scale" && e.params.color_a.v.map((x: number) => Math.round(x * 255)).join() === "255,0,0,128" && e.params.octaves.v === 4);
}

console.log(`\ncheck-skia-library: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
