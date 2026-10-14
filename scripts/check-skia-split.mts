// check-skia-split: automatic filter-stage splitting (specdocs/101326_skia-target.md
// §3.3 "built and measured", Wave 3 lane S — engine/skia/split.ts). CanvasKit
// in Node, CPU raster surfaces, no GPU:
//
//   1. one texel helper: `tbx.texel` (tbx_texel_clamp) replaced
//      `tbx.gather.edge` and `tbx.warp.texel`; no registered function names
//      the old ones, every gather / warp that clamps declares the new one;
//   2. the cost model: declared (structural) vs at-params taps and costs;
//   3. the planner on graph shapes, through the real evaluator + Skia Fill:
//      in budget → fused; one split; a chain (two nested layers); fan-out
//      (one layer read by two gathers and by a plain read); off-grid reads →
//      bilinear; a child shader or a second layer blocks a split; a Fill
//      blendMode keeps it fused; the structure and the SkSL hold still while
//      a radius / sample count animates;
//   4. exactness: over an 8-bit-exact upstream, the split draws the SAME
//      bytes as the fused program for every on-grid gather (sharpen ×4,
//      edge ×2, kuwahara, a chain's inner stage); off-grid reads equal a
//      CPU bilinear of the layer; over real noise the split stays within
//      the 8-bit layer's quantization of the fused program (measured bands);
//   5. the Fill's color alpha and opacity scale the filtered output;
//   6. color management: every split program is color-managed, and the
//      split draws the same on a Display P3 surface (layers in P3) as sRGB;
//   7. export: the split fixture's canvases (scripts/fixtures/skia/
//      split-graph.ts) ship through exportSkia with every program compiling
//      to its exact binds, the bundle type-checks (skia-harness), emitted
//      worklets keep the capture order, and skia-harness/src/bundle-split
//      is today's export (`export-skia.mts --fixture split`);
//   8. the readout: units/px before / after for the gather fixture
//      (gather-graph.ts) and the split fixture, pinned per canvas;
//   9. refusals the split does NOT lift (Kuwahara r > 24, Bevel JFA styles).
//
//   npx tsx scripts/check-skia-split.mts [--no-typecheck]

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { SkiaNode, SkiaScene, SkslProgramIR } from "@/engine/skia/scene-ir";
import type { NodeDefinition } from "@/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef, registerNode } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const lib = await import("@/engine/skia/library");
const { TEXEL_HELPER } = await import("@/engine/skia/library/texel");
const { estimateShaderCost, fuseShader, PARAM_TAPS } = await import("@/engine/skia/fuse");
const split = await import("@/engine/skia/split");
const { renderScene } = await import("@/engine/skia/scene-render");
const { SKIA_IR_VERSION, bindStatic } = await import("@/engine/skia/scene-ir");
const { inspectSkiaFillStages } = await import("@/nodes/skia/fill");
const { KUWAHARA_SKIA_MAX_EXTENT } = await import("@/nodes/skia/kuwahara");
const gatherFx = await import("./fixtures/skia/gather-graph.ts");
const splitFx = await import("./fixtures/skia/split-graph.ts");
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

// ---- graphs through the real evaluator -----------------------------------------------

const ctxFor = (w: number, h: number, frame = 0): any => ({
  gl: {}, width: w, height: h, time: frame / 60, frame, tick: frame * 1000, ticksPerFrame: 1000, fps: 60,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
});
function defaults(type: string): Record<string, unknown> {
  const def = getNodeDef(type)!;
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}
const node = (id: string, type: string, over: Record<string, unknown> = {}, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, params: { ...defaults(type), ...over }, ...extra });
const wire = (source: string, target: string, socket: string): GraphEdge => ({ id: `${source}->${target}:${socket}`, source, sourceHandle: "out:primary", target, targetHandle: `in:${socket}` });
const noise = (id = "nz", over: Record<string, unknown> = {}): GraphNode =>
  node(id, "skia-noise", { type: "simplex", scale: 6, octaves: 3, offset_x: 0.3, contrast: 1.2, color_a: "#14233f", color_b: "#ffc94a", ...over });
const fill = (id = "f", over: Record<string, unknown> = {}): GraphNode => node(id, "skia-fill", { color: "#ffffff", opacity: 1, blendMode: "srcOver", ...over });

// Test library functions + nodes. `quant`: a per-pixel hash quantized to
// 8 bits (exactly k/255, opaque) — what an 8-bit layer stores losslessly,
// so a split over it must be byte-exact. `offgrid`: one tap 0.37 / −0.61 px
// off the pixel (an off-grid gather). `leaf`: an image-like child shader.
// Priced like a noise (4) so a 9-tap gather over it goes over budget; the
// heavy copy (12) makes a bilinear (4.2-unit) read worth a layer.
for (const [suffix, cost] of [["", 4], ["_heavy", 12]] as const) {
  lib.registerSkslFunction({
    id: `test.split.quant${suffix}@1`,
    entry: `test_split_quant${suffix}`,
    source: `float4 test_split_quant${suffix}(float2 uv, float2 res) {
  float2 p = floor(uv * res);
  float h = fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
  float3 c = float3(h, fract(h * 7.31), fract(h * 13.7));
  return float4(floor(c * 255.0 + 0.5) / 255.0, 1.0);
}`,
    params: [],
    inputs: [],
    cost,
  });
}
lib.registerSkslFunction({
  id: "test.split.offgrid@1",
  entry: "test_split_offgrid",
  source: `float4 test_split_offgrid(float2 uv, float2 res) {
  float4 a = $src(tbx_texel_clamp(uv + float2(0.37, -0.61) / res, res));
  float4 b = $src(tbx_texel_clamp(uv + float2(-1.25, 0.5) / res, res));
  return 0.5 * (a + b);
}`,
  params: [],
  inputs: [{ name: "src", mode: "gather", taps: 9 }],
  uses: [TEXEL_HELPER],
  cost: 0.1,
});
const testNode = (type: string, compute: NodeDefinition["compute"], inputs: string[] = []): NodeDefinition => ({
  type, name: type, category: "utility", hidden: true, backend: "webgl2",
  inputs: inputs.map((name) => ({ name, type: "skia_shader", required: false })), params: [], primaryOutput: "skia_shader", auxOutputs: [], compute,
});
registerNode(testNode("test-split-quant", ({ nodeId }) => ({ primary: { kind: "skia_shader", expr: { k: "call", fn: "test.split.quant@1", node: nodeId, params: {}, inputs: {} } } })));
registerNode(testNode("test-split-quant-heavy", ({ nodeId }) => ({ primary: { kind: "skia_shader", expr: { k: "call", fn: "test.split.quant_heavy@1", node: nodeId, params: {}, inputs: {} } } })));
registerNode(
  testNode(
    "test-split-offgrid",
    ({ nodeId, inputs }) => ({
      primary: { kind: "skia_shader", expr: { k: "call", fn: "test.split.offgrid@1", node: nodeId, params: {}, inputs: { src: (inputs.image as any)?.expr ?? { k: "leaf", shader: { k: "color", color: bindStatic([0, 0, 0, 0]) } } } } },
    }),
    ["image"]
  )
);
registerNode(testNode("test-split-leaf", () => ({ primary: { kind: "skia_shader", expr: { k: "leaf", shader: { k: "color", color: bindStatic([0.2, 0.6, 0.9, 1]) } } } })));
// An image leaf (lane I: an ImageShader child; its asset rides the shader
// value) and a gradient leaf (lane C lowers it to a color-managed program
// where it is drawn and exported).
const TEX_W = 9;
const TEX_H = 7;
const TEX_URL = (() => {
  const px = new Uint8Array(TEX_W * TEX_H * 4);
  for (let i = 0; i < TEX_W * TEX_H; i++) px.set([(i * 37) % 256, (i * 91) % 256, (i * 13 + 60) % 256, 255], i * 4);
  const img = CK.MakeImage({ width: TEX_W, height: TEX_H, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, px, TEX_W * 4);
  const bytes = img.encodeToBytes() as Uint8Array;
  img.delete();
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
})();
const TEX_ASSET = { id: "split-tex", kind: "image" as const, mime: "image/png", url: TEX_URL, width: TEX_W, height: TEX_H };
registerNode(
  testNode("test-split-image", ({ ctx }) => ({
    primary: {
      kind: "skia_shader",
      expr: { k: "leaf", shader: { k: "image", asset: TEX_ASSET.id, fit: "fill", rect: [bindStatic(0), bindStatic(0), bindStatic(ctx.width), bindStatic(ctx.height)], tile: "clamp" } },
      assets: { [TEX_ASSET.id]: TEX_ASSET },
    } as any,
  }))
);
registerNode(
  testNode("test-split-gradient", ({ ctx }) => ({
    primary: {
      kind: "skia_shader",
      expr: {
        k: "leaf",
        shader: {
          k: "linear",
          start: [bindStatic(0), bindStatic(0)],
          end: [bindStatic(ctx.width), bindStatic(ctx.height)],
          stops: [
            { pos: bindStatic(0), color: bindStatic([0.9, 0.1, 0.2, 1]) },
            { pos: bindStatic(1), color: bindStatic([0.1, 0.3, 0.95, 1]) },
          ],
        },
      },
    },
  }))
);

interface FillOut {
  node: SkiaNode;
  problems: string[];
  report: ReturnType<typeof inspectSkiaFillStages>;
  expr: ShaderExpr | null;
  assets?: Record<string, unknown>;
}
function evalFill(nodes: GraphNode[], edges: GraphEdge[], fillId = "f", w = 64, h = 48, frame = 0): FillOut {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ctx = ctxFor(w, h, frame);
    const r = evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, null, undefined, null, { extraTargets: [fillId] });
    const v = r.outputs.get(fillId)?.primary as any;
    if (v?.kind !== "skia_draw") throw new Error(`${fillId} produced ${v?.kind ?? "nothing"}${r.errors[fillId] ? `: ${r.errors[fillId]}` : ""}`);
    const shaderEdge = edges.find((e) => e.target === fillId && e.targetHandle === "in:shader");
    const sv = shaderEdge ? (r.outputs.get(shaderEdge.source)?.primary as any) : null;
    return { node: v.node, problems: v.problems ?? [], report: inspectSkiaFillStages(ctx, fillId), expr: sv?.expr ?? null, ...(v.assets ? { assets: v.assets } : {}) };
  } finally {
    console.warn = warn;
  }
}

