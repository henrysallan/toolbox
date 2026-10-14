// check-skia-merge: Merge (Skia) — the merge & blend family gate
// (specdocs/101326_skia-target.md §7 Wave 2, family 6). CanvasKit in Node,
// CPU raster surfaces with FLOAT pixels (no 8-bit rounding), no GPU:
//
//   1. the def mirrors Merge: Merge's `layers` param (+ max 8), Merge's
//      sockets (base, mask:base, layer:<id>, mask:<id>) as Skia shaders,
//      the fixed-slot cap (8 enabled layers) reported — and the editor's
//      layer-stack UX (header +, row eyes, grow-on-wire capped at 8 enabled
//      layers: nodes/effect/merge.ts growMergeLayersOnWire) —, the blend helper
//      derived from Merge's BLEND_FS with all 29 branches;
//   2. evaluation through the real evaluator maps the stack onto the slots
//      the way Merge composites it (disabled / unwired layers skipped,
//      maskInvert only with a mask, unwired base → opaque black) and binds
//      each layer's opacity to its `layer_opacity:<id>` key;
//   3. the fused program, rendered by CanvasKit on a float surface, equals a
//      CPU reference of Merge's formulas (written here from BLEND_FS, not
//      shared with the port) for all 29 modes — two layers, opacities,
//      masks + invert + base mask, eight layers of mixed modes;
//   4. Skia's NATIVE blend modes (what Skia Group / Skia Fill blendMode
//      draws) against the same reference: where they agree and where they
//      don't, so the NodeFacts' guidance is measured, not asserted;
//   5. export: a Skia Canvas graph with all 29 modes over four Merge (Skia)
//      nodes and keyframed layer opacity goes through checkExportable
//      (exportSkia, every program compiles with exactly its uniforms, the
//      bundle type-checks against react-native-skia when skia-harness is
//      installed); keyframed layer opacities plan as tracks, an
//      overshooting curve falls back to per-frame samples.
//
//   npx tsx scripts/check-skia-merge.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { ShaderIR, SkslProgramIR } from "@/engine/skia/scene-ir";
import type { NodeDefinition, SkiaShaderValue } from "@/engine/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const { fuseShader } = await import("@/engine/skia/fuse");
const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { getSkslHelper } = await import("@/engine/skia/library");
const { deriveMergeBlendSksl, mergeBlendHelperProblems, MERGE_BLEND_HELPER_ID } = await import("@/engine/skia/library/helpers-merge");
const { BLEND_FS, BLEND_MODE_ORDER, growMergeLayersOnWire, mergeLayersParam, mergeNode, modeToInt, newMergeLayer } = await import("@/nodes/effect/merge");
const { MERGE_TO_SKIA_BLEND, SKIA_MERGE_MAX_LAYERS } = await import("@/nodes/skia/merge");
const { SKIA_BLEND_MODES } = await import("@/nodes/skia/blend-modes");
const { makeSceneSampler, exportSkiaScene } = await import("@/lib/skia-export");
const { dataOnlyContext } = await import("@/lib/skia-export/scene-sample");
const { checkExportable } = await import("./skia/export-check");
const fx = await import("./fixtures/skia/merge-graph.ts");

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

const N = SKIA_MERGE_MAX_LAYERS;
const W = 64;
const H = 64;
const def = getNodeDef("skia-merge")!;

