// check-skia-gather: the gather family's gate (specdocs/101326_skia-target.md
// §7 Wave 2, family 4) — Displace, Chromatic Aberration, Sharpen, Edge
// Detect, Bevel & Emboss, Vector Field, Flow Blur and Kuwahara as `skia-*`
// SkSL ports. CanvasKit in Node, CPU raster surfaces, no GPU:
//
//   1. the defs mirror their originals (params are the mirror's ParamDefs,
//      sockets keep the mirror's names, every lib param is fed by a
//      same-named param), and every enum option either renders or is
//      reported unsupported — wiring problems only when wiring is known;
//   2. the fuser: each port over a pure upstream (Noise (Skia)) and over
//      another gather compiles, declares exactly its binds, keeps its SkSL
//      text when values animate, and fans the upstream out by its taps;
//      a port used on two upstreams compiles as a `_G1` copy;
//   3. semantics against closed forms on a linear ramp (no GL node needed):
//      edge clamping, the kernels, offsets and wraps, gradient directions,
//      symmetric walks, opacity, and every wiring rule; plus Displace's
//      wrap function from BOTH sources (the GL node's own wrapUv text and
//      the port's) run on CanvasKit — mirror reflects only past the edges;
//   4. cost: estimateShaderCost per port over an image child and over
//      Noise (Skia), the taps the param-driven ports really take, and the
//      list of ports over the 3× phone budget (helpers-gather.ts);
//   5. export: every Skia Canvas of the compare:skia fixture
//      (scripts/fixtures/skia/gather-graph.ts) exports through exportSkia,
//      its programs compile and declare their binds, and the bundle
//      type-checks against react-native-skia (scripts/skia/export-check.ts).
//
//   npx tsx scripts/check-skia-gather.mts [--no-typecheck]

/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { ShaderIR, SkslProgramIR } from "@/engine/skia/scene-ir";
import type { NodeDefinition } from "@/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef, registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const lib = await import("@/engine/skia/library");
const { PHONE_PIXEL_BUDGET } = await import("@/engine/skia/library/helpers-gather");
const { fuseShader, estimateShaderCost, PARAM_TAPS } = await import("@/engine/skia/fuse");
const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { bindStatic } = await import("@/engine/skia/scene-ir");
const { skiaBevelEmbossTaps } = await import("@/nodes/skia/bevel-emboss");
const { skiaFlowBlurTaps } = await import("@/nodes/skia/flow-blur");
const { skiaKuwaharaTaps, KUWAHARA_SKIA_MAX_EXTENT } = await import("@/nodes/skia/kuwahara");
const { DISPLACE_FS } = await import("@/nodes/effect/displace");
const fx = await import("./fixtures/skia/gather-graph.ts");
const { checkExportable } = await import("./skia/export-check.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();
const TYPECHECK = !process.argv.includes("--no-typecheck");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}

// The ports: type, mirror, and the lib function each emits.
const PORTS = [
  { type: "skia-displace", mirror: "displace", fn: "tbx.displace@2" },
  { type: "skia-chromatic-aberration", mirror: "chromatic-aberration", fn: "tbx.chromatic_aberration@1" },
  { type: "skia-sharpen", mirror: "sharpen", fn: "tbx.sharpen@1" },
  { type: "skia-edge-detect", mirror: "edge-detect", fn: "tbx.edge_detect@1" },
  { type: "skia-bevel-emboss", mirror: "bevel-emboss", fn: "tbx.bevel_emboss.emboss@1" },
  { type: "skia-vector-field", mirror: "vector-field", fn: "tbx.vector_field.image@1" },
  { type: "skia-flow-blur", mirror: "flow-blur", fn: "tbx.flow_blur@1" },
  { type: "skia-kuwahara", mirror: "kuwahara", fn: "tbx.kuwahara@1" },
] as const;

// Lib params with no same-named toolbox param, by design (wiring flags).
const DERIVED_LIB_PARAMS: Record<string, string[]> = { "tbx.vector_field.image@1": ["source_wired"] };