// The fused (unsplit) Fill a split replaced: same paint, the whole shader.
function fusedFill(out: FillOut, w: number, h: number, paint: Record<string, unknown> = {}): SkiaNode {
  const r = fuseShader(out.expr!, { resolution: [w, h], time: 0 });
  if (!r.shader) throw new Error(r.problems.join(" | "));
  return { k: "fill", paint: { style: "fill", shader: r.shader, ...paint } } as SkiaNode;
}

const shapeOf = (n: SkiaNode): string =>
  n.k === "group" ? `group[${(n.layer?.imageFilters ?? []).map((f) => f.k).join(",")}](${n.children.map(shapeOf).join(",")})` : n.k === "fill" ? `fill${n.paint.blendMode ? `:${n.paint.blendMode}` : ""}` : n.k;
const filterPrograms = (n: SkiaNode): SkslProgramIR[] =>
  n.k === "group" ? [...(n.layer?.imageFilters ?? []).flatMap((f) => (f.k === "runtime" ? [f.program] : [])), ...n.children.flatMap(filterPrograms)] : [];
const fillPrograms = (n: SkiaNode): SkslProgramIR[] =>
  n.k === "group" ? n.children.flatMap(fillPrograms) : n.k === "fill" && n.paint.shader?.k === "runtime" ? [n.paint.shader.program] : [];
const childDecls = (sksl: string) => [...sksl.matchAll(/\buniform\s+shader\s+(\w+)\s*;/g)].map((m) => m[1]);

// ---- rendering on CanvasKit CPU surfaces ------------------------------------------------

const SRGB = CK.ColorSpace.SRGB;
const P3 = CK.ColorSpace.DISPLAY_P3;
// Straight-alpha RGBA8 sRGB, row 0 = top.
const decoded = new Map<string, any>();
const resolveAsset = (id: string, _kind: string, asset: any) => {
  if (!decoded.has(id)) {
    const m = typeof asset?.url === "string" ? /^data:[^;]+;base64,(.*)$/.exec(asset.url) : null;
    decoded.set(id, m ? CK.MakeImageFromEncoded(Buffer.from(m[1], "base64")) : null);
  }
  return decoded.get(id);
};
function render(
  root: SkiaNode,
  w: number,
  h: number,
  o: { p3?: boolean; background?: [number, number, number, number]; assets?: Record<string, unknown> } = {}
): { px: Uint8Array; problems: string[] } {
  const base = CK.MakeSurface(1, 1);
  const surf = o.p3
    ? base.makeSurface({ width: w, height: h, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: P3 })
    : CK.MakeSurface(w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const scene: SkiaScene = { version: SKIA_IR_VERSION, width: w, height: h, root, assets: (o.assets ?? {}) as SkiaScene["assets"], ...(o.background ? { background: o.background } : {}) };
  const r = renderScene(CK, canvas, scene, { ...(o.p3 ? { layerFormat: { colorSpace: P3 } } : {}), assets: resolveAsset as any });
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = new Uint8Array(img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: SRGB }) as Uint8Array);
  r.release();
  img.delete();
  surf.delete();
  base.delete();
  return { px, problems: r.problems };
}
function diff(a: Uint8Array, b: Uint8Array): { max: number; mean: number; identical: number; p99: number } {
  let max = 0;
  let sum = 0;
  let same = 0;
  const worst: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      sum += d;
      if (d > px) px = d;
    }
    worst.push(px);
    if (px === 0) same++;
    if (px > max) max = px;
  }
  worst.sort((x, y) => x - y);
  return { max, mean: sum / a.length, identical: same / (a.length / 4), p99: worst[Math.floor(worst.length * 0.99)] ?? 0 };
}
const fmt = (d: { max: number; mean: number; identical: number }) => `max ${d.max}/255, mean ${d.mean.toFixed(3)}/255, ${(d.identical * 100).toFixed(1)}% identical`;