// ---- 1. the def ---------------------------------------------------------------------
{
  check("skia-merge is registered as { class: sksl, mirrors: merge }", def?.skia?.class === "sksl" && def.skia.mirrors === "merge");
  {
    const mine = def.params[0] as any;
    const theirs = mergeNode.params[0] as any;
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    keys.delete("max");
    check(
      `its \`layers\` param is Merge's, plus max: ${N} (the grow-on-wire cap)`,
      def.params.length === 1 && mine.max === N && theirs.max === undefined && [...keys].every((k) => mine[k] === theirs[k])
    );
  }
  check("shader primary + gated image preview, no universal mask", def.primaryOutput === "skia_shader" && def.auxOutputs.some((a) => a.name === "preview" && a.type === "image") && def.gatesOutputs === true && def.noMaskInput === true);
  const layers = [
    { id: "x1", mode: "multiply", opacity: 1 },
    { id: "x2", mode: "screen", opacity: 0.5, name: "Glow" },
  ];
  const mine = def.resolveInputs!({ layers }, { connectedTypes: {} });
  const theirs = mergeNode.resolveInputs!({ layers }, { connectedTypes: {} });
  check(
    "resolveInputs: Merge's socket names, labels and order, each a skia_shader",
    mine.length === theirs.length && mine.every((s, i) => s.name === theirs[i].name && s.label === theirs[i].label && s.required === theirs[i].required && s.type === "skia_shader"),
    mine.map((s) => s.name).join(", ")
  );
  check("static inputs: base + mask:base (Skia shaders)", def.inputs.map((i) => `${i.name}:${i.type}`).join(",") === "base:skia_shader,mask:base:skia_shader");

  const stack = (n: number, disabled = 0) =>
    Array.from({ length: n + disabled }, (_, i) => ({ id: `l${i}`, mode: "normal" as const, opacity: 1, ...(i < disabled ? { enabled: false } : {}) }));
  check(`${N} enabled layers are supported`, (def.validateParams?.({ layers: stack(N) }) ?? []).length === 0);
  const over = def.validateParams?.({ layers: stack(N + 1) }) ?? [];
  check(`${N + 1} enabled layers are reported (chain a second Merge (Skia))`, over.length === 1 && /at most 8 enabled layers/.test(over[0]), over[0]);
  check(`${N} enabled + 3 disabled is fine (only enabled layers take slots)`, (def.validateParams?.({ layers: stack(N, 3) }) ?? []).length === 0);

  const d = deriveMergeBlendSksl(BLEND_FS);
  check("the blend helper derives from Merge's BLEND_FS without problems", d.problems.length === 0 && mergeBlendHelperProblems().length === 0, d.problems.join(" | "));
  check(
    "derivation renames blendRgb → tbx_blend_rgb, compositeOver → tbx_blend_over, leaves no GLSL name or vecN behind",
    d.renames.some(([a, b]) => a === "blendRgb" && b === "tbx_blend_rgb") &&
      d.renames.some(([a, b]) => a === "compositeOver" && b === "tbx_blend_over") &&
      d.renames.every(([a]) => !new RegExp(`\\b${a}\\b`).test(d.source)) &&
      !/\bvec[234]\b/.test(d.source),
    d.renames.map(([a, b]) => `${a}→${b}`).join(", ")
  );
  check("the registered helper is the derived source", getSkslHelper(MERGE_BLEND_HELPER_ID)?.source === d.source);
  const branches = [...d.source.matchAll(/mode == (\d+)\)/g)].map((m) => Number(m[1]));
  check("the helper dispatches every Merge mode (modeToInt 0..28) exactly once", branches.length === 29 && BLEND_MODE_ORDER.every((m) => branches.filter((b) => b === modeToInt(m)).length === 1));
  const broken = deriveMergeBlendSksl(BLEND_FS.replace("vec4 compositeOver", "vec4 compositeOverX").replace("mode == 17)", "mode == 99)"));
  check("a broken BLEND_FS is reported, not silently ported", broken.problems.some((p) => /compositeOver/.test(p)) && broken.problems.some((p) => /mode 17/.test(p)), broken.problems.join(" | "));

  const rnOk = Object.entries(MERGE_TO_SKIA_BLEND).every(([m, rn]) => BLEND_MODE_ORDER.includes(m as any) && SKIA_BLEND_MODES.includes(rn!));
  check(`MERGE_TO_SKIA_BLEND maps ${Object.keys(MERGE_TO_SKIA_BLEND).length} Merge modes onto React Native Skia blendModes`, rnOk);

  // Grow-on-wire / "+" (the editor's layer-stack UX, EffectsApp + EffectNode
  // via nodes/effect/merge.ts): Merge (Skia) is a layer-stack node like
  // Merge, so the header's + and the per-row eyes show, and wiring the last
  // open layer appends one — up to the 8 enabled layers its slots take.
  const lp = mergeLayersParam(def);
  check("Merge (Skia) is a layer-stack node (header +, row eyes, grow-on-wire): its merge_layers param is `layers`", lp?.name === "layers" && lp.type === "merge_layers" && mergeLayersParam(mergeNode)?.name === "layers");
  check("…other Skia nodes are not (no + on a Skia Group or Fill)", !mergeLayersParam(getNodeDef("skia-group")) && !mergeLayersParam(getNodeDef("skia-fill")));
  const wired = (ls: { id: string }[], skip: string[] = []) => new Set(["base", ...ls.filter((l) => !skip.includes(l.id)).map((l) => `layer:${l.id}`), ...ls.map((l) => `mask:${l.id}`)]);
  const one = [{ id: "a", mode: "normal" as const, opacity: 1 }];
  check("an open (unwired) layer: no growth", growMergeLayersOnWire(one, wired(one, ["a"]), lp?.max) === null);
  check("…a wired mask alone doesn't fill a layer", growMergeLayersOnWire(one, new Set(["base", "mask:a"]), lp?.max) === null);
  const g1 = growMergeLayersOnWire(one, wired(one), lp?.max, "fresh");
  check("every layer wired: one fresh layer appended (normal, opacity 1), existing layers untouched", !!g1 && g1.length === 2 && g1[0] === one[0] && g1[1].id === "fresh" && g1[1].mode === "normal" && g1[1].opacity === 1 && g1[1].enabled === undefined);
  const g1Sockets = def.resolveInputs!({ layers: g1 }, { connectedTypes: {} }).map((x) => x.name);
  check("…and the grown stack resolves the new layer's sockets (layer:fresh, mask:fresh) as Skia shaders", g1Sockets.includes("layer:fresh") && g1Sockets.includes("mask:fresh"));
  const full = stack(N);
  check(`${N} enabled layers all wired: no growth past the slots (a 9th would be reported)`, growMergeLayersOnWire(full, wired(full), lp?.max) === null);
  const withOff = stack(N - 1, 1);
  const g2 = growMergeLayersOnWire(withOff, wired(withOff), lp?.max, "g2");
  check(`${N - 1} enabled + 1 disabled, all wired: grows to ${N} enabled (disabled layers take no slot)`, !!g2 && g2.length === N + 1 && (def.validateParams?.({ layers: g2 }) ?? []).length === 0);
  const big = stack(N);
  const g3 = growMergeLayersOnWire(big, wired(big), mergeLayersParam(mergeNode)?.max, "g3");
  check(`Merge (no cap) keeps growing past ${N}`, !!g3 && g3.length === N + 1);
  check("newMergeLayer is what + appends (mode normal, opacity 1, a fresh lyr- id)", (() => {
    const l = newMergeLayer();
    return l.mode === "normal" && l.opacity === 1 && /^lyr-[a-z0-9]+$/.test(l.id) && newMergeLayer().id !== l.id;
  })());
}