// Params each port needs to render at all (Bevel's default style is a JFA
// style; Kuwahara's default mode needs a field).
const RENDERABLE: Record<string, Record<string, unknown>> = {
  "skia-bevel-emboss": { style: "emboss" },
  "skia-kuwahara": { mode: "generalized", radius: 3 },
};

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
function renderProgram(p: SkslProgramIR, w: number, h: number): Uint8Array {
  const shader = programShader(p);
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

function fused(expr: ShaderExpr, w: number, h: number): SkslProgramIR {
  const r = fuseShader(expr, { resolution: [w, h], time: 0 });
  if (!r.shader || r.shader.k !== "runtime") throw new Error(`fuse failed: ${r.problems.join(" | ")}`);
  return r.shader.program;
}

function uniformNames(sksl: string): Set<string> {
  const r = compileSksl(CK, sksl);
  const out = new Set<string>();
  if (!r.effect) return out;
  for (let i = 0; i < r.effect.getUniformCount(); i++) out.add(r.effect.getUniformName(i));
  return out;
}

function bindsMatch(p: SkslProgramIR): { ok: boolean; detail: string } {
  const declared = uniformNames(p.sksl);
  const supplied = new Set(Object.keys(p.uniforms));
  const missing = [...declared].filter((n) => !supplied.has(n));
  const extra = [...supplied].filter((n) => !declared.has(n));
  return { ok: declared.size > 0 && !missing.length && !extra.length, detail: missing.length || extra.length ? `missing ${missing} extra ${extra}` : `${declared.size} uniforms` };
}

// ---- graphs through the real evaluator ---------------------------------------------

const ctxFor = (w: number, h: number): any => ({
  gl: {}, width: w, height: h, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
});

function defaults(type: string): Record<string, unknown> {
  const def = getNodeDef(type)!;
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

// Test upstreams: a linear ramp (u, v, u, 1) and a flat RGBA value.
lib.registerSkslFunction({
  id: "test.gather.ramp@1",
  entry: "test_gather_ramp",
  source: "float4 test_gather_ramp(float2 uv, float2 res) { return float4(uv.x, uv.y, uv.x, 1.0); }",
  params: [],
  inputs: [],
  cost: 0,
});
const testNode = (type: string, compute: NodeDefinition["compute"], params: NodeDefinition["params"] = []): NodeDefinition => ({
  type, name: type, category: "utility", hidden: true, backend: "webgl2", inputs: [], params, primaryOutput: "skia_shader", auxOutputs: [], compute,
});
registerNode(
  testNode("test-gather-ramp", ({ nodeId }) => ({ primary: { kind: "skia_shader", expr: { k: "call", fn: "test.gather.ramp@1", node: nodeId, params: {}, inputs: {} } } }))
);
// An image child as a Skia layer has one: a leaf (child shader), 1 per sample.
registerNode(
  testNode("test-gather-leaf", () => ({ primary: { kind: "skia_shader", expr: { k: "leaf", shader: { k: "color", color: bindStatic([0.5, 0.5, 0.5, 1]) } } } }))
);
registerNode(
  testNode(
    "test-gather-flat",
    ({ nodeId, params }) => ({
      primary: { kind: "skia_shader", expr: { k: "call", fn: "tbx.gather.flat@1", node: nodeId, params: { value: bindStatic([...(params.value as number[])]) }, inputs: {} } },
    }),
    [{ name: "value", label: "Value", type: "vec4", default: [0.5, 0.5, 0.5, 1] }]
  )
);

const wire = (source: string, target: string, socket: string): GraphEdge => ({
  id: `${source}->${target}:${socket}`,
  source,
  sourceHandle: "out:primary",
  target,
  targetHandle: `in:${socket}`,
});
const node = (id: string, type: string, over: Record<string, unknown> = {}): GraphNode => ({ id, type, params: { ...defaults(type), ...over } });
const ramp = (id = "ramp"): GraphNode => node(id, "test-gather-ramp");
const flat = (id: string, value: number[]): GraphNode => node(id, "test-gather-flat", { value });
const noise = (id = "nz", over: Record<string, unknown> = {}): GraphNode =>
  node(id, "skia-noise", { scale: 4, octaves: 3, offset_x: 0.3, color_a: "#102040", color_b: "#ffd060", ...over });

interface Evaluated {
  expr: ShaderExpr;
  problems: string[];
}
function evalNode(nodes: GraphNode[], edges: GraphEdge[], target: string, w = 32, h = 32): Evaluated {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = evaluateGraph(nodes, edges, ctxFor(w, h), new Map() as EvalCache, null, undefined, null, { extraTargets: [target] });
    const v = r.outputs.get(target)?.primary as any;
    if (v?.kind !== "skia_shader") throw new Error(`${target} produced ${v?.kind ?? "nothing"}${r.errors[target] ? `: ${r.errors[target]}` : ""}`);
    return { expr: v.expr, problems: v.problems ?? [] };
  } finally {
    console.warn = warn;
  }
}

// A port over the given upstream nodes (socket → node).
function portOver(type: string, over: Record<string, unknown>, ups: Record<string, GraphNode>, w = 32, h = 32): Evaluated & { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [...new Map(Object.values(ups).map((n) => [n.id, n])).values(), node("p", type, over)];
  const edges = Object.entries(ups).map(([socket, n]) => wire(n.id, "p", socket));
  return { ...evalNode(nodes, edges, "p", w, h), nodes, edges };
}

function render(e: Evaluated, w = 32, h = 32): Uint8Array {
  if (e.problems.length) throw new Error(e.problems.join(" | "));
  return renderProgram(fused(e.expr, w, h), w, h);
}

const px = (img: Uint8Array, x: number, y: number, w = 32) => Array.from(img.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
// Pixel (x, y), row 0 = top → toolbox uv (Y-up) at its centre.
const uvAt = (x: number, y: number, w = 32, h = 32): [number, number] => [(x + 0.5) / w, 1 - (y + 0.5) / h];

// Displace's mirror edge rule (GL and port): a period-2 triangle wave, the
// identity on [0,1] and reflected past each edge (1.2 → 0.8, −0.3 → 0.3).
const mirrorWrap = (q: number) => 1 - Math.abs((q * 0.5 - Math.floor(q * 0.5)) * 2 - 1);

// Worst |Δ| (0..255 steps) between a render and a closed form over pixels.
function worstVs(img: Uint8Array, want: (x: number, y: number) => number[] | null, w = 32, h = 32): { worst: number; at: string } {
  let worst = 0;
  let at = "";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = want(x, y);
      if (!c) continue;
      for (let k = 0; k < 4; k++) {
        const d = Math.abs(img[(y * w + x) * 4 + k] - Math.min(255, Math.max(0, c[k] * 255)));
        if (d > worst) {
          worst = d;
          at = `(${x},${y}) ch${k}: ${img[(y * w + x) * 4 + k]} vs ${(c[k] * 255).toFixed(1)}`;
        }
      }
    }
  }
  return { worst, at };
}