// ---- 1. one texel helper ------------------------------------------------------------------
{
  check("tbx.texel is registered (tbx_texel_clamp); tbx.gather.edge and tbx.warp.texel are gone", !!lib.getSkslHelper(TEXEL_HELPER) && !lib.getSkslHelper("tbx.gather.edge") && !lib.getSkslHelper("tbx.warp.texel"));
  const fns = lib.allSkslFunctions();
  const stale = fns.filter((f) => /tbx_gather_edge_uv|tbx_warp_texel/.test(f.source)).map((f) => f.id);
  check("no registered function calls tbx_gather_edge_uv / tbx_warp_texel", stale.length === 0, stale.join());
  const users = fns.filter((f) => /\btbx_texel_clamp\s*\(/.test(f.source));
  const undeclared = users.filter((f) => !(f.uses ?? []).includes(TEXEL_HELPER)).map((f) => f.id);
  check(`every function calling tbx_texel_clamp lists ${TEXEL_HELPER} in uses (${users.length} functions)`, users.length > 0 && undeclared.length === 0, undeclared.join());
  const want = [
    "tbx.displace@1", "tbx.chromatic_aberration@1", "tbx.sharpen@1", "tbx.edge_detect@1", "tbx.bevel_emboss.emboss@1",
    "tbx.vector_field.image@1", "tbx.flow_blur@1", "tbx.kuwahara@1", "tbx.split.bilinear@1",
  ];
  const warps = users.filter((f) => /^tbx\.(transform|mirror|polar|pixelate|array)/.test(f.id)).map((f) => f.id);
  const missing = want.filter((id) => !users.some((f) => f.id === id));
  check(`the gathers, the warps (${warps.length}: ${warps.join(", ")}) and the splitter share it`, missing.length === 0 && warps.length >= 5, `missing ${missing.join()}`);
  // Its semantics: clamp to the outermost texel centres.
  const probe = fuseShader({ k: "call", fn: "test.split.offgrid@1", node: "o", params: {}, inputs: { src: { k: "call", fn: "test.split.quant@1", node: "q", params: {}, inputs: {} } } }, { resolution: [16, 16], time: 0 });
  check("a program using it compiles in CanvasKit", !!probe.shader && probe.shader.k === "runtime" && !!CK.RuntimeEffect.Make(probe.shader.program.sksl));
}

// ---- 1b. which outputs a layer can hold ------------------------------------------------------
// The splitter never renders an `unbounded` function's output into a layer
// (an 8-bit color image clips it). Audit every Skia shader node at its
// defaults over a noise on each shader socket, reading main's straight value
// raw on an F32 surface: a node that leaves [0, 1] there must flag its
// function `unbounded`, and a flagged one must really leave it.
{
  const { allNodeDefs } = await import("@/engine/registry");
  const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
  const RW = 48;
  const base = CK.MakeSurface(1, 1);
  const rows: string[] = [];
  const wrong: string[] = [];
  for (const d of allNodeDefs().filter((x) => x.type.startsWith("skia-") && x.primaryOutput === "skia_shader")) {
    const over = d.type === "skia-bevel-emboss" ? { style: "emboss" } : d.type === "skia-dither" ? { algorithm: "ordered" } : {};
    const nodes = [noise(), node("p", d.type, over)];
    const edges = d.inputs.filter((i) => i.type === "skia_shader").map((i) => wire("nz", "p", i.name));
    const warn = console.warn;
    console.warn = () => {};
    let v: any;
    try {
      v = evaluateGraph(nodes, edges, ctxFor(RW, RW), new Map() as EvalCache, null, undefined, null, { extraTargets: ["p"] }).outputs.get("p")?.primary;
    } finally {
      console.warn = warn;
    }
    if (v?.kind !== "skia_shader" || v.problems?.length || v.expr?.k !== "call") continue;
    const r = fuseShader(v.expr, { resolution: [RW, RW], time: 0 });
    if (!r.shader || r.shader.k !== "runtime" || r.shader.program.children.length) continue;
    // main's straight result, affinely packed into [0, 1] (−1.5 … 2.5).
    const sksl = r.shader.program.sksl.replace("return tbx_cm_out(c);", "return half4(c.rgb * 0.25 + 0.375, 1.0);");
    const c = compileSksl(CK, sksl);
    if (!c.effect) continue;
    const values: Record<string, number | number[]> = {};
    for (const [k, b] of Object.entries(r.shader.program.uniforms)) values[k] = b.v;
    const shader = c.effect.makeShader(packUniforms(c.effect, values));
    const surf = base.makeSurface({ width: RW, height: RW, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: SRGB });
    const p = new CK.Paint();
    p.setShader(shader);
    p.setBlendMode(CK.BlendMode.Src);
    surf.getCanvas().drawPaint(p);
    surf.flush();
    const img = surf.makeImageSnapshot();
    const f = (img.readPixels(0, 0, { width: RW, height: RW, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: SRGB }) as Float32Array).slice(0, RW * RW * 4);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < f.length; i += 4) for (let k = 0; k < 3; k++) {
      const x = (f[i + k] - 0.375) / 0.25;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    const out = lo < -2e-3 || hi > 1 + 2e-3;
    const flagged = !!lib.getSkslFunction(v.expr.fn)?.unbounded;
    if (out !== flagged) wrong.push(`${d.type} (${v.expr.fn}): [${lo.toFixed(3)}, ${hi.toFixed(3)}]${flagged ? " flagged" : " not flagged"}`);
    if (out) rows.push(`${d.type} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`);
    for (const o of [img, surf, p, shader]) o.delete();
  }
  base.delete();
  check("range audit: exactly the shader nodes that leave [0, 1] at their defaults flag their function `unbounded` (never a layer)", wrong.length === 0 && rows.length > 0, wrong.length ? wrong.join("; ") : rows.join(", "));
}

// ---- 2. the cost model --------------------------------------------------------------------
{
  const kuw = (radius: number) => ({ k: "call", fn: "tbx.kuwahara@1", node: "k", params: Object.fromEntries(["radius", "mode", "sharpness", "hardness", "anisotropy", "min_coherence", "opacity"].map((p) => [p, bindStatic(p === "radius" ? radius : 1)])), inputs: { src: { k: "call", fn: "test.split.quant@1", node: "q", params: {}, inputs: {} }, field: { k: "call", fn: "tbx.const@1", node: "c", params: { color: bindStatic([0, 0, 0, 0]) }, inputs: {} } } }) as ShaderExpr;
  const at = (e: ShaderExpr, mode: "declared" | "params", nodeId = "q") => estimateShaderCost(e, { at: mode }).nodes.find((n) => n.node === nodeId)?.evaluations;
  check(`declared (structural) taps: a "param" gather counts ${PARAM_TAPS}, whatever the radius`, at(kuw(3), "declared") === PARAM_TAPS && at(kuw(24), "declared") === PARAM_TAPS);
  check("at params: Kuwahara's upstream is evaluated once per disc lattice point (29 at r 3, 113 at r 6)", at(kuw(3), "params") === 29 && at(kuw(6), "params") === 113, `${at(kuw(3), "params")} / ${at(kuw(6), "params")}`);
  check("…and the declared default is unchanged (estimateShaderCost(expr) ≡ at: declared)", estimateShaderCost(kuw(6)).cost === estimateShaderCost(kuw(6), { at: "declared" }).cost);
  info(`cost of Kuwahara over a 4-unit upstream: declared ${estimateShaderCost(kuw(6)).cost.toFixed(1)}, at r 6 ${estimateShaderCost(kuw(6), { at: "params" }).cost.toFixed(1)}, at r 24 ${estimateShaderCost(kuw(24), { at: "params" }).cost.toFixed(1)} units/px (budget ${split.PHONE_PIXEL_BUDGET}, layer ${split.SPLIT_LAYER_COST})`);
}

// ---- 3. the planner on graph shapes ----------------------------------------------------------
const W = 64;
const H = 48;
const shapes: Record<string, FillOut> = {};
{
  const g = (extra: GraphNode[], edges: GraphEdge[]) => ({ nodes: [noise(), fill(), ...extra], edges: [...edges] });
  // a. in budget: noise alone, and a cheap gather (displace 1 tap).
  {
    const a = evalFill([noise(), fill()], [wire("nz", "f", "shader")]);
    check("in budget (Noise alone): a plain fill, nothing split", a.node.k === "fill" && a.report?.layers === 0 && a.report?.stages.length === 1, shapeOf(a.node));
  }
  // b. one split: Sharpen over noise.
  {
    const { nodes, edges } = g([node("s", "skia-sharpen", { algorithm: "unsharp", amount: 1.5 })], [wire("nz", "s", "image"), wire("s", "f", "shader")]);
    const b = evalFill(nodes, edges);
    shapes.sharpen = b;
    const fp = filterPrograms(b.node);
    const f0 = b.node.k === "group" ? b.node.layer!.imageFilters![0] : null;
    check("Sharpen over noise (36.2 units) splits once: group[runtime](fill:src)", shapeOf(b.node) === "group[runtime](fill:src)" && b.report?.layers === 1, shapeOf(b.node));
    check(
      "…the filter program declares ONE child, the IR's `content` names it, and lists no children (RN binds the layer as the only child)",
      fp.length === 1 && childDecls(fp[0].sksl).length === 1 && f0?.k === "runtime" && f0.content === childDecls(fp[0].sksl)[0] && fp[0].children.length === 0
    );
    check("…the noise renders once, in the layer's own program; the filter has sharpen + the Fill's paint, no noise", !!fp[0].fused?.includes("tbx.sharpen@1") && !!fp[0].fused?.includes("tbx.split.paint@1") && !fp[0].fused?.some((f) => f.startsWith("tbx.noise")) && fillPrograms(b.node)[0]?.fused?.some((f) => f.startsWith("tbx.noise")) === true);
    check("…on-grid taps read the layer directly (no bilinear)", !/tbx_split_bilinear/.test(fp[0].sksl) && b.report?.stages.every((s) => !s.bilinear) === true);
    check("…every IR node is the Fill's (id)", b.node.id === "f" && b.node.k === "group" && b.node.children[0].id === "f");
    check("…cost 36.2 → 15.2 units/px (4 + 9.2 + one layer)", Math.abs((b.report?.before.declared ?? 0) - 36.2) < 1e-6 && Math.abs((b.report?.after.declared ?? 0) - 15.2) < 1e-6, `${b.report?.before.declared} → ${b.report?.after.declared}`);
  }
  // c. chain: Edge(Kuwahara(noise)) — two nested layers.
  {
    const { nodes, edges } = g(
      [node("k", "skia-kuwahara", { mode: "generalized", radius: 3, sharpness: 6, hardness: 10, opacity: 1 }), node("e", "skia-edge-detect", { strength: 2 })],
      [wire("nz", "k", "image"), wire("k", "e", "image"), wire("e", "f", "shader")]
    );
    const c = evalFill(nodes, edges);
    shapes.chain = c;
    const fp = filterPrograms(c.node);
    check("a chain Edge(Kuwahara(noise)) splits twice, nested: group[runtime](group[runtime](fill:src))", shapeOf(c.node) === "group[runtime](group[runtime](fill:src))" && c.report?.layers === 2, shapeOf(c.node));
    check("…outer filter = edge detect, inner = kuwahara, innermost fill = noise", !!fp[0]?.fused?.includes("tbx.edge_detect@1") && !fp[0].fused.includes("tbx.kuwahara@1") && !!fp[1]?.fused?.includes("tbx.kuwahara@1") && !fp[1].fused.some((f) => f.startsWith("tbx.noise")));
    check("…only the outermost filter carries the Fill's paint", !!fp[0]?.fused?.includes("tbx.split.paint@1") && !fp[1]?.fused?.includes("tbx.split.paint@1"));
    check("…and the Kuwahara stage says it stays over budget (its own ALU, no upstream left to split)", (c.report?.notes ?? []).some((m) => /^a stage: 179\.0 units\/px/.test(m)), c.report?.notes.join(" | "));
  }
  // c2. a gather over an OVERSHOOTING upstream: Edge(Sharpen(noise)). A layer
  // would clip the sharpen, so the noise is staged instead.
  {
    const { nodes, edges } = g(
      [node("s", "skia-sharpen", { algorithm: "box", amount: 1 }), node("e", "skia-edge-detect", { strength: 2 })],
      [wire("nz", "s", "image"), wire("s", "e", "image"), wire("e", "f", "shader")]
    );
    const c = evalFill(nodes, edges);
    shapes.overshoot = c;
    const fp = filterPrograms(c.node);
    check(
      "Edge(Sharpen(noise)): Sharpen's output can leave [0, 1], so it is never a layer — the noise is staged, sharpen + edge share the filter",
      shapeOf(c.node) === "group[runtime](fill:src)" && !!fp[0]?.fused?.includes("tbx.sharpen@1") && !!fp[0].fused.includes("tbx.edge_detect@1") && (c.report?.notes ?? []).some((m) => /skipped a split not at s: its output can leave \[0, 1\]/.test(m)),
      `${shapeOf(c.node)} | ${c.report?.notes.join(" | ")}`
    );
  }
  // d. fan-out: Merge(Sharpen(N), Edge(N)) — one layer, two gathers.
  {
    const layers = [{ id: "L", mode: "screen", opacity: 0.8 }];
    const { nodes, edges } = g(
      [node("s", "skia-sharpen"), node("e", "skia-edge-detect"), node("m", "skia-merge", { layers })],
      [wire("nz", "s", "image"), wire("nz", "e", "image"), wire("s", "m", "base"), wire("e", "m", "layer:L"), wire("m", "f", "shader")]
    );
    const d = evalFill(nodes, edges);
    shapes.fan = d;
    const fp = filterPrograms(d.node);
    check("fan-out Merge(Sharpen(N), Edge(N)): ONE layer of N read by both gathers", shapeOf(d.node) === "group[runtime](fill:src)" && fp.length === 1 && !!fp[0].fused?.includes("tbx.sharpen@1") && !!fp[0].fused.includes("tbx.edge_detect@1") && childDecls(fp[0].sksl).length === 1, shapeOf(d.node));
  }
  // e. a plain read of the split upstream comes from the layer too.
  {
    const layers = [{ id: "L", mode: "multiply", opacity: 1 }];
    const { nodes, edges } = g(
      [node("s", "skia-sharpen", { amount: 2 }), node("m", "skia-merge", { layers })],
      [wire("nz", "s", "image"), wire("s", "m", "base"), wire("nz", "m", "layer:L"), wire("m", "f", "shader")]
    );
    const e = evalFill(nodes, edges);
    shapes.pure = e;
    const fp = filterPrograms(e.node);
    check("Merge(Sharpen(N), N): the merge's plain read of N is the layer too (no noise in the filter)", fp.length === 1 && !fp[0].fused?.some((f) => f.startsWith("tbx.noise")), fp[0]?.fused?.join());
  }
  // f. off-grid: Flow Blur over a field from Vector Field(noise) → bilinear.
  {
    const nodes = [noise(), noise("nb", { seed: 9, scale: 3 }), node("vf", "skia-vector-field", { mode: "orbit", radius: 0.03 }), node("fb", "skia-flow-blur", { mode: "velocity", samples: 12 }), fill()];
    const edges = [wire("nb", "vf", "source"), wire("nz", "fb", "image"), wire("vf", "fb", "field"), wire("fb", "f", "shader")];
    const f = evalFill(nodes, edges);
    shapes.flow = f;
    const fp = filterPrograms(f.node);
    check("Flow Blur with a Vector Field(noise) field: the field renders into the layer, read bilinearly (off-grid walk)", shapeOf(f.node) === "group[runtime](fill:src)" && /tbx_split_bilinear/.test(fp[0]?.sksl ?? "") && f.report?.stages.some((s) => s.bilinear) === true && !!fillPrograms(f.node)[0]?.fused?.includes("tbx.vector_field.image@1"), shapeOf(f.node));
    check("…the image (a 4-unit noise, cheaper than a 4.2-unit bilinear read) stays fused in the filter", !!fp[0]?.fused?.some((x) => x.startsWith("tbx.noise")));
    // Flow Blur over two plain noises: no split saves anything.
    const n2 = evalFill([noise(), noise("nb", { seed: 9 }), node("fb", "skia-flow-blur", { mode: "tangent" }), fill()], [wire("nz", "fb", "image"), wire("nb", "fb", "field"), wire("fb", "f", "shader")]);
    check("Flow Blur over two plain noises stays fused (over budget, nothing saves) and says so", n2.node.k === "fill" && (n2.report?.notes ?? []).some((m) => /no split saves anything/.test(m)), n2.report?.notes.join(" | "));
  }
  // g. a child shader outside the upstream blocks the split.
  {
    const layers = [{ id: "L", mode: "screen", opacity: 1 }];
    const { nodes, edges } = g(
      [node("s", "skia-sharpen"), node("lf", "test-split-leaf"), node("m", "skia-merge", { layers })],
      [wire("nz", "s", "image"), wire("s", "m", "base"), wire("lf", "m", "layer:L"), wire("m", "f", "shader")]
    );
    const gg = evalFill(nodes, edges);
    check("a child shader the filter would keep (an image-like leaf) blocks the split: fused, with the reason", gg.node.k === "fill" && (gg.report?.notes ?? []).some((m) => /only child is the layer/.test(m)), gg.report?.notes.join(" | "));
    // …but a child INSIDE the upstream is fine (it moves into the layer's program).
    const { nodes: n2, edges: e2 } = g(
      [node("lf", "test-split-leaf"), node("m", "skia-merge", { layers }), node("s", "skia-sharpen")],
      [wire("nz", "m", "base"), wire("lf", "m", "layer:L"), wire("m", "s", "image"), wire("s", "f", "shader")]
    );
    const g2 = evalFill(n2, e2);
    const inner = fillPrograms(g2.node)[0];
    check("…while a child inside the split upstream moves into the layer's program", shapeOf(g2.node) === "group[runtime](fill:src)" && (inner?.children.length ?? 0) === 1, shapeOf(g2.node));
  }
  // h. two independent expensive upstreams: one layer only.
  {
    const layers = [{ id: "L", mode: "screen", opacity: 1 }];
    const { nodes, edges } = g(
      [noise("n2", { seed: 11 }), node("s1", "skia-sharpen"), node("s2", "skia-sharpen"), node("m", "skia-merge", { layers })],
      [wire("nz", "s1", "image"), wire("n2", "s2", "image"), wire("s1", "m", "base"), wire("s2", "m", "layer:L"), wire("m", "f", "shader")]
    );
    const hh = evalFill(nodes, edges);
    check("two independent over-budget gathers: one is staged (a filter reads ONE layer), the other stays fused", shapeOf(hh.node) === "group[runtime](fill:src)" && (hh.report?.stages.at(-1)?.declared ?? 0) > split.PHONE_PIXEL_BUDGET, `${shapeOf(hh.node)} ${hh.report?.stages.map((s) => s.declared.toFixed(1)).join(" / ")}`);
  }
  // i. a Fill with its own blend mode stays fused.
  {
    const { nodes, edges } = g([node("s", "skia-sharpen")], [wire("nz", "s", "image"), wire("s", "f", "shader")]);
    nodes[1] = fill("f", { blendMode: "multiply" });
    const i = evalFill(nodes, edges);
    check("a Fill with blendMode multiply stays fused (a layer composites srcOver) and says so", i.node.k === "fill" && (i.report?.notes ?? []).some((m) => /blendMode multiply/.test(m)), i.report?.notes.join(" | "));
  }
  // k. image leaves (lane I) and gradient leaves (lane C) inside the split
  // upstream: they move into the layer's own fill program (its children),
  // the image's asset still rides the draw value, the gradient is lowered
  // to its color-managed program where it is drawn — and the split draws
  // what the fused Fill draws.
  for (const [label, leafType] of [["an image leaf", "test-split-image"], ["a gradient leaf", "test-split-gradient"]] as const) {
    const layers = [{ id: "L", mode: "overlay", opacity: 0.7 }];
    const { nodes, edges } = g(
      [node("lf", leafType), node("m", "skia-merge", { layers }), node("s", "skia-sharpen", { algorithm: "unsharp", amount: 1 })],
      [wire("nz", "m", "base"), wire("lf", "m", "layer:L"), wire("m", "s", "image"), wire("s", "f", "shader")]
    );
    const k = evalFill(nodes, edges);
    shapes[leafType] = k;
    const inner = fillPrograms(k.node)[0];
    const kid = inner?.children[0]?.shader.k;
    const wantKid = leafType === "test-split-image" ? "image" : "linear";
    const assetsOk = leafType === "test-split-image" ? !!k.assets?.[TEX_ASSET.id] : !k.assets;
    const a = render(k.node, W, H, { assets: k.assets });
    const b = render(fusedFill(k, W, H), W, H, { assets: k.assets });
    const d = diff(a.px, b.px);
    check(
      `Sharpen over Merge(noise, ${label}): split, the leaf a child of the layer's fill program (${wantKid}), ${leafType === "test-split-image" ? "its asset on the staged draw value" : "no asset"}, drawn as the fused Fill within the kernel's rounding (≤ 3/255)`,
      shapeOf(k.node) === "group[runtime](fill:src)" && kid === wantKid && filterPrograms(k.node)[0]?.children.length === 0 && assetsOk && a.problems.length === 0 && d.max <= 3,
      `${shapeOf(k.node)} child ${kid} assets ${Object.keys(k.assets ?? {}).join() || "none"} ${fmt(d)}${a.problems.length ? ` | ${a.problems.join(" | ")}` : ""}`
    );
  }
  // j. structural: animated radius / samples never change the structure or the SkSL.
  {
    const g2 = gatherFx.gatherGraph();
    const frames = [0, 40, 80, 120];
    const unstable: string[] = [];
    for (const id of ["f_kuw", "f_fb", "f_bev", "f_shp"]) {
      const outs = frames.map((fr) => evalFill(g2.nodes, g2.edges, id, 128, 128, fr));
      const s0 = shapeOf(outs[0].node);
      const p0 = [...filterPrograms(outs[0].node), ...fillPrograms(outs[0].node)].map((p) => p.sksl).join("\n");
      for (const o of outs.slice(1)) {
        const p = [...filterPrograms(o.node), ...fillPrograms(o.node)].map((x) => x.sksl).join("\n");
        if (shapeOf(o.node) !== s0 || p !== p0) unstable.push(id);
      }
    }
    check("structural: Kuwahara's animated radius (3 → 7), Flow Blur's length, Bevel's feather and Sharpen's amount never change a split's structure or SkSL (frames 0/40/80/120)", unstable.length === 0, unstable.join());
  }
}

// ---- 4. exactness ------------------------------------------------------------------------------
{
  // Over the 8-bit-exact upstream every on-grid gather must reproduce the
  // fused program byte for byte (the layer holds exactly what the fused
  // program re-evaluated at each texel centre, edges clamped alike).
  const onGrid: [string, string, Record<string, unknown>][] = [
    ["sharpen box", "skia-sharpen", { algorithm: "box", amount: 1.5 }],
    ["sharpen diamond", "skia-sharpen", { algorithm: "diamond", amount: 0.8 }],
    ["sharpen cross", "skia-sharpen", { algorithm: "cross", amount: 2 }],
    ["sharpen unsharp", "skia-sharpen", { algorithm: "unsharp", amount: 1.2 }],
    ["edge sobel", "skia-edge-detect", { algorithm: "sobel", strength: 3, threshold: 0.05 }],
    ["edge prewitt", "skia-edge-detect", { algorithm: "prewitt", strength: 2, threshold: 0 }],
    ["kuwahara r 3", "skia-kuwahara", { mode: "generalized", radius: 3, sharpness: 6, hardness: 10, opacity: 1 }],
  ];
  const rows: string[] = [];
  let worst = 0;
  for (const [label, type, params] of onGrid) {
    const nodes = [node("q", "test-split-quant"), node("k", type, params), fill()];
    const edges = [wire("q", "k", "image"), wire("k", "f", "shader")];
    const out = evalFill(nodes, edges, "f", W, H);
    if (out.node.k !== "group") {
      rows.push(`${label}: NOT SPLIT`);
      worst = 999;
      continue;
    }
    const a = render(out.node, W, H);
    const b = render(fusedFill(out, W, H), W, H);
    const d = diff(a.px, b.px);
    worst = Math.max(worst, d.max, a.problems.length ? 999 : 0);
    rows.push(`${label} ${d.max}`);
  }
  check(`on-grid gathers over an 8-bit-exact upstream: split ≡ fused, byte for byte (${W}×${H}, edges included)`, worst === 0, rows.join(", "));

  // Off-grid: the bilinear read equals a CPU bilinear of the layer bytes.
  {
    const nodes = [node("q", "test-split-quant-heavy"), node("o", "test-split-offgrid"), fill()];
    const out = evalFill(nodes, [wire("q", "o", "image"), wire("o", "f", "shader")], "f", W, H);
    const fp = filterPrograms(out.node);
    const a = render(out.node, W, H);
    const layer = render({ k: "fill", paint: { style: "fill", shader: fuseShader({ k: "call", fn: "test.split.quant_heavy@1", node: "q", params: {}, inputs: {} }, { resolution: [W, H], time: 0 }).shader! } } as SkiaNode, W, H).px;
    // Texel (i, j) with j counted from the BOTTOM (uv is Y-up).
    const tex = (i: number, j: number, c: number) => layer[((H - 1 - Math.min(H - 1, Math.max(0, j))) * W + Math.min(W - 1, Math.max(0, i))) * 4 + c] / 255;
    const clampUv = (u: number, n: number) => Math.min(1 - 0.5 / n, Math.max(0.5 / n, u));
    const bil = (u: number, v: number, c: number) => {
      const px = Math.min(W - 1, Math.max(0, clampUv(u, W) * W - 0.5));
      const py = Math.min(H - 1, Math.max(0, clampUv(v, H) * H - 0.5));
      const i = Math.floor(px), j = Math.floor(py), fx = px - i, fy = py - j;
      const i1 = Math.min(i + 1, W - 1), j1 = Math.min(j + 1, H - 1);
      const top = tex(i, j, c) * (1 - fx) + tex(i1, j, c) * fx;
      const bot = tex(i, j1, c) * (1 - fx) + tex(i1, j1, c) * fx;
      return top * (1 - fy) + bot * fy;
    };
    let max = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, v = 1 - (y + 0.5) / H;
        for (let c = 0; c < 3; c++) {
          const want = 0.5 * (bil(u + 0.37 / W, v - 0.61 / H, c) + bil(u - 1.25 / W, v + 0.5 / H, c));
          max = Math.max(max, Math.abs(a.px[(y * W + x) * 4 + c] - want * 255));
        }
      }
    }
    check("off-grid taps read the layer bilinearly from texel centres (tbx.split.bilinear@1) ≡ a CPU bilinear of the layer's bytes, edges clamped", shapeOf(out.node) === "group[runtime](fill:src)" && /tbx_split_bilinear/.test(fp[0]?.sksl ?? "") && max <= 0.51, `max |Δ| ${max.toFixed(3)}/255`);
  }

  // Over real noise the split differs from the fused program by the layer's
  // 8-bit rounding (≤ ½ step per tap) times the kernel's L1 norm, plus the
  // output's own rounding: bound = ceil(½ · Σ|w|) + 1 steps.
  //   sharpen unsharp 1.5   Σ|w| = 2.125 + 4·0.1875 + 4·0.09375 = 3.25 → 3
  //   sharpen box 2 × N     Σ|w| = 9 + 8 = 17, + N's own ½            → 10
  //   screen(box 1, sobel)  4.5 + √2·4 (sobel, strength 1)           → 12
  const cases: [string, FillOut, number][] = [
    ["sharpen unsharp 1.5", shapes.sharpen, 3],
    ["merge multiply(sharpen box 2 (N), N)", shapes.pure, 10],
    ["fan: merge screen(sharpen box (N), edge sobel (N))", shapes.fan, 12],
  ];
  for (const [label, out, band] of cases) {
    const a = render(out.node, W, H);
    const b = render(fusedFill(out, W, H), W, H);
    const d = diff(a.px, b.px);
    check(`${label} over noise: split vs fused within the 8-bit layer's rounding × the kernel (≤ ${band}/255)`, d.max <= band && a.problems.length === 0, `${fmt(d)}${a.problems.length ? ` | ${a.problems.join(" | ")}` : ""}`);
  }
  // Chains amplify a layer's rounding through every kernel after it, so
  // they are held to their mean and 99th percentile (max reported):
  //   Edge(Kuwahara(N))  the kuwahara layer's ½ step into a Sobel at
  //                      strength 2 (√2·8·2 ≈ 23 → 11 steps), worst case;
  //   Edge(Sharpen(N))   one layer (N): ½ × box 9 × Sobel 23 ≈ 101 steps
  //                      worst case — and NOT the sharpen's own layer, which
  //                      would clip its overshoot: measured that way, 1 % of
  //                      pixels were ≥ 42/255 off (max 144).
  for (const [label, out, mean, p99] of [
    ["chain Edge(Kuwahara r 3 (N))", shapes.chain, 1, 6],
    ["Edge(Sharpen box (N)), the noise staged", shapes.overshoot, 1, 12],
  ] as const) {
    const a = render(out.node, W, H);
    const b = render(fusedFill(out, W, H), W, H);
    const d = diff(a.px, b.px);
    check(`${label} over noise: mean ≤ ${mean}/255 and 99 % of pixels within ${p99}/255 of the fused program`, d.mean <= mean && d.p99 <= p99 && a.problems.length === 0, `${fmt(d)}, p99 ${d.p99}/255`);
  }
}