// ---- 2. evaluation through the real evaluator ------------------------------------------

const leaf = (asset: string): ShaderExpr => ({
  k: "leaf",
  shader: { k: "image", asset, fit: "fill", rect: [{ v: 0 }, { v: 0 }, { v: W }, { v: H }] },
});

// Upstream producers: a test-only node per input image whose primary is a
// leaf expression, so the evaluator wires real skia_shader values in.
const LEAF_TYPE = "test-merge-leaf";
{
  const { registerNode } = await import("@/engine/registry");
  const leafDef: NodeDefinition = {
    type: LEAF_TYPE,
    name: "Test leaf",
    category: "utility",
    hidden: true,
    backend: "webgl2",
    inputs: [],
    params: [{ name: "asset", label: "Asset", type: "string", default: "" }],
    primaryOutput: "skia_shader",
    auxOutputs: [],
    compute({ params }) {
      const primary: SkiaShaderValue = { kind: "skia_shader", expr: leaf(String(params.asset)) };
      return { primary };
    },
  };
  registerNode(leafDef);
}

interface MergeCase {
  layers: Record<string, unknown>[];
  // socket → leaf asset
  wires: Record<string, string>;
  animation?: GraphNode["animation"];
}

function evalMerge(c: MergeCase, tick = 0): { expr: ShaderExpr; problems?: string[] } {
  const nodes: GraphNode[] = [{ id: "m", type: "skia-merge", params: { layers: c.layers }, ...(c.animation ? { animation: c.animation } : {}) }];
  const edges: GraphEdge[] = [];
  for (const [socket, asset] of Object.entries(c.wires)) {
    const id = `src_${socket.replace(/[^a-z0-9]/gi, "_")}`;
    nodes.push({ id, type: LEAF_TYPE, params: { asset } });
    edges.push({ id: `${id}->m`, source: id, sourceHandle: "out:primary", target: "m", targetHandle: `in:${socket}` });
  }
  const ctx = dataOnlyContext({ width: W, height: H }, { fps: 60, ticksPerFrame: 1000 });
  (ctx as any).tick = tick;
  const r = evaluateGraph(nodes, edges, ctx, new Map() as EvalCache, null, undefined, null, {
    extraTargets: ["m"],
    extraConsumed: new Map([["m", ["primary"]]]),
  });
  const v = r.outputs.get("m")?.primary as any;
  if (v?.kind !== "skia_shader") throw new Error(`skia-merge produced ${v?.kind ?? "nothing"}: ${JSON.stringify(r.errors)}`);
  return { expr: v.expr, problems: v.problems };
}

const uniformsOf = (e: ShaderExpr) => (e.k === "call" ? e.params : {});
const val = (e: ShaderExpr, name: string) => (uniformsOf(e)[name] as any)?.v;

{
  const { expr } = evalMerge({
    layers: [
      { id: "a", mode: "multiply", opacity: 0.5 },
      { id: "off", mode: "screen", opacity: 1, enabled: false },
      { id: "b", mode: "overlay", opacity: 0.25, maskInvert: true },
      { id: "c", mode: "glow", opacity: 1, maskInvert: true },
      { id: "u", mode: "darken", opacity: 1 },
    ],
    wires: { base: "base", "layer:a": "l1", "layer:off": "l2", "layer:b": "l2", "mask:b": "m1", "layer:c": "l1" },
  });
  const slots = Array.from({ length: 5 }, (_, k) => ["on", "mode", "opacity", "masked", "invert"].map((p) => val(expr, `${p}${k}`)).join("/"));
  check(
    "slots follow the ENABLED layers in stack order (disabled skipped)",
    val(expr, "mode0") === modeToInt("multiply") && val(expr, "mode1") === modeToInt("overlay") && val(expr, "mode2") === modeToInt("glow") && val(expr, "mode3") === modeToInt("darken"),
    slots.join("  ")
  );
  check("an enabled but unwired layer is off; unused slots are off", val(expr, "on3") === 0 && val(expr, "on4") === 0 && val(expr, "on0") === 1 && val(expr, "on1") === 1 && val(expr, "on2") === 1);
  check("maskInvert applies only with a wired mask", val(expr, "masked1") === 1 && val(expr, "invert1") === 1 && val(expr, "masked2") === 0 && val(expr, "invert2") === 0);
  const ref = (uniformsOf(expr).opacity1 as any)?.ref;
  check("a layer's opacity binds to its layer_opacity:<id> key", ref?.node === "m" && ref?.param === "layer_opacity:b" && val(expr, "opacity1") === 0.25);
  check("modes / on / invert are derived from `layers`; base flags are static", (uniformsOf(expr).mode0 as any)?.deps?.[0]?.param === "layers" && !(uniformsOf(expr).base_on as any)?.ref);

  const noBase = evalMerge({ layers: [{ id: "a", mode: "normal", opacity: 1 }], wires: { "layer:a": "l1" } }).expr;
  check("unwired base → base_on 0 (renders opaque black, like Merge) and every layer off", val(noBase, "base_on") === 0 && val(noBase, "on0") === 0);

  const anim = evalMerge(
    {
      layers: [{ id: "a", mode: "normal", opacity: 0.9 }],
      wires: { base: "base", "layer:a": "l1" },
      animation: { "layer_opacity:a": fx.opacityBlock([[0, 0.2], [10, 0.8]]) },
    },
    5000
  ).expr;
  check("keyframed layer opacity reaches the uniform (the evaluator's virtual-key override)", Math.abs(val(anim, "opacity0") - 0.5) < 1e-9, String(val(anim, "opacity0")));

  const tooMany = evalMerge({
    layers: Array.from({ length: N + 1 }, (_, i) => ({ id: `t${i}`, mode: "normal", opacity: 1 })),
    wires: { base: "base" },
  });
  check("9 enabled layers → problems + transparent output", (tooMany.problems?.length ?? 0) === 1 && tooMany.expr.k === "call" && tooMany.expr.fn === "tbx.const@1");
}