// ---- 1. defs ---------------------------------------------------------------------------
{
  for (const p of PORTS) {
    const def = getNodeDef(p.type)!;
    const orig = getNodeDef(p.mirror)!;
    check(`${p.type}: registered, skia { class: "sksl", mirrors: "${p.mirror}" }, shader primary + gated image preview`, !!def && def.skia?.class === "sksl" && def.skia.mirrors === p.mirror && def.primaryOutput === "skia_shader" && def.auxOutputs.some((a) => a.name === "preview" && a.type === "image") && def.gatesOutputs === true && def.noMaskInput === true);
    const drift = def.params.filter((d) => orig.params.find((o) => o.name === d.name) !== d).map((d) => d.name);
    check(`${p.type}: every param is the mirror's own ParamDef`, drift.length === 0, drift.join());
    const origImageInputs = orig.inputs.filter((i) => i.type === "image").map((i) => i.name);
    const sockets = def.inputs.map((i) => i.name);
    check(`${p.type}: shader sockets keep the mirror's image socket names (${sockets.join(", ")})`, sockets.every((s) => origImageInputs.includes(s)) && def.inputs.every((i) => i.type === "skia_shader"), `mirror has ${origImageInputs.join(", ")}`);
    const fn = lib.getSkslFunction(p.fn)!;
    const unfed = fn.params.filter((lp) => !def.params.some((d) => d.name === lp.name) && !(DERIVED_LIB_PARAMS[p.fn] ?? []).includes(lp.name)).map((lp) => lp.name);
    check(`${p.type}: every lib param is fed by a same-named param`, !!fn && unfed.length === 0, unfed.join());
    check(`${p.type}: ${fn.id} declares gather inputs with taps`, fn.inputs.some((i) => i.mode === "gather") && fn.inputs.every((i) => i.mode === "pure" || i.taps !== undefined));
    check(`${p.type}: facts are authored`, !!def.facts?.gotchas?.length);

    // Every enum option renders or is reported unsupported.
    const enums = def.params.filter((d) => d.type === "enum" && d.options);
    const silent: string[] = [];
    for (const e of enums) {
      for (const o of e.options!) {
        const over = { ...RENDERABLE[p.type], [e.name]: o };
        const reported = def.validateParams!({ ...defaults(p.type), ...over }).length > 0;
        if (reported) continue;
        const ups: Record<string, GraphNode> = {};
        for (const s of sockets) ups[s] = ramp();
        try {
          const ev = portOver(p.type, over, ups, 8, 8);
          if (ev.problems.length) silent.push(`${e.name}=${o}: ${ev.problems[0]}`);
          else render(ev, 8, 8);
        } catch (err) {
          silent.push(`${e.name}=${o}: ${String(err).slice(0, 120)}`);
        }
      }
    }
    check(`${p.type}: every enum option (${enums.map((e) => e.name).join(", ") || "none"}) fuses and renders or is reported unsupported`, silent.length === 0, silent.join(" | "));
  }

  const bevel = getNodeDef("skia-bevel-emboss")!;
  const refused = ["outer-bevel", "inner-bevel", "pillow-emboss"].filter((s) => bevel.validateParams!({ style: s }).length === 1);
  check("skia-bevel-emboss refuses the JFA styles and accepts emboss", refused.length === 3 && bevel.validateParams!({ style: "emboss" }).length === 0, refused.join());
  const kuw = getNodeDef("skia-kuwahara")!;
  check(`skia-kuwahara refuses radius > ${KUWAHARA_SKIA_MAX_EXTENT} px and accepts the cap`, kuw.validateParams!({ radius: KUWAHARA_SKIA_MAX_EXTENT + 0.5 }).length === 1 && kuw.validateParams!({ radius: KUWAHARA_SKIA_MAX_EXTENT }).length === 0);
  check("validateParams reports no wiring problems (it cannot see wires)", getNodeDef("skia-flow-blur")!.validateParams!({}).length === 0 && kuw.validateParams!({ mode: "anisotropic" }).length === 0);

  const fb = portOver("skia-flow-blur", {}, { image: ramp() });
  check("skia-flow-blur with its field unwired reports the multipass internal field and emits transparent", fb.problems.some((m) => m.includes("needs its field wired")) && (fb.expr as any).fn === "tbx.const@1" && (fb.expr as any).params.color.v.join() === "0,0,0,0");
  const fbOk = portOver("skia-flow-blur", {}, { image: ramp(), field: flat("fl", [1, 0.5, 0, 1]) });
  check("skia-flow-blur with its field wired has no problems", fbOk.problems.length === 0 && (fbOk.expr as any).fn === "tbx.flow_blur@1");
  const ka = portOver("skia-kuwahara", { mode: "anisotropic" }, { image: ramp() });
  const kg = portOver("skia-kuwahara", { mode: "generalized" }, { image: ramp() });
  check("skia-kuwahara anisotropic needs a field; generalized does not", ka.problems.some((m) => m.includes("needs its field wired")) && kg.problems.length === 0);
  const dispOnly = portOver("skia-displace", {}, {});
  check("an unwired gather reads transparent, not an error", dispOnly.problems.length === 0 && render(dispOnly).every((v) => v === 0));

  // Preview gating (data-only context: no preview without a GL context;
  // primary-only consumption never builds one).
  const def = getNodeDef("skia-sharpen")!;
  const out = def.compute({ inputs: {}, auxIn: {}, params: defaults("skia-sharpen"), ctx: ctxFor(8, 8), nodeId: "s", consumedOutputs: new Set(["primary"]) }) as any;
  check("preview is not built when only the shader is consumed", out.aux === undefined && out.primary.kind === "skia_shader");
}