// ---- 5. the Fill's paint on the filtered output -------------------------------------------------
{
  const nodes = [noise(), node("s", "skia-sharpen", { algorithm: "unsharp", amount: 1 }), fill("f", { color: "#ffffffcc", opacity: 0.5 })];
  const edges = [wire("nz", "s", "image"), wire("s", "f", "shader")];
  const out = evalFill(nodes, edges, "f", W, H);
  const paint = { color: { v: [1, 1, 1, 0.8] }, opacity: { v: 0.5 } };
  const a = render(out.node, W, H);
  const b = render(fusedFill(out, W, H, paint), W, H);
  const d = diff(a.px, b.px);
  const alpha = a.px[3];
  check("color alpha 0.8 × opacity 0.5 fade the filtered result (split ≡ fused within the layer's quantization)", out.node.k === "group" && Math.abs(alpha - 102) <= 1 && d.max <= 3, `alpha ${alpha}, ${fmt(d)}`);
  const bg: [number, number, number, number] = [0.1, 0.4, 0.2, 1];
  const a2 = render(out.node, W, H, { background: bg });
  const b2 = render(fusedFill(out, W, H, paint), W, H, { background: bg });
  check("…and composite srcOver over what is drawn below", diff(a2.px, b2.px).max <= 3, fmt(diff(a2.px, b2.px)));
}