// ---- 3. fused program on a float surface vs the CPU reference ---------------------------

// Straight 8-bit images, row 0 = top (Skia). Varied so every branch sees a
// range: red pairs base x against layer y (the full (a, b) grid), green and
// blue mix both, alpha covers 0..1 on the layers.
type Img = { px: Uint8Array };
function img(fill: (x: number, y: number) => [number, number, number, number]): Img {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(fill(x, y), (y * W + x) * 4);
  return { px };
}
const IMAGES: Record<string, Img> = {
  base: img((x, y) => [x * 4, y * 4, (x * y) % 256, 110 + ((x * 3 + y * 5) % 146)]),
  opaque: img((x, y) => [x * 4, y * 4, (x * y) % 256, 255]),
  l1: img((x, y) => [y * 4, (x * 7 + y * 3) % 256, (x * 13) % 256, (x * 5 + y * 9) % 256]),
  l2: img((x, y) => [255 - x * 4, 255 - ((x * 11 + y * 2) % 256), (y * 17) % 256, 40 + ((x * 7 + y * 3) % 216)]),
  m1: img((x, y) => [x * 4, x * 4, x * 4, 128 + y * 2]),
  m2: img((x, y) => [(y * 4) % 256, 255 - x * 4, 128, 255]),
};

const ckImages = new Map<string, any>();
function imageShader(asset: string): any {
  let im = ckImages.get(asset);
  if (!im) {
    const src = IMAGES[asset];
    if (!src) throw new Error(`no test image "${asset}"`);
    im = CK.MakeImage({ width: W, height: H, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }, src.px, W * 4);
    ckImages.set(asset, im);
  }
  return im.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Nearest, CK.MipmapMode.None);
}

function childShader(s: ShaderIR): any {
  if (s.k === "image") return imageShader(s.asset);
  if (s.k === "color") return CK.Shader.MakeColor(CK.Color4f(...s.color.v), CK.ColorSpace.SRGB);
  if (s.k === "runtime") return programShader(s.program);
  throw new Error(`gate renders image / color / runtime children only, got ${s.k}`);
}

function programShader(p: SkslProgramIR): any {
  const r = compileSksl(CK, p.sksl);
  if (!r.effect) throw new Error(r.error);
  const values: Record<string, number | number[]> = {};
  for (const [k, b] of Object.entries(p.uniforms)) values[k] = b.v;
  const u = packUniforms(r.effect, values);
  return p.children.length ? r.effect.makeShaderWithChildren(u, p.children.map((c) => childShader(c.shader))) : r.effect.makeShader(u);
}

// A float surface: premultiplied RGBA_F32 pixels, row 0 = top.
function floatSurface(draw: (canvas: any) => void): Float32Array {
  const mem = CK.Malloc(Float32Array, W * H * 4);
  const surf = CK.MakeRasterDirectSurface(
    { width: W, height: H, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB },
    mem,
    W * 16
  );
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  draw(canvas);
  surf.flush();
  const out = Float32Array.from(mem.toTypedArray());
  surf.delete();
  CK.Free(mem);
  return out;
}

function renderExpr(expr: ShaderExpr): Float32Array {
  const r = fuseShader(expr, { resolution: [W, H], time: 0 });
  if (!r.shader || r.shader.k !== "runtime") throw new Error(`fuse failed: ${r.problems.join(" | ")}`);
  const shader = programShader(r.shader.program);
  return floatSurface((canvas) => {
    const paint = new CK.Paint();
    paint.setShader(shader);
    paint.setBlendMode(CK.BlendMode.Src);
    canvas.drawPaint(paint);
    paint.delete();
    shader.delete();
  });
}