// ---- 2. the fuser ----------------------------------------------------------------------
const W = 48;
const H = 48;
// Over-another-gather upstream per port: Chromatic Aberration (Skia) over
// Noise (Skia) (Sharpen (Skia) for Chromatic Aberration itself).
const innerFor = (type: string) => (type === "skia-chromatic-aberration" ? { type: "skia-sharpen", taps: 9 } : { type: "skia-chromatic-aberration", taps: 3 });
const declaredTaps = (fnId: string, input: string) => {
  const t = lib.getSkslFunction(fnId)!.inputs.find((i) => i.name === input)!.taps;
  return t === "param" ? PARAM_TAPS : (t ?? 1);
};
{
  for (const p of PORTS) {
    const def = getNodeDef(p.type)!;
    const fn = lib.getSkslFunction(p.fn)!;
    const sockets = def.inputs.map((i) => i.name);
    const over = { ...RENDERABLE[p.type] };

    // (a) over a pure upstream: every socket ← one Noise (Skia).
    const ups: Record<string, GraphNode> = {};
    for (const s of sockets) ups[s] = noise();
    const a = portOver(p.type, over, ups, W, H);
    const pa = fused(a.expr, W, H);
    const ca = compileSksl(CK, pa.sksl);
    const ba = bindsMatch(pa);
    check(`${p.type} over Noise (Skia): fuses to one program, compiles, declares exactly its binds`, !a.problems.length && pa.children.length === 0 && !!ca.effect && ba.ok, ca.error?.split("\n")[0] ?? ba.detail);
    const gathers = fn.inputs.filter((i) => i.mode === "gather").length;
    const gFns = (pa.sksl.match(/^float4 g\d+\(float2 uv\) \{/gm) ?? []).length;
    check(`${p.type} over Noise (Skia): one g<k> per distinct gathered upstream (${Math.min(gathers, 1)})`, gFns === 1, `${gFns} g functions`);
    const cost = estimateShaderCost(a.expr);
    const nz = cost.nodes.find((n) => n.node === "nz")!;
    // Every lib input is fed (all sockets wired), so Σ taps (pure = 1).
    const wantEvals = fn.inputs.reduce((s, i) => s + (i.mode === "gather" ? declaredTaps(p.fn, i.name) : 1), 0);
    check(`${p.type} over Noise (Skia): the noise is evaluated ${wantEvals}× per pixel (declared taps)`, nz?.evaluations === wantEvals, `got ${nz?.evaluations}`);

    // Animating a value keeps the program text (CanvasKit's cache holds).
    const firstScalar = def.params.find((d) => d.type === "scalar")!;
    const moved = portOver(p.type, { ...over, [firstScalar.name]: (firstScalar.min ?? 0) + ((firstScalar.max ?? 1) - (firstScalar.min ?? 0)) * 0.37 }, ups, W, H);
    check(`${p.type}: a new ${firstScalar.name} value → byte-identical SkSL`, fused(moved.expr, W, H).sksl === pa.sksl);

    // (b) over another gather.
    const inner = innerFor(p.type);
    const bn: GraphNode[] = [noise(), node("inner", inner.type, {}), node("p", p.type, over)];
    const be: GraphEdge[] = [wire("nz", "inner", "image"), ...sockets.map((s) => wire("inner", "p", s))];
    const eb = evalNode(bn, be, "p", W, H);
    const pb = fused(eb.expr, W, H);
    const cb = compileSksl(CK, pb.sksl);
    const bb = bindsMatch(pb);
    check(`${p.type} over ${inner.type} over Noise (Skia): compiles, declares exactly its binds`, !eb.problems.length && !!cb.effect && bb.ok, cb.error?.split("\n")[0] ?? bb.detail);
    const gb = (pb.sksl.match(/^float4 g\d+\(float2 uv\) \{/gm) ?? []).length;
    check(`${p.type} over a gather: two g<k> (the inner gather and its noise)`, gb === 2, `${gb}`);
    const cost2 = estimateShaderCost(eb.expr);
    const nz2 = cost2.nodes.find((n) => n.node === "nz")!;
    check(`${p.type} over a gather: the noise fans out ${wantEvals} × ${inner.taps}`, nz2?.evaluations === wantEvals * inner.taps, `got ${nz2?.evaluations}`);
    const img = renderProgram(pb, W, H);
    check(`${p.type} over a gather renders (not all transparent)`, img.some((v, i) => i % 4 === 3 && v > 0));
  }

  // One gather port on two different upstreams → a _G1 copy of it and of
  // every private helper (the `$src(` tokens differ).
  const nodes: GraphNode[] = [noise("n1"), noise("n2", { seed: 9 }), node("c1", "skia-chromatic-aberration", { amount: 0.02 }), node("c2", "skia-chromatic-aberration", { amount: 0.03, mode: "directional" }), node("d", "skia-displace", {})];
  const edges = [wire("n1", "c1", "image"), wire("n2", "c2", "image"), wire("c1", "d", "image"), wire("c2", "d", "displacement")];
  const e = evalNode(nodes, edges, "d", W, H);
  const p = fused(e.expr, W, H);
  check("a port on two upstreams is emitted twice (_G1 copy, private helpers renamed)", /float4 tbx_chromatic_aberration\(/.test(p.sksl) && /float4 tbx_chromatic_aberration_G1\(/.test(p.sksl) && /float4 tbx_chromatic_aberration_G1_samp\(/.test(p.sksl));
  check("…and the copies compile and declare exactly their binds", !!compileSksl(CK, p.sksl).effect && bindsMatch(p).ok, bindsMatch(p).detail);
  const twice = renderProgram(p, W, H);
  const direct = render(evalNode([noise("n1"), node("c1", "skia-chromatic-aberration", { amount: 0.02 }), node("d", "skia-displace", {}), noise("n2", { seed: 9 }), node("c2", "skia-chromatic-aberration", { amount: 0.03, mode: "directional" })], edges, "d", W, H), W, H);
  check("…deterministically (same graph, same pixels)", twice.every((v, i) => v === direct[i]));
}

// ---- 3. semantics vs closed forms on a linear ramp ------------------------------------
// The ramp is (u, v, u, 1) with u, v toolbox uv (Y-up). 32×32, 1 px = 1/32.
{
  const N = 32;
  const d = 1 / N;
  const h = 0.5 / N;
  const edgeClamp = (x: number) => Math.min(1 - h, Math.max(h, x));

  // Sharpen box, amount 0.5: identity on a linear ramp inside; at the frame
  // edge the outer tap repeats the edge texel (CLAMP_TO_EDGE).
  {
    const img = render(portOver("skia-sharpen", { algorithm: "box", amount: 0.5 }, { image: ramp() }));
    const r = worstVs(img, (x, y) => {
      const [u, v] = uvAt(x, y);
      const lap = (c: number, plus: number, minus: number) => c * (1 + 4 * 0.5) - 0.5 * (2 * c + edgeClamp(plus) + edgeClamp(minus));
      return [lap(u, u + d, u - d), lap(v, v + d, v - d), lap(u, u + d, u - d), 1];
    });
    check("Sharpen (Skia) box: identity on a ramp, edge taps clamp like CLAMP_TO_EDGE", r.worst <= 1, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const left = px(img, 0, 16)[0];
    const right = px(img, 31, 16)[0];
    check("…the clamp is what moves the edge columns (0 and 255, not the ramp's 4 and 251)", left === 0 && right === 255, `${left}, ${right}`);
  }
  // Unsharp at amount 0 and every algorithm at amount 0: identity.
  {
    const base = render(evalNode([noise()], [], "nz"));
    let worst = 0;
    for (const algorithm of ["box", "diamond", "cross", "unsharp"]) {
      const img = render(portOver("skia-sharpen", { algorithm, amount: 0 }, { image: noise() }));
      for (let i = 0; i < img.length; i++) worst = Math.max(worst, Math.abs(img[i] - base[i]));
    }
    check("Sharpen (Skia): amount 0 is the identity for every algorithm", worst <= 1, `max |Δ| ${worst}/255`);
  }
  // Edge Detect Sobel on the ramp: |∇| = 8/N · |(0.299, 0.587)| in the interior.
  {
    const img = render(portOver("skia-edge-detect", { algorithm: "sobel", strength: 1, threshold: 0 }, { image: ramp() }));
    const mag = 8 * d * Math.hypot(0.299 + 0.114, 0.587);
    const r = worstVs(img, (x, y) => (x > 0 && x < N - 1 && y > 0 && y < N - 1 ? [mag, mag, mag, 1] : null));
    check("Edge Detect (Skia) Sobel: the ramp's gradient magnitude, opaque grey", r.worst <= 1, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const pre = render(portOver("skia-edge-detect", { algorithm: "prewitt", strength: 2, threshold: 0 }, { image: ramp() }));
    const mag2 = 2 * 6 * d * Math.hypot(0.299 + 0.114, 0.587);
    const r2 = worstVs(pre, (x, y) => (x > 0 && x < N - 1 && y > 0 && y < N - 1 ? [mag2, mag2, mag2, 1] : null));
    check("Edge Detect (Skia) Prewitt × strength", r2.worst <= 1, `max |Δ| ${r2.worst.toFixed(2)}/255 ${r2.at}`);
    const hard = render(portOver("skia-edge-detect", { algorithm: "sobel", strength: 1, threshold: mag + 0.01 }, { image: ramp() }));
    check("Edge Detect (Skia): threshold above the magnitude → black", px(hard, 16, 16).join() === "0,0,0,255");
    const none = render(evalNode([node("e", "skia-edge-detect")], [], "e"));
    check("Edge Detect (Skia) unwired is transparent, like Edge Detect", none.every((v) => v === 0));
  }
  // Chromatic Aberration directional, angle 0: R from u + a, B from u − a;
  // a tap past the frame is transparent (R = 0 there, alpha from the others).
  {
    const a = 2 * d;
    const img = render(portOver("skia-chromatic-aberration", { mode: "directional", angle: 0, amount: a, opacity: 0.5 }, { image: ramp() }));
    const r = worstVs(img, (x, y) => {
      const [u, v] = uvAt(x, y);
      const R = u + a > 1 ? 0 : edgeClamp(u + a);
      const B = u - a < 0 ? 0 : edgeClamp(u - a);
      return [R, edgeClamp(v), B, 0.5];
    });
    // Alpha 0.5: the 8-bit premultiplied surface costs up to 2 steps on unpremultiply.
    check("Chromatic Aberration (Skia) directional: R/B taps ± amount, out-of-frame taps transparent, alpha × opacity", r.worst <= 2, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const rad = render(portOver("skia-chromatic-aberration", { mode: "radial", center: [0.25, 0.25], falloff: 0, amount: 0.1 }, { image: ramp() }));
    const r2 = worstVs(rad, (x, y) => {
      const [u, v] = uvAt(x, y);
      // center is Y-down: (0.25, 0.25) → uv (0.25, 0.75); falloff 0 → k = 1.
      const off = [(u - 0.25) * 0.1, (v - 0.75) * 0.1];
      const tap = (s: number, k: number) => {
        const q = [u + s * off[0], v + s * off[1]];
        return q[0] < 0 || q[0] > 1 || q[1] < 0 || q[1] > 1 ? 0 : edgeClamp(q[k]);
      };
      return [tap(1, 0), edgeClamp(v), tap(-1, 0), 1];
    });
    check("Chromatic Aberration (Skia) radial: offset ∝ (uv − center), center Y-down", r2.worst <= 1, `max |Δ| ${r2.worst.toFixed(2)}/255 ${r2.at}`);
  }
  // Displace with a flat map: a uniform offset ((map − midlevel) × amount).
  // mirror reflects only the out-of-range samples (mirrorWrap); until
  // 2026-10-16 both Displace and the port returned 1 − uv inside the frame,
  // flipping the whole image (spec §2c). Offset 0 is that bug's plainest
  // form: every wrap must then be the identity.
  {
    const map = flat("map", [0.6, 0.3, 0.9, 1]);
    const base = { amountX: 0.25, amountY: 0.5, channelX: "r", channelY: "g", midlevel: 0.5, rotate: false };
    const deep = flat("deep", [1, 0, 0, 1]);
    const cases: [GraphNode, number, number, [number, number]][] = [
      [map, 0, 0, [0, 0]],
      [map, 0.25, 0.5, [(0.6 - 0.5) * 0.25, (0.3 - 0.5) * 0.5]],
      [deep, 1, 1, [0.5, -0.5]],
    ];
    for (const [disp, amountX, amountY, off] of cases) {
      for (const wrap of ["clamp", "transparent", "mirror"]) {
        const img = render(portOver("skia-displace", { ...base, amountX, amountY, wrap }, { image: ramp(), displacement: disp }));
        const r = worstVs(img, (x, y) => {
          const [u, v] = uvAt(x, y);
          let p = [u + off[0], v + off[1]];
          if (wrap === "transparent" && (p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1)) return [0, 0, 0, 0];
          if (wrap === "clamp") p = p.map((q) => Math.min(1, Math.max(0, q)));
          if (wrap === "mirror") p = p.map(mirrorWrap);
          return [edgeClamp(p[0]), edgeClamp(p[1]), edgeClamp(p[0]), 1];
        });
        check(`Displace (Skia) wrap=${wrap}, offset (${off.map((o) => +o.toFixed(3)).join(", ")}): a flat map shifts by (map − midlevel) × amount`, r.worst <= 1, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
      }
    }
    const lum = 0.2126 * 0.6 + 0.7152 * 0.3 + 0.0722 * 0.9;
    const ang = (lum - 0.5) * 2 * (40 * Math.PI) / 180;
    const rot = render(portOver("skia-displace", { ...base, amountX: 0, amountY: 0, rotate: true, rotateAmount: 40, wrap: "clamp" }, { image: ramp(), displacement: map }));
    const r = worstVs(rot, (x, y) => {
      const [u, v] = uvAt(x, y);
      const q = [u - 0.5, v - 0.5];
      const p = [Math.cos(ang) * q[0] - Math.sin(ang) * q[1] + 0.5, Math.sin(ang) * q[0] + Math.cos(ang) * q[1] + 0.5].map((t) => Math.min(1, Math.max(0, t)));
      return [edgeClamp(p[0]), edgeClamp(p[1]), edgeClamp(p[0]), 1];
    });
    check("Displace (Skia) rotate: spins the sample point about the centre by (luma − midlevel) × 2 × amount", r.worst <= 1, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const pass = render(portOver("skia-displace", { ...base, midlevel: 0.3, rotate: true, wrap: "clamp" }, { image: ramp() }));
    const id = render(evalNode([ramp()], [], "ramp"));
    check("Displace (Skia) unwired map: passes the source through (any midlevel, rotate on)", pass.every((v, i) => Math.abs(v - id[i]) <= 1));
    const pe = portOver("skia-displace", { midlevel: 0.3 }, { image: ramp() });
    const flatIn = (pe.expr as any).inputs.disp;
    check("…via a constant DATA map (tbx.gather.flat, no layout(color)) derived from midlevel", flatIn?.fn === "tbx.gather.flat@1" && flatIn.params.value.deps?.[0]?.param === "midlevel" && flatIn.params.value.v.join() === "0.3,0.3,0.3,0.3");
  }
  // Displace's wrap function itself, from both sources, run on CanvasKit:
  // the GL node's real shader text (DISPLACE_FS's wrapUv, vec2 → float2, the
  // u_wrap uniform → the mode) and the port's tbx_displace_wrap, over uv a
  // period and more past each edge. npm run check has no GL, so this is the
  // GL node's offline regression gate for the 2026-10-16 mirror fix.
  {
    const W = 256;
    const f = (n: number) => n.toFixed(4);
    const strip = (fnSrc: string, call: string, lo: number, hi: number): Uint8Array =>
      renderProgram(
        {
          sksl: `${fnSrc}\nhalf4 main(float2 fc) {\n  float t = fc.x / ${f(W)};\n  float2 q = float2(${f(lo)} + ${f(hi - lo)} * t, ${f(hi)} - ${f(hi - lo)} * t);\n  return half4(half2(${call}), 0.0, 1.0);\n}`,
          uniforms: {},
          children: [],
        },
        W,
        1
      );
    const glSrc = /vec2 wrapUv\(vec2 uv\) \{[\s\S]*?\n\}/.exec(DISPLACE_FS)?.[0];
    const portFn = lib.allSkslFunctions().find((fn) => fn.id === "tbx.displace@2");
    const portSrc = /float2 tbx_displace_wrap\(float2 uv, int wrap\) \{[\s\S]*?\n\}/.exec(portFn?.source ?? "")?.[0];
    check("Displace's wrapUv (DISPLACE_FS) and the port's tbx_displace_wrap are both found", !!glSrc && !!portSrc);
    const modes: [number, string, number, number, (q: number) => number][] = [
      [0, "transparent", 0, 1, (q) => q],
      [1, "clamp", -1.5, 2.5, (q) => Math.min(1, Math.max(0, q))],
      [2, "mirror", -1.5, 2.5, mirrorWrap],
    ];
    for (const [mode, wrap, lo, hi, want] of glSrc && portSrc ? modes : []) {
      const gl = strip(glSrc!.replace(/\bvec2\b/g, "float2").replace(/\bu_wrap\b/g, String(mode)), "wrapUv(q)", lo, hi);
      const port = strip(portSrc!, `tbx_displace_wrap(q, ${mode})`, lo, hi);
      for (const [who, img] of [["Displace (GL wrapUv)", gl], ["Displace (Skia)", port]] as const) {
        // Worst |Δ| for samples inside [0,1] and for those past an edge.
        const worst = [0, 0];
        let at = "";
        for (let x = 0; x < W; x++) {
          const t = (x + 0.5) / W;
          const q = [lo + (hi - lo) * t, hi - (hi - lo) * t];
          for (let k = 0; k < 2; k++) {
            const err = Math.abs(img[x * 4 + k] - want(q[k]) * 255);
            const side = q[k] >= 0 && q[k] <= 1 ? 0 : 1;
            if (err > worst[side]) {
              worst[side] = err;
              at = `uv ${q[k].toFixed(3)} → ${img[x * 4 + k]} vs ${(want(q[k]) * 255).toFixed(1)}`;
            }
          }
        }
        const what = wrap === "mirror" ? "in-range uv untouched, out-of-range reflected (period 2)" : wrap === "clamp" ? "in-range uv untouched, out-of-range clamped" : "uv passes through";
        check(`${who} wrap=${wrap}: ${what}`, worst[0] <= 1 && worst[1] <= 1, `in-range max ${worst[0].toFixed(1)}/255, out-of-range max ${worst[1].toFixed(1)}/255${at ? `; worst at ${at}` : ""}`);
      }
      check(`…GL wrapUv and the port agree byte for byte (wrap=${wrap})`, gl.every((v, i) => v === port[i]));
    }
  }
  // Vector Field over the ramp: luma = 0.2848u + 0.7152v, g = (gx, −gyUp).
  {
    const s = 0.6;
    const img = render(portOver("skia-vector-field", { mode: "attract", strength: s, radius: 0.05, invert: false }, { source: ramp() }));
    const g = [0.2848, -0.7152];
    const n = g.map((c) => c / Math.hypot(...g));
    const enc = (vx: number, vy: number) => [Math.min(1, Math.max(-1, vx)) * 0.5 + 0.5, Math.min(1, Math.max(-1, vy)) * 0.5 + 0.5, 0, 1];
    const inner = (x: number, y: number) => x >= 3 && x <= N - 4 && y >= 3 && y <= N - 4;
    const r = worstVs(img, (x, y) => (inner(x, y) ? enc(n[0] * s, n[1] * s) : null));
    check("Vector Field (Skia) attract: velocity along +∇luma (Y-down), × strength", r.worst <= 1, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const orbit = render(portOver("skia-vector-field", { mode: "orbit", strength: s, radius: 0.05, invert: true }, { source: ramp(), field: flat("fl", [0.6, 0.45, 0.3, 1]) }));
    const ro = worstVs(orbit, (x, y) => (inner(x, y) ? enc(n[1] * s + 0.2, -n[0] * s - 0.1) : null));
    check("Vector Field (Skia) orbit + invert + a summed field", ro.worst <= 1, `max |Δ| ${ro.worst.toFixed(2)}/255 ${ro.at}`);
    const iso = render(portOver("skia-vector-field", { mode: "isoline", strength: 1, radius: 0.05 }, { source: ramp() }));
    const ri = worstVs(iso, (x, y) => (inner(x, y) ? enc(-n[1], n[0]) : null));
    check("Vector Field (Skia) isoline: unit speed along the level set", ri.worst <= 1, `max |Δ| ${ri.worst.toFixed(2)}/255 ${ri.at}`);
    const through = render(portOver("skia-vector-field", {}, { field: flat("fl", [0.3, 0.7, 0.2, 0.9]) }));
    check("Vector Field (Skia) unwired source: the field passes through untouched (B and A too)", worstVs(through, () => [0.3, 0.7, 0.2, 0.9]).worst <= 1);
    const neutral = render(evalNode([node("v", "skia-vector-field")], [], "v"));
    check("Vector Field (Skia) with nothing wired: the neutral field (0.5, 0.5, 0, 1)", worstVs(neutral, () => [0.5, 0.5, 0, 1]).worst <= 1);
    const fieldIn = (portOver("skia-vector-field", {}, { source: ramp() }).expr as any).inputs.field;
    check("…the unwired field is a constant DATA value (no layout(color) conversion)", fieldIn?.fn === "tbx.gather.flat@1");
  }
  // Bevel & Emboss (emboss): a flat height has normal (0, 0, 1), so each
  // light's diffuse term is sin(elevation).
  {
    const src = flat("src", [0.2, 0.4, 0.6, 0.8]);
    const lights = { style: "emboss", l1_angle: 70, l1_elevation: 30, l1_hi_op: 1, l1_sh_op: 1, l2_hi_op: 0, l2_sh_op: 0, highlight_color: "#ffffff", highlight_blend: "normal" };
    const img = render(portOver("skia-bevel-emboss", lights, { image: src }));
    const k = Math.sin((30 * Math.PI) / 180);
    const r = worstVs(img, () => [0.2 + (1 - 0.2) * k, 0.4 + (1 - 0.4) * k, 0.6 + (1 - 0.6) * k, 0.8]);
    check("Bevel & Emboss (Skia): a flat height lights by sin(elevation), alpha kept", r.worst <= 1.5, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const off = render(portOver("skia-bevel-emboss", { style: "emboss", l1_hi_op: 0, l1_sh_op: 0, l2_hi_op: 0, l2_sh_op: 0 }, { image: noise() }));
    const base = render(evalNode([noise()], [], "nz"));
    check("Bevel & Emboss (Skia): lights at 0 are the identity", off.every((v, i) => Math.abs(v - base[i]) <= 1));
    const own = render(portOver("skia-bevel-emboss", { style: "emboss", feather: 2 }, { image: noise() }));
    const wired = render(portOver("skia-bevel-emboss", { style: "emboss", feather: 2 }, { image: noise(), height: noise() }));
    check("Bevel & Emboss (Skia): height unwired reads the image (= the image wired as height)", own.every((v, i) => v === wired[i]) && own.some((v, i) => Math.abs(v - base[i]) > 3));
    const none = render(portOver("skia-bevel-emboss", { style: "emboss" }, { height: noise() }));
    check("Bevel & Emboss (Skia) with no image is transparent", none.every((v) => v === 0));
  }
  // Flow Blur: length 0 is the identity; a uniform velocity walks both ways
  // symmetrically, so a linear ramp averages back to itself.
  {
    const base = render(evalNode([noise()], [], "nz"));
    const z = render(portOver("skia-flow-blur", { length: 0, opacity: 1 }, { image: noise(), field: noise("nf", { seed: 5 }) }));
    check("Flow Blur (Skia): length 0 is the identity", z.every((v, i) => Math.abs(v - base[i]) <= 1));
    for (const mode of ["velocity", "tangent"]) {
      for (const falloff of ["gauss", "box"]) {
        const img = render(portOver("skia-flow-blur", { length: 4 * d, samples: 8, mode, falloff, opacity: 0.5 }, { image: ramp(), field: flat("fl", [1, 0.5, 0, 1]) }));
        const r = worstVs(img, (x, y) => {
          const [u, v] = uvAt(x, y);
          return x >= 4 && x <= N - 5 ? [u, edgeClamp(v), u, 0.5] : null;
        });
        check(`Flow Blur (Skia) ${mode}/${falloff}: a uniform field walks ±, symmetric on a ramp; opacity → alpha`, r.worst <= 2, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
      }
    }
    const taps = skiaFlowBlurTaps({ samples: 24 });
    check("Flow Blur (Skia) taps: 1 + 2 × samples per input (rounded, capped at 64)", taps.src === 49 && taps.field === 49 && skiaFlowBlurTaps({ samples: 99 }).src === 129 && skiaFlowBlurTaps({ samples: 0.2 }).src === 3);
  }
  // Kuwahara: a flat image stays flat (alpha × opacity); a symmetric kernel
  // over a linear ramp pools back to the ramp.
  {
    const src = flat("src", [0.7, 0.2, 0.5, 0.8]);
    const img = render(portOver("skia-kuwahara", { mode: "generalized", radius: 4, opacity: 0.75 }, { image: src }));
    const rf = worstVs(img, () => [0.7, 0.2, 0.5, 0.6]);
    check("Kuwahara (Skia): a flat image stays flat, alpha × opacity", rf.worst <= 2, `max |Δ| ${rf.worst.toFixed(2)}/255 ${rf.at}`);
    const rr = render(portOver("skia-kuwahara", { mode: "generalized", radius: 3 }, { image: ramp() }));
    const r = worstVs(rr, (x, y) => {
      const [u, v] = uvAt(x, y);
      return x >= 4 && x <= N - 5 && y >= 4 && y <= N - 5 ? [u, v, u, 1] : null;
    });
    check("Kuwahara (Skia) generalized: symmetric sectors pool a linear ramp back to itself", r.worst <= 1.5, `max |Δ| ${r.worst.toFixed(2)}/255 ${r.at}`);
    const an = render(portOver("skia-kuwahara", { mode: "anisotropic", radius: 3, anisotropy: 1, min_coherence: 0.8 }, { image: ramp(), field: flat("fl", [1, 0.5, 0, 1]) }));
    const ra = worstVs(an, (x, y) => {
      const [u, v] = uvAt(x, y);
      return x >= 7 && x <= N - 8 && y >= 4 && y <= N - 5 ? [u, v, u, 1] : null;
    });
    check("Kuwahara (Skia) anisotropic: an x-aligned ellipse (min coherence) still pools a ramp back", ra.worst <= 1.5, `max |Δ| ${ra.worst.toFixed(2)}/255 ${ra.at}`);
    const t6 = skiaKuwaharaTaps({ radius: 6 });
    check("Kuwahara (Skia) taps at radius 6: the 113 lattice points of the disc", t6.src === 113, `${t6.src}`);
  }
}

// ---- 4. cost -------------------------------------------------------------------------------
// Per-pixel cost of each port at its default params (renderable ones),
// over (a) an image child (a leaf: 1 per sample) and (b) Noise (Skia)
// (4 per evaluation). `declared` is estimateShaderCost (taps "param" → 9);
// `at params` swaps in the taps the param-driven ports really take.
{
  const leaf: GraphNode = node("img", "test-gather-leaf");
  const COST_PARAMS: Record<string, Record<string, unknown>> = { "skia-bevel-emboss": { style: "emboss" }, "skia-kuwahara": { mode: "generalized" } };
  const rows: { type: string; up: string; declared: number; actual: number }[] = [];
  const actualTaps = (type: string, params: Record<string, unknown>): Record<string, number> | null => {
    if (type === "skia-bevel-emboss") return skiaBevelEmbossTaps(params);
    if (type === "skia-flow-blur") return skiaFlowBlurTaps(params);
    if (type === "skia-kuwahara") return skiaKuwaharaTaps(params);
    return null;
  };
  for (const p of PORTS) {
    const def = getNodeDef(p.type)!;
    const fn = lib.getSkslFunction(p.fn)!;
    const params = { ...defaults(p.type), ...COST_PARAMS[p.type] };
    for (const [upName, upNode, upCost] of [["image child", leaf, 1], ["Noise (Skia)", noise(), 4]] as const) {
      const ups: Record<string, GraphNode> = {};
      for (const s of def.inputs.map((i) => i.name)) ups[s] = upNode;
      const ev = portOver(p.type, COST_PARAMS[p.type] ?? {}, ups);
      const declared = estimateShaderCost(ev.expr).cost;
      // Upstream evaluations at the real taps (every lib input is fed).
      const taps = actualTaps(p.type, params);
      let evals = 0;
      for (const i of fn.inputs) evals += i.mode === "gather" ? (taps?.[i.name] ?? declaredTaps(p.fn, i.name)) : 1;
      const actual = (fn.cost ?? 1) + evals * upCost;
      rows.push({ type: p.type, up: upName, declared, actual });
    }
  }
  for (const r of rows) info(`cost ${r.type.padEnd(26)} over ${r.up.padEnd(13)} declared ${r.declared.toFixed(1).padStart(6)}  at params ${r.actual.toFixed(1).padStart(6)}${r.actual > PHONE_PIXEL_BUDGET ? `  > budget ${PHONE_PIXEL_BUDGET}` : ""}`);
  const over = (up: string) => rows.filter((r) => r.up === up && r.actual > PHONE_PIXEL_BUDGET).map((r) => r.type).sort();
  check(
    `over an image child, only Flow Blur and Kuwahara exceed the ${PHONE_PIXEL_BUDGET}-unit phone budget at default params`,
    over("image child").join() === ["skia-flow-blur", "skia-kuwahara"].join(),
    over("image child").join()
  );
  check(
    "over Noise (Skia), the 3×3 kernels join them (Sharpen 9 taps, Edge Detect 8)",
    over("Noise (Skia)").join() === ["skia-edge-detect", "skia-flow-blur", "skia-kuwahara", "skia-sharpen"].join(),
    over("Noise (Skia)").join()
  );
  const feathered = skiaBevelEmbossTaps({ feather: 2 }).height;
  check("Bevel & Emboss (Skia): feather ≥ 0.5 px takes the height 36× (4 without)", feathered === 36 && skiaBevelEmbossTaps({ feather: 0.4 }).height === 4);
}

// ---- 5. export ----------------------------------------------------------------------------
{
  const g = fx.gatherGraph();
  const typecheckOnce = new Set<string>();
  for (const pair of fx.GATHER_PAIRS) {
    // Type-check one bundle per port type (the emitted TSX is the same shape).
    const typecheck = TYPECHECK && !typecheckOnce.has(pair.type);
    typecheckOnce.add(pair.type);
    const r = await checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: pair.canvas, slot: "gather", name: `gather_${pair.native}`, canvas: { width: 512, height: 512 }, timeline: fx.GATHER_TIMELINE, typecheck });
    const bad = r.programs.filter((p) => !p.ok);
    check(
      `export ${pair.canvas} (skia-${pair.type}): exportSkia has no problems, ${r.programs.length} program(s) compile with exact binds${typecheck ? `, bundle type-checks${r.typecheck.ran ? "" : " (skipped)"}` : ""}`,
      r.problems.length === 0 && !!r.files && r.programs.length > 0 && bad.length === 0 && (!typecheck || r.typecheck.ok),
      [...r.problems, ...bad.map((b) => `${b.where}: ${b.detail.split("\n")[0]}`), typecheck && !r.typecheck.ok ? r.typecheck.output : "", !r.typecheck.ran && typecheck ? r.typecheck.output : ""].filter(Boolean).join(" | ")
    );
    if (r.warnings.length) info(`${pair.canvas} export warnings: ${r.warnings.join(" | ")}`);
  }

  // The wiring rewrites export too: Displace with its map unwired (the flat
  // map is a value DERIVED from a keyframed midlevel), Vector Field with
  // neither input (static neutral field + source_wired 0), Bevel & Emboss
  // reading its image as the height.
  const kf = (a: number, b: number) => ({ animated: true, trackVisible: true, keyframes: [{ tick: 0, value: a, easingOut: "easeInOutSine" as const }, { tick: 60_000, value: b, easingOut: "linear" as const }] });
  const nodes: GraphNode[] = [
    noise("nz"),
    { ...node("d", "skia-displace", { rotate: true }), animation: { midlevel: kf(0.3, 0.7) } },
    node("v", "skia-vector-field"),
    node("b", "skia-bevel-emboss", { style: "emboss", feather: 1 }),
    node("m", "skia-flow-blur", { samples: 6 }),
    node("fm", "skia-fill"),
    node("cv", "skia-canvas"),
  ];
  const edges: GraphEdge[] = [
    wire("nz", "d", "image"),
    wire("d", "b", "image"),
    wire("b", "m", "image"),
    wire("v", "m", "field"),
    wire("m", "fm", "shader"),
    wire("fm", "cv", "scene"),
  ];
  const r = await checkExportable({ nodes, edges, canvasId: "cv", slot: "gather", name: "gather_wiring", timeline: fx.GATHER_TIMELINE, typecheck: TYPECHECK });
  check(
    "export: the wiring rewrites (flat map derived from a keyframed midlevel, unwired Vector Field, image-as-height) ship",
    r.problems.length === 0 && !!r.files && r.programs.length > 0 && r.programs.every((p) => p.ok) && (!TYPECHECK || r.typecheck.ok),
    [...r.problems, ...r.programs.filter((p) => !p.ok).map((p) => p.detail), r.typecheck.ok ? "" : r.typecheck.output].filter(Boolean).join(" | ")
  );
  if (r.warnings.length) info(`wiring export warnings: ${r.warnings.join(" | ")}`);
  const manifest = r.files?.["manifest.json"] ? JSON.parse(r.files["manifest.json"]) : null;
  const mapBind = manifest?.binds?.find((b: any) => /_3adisplacement_value$/.test(b.path));
  const midBind = manifest?.binds?.find((b: any) => /^root\..*\.nd_midlevel$/.test(b.path));
  check(
    "…the flat map is SAMPLED per frame from the keyframed midlevel, midlevel itself ships as a track",
    mapBind?.kind === "sampled" && /d\.midlevel/.test(mapBind.from ?? "") && midBind?.kind === "track",
    `${mapBind?.kind} (${mapBind?.from}) / ${midBind?.kind}`
  );
}

console.log(`\ncheck-skia-gather: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