// ---- 6. color management -------------------------------------------------------------------
{
  const all = Object.values(shapes).flatMap((o) => [...filterPrograms(o.node), ...fillPrograms(o.node)]);
  const unmanaged = all.filter((p) => !lib.isColorManagedSksl(p.sksl));
  check(`every split program (${all.length}) is color-managed (tbx_cm_child in, tbx_cm_out out)`, all.length > 0 && unmanaged.length === 0);
  const wrapperOk = filterPrograms(shapes.chain.node).every((p) => /tbx_cm_child\(float4\(s\d+\.eval/.test(p.sksl));
  check("…filters read the layer through tbx_cm_child (working space → sRGB)", wrapperOk);
  // An 8-bit P3 layer rounds in P3's encoding, not sRGB's, so the split's
  // intermediate differs by up to one P3 step (coarser than sRGB's in
  // saturated darks), amplified by the kernel like §4's bands.
  for (const [label, out] of [["sharpen", shapes.sharpen], ["flow (bilinear)", shapes.flow]] as const) {
    const a = render(out.node, W, H);
    const p3 = render(out.node, W, H, { p3: true });
    const d = diff(a.px, p3.px);
    check(`${label}: on a Display P3 F32 surface with 8-bit P3 layers the split draws what sRGB does, within the P3 layer's rounding × the kernel (≤ 6/255)`, d.max <= 6 && p3.problems.length === 0, fmt(d));
  }
  {
    const a = render(shapes.chain.node, W, H);
    const p3 = render(shapes.chain.node, W, H, { p3: true });
    const d = diff(a.px, p3.px);
    check("chain on Display P3: mean ≤ 2/255 and 99% of pixels within 24/255 of sRGB (two high-pass stages amplify the P3 layers' rounding)", d.mean <= 2 && d.p99 <= 24 && p3.problems.length === 0, `${fmt(d)}, p99 ${d.p99}/255`);
  }
}

// ---- 7. export -----------------------------------------------------------------------------------
{
  const g = splitFx.splitGraph();
  const timeline = { ...splitFx.SPLIT_TIMELINE, markers: splitFx.SPLIT_MARKERS };
  let typechecked = false;
  for (const p of splitFx.SPLIT_PAIRS) {
    const typecheck = TYPECHECK && !typechecked;
    typechecked = true;
    const r = await checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: p.canvas, slot: "split", name: `split_${p.id}`, canvas: { width: 512, height: 512 }, timeline, typecheck });
    const bad = r.programs.filter((x) => !x.ok);
    const filters = r.programs.filter((x) => /imageFilters/.test(x.where)).length;
    check(
      `export ${p.canvas}: no problems, ${r.programs.length} programs (${filters} runtime filters) compile with exact binds${typecheck ? `, bundle type-checks${r.typecheck.ran ? "" : " (skipped)"}` : ""}`,
      r.problems.length === 0 && !!r.files && filters === p.layers && bad.length === 0 && (!typecheck || r.typecheck.ok),
      [...r.problems, ...bad.map((b) => `${b.where}: ${b.detail.split("\n")[0]}`), typecheck && !r.typecheck.ok ? r.typecheck.output : ""].filter(Boolean).join(" | ")
    );
    check(`…${p.canvas} warns that RN web can't play <RuntimeShader> (native only)`, r.warnings.filter((w) => /runtime image filter/.test(w)).length === p.layers);
    const tsx = r.files?.["ToolboxScene.tsx"] ?? "";
    check(`…${p.canvas} emits <Group layer={<Paint><RuntimeShader …/></Paint>}> × ${p.layers} and a <Fill blendMode="src">`, (tsx.match(/<RuntimeShader /g) ?? []).length === p.layers && /layer=\{<Paint>/.test(tsx) && /<Fill blendMode="src">/.test(tsx));
    if (p.id === "combo") {
      const manifest = JSON.parse(r.files!["manifest.json"]);
      const filt = (manifest.binds as any[]).filter((b) => /imageFilters/.test(b.path) && b.kind === "track").map((b) => b.path.split(".").pop());
      check("…the filters' animated params ship as tracks (edge strength, merge layer opacity, kuwahara hardness)", ["ns_5fcombo_5fedge_strength", "ns_5fcombo_opacity0", "ns_5fcombo_5fkuw_hardness"].every((u) => filt.includes(u)), filt.join(", "));
      // Worklet capture order in the emitted modules (the TDZ trap, §2d).
      const order = (src: string): string[] => {
        const decl = /^(?:export )?(?:function (\w+)\(|const (\w+) = (?:\([^)]*\)(?:: [\w[\]<>]+)? =>|function))/gm;
        const found: { name: string; at: number }[] = [];
        for (let m = decl.exec(src); m; m = decl.exec(src)) found.push({ name: m[1] ?? m[2], at: m.index });
        const errs: string[] = [];
        found.forEach((d, i) => {
          const body = src.slice(d.at, found[i + 1]?.at ?? src.length);
          if (!/^\s*"worklet";/m.test(body.split("\n").slice(1, 3).join("\n"))) return;
          for (const later of found.slice(i + 1)) if (new RegExp(`\\b${later.name}\\(`).test(body)) errs.push(`${d.name} calls ${later.name}`);
        });
        return errs;
      };
      const late = ["timeline.ts", "toolbox-clock.ts", "ToolboxScene.tsx"].flatMap((f) => order(r.files![f] ?? "").map((e) => `${f}: ${e}`));
      check("…emitted worklets only call worklets declared above them", late.length === 0, late.join("; "));
      // The harness slot is today's export.
      const slot = path.join(ROOT, "skia-harness/src/bundle-split");
      const { exportSkia } = await import("@/lib/skia-export");
      const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
      const fresh = exportSkia({ nodes: g.nodes, edges: g.edges, targetId: splitFx.SPLIT_PARITY_CANVAS, name: "Split stages", canvas: { width: 512, height: 512 }, timeline, runtimeSource });
      const stale = Object.entries(fresh.files ?? {}).filter(([f, text]) => !fs.existsSync(path.join(slot, f)) || fs.readFileSync(path.join(slot, f), "utf8") !== text).map(([f]) => f);
      check("skia-harness/src/bundle-split is today's export (re-run `npx tsx scripts/export-skia.mts --fixture split --out skia-harness/src/bundle-split`, then parity:skia -- --bundle split)", !!fresh.files && stale.length === 0, stale.join(", "));
    }
  }
  // A split over an image / gradient leaf exports: the image ships as an
  // asset, the gradient as its lowered program, every program compiles.
  for (const leafType of ["test-split-image", "test-split-gradient"]) {
    const layers = [{ id: "L", mode: "overlay", opacity: 0.7 }];
    const nodes = [noise(), node("lf", leafType), node("m", "skia-merge", { layers }), node("s", "skia-sharpen", { algorithm: "unsharp", amount: 1 }), fill(), node("cv", "skia-canvas")];
    const edges = [wire("nz", "m", "base"), wire("lf", "m", "layer:L"), wire("m", "s", "image"), wire("s", "f", "shader"), wire("f", "cv", "scene")];
    const r = await checkExportable({ nodes, edges, canvasId: "cv", slot: "split", name: `split_${leafType}`, canvas: { width: 64, height: 48 }, typecheck: false });
    const manifest = r.files?.["manifest.json"] ? JSON.parse(r.files["manifest.json"]) : null;
    const shipsAsset = leafType !== "test-split-image" || (manifest?.assets ?? []).some((a: any) => a.id === TEX_ASSET.id);
    const tsx = r.files?.["ToolboxScene.tsx"] ?? "";
    check(
      `export: a split over ${leafType === "test-split-image" ? "an image leaf ships the image asset" : "a gradient leaf ships it as its lowered program"} and a <RuntimeShader> layer; every program compiles with exact binds`,
      r.problems.length === 0 && !!r.files && r.programs.length > 0 && r.programs.every((x) => x.ok) && shipsAsset && /<RuntimeShader /.test(tsx),
      [...r.problems, ...r.programs.filter((x) => !x.ok).map((x) => `${x.where}: ${x.detail.split("\n")[0]}`), shipsAsset ? "" : "asset missing"].filter(Boolean).join(" | ")
    );
  }
  // The other animation shapes take a split scene too.
  for (const animation of ["baked", "native"] as const) {
    const r = await checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: "c_combo", slot: "split", name: `split_${animation}`, canvas: { width: 512, height: 512 }, timeline, animation, typecheck: TYPECHECK });
    check(`animation "${animation}": the split scene exports, programs compile${TYPECHECK ? ", bundle type-checks" : ""}`, r.problems.length === 0 && !!r.files && r.programs.every((x) => x.ok) && (!TYPECHECK || r.typecheck.ok), [...r.problems, ...r.programs.filter((x) => !x.ok).map((x) => x.detail), r.typecheck.ok ? "" : r.typecheck.output].filter(Boolean).join(" | "));
  }
}