// --- the CPU reference: Merge's GLSL (BLEND_MODE_GLSL + compositeOver), by hand ---
type V3 = [number, number, number];
type V4 = [number, number, number, number];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const step = (edge: number, x: number) => (x < edge ? 0 : 1);
const mix = (x: number, y: number, t: number) => x * (1 - t) + y * t;
const ch = (f: (a: number, b: number) => number) => (a: V3, b: V3): V3 => [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])];
const lumaOf = (c: V3) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const FORMULAS: Record<string, (a: V3, b: V3) => V3> = {
  mix: (_a, b) => b,
  normal: (_a, b) => b,
  overlay: ch((a, b) => mix(2 * a * b, 1 - 2 * (1 - a) * (1 - b), step(0.5, a))),
  screen: ch((a, b) => 1 - (1 - a) * (1 - b)),
  multiply: ch((a, b) => a * b),
  add: ch((a, b) => clamp01(a + b)),
  subtract: ch((a, b) => clamp01(a - b)),
  divide: ch((a, b) => clamp01(a / Math.max(b, 1e-5))),
  difference: ch((a, b) => Math.abs(a - b)),
  average: ch((a, b) => (a + b) * 0.5),
  "hard-light": ch((a, b) => mix(2 * a * b, 1 - 2 * (1 - a) * (1 - b), step(0.5, b))),
  "soft-light": ch((a, b) => mix(2 * a * b + a * a * (1 - 2 * b), 2 * a * (1 - b) + Math.sqrt(Math.max(a, 0)) * (2 * b - 1), step(0.5, b))),
  "vivid-light": ch((a, b) =>
    mix(clamp01(1 - (1 - a) / Math.max(2 * b, 1e-5)), clamp01(a / Math.max(1 - 2 * (b - 0.5), 1e-5)), step(0.5, b))
  ),
  "pin-light": ch((a, b) => mix(Math.min(a, 2 * b), Math.max(a, 2 * (b - 0.5)), step(0.5, b))),
  "linear-light": ch((a, b) => clamp01(a + 2 * b - 1)),
  "hard-mix": ch((a, b) => step(1, a + b)),
  lighten: ch((a, b) => Math.max(a, b)),
  darken: ch((a, b) => Math.min(a, b)),
  "lighter-color": (a, b) => (lumaOf(a) > lumaOf(b) ? a : b),
  "darker-color": (a, b) => (lumaOf(a) < lumaOf(b) ? a : b),
  "color-dodge": ch((a, b) => clamp01(a / Math.max(1 - b, 1e-5))),
  "color-burn": ch((a, b) => clamp01(1 - (1 - a) / Math.max(b, 1e-5))),
  "linear-dodge": ch((a, b) => clamp01(a + b)),
  "linear-burn": ch((a, b) => clamp01(a + b - 1)),
  exclusion: ch((a, b) => a + b - 2 * a * b),
  negation: ch((a, b) => 1 - Math.abs(1 - a - b)),
  reflect: ch((a, b) => clamp01((a * a) / Math.max(1 - b, 1e-5))),
  glow: ch((a, b) => clamp01((b * b) / Math.max(1 - a, 1e-5))),
  phoenix: ch((a, b) => clamp01(Math.min(a, b) - Math.max(a, b) + 1)),
};
check("the CPU reference covers every Merge mode", BLEND_MODE_ORDER.every((m) => typeof FORMULAS[m] === "function") && Object.keys(FORMULAS).length === 29);

function compositeOver(a: V4, b: V4, opacity: number, matte: number, mode: string): V4 {
  const blended = FORMULAS[mode]([a[0], a[1], a[2]], [b[0], b[1], b[2]]);
  const srcA = clamp01(b[3] * opacity * matte);
  const outA = srcA + a[3] * (1 - srcA);
  if (outA < 1e-4) return [0, 0, 0, outA];
  const o = (i: number) => (blended[i] * srcA + a[i] * a[3] * (1 - srcA)) / outA;
  return [o(0), o(1), o(2), outA];
}

// What the shader reads from a child image: straight color, and (0,0,0,0)
// where alpha is 0 (Skia children are premultiplied).
function px(asset: string, i: number): V4 {
  const p = IMAGES[asset].px;
  const a = p[i * 4 + 3] / 255;
  if (a === 0) return [0, 0, 0, 0];
  return [p[i * 4] / 255, p[i * 4 + 1] / 255, p[i * 4 + 2] / 255, a];
}
const coverage = (c: V4) => lumaOf([c[0], c[1], c[2]]) * c[3];

interface RefLayer {
  src: string;
  mode: string;
  opacity: number;
  mask?: string;
  invert?: boolean;
  enabled?: boolean;
}
function reference(base: string, baseMask: string | null, layers: RefLayer[]): Float32Array {
  const out = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    let acc = px(base, i);
    if (baseMask) acc = [acc[0], acc[1], acc[2], acc[3] * coverage(px(baseMask, i))];
    for (const l of layers) {
      if (l.enabled === false) continue;
      let m = 1;
      if (l.mask) {
        m = coverage(px(l.mask, i));
        if (l.invert) m = 1 - m;
      }
      acc = compositeOver(acc, px(l.src, i), l.opacity, m, l.mode);
    }
    out.set([acc[0] * acc[3], acc[1] * acc[3], acc[2] * acc[3], acc[3]], i * 4);
  }
  return out;
}

interface Diff {
  max: number;
  mean: number;
  // Fraction of channels off by more than TOL.
  broad: number;
  worstAt: number;
}
const TOL = 1e-3;
function diff(a: Float32Array, b: Float32Array): Diff {
  let max = 0;
  let sum = 0;
  let over = 0;
  let worstAt = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > TOL) over++;
    if (d > max) {
      max = d;
      worstAt = i;
    }
  }
  return { max, mean: sum / a.length, broad: over / a.length, worstAt };
}
const fmt = (d: Diff) => `max ${d.max.toFixed(5)} mean ${d.mean.toExponential(1)} off>${TOL} ${(d.broad * 100).toFixed(2)}%`;

function merged(base: string, baseMask: string | null, layers: RefLayer[]): { got: Float32Array; want: Float32Array } {
  const wires: Record<string, string> = { base };
  if (baseMask) wires["mask:base"] = baseMask;
  const stack = layers.map((l, i) => {
    wires[`layer:k${i}`] = l.src;
    if (l.mask) wires[`mask:k${i}`] = l.mask;
    return { id: `k${i}`, mode: l.mode, opacity: l.opacity, ...(l.invert ? { maskInvert: true } : {}), ...(l.enabled === false ? { enabled: false } : {}) };
  });
  const { expr, problems } = evalMerge({ layers: stack, wires });
  if (problems?.length) throw new Error(problems.join(" | "));
  return { got: renderExpr(expr), want: reference(base, baseMask, layers) };
}

// A precision artifact on a discontinuous mode (hard-mix's step, the luma
// comparisons, the guarded divisions) is a large delta on a FEW pixels that
// sit exactly on a threshold, where fp32 and doubles round differently; a
// wrong formula is wrong nearly everywhere. So a case fails on BREADTH, as
// check-shaders does for the GL fused-vs-chained proof.
const BREADTH = 0.005;
{
  const CASES: { name: string; base: string; baseMask: string | null; layers: (mode: string) => RefLayer[] }[] = [
    { name: "two layers, opacity 1", base: "base", baseMask: null, layers: (mode) => [{ src: "l1", mode, opacity: 1 }, { src: "l2", mode, opacity: 1 }] },
    { name: "opacity .5 / .75", base: "base", baseMask: null, layers: (mode) => [{ src: "l1", mode, opacity: 0.5 }, { src: "l2", mode, opacity: 0.75 }] },
    {
      name: "mask, inverted mask, base mask",
      base: "base",
      baseMask: "m2",
      layers: (mode) => [{ src: "l1", mode, opacity: 1, mask: "m1" }, { src: "l2", mode, opacity: 0.8, mask: "m2", invert: true }],
    },
    { name: "opaque base", base: "opaque", baseMask: null, layers: (mode) => [{ src: "l1", mode, opacity: 0.9 }] },
  ];
  for (const c of CASES) {
    const rows: string[] = [];
    let worst: { mode: string; d: Diff } | null = null;
    const suspects: string[] = [];
    for (const mode of BLEND_MODE_ORDER) {
      const { got, want } = merged(c.base, c.baseMask, c.layers(mode));
      const d = diff(got, want);
      if (!worst || d.max > worst.d.max) worst = { mode, d };
      if (d.broad > BREADTH) suspects.push(`${mode} (${fmt(d)})`);
      rows.push(`${mode} ${d.max.toFixed(4)}/${(d.broad * 100).toFixed(2)}%`);
    }
    check(
      `fused Merge (Skia) == CPU reference of Merge's formulas, all 29 modes — ${c.name}`,
      suspects.length === 0,
      suspects.length ? `broad differences: ${suspects.join("; ")}` : `worst ${worst!.mode}: ${fmt(worst!.d)}`
    );
    if (c.name === "two layers, opacity 1") info(`per mode (max | off>${TOL}): ${rows.join(", ")}`);
  }

  // Eight layers, mixed modes, masks, one disabled (it must not take a slot).
  const eight: RefLayer[] = [
    { src: "l1", mode: "multiply", opacity: 0.8, mask: "m1" },
    { src: "l2", mode: "screen", opacity: 0.6, mask: "m2", invert: true },
    { src: "l1", mode: "difference", opacity: 1, enabled: false },
    { src: "l2", mode: "overlay", opacity: 1 },
    { src: "l1", mode: "soft-light", opacity: 0.9 },
    { src: "l2", mode: "color-dodge", opacity: 0.4, mask: "m1" },
    { src: "l1", mode: "linear-burn", opacity: 0.7 },
    { src: "l2", mode: "pin-light", opacity: 0.5 },
    { src: "l1", mode: "phoenix", opacity: 0.35, mask: "m2" },
  ];
  const { got, want } = merged("base", "m1", eight);
  const d = diff(got, want);
  check("8 enabled layers (+1 disabled), mixed modes and masks, one shader == reference", d.broad <= BREADTH && d.max < 0.02, fmt(d));

  // Merge with nothing wired into base clears to opaque black.
  const { expr } = evalMerge({ layers: [{ id: "a", mode: "normal", opacity: 1 }], wires: { "layer:a": "l1" } });
  const black = renderExpr(expr);
  check("unwired base renders opaque black (Merge's clear)", black.every((v, i) => (i % 4 === 3 ? v === 1 : v === 0)));
}

// ---- 4. Skia's native blend modes vs Merge's formulas ---------------------------------------
//
// What Skia Group / Skia Fill blendMode draws: the base, then the layer with
// the paint's blend mode and alpha = layer opacity (React Native Skia's
// per-draw opacity). Measured on the same images; the claims in Merge
// (Skia)'s NodeFacts are the assertions.