// ---- 8. the readout -------------------------------------------------------------------------------
{
  const readout = (label: string, nodes: GraphNode[], edges: GraphEdge[], fills: string[]) => {
    const rows: Record<string, { layers: number; before: number; after: number; beforeP: number; afterP: number }> = {};
    for (const f of fills) {
      const o = evalFill(nodes, edges, f, 512, 512);
      const r = o.report!;
      rows[f] = { layers: r.layers, before: r.before.declared, after: r.after.declared, beforeP: r.before.atParams, afterP: r.after.atParams };
      info(
        `${label} ${f.padEnd(10)} ${r.layers ? `${r.layers} layer${r.layers > 1 ? "s" : ""}` : "fused   "}  declared ${r.before.declared.toFixed(1).padStart(6)} → ${r.after.declared.toFixed(1).padStart(6)}  at params (f0) ${r.before.atParams.toFixed(1).padStart(7)} → ${r.after.atParams.toFixed(1).padStart(6)}` +
          `  stages ${r.stages.map((s) => `${s.role}${s.bilinear ? "/bilinear" : ""} ${s.declared.toFixed(1)}`).join(" · ")}${r.notes.length ? `  (${r.notes.join("; ")})` : ""}`
      );
    }
    return rows;
  };
  const gg = gatherFx.gatherGraph();
  const gRows = readout("gather", gg.nodes, gg.edges, gg.nodes.filter((n) => n.type === "skia-fill").map((n) => n.id));
  const splitIds = Object.entries(gRows).filter(([, r]) => r.layers > 0).map(([f]) => f).sort();
  check(
    "gather fixture: exactly the over-budget canvases with something to save split — Sharpen ×2, Edge Detect, Flow Blur over a vector field ×2, Kuwahara ×2",
    splitIds.join() === ["f_edge", "f_fb", "f_fb_t", "f_kuw", "f_kuw_a", "f_shp", "f_shp_x"].join(),
    splitIds.join()
  );
  check("…every split lowers the declared cost, and Sharpen / Edge Detect over noise land under the budget", splitIds.every((f) => gRows[f].after < gRows[f].before) && ["f_shp", "f_shp_x", "f_edge"].every((f) => gRows[f].after <= split.PHONE_PIXEL_BUDGET));
  const sg = splitFx.splitGraph();
  const sRows = readout("split ", sg.nodes, sg.edges, splitFx.SPLIT_PAIRS.map((p) => `f_${p.id}`));
  check(
    "split fixture: chain / fan / combo split into 2 / 1 / 2 layers, each cheaper; fan lands under the budget (the chains keep Kuwahara's own 179 units)",
    splitFx.SPLIT_PAIRS.every((p) => sRows[`f_${p.id}`].layers === p.layers && sRows[`f_${p.id}`].after < sRows[`f_${p.id}`].before) && sRows.f_fan.after <= split.PHONE_PIXEL_BUDGET,
    splitFx.SPLIT_PAIRS.map((p) => `${p.id} ${sRows[`f_${p.id}`].layers}: ${sRows[`f_${p.id}`].before.toFixed(1)} → ${sRows[`f_${p.id}`].after.toFixed(1)}`).join(", ")
  );
}