const ckBlend = (rn: string) => CK.BlendMode[rn[0].toUpperCase() + rn.slice(1)];
function nativeBlend(base: string, layer: string, rn: string, opacity: number): Float32Array {
  return floatSurface((canvas) => {
    const draw = (asset: string, mode: any, alpha: number) => {
      const paint = new CK.Paint();
      const s = imageShader(asset);
      paint.setShader(s);
      paint.setBlendMode(mode);
      paint.setAlphaf(alpha);
      canvas.drawPaint(paint);
      paint.delete();
      s.delete();
    };
    draw(base, CK.BlendMode.SrcOver, 1);
    draw(layer, ckBlend(rn), opacity);
  });
}

{
  const summary: string[] = [];
  const failuresHere: string[] = [];
  for (const [mode, rn] of Object.entries(MERGE_TO_SKIA_BLEND) as [string, string][]) {
    const want = (base: string) => reference(base, null, [{ src: "l1", mode, opacity: 0.9 }]);
    const opq = diff(nativeBlend("opaque", "l1", rn, 0.9), want("opaque"));
    const tr = diff(nativeBlend("base", "l1", rn, 0.9), want("base"));
    summary.push(`${mode}→${rn}: opaque ${opq.max.toFixed(3)}/${(opq.broad * 100).toFixed(1)}%, translucent ${tr.max.toFixed(3)}/${(tr.broad * 100).toFixed(1)}%`);
    const isNormal = rn === "srcOver";
    // Opaque base: the W3C formulas are Merge's, except softLight's dark
    // branch and plus's premultiplied clamp.
    if (isNormal || !["softLight", "plus"].includes(rn)) {
      if (opq.broad > BREADTH) failuresHere.push(`${mode}: opaque base should agree, ${fmt(opq)}`);
    } else if (opq.broad <= BREADTH) failuresHere.push(`${mode}: opaque base was expected to DISAGREE (${rn}), ${fmt(opq)}`);
    // Translucent base: only normal agrees.
    if (isNormal && tr.broad > BREADTH) failuresHere.push(`${mode}: translucent base should agree, ${fmt(tr)}`);
    if (!isNormal && tr.broad <= 0.02) failuresHere.push(`${mode}: translucent base was expected to disagree broadly, ${fmt(tr)}`);
  }
  check("Skia native blendMode vs Merge: agree on an opaque base except softLight / plus; over a translucent base only normal agrees", failuresHere.length === 0, failuresHere.join(" | "));
  info(`native blend vs Merge (max | off>${TOL}): ${summary.join("; ")}`);

  // softLight differs ONLY in the W3C dark-backdrop branch: base ≤ 0.25
  // under a layer > 0.5 (D(Cb) = ((16Cb − 12)Cb + 4)Cb instead of √Cb).
  const got = nativeBlend("opaque", "l1", "softLight", 1);
  const want = reference("opaque", null, [{ src: "l1", mode: "soft-light", opacity: 1 }]);
  let outside = 0;
  let inside = 0;
  let maxIn = 0;
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(got[i * 4 + c] - want[i * 4 + c]);
      if (d <= TOL) continue;
      const a = px("opaque", i)[c];
      const b = px("l1", i)[c];
      if (a <= 0.25 && b > 0.5 && px("l1", i)[3] > 0) {
        inside++;
        maxIn = Math.max(maxIn, d);
      } else outside++;
    }
  }
  check("softLight vs soft-light: every difference is a base ≤ 0.25 under a layer > 0.5", outside === 0 && inside > 0, `${inside} channels differ there (max ${maxIn.toFixed(3)}), ${outside} elsewhere`);
}

// ---- 5. export: all 29 modes, keyframed layer opacity --------------------------------------