// ---- 9. refusals a split does not lift -------------------------------------------------------------
{
  const kuw = getNodeDef("skia-kuwahara")!;
  const bevel = getNodeDef("skia-bevel-emboss")!;
  check(
    `Kuwahara (Skia) radius > ${KUWAHARA_SKIA_MAX_EXTENT} px stays refused: the cap is the constant loop bound, not where the taps come from`,
    kuw.validateParams!({ radius: KUWAHARA_SKIA_MAX_EXTENT + 1 }).length === 1
  );
  check("Bevel & Emboss (Skia) outer / inner / pillow stay refused: a JFA ping-pong of log2(size) passes, not one gather over one layer", ["outer-bevel", "inner-bevel", "pillow-emboss"].every((s) => bevel.validateParams!({ style: s }).length === 1));
  const kAt = (r: number) => {
    const e: ShaderExpr = { k: "call", fn: "tbx.kuwahara@1", node: "k", params: Object.fromEntries(["radius", "mode", "sharpness", "hardness", "anisotropy", "min_coherence", "opacity"].map((p) => [p, bindStatic(p === "radius" ? r : 1)])), inputs: { src: { k: "leaf", shader: { k: "color", color: bindStatic([0.5, 0.5, 0.5, 1]) } }, field: { k: "call", fn: "tbx.const@1", node: "c", params: { color: bindStatic([0, 0, 0, 0]) }, inputs: {} } } };
    return estimateShaderCost(e, { at: "params" }).cost;
  };
  info(`Kuwahara over an already-rendered layer (1 unit per tap), at params: r 6 ${kAt(6).toFixed(0)}, r 24 ${kAt(24).toFixed(0)}, r 48 (were the cap raised) ≈ ${(2.5 * Math.PI * 48 * 48).toFixed(0)} units/px — its own ALU, ${(kAt(24) / split.PHONE_PIXEL_BUDGET).toFixed(0)}× the budget at the cap`);
}

console.log(`\ncheck-skia-split: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