{
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const wire = (source: string, target: string, handle: string) =>
    edges.push({ id: `${source}->${target}:${handle}`, source, sourceHandle: "out:primary", target, targetHandle: handle });
  const up = (k: string, n: Record<string, unknown>, stops: unknown) => {
    nodes.push({ id: `sn${k}`, type: "skia-noise", params: { ...n } });
    nodes.push({ id: `sr${k}`, type: "skia-color-ramp", params: { stops, offset: 0, interpolation: "linear", space: "srgb" } });
    wire(`sn${k}`, `sr${k}`, "in:image");
  };
  up("A", fx.NOISE_A, fx.RAMP_A);
  up("B", fx.NOISE_B, fx.RAMP_B);
  up("C", fx.NOISE_C, fx.RAMP_C);
  nodes.push({ id: "snM", type: "skia-noise", params: { ...fx.NOISE_M } });

  const OVERSHOOT = "m3-L0";
  const chunks = [0, 1, 2, 3].map((j) => BLEND_MODE_ORDER.slice(j * N, j * N + N));
  check("four Merge (Skia) nodes cover all 29 modes (8 + 8 + 8 + 5)", chunks.flat().length === 29 && chunks.every((c) => c.length <= N));
  const keyframed: string[] = [];
  chunks.forEach((modes, j) => {
    const id = `m${j}`;
    const layers = modes.map((mode, i) => ({ id: `${id}-L${i}`, mode, opacity: 0.85, ...(i === 1 ? { maskInvert: true } : {}) }));
    const animation: GraphNode["animation"] = {};
    for (const i of [0, 3]) {
      const lid = `${id}-L${i}`;
      if (!layers[i]) continue;
      animation[`layer_opacity:${lid}`] =
        lid === OVERSHOOT
          ? { animated: true, trackVisible: true, keyframes: [{ tick: 0, value: 0.3, easingOut: "easeOutBack" }, { tick: 40_000, value: 1, easingOut: "linear" }] }
          : // Distinct curves, so the emitter cannot share one track between them.
            fx.opacityBlock([[0, 0.2 + 0.1 * j + 0.02 * i], [60, 1]]);
      keyframed.push(lid);
    }
    nodes.push({ id, type: "skia-merge", params: { layers }, animation });
    wire("srA", id, "in:base");
    if (j === 0) wire("snM", id, "in:mask:base");
    layers.forEach((l, i) => {
      wire(i % 2 ? "srC" : "srB", id, `in:layer:${l.id}`);
      if (i % 3 === 1) wire("snM", id, `in:mask:${l.id}`);
    });
    nodes.push({ id: `f${j}`, type: "skia-fill", params: { color: "#ffffff", opacity: 1, blendMode: "srcOver" } });
    wire(id, `f${j}`, "in:shader");
  });
  nodes.push({ id: "g", type: "skia-group", params: {} });
  chunks.forEach((_c, j) => wire(`f${j}`, "g", `in:child${j + 1}`));
  nodes.push({ id: "canvas", type: "skia-canvas", params: {} });
  wire("g", "canvas", "in:scene");

  const r = await checkExportable({ nodes, edges, canvasId: "canvas", slot: "merge", typecheck: true });
  check("exportSkia: the 29-mode Skia Canvas graph exports with no problems", r.problems.length === 0 && !!r.files, r.problems.join(" | "));
  check(
    "every runtime program compiles in CanvasKit and declares exactly its binds' uniforms",
    r.programs.length === 4 && r.programs.every((p) => p.ok),
    r.programs.map((p) => `${p.where}: ${p.ok ? "ok" : "FAIL"} ${p.detail}`).join("; ")
  );
  check(
    r.typecheck.ran ? "the emitted bundle type-checks against react-native-skia 3.4 + Reanimated 4.7" : "bundle type-check (skipped: skia-harness not installed)",
    r.typecheck.ok,
    r.typecheck.output || undefined
  );
  check("the only export warning is the overshooting layer's sampled fallback", r.warnings.length === 1 && r.warnings[0].includes(`layer_opacity:${OVERSHOOT}`), r.warnings.join(" | "));

  // The bind plan itself: tracks for keyframed layer opacity.
  const canvas = { width: 256, height: 256 };
  const timeline = { fps: 60, ticksPerFrame: 1000, sceneDurationTicks: 60_000 };
  const sampler = makeSceneSampler(nodes, edges, "canvas", canvas, timeline);
  if ("problem" in sampler) throw new Error(sampler.problem);
  const scene = sampler.sampleAt(0)!;
  const ex = exportSkiaScene(scene, nodes, edges, {
    name: "merge",
    timeline,
    runtimeSource: fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8"),
    sampleAt: (t) => sampler.sampleAt(t),
  });
  const opacityBinds = ex.binds.filter((b) => /_opacity\d$/.test(b.path));
  const byLayer = (lid: string) =>
    ex.binds.find((b) => {
      if (!/_opacity\d$/.test(b.path)) return false;
      return b.plan.kind !== "refused" && b.plan.from.includes(`layer_opacity:${lid}`);
    });
  const tracks = keyframed.filter((l) => l !== OVERSHOOT).map((l) => [l, byLayer(l)?.plan.kind] as const);
  check(
    `keyframed layer opacities export as timeline tracks (${tracks.length})`,
    tracks.every(([, k]) => k === "track"),
    tracks.map(([l, k]) => `${l}: ${k}`).join(", ")
  );
  check("an overshooting curve (clamped by the evaluator) falls back to exact per-frame samples", byLayer(OVERSHOOT)?.plan.kind === "sampled", byLayer(OVERSHOOT)?.plan.kind);
  const statics = opacityBinds.filter((b) => b.plan.kind === "static").length;
  check(`static layer opacities stay static (${statics} of ${opacityBinds.length} slots)`, statics === opacityBinds.length - keyframed.length);
  const modeBinds = ex.binds.filter((b) => /_mode\d$/.test(b.path));
  check("every mode uniform is static (constant over the scene)", modeBinds.length === 4 * N && modeBinds.every((b) => b.plan.kind === "static"));
  const timelineFile = Object.entries(ex.files ?? {}).find(([f]) => /timeline\.ts$/.test(f))?.[1] ?? "";
  check(
    "the emitted timeline.ts declares one TimelineTrack per keyframed layer opacity",
    tracks.length > 0 && tracks.every(([l]) => new RegExp(`layer_opacity:${l} \\(2 keys\\)\\nconst T_b\\d+: TimelineTrack`).test(timelineFile)),
    `${(timelineFile.match(/const T_b\d+: TimelineTrack/g) ?? []).length} tracks in timeline.ts`
  );
}

console.log(`\ncheck-skia-merge: ${failures === 0 ? "all passed" : `${failures} failure(s)`}`);
process.exit(failures ? 1 : 0);
