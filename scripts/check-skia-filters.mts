// check-skia-filters: the Skia filter family — the `filter` lowering class
// (specdocs/101326_skia-target.md §3.2, §3.2a, Wave 3 lane F). CanvasKit
// 0.41.0 in Node, CPU raster surfaces; no GL. Pixel parity with the GL
// nodes is `compare:skia` on scripts/fixtures/skia/filters-graph.ts (Electron);
// React Native Skia web is `parity:skia -- --bundle filters`. This gate:
//
//   1. defs: every filter node is `skia: { class: "filter" }` with a
//      skia_draw `content` in and out; the mirrors (Blur, Bloom, Grain, Lens
//      Flare) carry the GL node's own ParamDefs; Grain's mix modes agree;
//   2. Blur (Skia): the GL kernel's variance is (r/2)² up to its 64-tap cap
//      and glBlurSigma past it; the IR binds sigma = radius × 0.5 as a
//      scaled ref; linear light is the srgbToLinear / linearToSrgb layer
//      pair; bokeh / convolve refuse; CanvasKit's blur measured from a
//      line's spread is that sigma;
//   3. CPU references, each against the CONTENT CanvasKit rendered:
//      Morphology (square window, rounded radius: exact), Color Matrix
//      (unpremultiplied 4×5, ≤ 1/255; the adjust matrices against the CSS
//      Filter Effects formulas), Drop Shadow (drop and RN's inner), Grain
//      classic (Grain's float hash run in fp32), SkSL Filter (its default
//      source), Bloom's bright pass;
//   4. Bloom (Skia): bloomLevelSigmas against a 1-D simulation of Bloom's
//      GL mip chain (its exact taps, bilinear + clamp, per level), the
//      level weights against Bloom's upsample loop, and the srcATop
//      additive-light composite (glow only where the content is);
//   5. the renderer: `layer.blendMode` (native and emulated layers), the
//      emulated layer's margin (a runtime stage before a blur doesn't fade
//      at the canvas edge; off-canvas content blurs in), and filters scale
//      with the CTM (2× under a 2× CTM, box-downsampled ≡ 1×);
//   6. colour management: every runtime filter program on sRGB 8-bit vs
//      Display P3 F32 ≤ 1/255 (NEGATIVE: management forced off differs);
//   7. export: every fixture canvas exports; the stacks pass checkExportable
//      (programs compile with exactly their uniforms, the bundle type-checks
//      against react-native-skia 3.4.0) in worklet, baked and native modes;
//      keyframed params plan as tracks (blur radius × 0.5, grain seed, an
//      SkSL Filter channel); the JSX has the layer Paint's blendMode and
//      <RuntimeShader>; runtime filters are flagged not web-playable; the
//      harness slot skia-harness/src/bundle-filters is today's export;
//   8. assets survive every filter (an Image (Skia) behind Blur → Bloom
//      ships its bytes), and a filter inside a Copy to Points (Skia)
//      instance draws in the atlas's sprite sheet as in its groups.
//
//   npx tsx scripts/check-skia-filters.mts      (FILTERS_SIZE=<px>, default 64)

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { SkiaDrawValue } from "@/engine/types";
import type { ImageFilterIR, SkiaNode, SkiaScene, SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { renderScene } = await import("@/engine/skia/scene-render");
const { SKIA_IR_VERSION, bindStatic } = await import("@/engine/skia/scene-ir");
const { compileSksl } = await import("@/engine/skia/sksl-program");
const { isColorManagedSksl } = await import("@/engine/skia/library/color-management");
const { buildSkslFilterProgram, lintSkslFilter, rewriteSkslFilterSource, skslFilterError } = await import("@/engine/skia/sksl-filter");
const { dataOnlyContext, makeSceneSampler } = await import("@/lib/skia-export/scene-sample");
const { exportSkia } = await import("@/lib/skia-export");
const { buildGaussianWeights } = await import("@/engine/convolve/complex");
const blurMod = await import("@/nodes/skia/blur");
const bloomMod = await import("@/nodes/skia/bloom");
const grainMod = await import("@/nodes/skia/grain");
const cmMod = await import("@/nodes/skia/color-matrix");
const { checkExportable } = await import("./skia/export-check");
const fx = await import("./fixtures/skia/filters-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}

const S = Number(process.env.FILTERS_SIZE ?? 64);
const timeline = { ...fx.FILTERS_TIMELINE };
const FILTER_TYPES = [
  "skia-blur",
  "skia-bloom",
  "skia-grain",
  "skia-drop-shadow",
  "skia-morphology",
  "skia-color-matrix",
  "skia-sksl-filter",
  "skia-lens-flare",
] as const;
const MIRRORS: Record<string, string> = { "skia-blur": "blur", "skia-bloom": "bloom", "skia-grain": "grain", "skia-lens-flare": "lens-flare" };

// ---- helpers ------------------------------------------------------------------------------

function quietly<T>(f: () => T): T {
  const e = console.error;
  const w = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return f();
  } finally {
    console.error = e;
    console.warn = w;
  }
}

const sceneFor = (root: SkiaNode, w: number, h = w): SkiaScene => ({ version: SKIA_IR_VERSION, width: w, height: h, root, assets: {} });

// Premultiplied RGBA8 of a scene drawn at w × h (× `scale` under the CTM).
function draw(scene: SkiaScene, w = scene.width, h = scene.height, scale = 1, cs = CK.ColorSpace.SRGB, f32 = false): { px: Uint8Array; problems: string[] } {
  const surf = CK.MakeSurface(1, 1).makeSurface({
    width: w,
    height: h,
    colorType: f32 ? CK.ColorType.RGBA_F32 : CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Premul,
    colorSpace: cs,
  });
  const c = surf.getCanvas();
  c.clear(CK.TRANSPARENT);
  c.save();
  if (scale !== 1) c.scale(scale, scale);
  const r = renderScene(CK, c, scene, { surfaceSize: [w, h], layerFormat: { colorSpace: cs, f32 } });
  c.restore();
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = new Uint8Array(img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB }));
  r.release();
  img.delete();
  surf.delete();
  return { px, problems: r.problems };
}

// Alpha of a scene drawn on an F32 surface (no 8-bit rounding).
function drawAlphaF32(scene: SkiaScene): Float32Array {
  const w = scene.width;
  const h = scene.height;
  const surf = CK.MakeSurface(1, 1).makeSurface({ width: w, height: h, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB });
  const c = surf.getCanvas();
  c.clear(CK.TRANSPARENT);
  const r = renderScene(CK, c, scene, { surfaceSize: [w, h] });
  surf.flush();
  const img = surf.makeImageSnapshot();
  // (CanvasKit 0.41.0 sizes an F32 readPixels result 4× too long: slice.)
  const f = (img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB }) as Float32Array).slice(0, w * h * 4);
  r.release();
  img.delete();
  surf.delete();
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = f[i * 4 + 3];
  return out;
}

interface Diff {
  max: number;
  mean: number;
  over1: number; // fraction of channels off by more than 1/255
}
function diff(a: ArrayLike<number>, b: ArrayLike<number>): Diff {
  let max = 0;
  let sum = 0;
  let over = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    sum += d;
    if (d > 1) over++;
  }
  return { max, mean: sum / a.length / 255, over1: over / a.length };
}
const fmt = (d: Diff) => `max ${d.max.toFixed(1)}/255, mean ${(d.mean * 255).toFixed(3)}/255, ${(d.over1 * 100).toFixed(2)}% > 1/255`;

// Run a filter node's compute over a content drawing, defaults + overrides.
function runFilter(type: string, params: Record<string, unknown>, content: SkiaNode, size = S, nodeId = "f"): SkiaDrawValue {
  const def = getNodeDef(type)!;
  const p: Record<string, unknown> = {};
  for (const d of def.params) p[d.name] = d.default;
  Object.assign(p, params);
  const ctx = dataOnlyContext({ width: size, height: size }, timeline);
  const out = def.compute({ inputs: { content: { kind: "skia_draw", node: content } }, auxIn: {}, params: p, ctx, nodeId }) as { primary: SkiaDrawValue };
  return out.primary;
}

// Test content (canvas px), well inside the canvas: colored, translucent
// and opaque shapes on transparency, and a full-canvas variant.
function shapes(size = S, background = false): SkiaNode {
  const k = size / 64;
  const shape = (x: number, y: number, w: number, h: number, c: [number, number, number, number], circle = false): SkiaNode => ({
    k: "shape",
    geom: circle ? { k: "circle", cx: bindStatic((x + w / 2) * k), cy: bindStatic((y + h / 2) * k), r: bindStatic((w / 2) * k) } : { k: "rect", x: bindStatic(x * k), y: bindStatic(y * k), w: bindStatic(w * k), h: bindStatic(h * k) },
    paint: { style: "fill", color: bindStatic(c) },
  });
  return {
    k: "group",
    children: [
      ...(background ? [{ k: "fill", paint: { style: "fill", color: bindStatic([0.15, 0.2, 0.35, 1]) } } as SkiaNode] : []),
      shape(14, 14, 20, 16, [1, 0.55, 0.2, 1]),
      shape(30, 26, 18, 22, [0.2, 0.75, 1, 0.6]),
      shape(18, 36, 12, 12, [1, 1, 1, 1], true),
      shape(40, 12, 8, 8, [0.9, 0.2, 0.6, 1], true),
    ],
  };
}

// ---- 1. defs --------------------------------------------------------------------------------
{
  for (const t of FILTER_TYPES) {
    const def = getNodeDef(t);
    check(`${t} is registered as a filter`, !!def && def.skia?.class === "filter" && (def.skia?.mirrors ?? null) === (MIRRORS[t] ?? null), JSON.stringify(def?.skia));
    if (!def) continue;
    const content = def.inputs.find((i) => i.name === "content");
    check(`${t}: content (skia_draw) in, skia_draw out, no universal mask, facts`, content?.type === "skia_draw" && def.primaryOutput === "skia_draw" && def.noMaskInput === true && !!def.facts?.gotchas?.length);
  }
  const same = (skia: string, gl: string, names: string[]) => {
    const a = getNodeDef(skia)!;
    const b = getNodeDef(gl)!;
    const bad = names.filter((n) => a.params.find((p) => p.name === n) !== b.params.find((p) => p.name === n));
    check(`${skia} carries ${gl}'s own ParamDefs (${names.length})`, bad.length === 0, bad.join(", "));
  };
  same("skia-blur", "blur", ["mode", "radius", "linearize"]);
  same("skia-bloom", "bloom", ["threshold", "soft_knee", "intensity", "levels", "karis_average", "quality", "anamorphic", "tint_low", "tint_high", "tint_amount"]);
  same("skia-grain", "grain", ["scale", "luminance", "chromatic", "seed", "mix_mode", "mix", "view"]);
  same("skia-lens-flare", "lens-flare", ["threshold", "soft_knee", "intensity", "tint", "num_ghosts", "ghost_dispersal", "chromatic_aberration", "halo_width", "halo_intensity", "streak_strength", "streak_length", "streak_axis"]);
  const mixOpts = getNodeDef("grain")!.params.find((p) => p.name === "mix_mode")?.options ?? [];
  check("Grain (Skia)'s mix-mode indices are Grain's shader indices", JSON.stringify(mixOpts) === JSON.stringify(grainMod.SKIA_GRAIN_MIX_MODES));
  const models = getNodeDef("grain")!.params.find((p) => p.name === "model")?.options ?? [];
  check("Grain (Skia)'s model list is Grain's", JSON.stringify([...models].sort()) === JSON.stringify([...grainMod.SKIA_GRAIN_MODELS].sort()), models.join(","));
}

// ---- 2. Blur (Skia) ---------------------------------------------------------------------------
{
  // The GL node's kernel: gaussianPlan's weights, sigma = r/2, ceil(3σ) taps ≤ 64.
  const glVariance = (r: number) => {
    const s = r * 0.5;
    const half = Math.min(64, Math.max(1, Math.ceil(s * 3)));
    const w = buildGaussianWeights(s, half);
    let sw = 0;
    let sv = 0;
    for (let i = -half; i <= half; i++) {
      const wi = w[Math.abs(i) * 4];
      sw += wi;
      sv += wi * i * i;
    }
    return { sum: sw, sigma: Math.sqrt(sv / sw) };
  };
  const rows: string[] = [];
  let worst = 0;
  for (const r of [2, 4, 12, 24, 42]) {
    const g = glVariance(r);
    worst = Math.max(worst, Math.abs(g.sigma - r / 2) / (r / 2));
    rows.push(`r ${r}: σ_GL ${g.sigma.toFixed(3)}`);
  }
  // ceil(3σ) truncation and the discrete sampling move σ a little at small r.
  check("Blur's GL kernel (normalized) has sigma = radius / 2 up to its tap cap", worst < 0.02, `${rows.join(", ")}; worst ${(worst * 100).toFixed(2)}%`);
  let worstT = 0;
  for (const r of [50, 70, 120, 400]) worstT = Math.max(worstT, Math.abs(glVariance(r).sigma - blurMod.glBlurSigma(r)));
  // (The GL weights are Float32: agreement to fp32.)
  check("past the cap, glBlurSigma is the truncated GL kernel's own spread", worstT < 1e-5, `${worstT}`);

  const v = runFilter("skia-blur", { radius: 12, linearize: false }, shapes());
  const n = v.node as Extract<SkiaNode, { k: "group" }>;
  const f = n.layer?.imageFilters?.[0] as Extract<ImageFilterIR, { k: "blur" }> | undefined;
  check(
    "Blur (Skia): one Blur on the content's layer, σ = radius × 0.5 as a scaled ref (a keyframed radius exports ×0.5)",
    n.k === "group" && n.layer?.imageFilters?.length === 1 && f?.k === "blur" && f.sx === f.sy && f.sx.v === 6 && f.sx.ref?.param === "radius" && f.sx.ref?.scale === 0.5 && f.tile === "clamp",
    JSON.stringify(f)
  );
  const big = runFilter("skia-blur", { radius: 70, linearize: false }, shapes()).node as any;
  check("past the GL cap the sigma is derived (variance-matched), not radius × 0.5", big.layer.imageFilters[0].sx.v === blurMod.glBlurSigma(70) && !big.layer.imageFilters[0].sx.ref && big.layer.imageFilters[0].sx.deps?.[0]?.param === "radius");
  const lin = runFilter("skia-blur", { radius: 12, linearize: true }, shapes()).node as any;
  check(
    "linear light: outer layer [blur] + linearToSrgb, inner layer srgbToLinear around the content",
    lin.layer.imageFilters[0].k === "blur" && lin.layer.colorFilters?.[0]?.k === "linearToSrgb" && lin.children[0].layer.colorFilters?.[0]?.k === "srgbToLinear" && !lin.children[0].layer.imageFilters,
    JSON.stringify({ outer: lin.layer.colorFilters, inner: lin.children[0].layer })
  );
  for (const mode of ["bokeh", "convolve"]) {
    const r = runFilter("skia-blur", { mode, radius: 12 }, shapes());
    check(`mode ${mode} refuses with a reason and passes the content through`, (r.problems ?? []).some((p) => p.includes(mode)) && (r.node as any).layer === undefined);
  }

  // CanvasKit's blur, measured: a 1-px line's spread under Blur (Skia).
  const W = 192;
  const line: SkiaNode = { k: "shape", geom: { k: "rect", x: bindStatic(96), y: bindStatic(0), w: bindStatic(1), h: bindStatic(W) }, paint: { style: "fill", color: bindStatic([1, 1, 1, 1]), antiAlias: false } };
  const meas: string[] = [];
  let worstM = 0;
  for (const r of [3, 8, 16, 30]) {
    const out = runFilter("skia-blur", { radius: r, linearize: false }, line, W);
    // F32 surface: an 8-bit layer would clip the Gaussian's tails to 0.
    const px = drawAlphaF32(sceneFor(out.node, W));
    let sw = 0;
    let sx = 0;
    let sv = 0;
    const y = W / 2;
    for (let x = 0; x < W; x++) sw += px[y * W + x];
    for (let x = 0; x < W; x++) sx += px[y * W + x] * (x + 0.5);
    const cx = sx / sw;
    for (let x = 0; x < W; x++) sv += px[y * W + x] * (x + 0.5 - cx) ** 2;
    const sigma = Math.sqrt(sv / sw - 1 / 12); // minus the 1-px line's own width
    worstM = Math.max(worstM, Math.abs(sigma - r / 2) / (r / 2));
    meas.push(`r ${r}: σ ${sigma.toFixed(2)} (want ${r / 2})`);
  }
  // CanvasKit's CPU raster approximates a Gaussian with box passes whose
  // integer widths miss the variance by up to ~8% (σ 8 draws 7.39); the
  // GPU backends (the editor's WebGL, Graphite on device) run true
  // Gaussians — compare:skia's MATCH is that number.
  check("CanvasKit (CPU) draws Blur (Skia) with sigma = radius / 2 (measured from a line's spread, F32)", worstM < 0.1, `${meas.join(", ")}; worst ${(worstM * 100).toFixed(1)}%`);
}

// ---- 3. CPU references --------------------------------------------------------------------
const content = shapes();
const contentPx = draw(sceneFor(content, S)).px;
const at = (px: Uint8Array, x: number, y: number, c: number, w = S) => (x < 0 || y < 0 || x >= w || y >= w ? 0 : px[(y * w + x) * 4 + c]);

// 3a. Morphology: square window, radius rounded, per channel.
{
  for (const [op, r] of [["dilate", 2], ["erode", 1], ["dilate", 1.4], ["dilate", 1.5]] as const) {
    const out = runFilter("skia-morphology", { op, radius: r }, content);
    const got = draw(sceneFor(out.node, S)).px;
    const R = Math.round(r);
    const ref = new Uint8Array(got.length);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        for (let c = 0; c < 4; c++) {
          let m = op === "dilate" ? 0 : 255;
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) m = op === "dilate" ? Math.max(m, at(contentPx, x + dx, y + dy, c)) : Math.min(m, at(contentPx, x + dx, y + dy, c));
          ref[(y * S + x) * 4 + c] = m;
        }
      }
    }
    const d = diff(got, ref);
    check(`Morphology (Skia) ${op} r=${r} ≡ the (2·round(r)+1)² square max/min of the content`, d.max === 0, fmt(d));
  }
}

// 3b. Color Matrix: unpremultiplied 4×5, translate in 0..1.
{
  const cases: [string, Record<string, unknown>][] = [
    ["adjust", { mode: "adjust", brightness: 0.05, contrast: 1.2, saturation: 0.4, hue: 35, sepia: 0.2, invert: 0.1, opacity: 0.8 }],
    ["custom", { mode: "custom", matrix: "0 0 1 0 0, 0 1 0 0 0.1, 1 0 0 0 0, 0 0 0 1 0" }],
  ];
  for (const [label, params] of cases) {
    const out = runFilter("skia-color-matrix", params, content);
    const m = ((out.node as any).layer.colorFilters[0].m.v as number[]).slice();
    const got = draw(sceneFor(out.node, S)).px;
    const ref = new Uint8Array(got.length);
    for (let i = 0; i < got.length; i += 4) {
      const a = contentPx[i + 3] / 255;
      const u = a > 0 ? [contentPx[i] / 255 / a, contentPx[i + 1] / 255 / a, contentPx[i + 2] / 255 / a, a] : [0, 0, 0, 0];
      const o = [0, 1, 2, 3].map((r) => Math.max(0, Math.min(1, m[r * 5] * u[0] + m[r * 5 + 1] * u[1] + m[r * 5 + 2] * u[2] + m[r * 5 + 3] * u[3] + m[r * 5 + 4])));
      // An all-transparent pixel stays transparent only if the matrix maps
      // alpha 0 to 0 (Skia doesn't run colour filters on empty layer pixels).
      const oa = a > 0 ? o[3] : 0;
      ref[i] = Math.round(o[0] * oa * 255);
      ref[i + 1] = Math.round(o[1] * oa * 255);
      ref[i + 2] = Math.round(o[2] * oa * 255);
      ref[i + 3] = Math.round(oa * 255);
    }
    const d = diff(got, ref);
    check(`Color Matrix (Skia) ${label} ≡ the 4×5 matrix on unpremultiplied content`, d.max <= 2, fmt(d));
  }
  // The adjust matrices vs their CSS Filter Effects definitions on colors.
  const apply = (m: number[], c: number[]) => [0, 1, 2].map((r) => m[r * 5] * c[0] + m[r * 5 + 1] * c[1] + m[r * 5 + 2] * c[2] + m[r * 5 + 4]);
  const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  const base = { brightness: 0, contrast: 1, saturation: 1, hue: 0, sepia: 0, invert: 0, opacity: 1 };
  const c0 = [0.8, 0.3, 0.1];
  const l = 0.2126 * c0[0] + 0.7152 * c0[1] + 0.0722 * c0[2];
  check("saturation 0 → Rec. 709 luma gray", near(apply(cmMod.adjustMatrix45({ ...base, saturation: 0 }), c0), [l, l, l]));
  check("invert 1 → 1 − c; contrast 2 → (c − ½)·2 + ½; brightness +0.1 adds", near(apply(cmMod.adjustMatrix45({ ...base, invert: 1 }), c0), c0.map((x) => 1 - x)) && near(apply(cmMod.adjustMatrix45({ ...base, contrast: 2 }), c0), c0.map((x) => (x - 0.5) * 2 + 0.5)) && near(apply(cmMod.adjustMatrix45({ ...base, brightness: 0.1 }), c0), c0.map((x) => x + 0.1)));
  const sep = apply(cmMod.adjustMatrix45({ ...base, sepia: 1 }), c0);
  check("sepia 1 = CSS sepia(1)", near(sep, [0.393 * 0.8 + 0.769 * 0.3 + 0.189 * 0.1, 0.349 * 0.8 + 0.686 * 0.3 + 0.168 * 0.1, 0.272 * 0.8 + 0.534 * 0.3 + 0.131 * 0.1]));
  const h0 = apply(cmMod.adjustMatrix45({ ...base, hue: 0.0001 }), c0);
  check("hue ≈ 0 is ≈ identity, hue 360 = identity (CSS hue-rotate)", h0.every((x, i) => Math.abs(x - c0[i]) < 1e-5) && near(apply(cmMod.adjustMatrix45({ ...base, hue: 360 }), c0), c0));
  const bad = runFilter("skia-color-matrix", { mode: "custom", matrix: "1 2 3" }, content);
  check("a custom matrix that isn't 20 numbers is a problem (identity drawn)", (bad.problems ?? []).some((p) => p.includes("20 numbers")));
}

// 3c. Drop Shadow: drop = shadow (Skia's blur of the offset, tinted alpha)
// under the content; inner = RN's MakeInnerShadow (the blurred, offset
// complement of the shape's saturated alpha, clipped back into it, over the
// content). The masks are built here and blurred by CanvasKit's own Blur
// (on CPU raster a box-pass approximation of the Gaussian that the Blur
// check above measures), so what is held exactly is the composite.
{
  // Skia's blur of an alpha mask given on a (S + 2M)² grid, cropped to S².
  const skiaBlurAlpha = (mask: Float64Array, M: number, sigma: number): Float64Array => {
    const W = S + 2 * M;
    const bytes = new Uint8Array(W * W * 4);
    for (let i = 0; i < W * W; i++) {
      bytes[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, mask[i])) * 255);
    }
    const img = CK.MakeImage({ width: W, height: W, alphaType: CK.AlphaType.Premul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, bytes, W * 4);
    const surf = CK.MakeSurface(W, W);
    const c = surf.getCanvas();
    c.clear(CK.TRANSPARENT);
    const lp = new CK.Paint();
    lp.setImageFilter(CK.ImageFilter.MakeBlur(sigma, sigma, CK.TileMode.Decal, null));
    c.saveLayer(lp);
    c.drawImage(img, 0, 0);
    c.restore();
    surf.flush();
    const px = c.readPixels(0, 0, { width: W, height: W, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB });
    const out = new Float64Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = px[((y + M) * W + x + M) * 4 + 3] / 255;
    for (const o of [lp, img, surf]) o.delete();
    return out;
  };
  const alpha = new Float64Array(S * S).map((_, i) => contentPx[i * 4 + 3] / 255);
  const hex = "#1a0033cc";
  const sc = [0x1a / 255, 0, 0x33 / 255, 0xcc / 255];
  for (const [mode, dx, dy, b] of [["drop", 3, 4, 6], ["inner", 2, 3, 4]] as const) {
    const out = runFilter("skia-drop-shadow", { dx, dy, blur: b, color: hex, mode }, content);
    const got = draw(sceneFor(out.node, S)).px;
    const sigma = b / 2;
    const M = Math.ceil(3 * sigma) + Math.max(Math.abs(dx), Math.abs(dy)) + 2;
    const W = S + 2 * M;
    // The mask on the extended grid, offset by (dx, dy): content alpha for
    // a drop shadow; the complement of the saturated alpha (1 off the
    // shape, the canvas outside included) for an inner one.
    const mask = new Float64Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const sx = x - M - dx;
      const sy = y - M - dy;
      const inside = sx >= 0 && sy >= 0 && sx < S && sy < S;
      const a = inside ? alpha[sy * S + sx] : 0;
      mask[y * W + x] = mode === "drop" ? a : a > 0 ? 0 : 1;
    }
    const sh = skiaBlurAlpha(mask, M, sigma);
    const ref = new Uint8Array(got.length);
    for (let i = 0; i < S * S; i++) {
      const ca = alpha[i];
      if (mode === "drop") {
        const sa = sh[i] * sc[3];
        for (let c = 0; c < 3; c++) ref[i * 4 + c] = Math.round((contentPx[i * 4 + c] / 255 + sc[c] * sa * (1 - ca)) * 255);
        ref[i * 4 + 3] = Math.round((ca + sa * (1 - ca)) * 255);
      } else {
        const sa = sh[i] * sc[3] * ca;
        for (let c = 0; c < 3; c++) ref[i * 4 + c] = Math.round((sc[c] * sa + (contentPx[i * 4 + c] / 255) * (1 - sa)) * 255);
        ref[i * 4 + 3] = Math.round((sa + ca * (1 - sa)) * 255);
      }
    }
    const d = diff(got, ref);
    if (process.env.FILTERS_DEBUG) {
      let wi = 0;
      for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - ref[i]) > Math.abs(got[wi] - ref[wi])) wi = i;
      const p = wi >> 2;
      info(`${mode} worst at (${p % S}, ${Math.floor(p / S)}) ch ${wi & 3}: got [${got.slice(p * 4, p * 4 + 4)}] ref [${ref.slice(p * 4, p * 4 + 4)}] content [${contentPx.slice(p * 4, p * 4 + 4)}]`);
    }
    check(`Drop Shadow (Skia) ${mode} ≡ its definition over Skia's blur (σ = blur / 2, offset, colour, ${mode === "drop" ? "under the content" : "clipped into it"})`, d.max <= 2, fmt(d));
  }
}

// 3d. Grain (classic): Grain's float hash, fp32, cell for cell.
const f32 = Math.fround;
function fract32(x: number) {
  return f32(x - Math.floor(x));
}
function hash13(x: number, y: number, z: number): number {
  let px = fract32(f32(x * f32(0.1031)));
  let py = fract32(f32(y * f32(0.1031)));
  let pz = fract32(f32(z * f32(0.1031)));
  const c = f32(33.33);
  const d = f32(f32(f32(px * f32(py + c)) + f32(py * f32(pz + c))) + f32(pz * f32(px + c)));
  px = f32(px + d);
  py = f32(py + d);
  pz = f32(pz + d);
  return fract32(f32(f32(px + py) * pz));
}
function gaussian(x: number, y: number, z: number) {
  return f32(f32(hash13(x, y, z) + hash13(f32(x + 17), f32(y + 31), f32(z + 13))) - 1);
}
{
  const cases: Record<string, unknown>[] = [
    { scale: 1, luminance: 0.3, chromatic: 0, seed: 0, mix_mode: "overlay", mix: 1 },
    { scale: 3, luminance: 0.15, chromatic: 0.12, seed: 17, mix_mode: "add", mix: 0.7 },
    { scale: 2, luminance: 0.25, chromatic: 0.05, seed: 3, mix_mode: "soft-light", mix: 1 },
  ];
  const bg = shapes(S, true);
  const bgPx = draw(sceneFor(bg, S)).px;
  for (const p of cases) {
    const out = runFilter("skia-grain", p, bg);
    const got = draw(sceneFor(out.node, S)).px;
    const ref = new Uint8Array(got.length);
    const mode = grainMod.SKIA_GRAIN_MIX_MODES.indexOf(p.mix_mode as never);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        // Grain's v_uv · u_res: x, y from the bottom.
        const cx = Math.floor((x + 0.5) / Math.max(p.scale as number, 1));
        const cy = Math.floor((S - (y + 0.5)) / Math.max(p.scale as number, 1));
        const seed = p.seed as number;
        const gl = gaussian(cx, cy, seed);
        const g3 = [gaussian(cx, cy, f32(seed + 11.13)), gaussian(cx, cy, f32(seed + 41.27)), gaussian(cx, cy, f32(seed + 73.91))];
        const a = bgPx[i + 3] / 255;
        const base = [0, 1, 2].map((c) => (a > 0 ? bgPx[i + c] / 255 / a : 0));
        const grain = [0, 1, 2].map((c) => gl * (p.luminance as number) + g3[c] * (p.chromatic as number));
        const out3 = base.map((b, c) => {
          const g = grain[c];
          const layer = Math.max(0, Math.min(1, 0.5 + g * 0.5));
          let m: number;
          if (mode === 0) m = b + g;
          else if (mode === 2) m = b < 0.5 ? 2 * b * layer : 1 - 2 * (1 - b) * (1 - layer);
          else if (mode === 3) m = (1 - 2 * layer) * b * b + 2 * layer * b;
          else m = b;
          return b + (m - b) * Math.max(0, Math.min(1, p.mix as number));
        });
        for (let c = 0; c < 3; c++) ref[i + c] = Math.round(Math.max(0, Math.min(1, out3[c] * a)) * 255);
        ref[i + 3] = Math.round(a * 255);
      }
    }
    const d = diff(got, ref);
    // fp32 here and in Skia's CPU backend agree but for the odd fract()
    // rounding that flips a hash (a different grain value in one cell);
    // on the GPU compare:skia measures Grain vs Grain (Skia) at max 1/255.
    check(`Grain (Skia) classic ${p.mix_mode} scale ${p.scale} ≡ Grain's fp32 hash per cell`, d.over1 < 0.002, `${fmt(d)} (a hash flip moves one cell)`);
  }
  const v2 = runFilter("skia-grain", { model: "fine" }, shapes());
  check("Grain (Skia) model fine refuses (uint pcg3d) and passes the content through", (v2.problems ?? []).some((p) => p.includes("pcg3d")) && (v2.node as any).layer === undefined);
}

// 3e. SkSL Filter: the default source and the fixture's, against JS.
{
  const def = getNodeDef("skia-sksl-filter")!;
  const src = fx.SKSL_FILTER_SOURCE;
  const prog = buildSkslFilterProgram({ expression: src, inputs: fx.SKSL_FILTER_CHANNELS });
  const c = compileSksl(CK, prog.sksl);
  check("SkSL Filter: the program compiles in CanvasKit", !!c.effect, c.error ?? "");
  check("…declares content as its only child, iResolution / iTime and the channels", prog.sksl.includes("uniform shader content;") && !/uniform shader iImage/.test(prog.sksl) && prog.channels.map((x) => x.name).join() === "amount,tint");
  const rw = rewriteSkslFilterSource(src);
  check("…the source rewrite renames main and content.eval in code only, with no line moves", rw.hasMain && rw.code.split("\n").length === src.split("\n").length && /tbx_eval_content\(fragCoord\)/.test(rw.code) && !/\bcontent\.eval/.test(rw.code));
  const broken = buildSkslFilterProgram({ expression: "half4 main(float2 p) {\n  float4 c = content.eval(p);\n  return c.rgbz;\n}", inputs: [] });
  const err = compileSksl(CK, broken.sksl);
  const mapped = err.error ? skslFilterError(err.error, broken) : "";
  check("…a Skia error maps to the user's line and names", /line 3/.test(mapped) && !/tbx_/.test(mapped), mapped.split("\n")[0]);
  check("…lints: iImage1 and uniform lines are problems, no content.eval is a warning", lintSkslFilter("half4 main(float2 p) { return iImage1.eval(p); }").problems.length > 0 && lintSkslFilter("uniform float k;\nhalf4 main(float2 p) { return content.eval(p); }").problems.length > 0 && lintSkslFilter("half4 main(float2 p) { return half4(1); }").warnings.length > 0);
  {
    const rsrc = `// ramp("grad")\nhalf4 main(float2 p) { float4 c = content.eval(p); return half4(c); }`;
    const { syncChannelInputs } = await import("@/engine/expr-channels");
    const rp = buildSkslFilterProgram({ expression: rsrc, inputs: syncChannelInputs([], rsrc) });
    check(
      "…ramp / curve channels are refused (their LUT children can't ride a one-child RuntimeShader filter), content stays the only child",
      rp.unsupported.includes("grad") && (rp.sksl.match(/uniform shader /g) ?? []).length === 1,
      `${rp.unsupported.join(",")} / ${(rp.sksl.match(/uniform shader \w+/g) ?? []).join(", ")}`
    );
  }
  check("…its default source compiles and syncs its channels", !!compileSksl(CK, buildSkslFilterProgram({ expression: def.params.find((p) => p.name === "expression")!.default, inputs: def.params.find((p) => p.name === "inputs")!.default }).sksl).effect);
  const bg = shapes(S, true);
  const bgPx = draw(sceneFor(bg, S)).px;
  const out = runFilter("skia-sksl-filter", { expression: src, inputs: fx.SKSL_FILTER_CHANNELS }, bg);
  const prog2 = ((out.node as any).layer.imageFilters[0] as Extract<ImageFilterIR, { k: "runtime" }>).program;
  check("…channels bind as ch:<name> refs (keyframable / wireable), iTime as the clock", (prog2.uniforms.amount as any).ref?.param === "ch:amount" && (prog2.uniforms.tint as any).ref?.param === "ch:tint" && !prog2.uniforms.iTime.ref);
  const got = draw(sceneFor(out.node, S)).px;
  const ref = new Uint8Array(got.length);
  const amount = 0.6;
  const tint = [1, 0xb0 / 255, 0x70 / 255];
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const u = [(x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5];
    const v = 1 - amount * smooth(0.25, 0.75, Math.hypot(u[0], u[1]));
    for (let k = 0; k < 3; k++) {
      const cc = bgPx[i + k] / 255;
      ref[i + k] = Math.round(Math.max(0, Math.min(1, (cc + (cc * tint[k] - cc) * 0.5 * amount) * v)) * 255);
    }
    ref[i + 3] = bgPx[i + 3];
  }
  const d = diff(got, ref);
  check("…renders the fixture's vignette over the content as the JS reference does", d.max <= 1, fmt(d));
}

// 3f. Bloom's bright pass: the soft knee, verbatim.
{
  const ramp: SkiaNode = { k: "fill", paint: { style: "fill", shader: { k: "linear", start: [bindStatic(0), bindStatic(0)], end: [bindStatic(S), bindStatic(0)], stops: [{ pos: bindStatic(0), color: bindStatic([0, 0, 0, 1]) }, { pos: bindStatic(1), color: bindStatic([1, 0.6, 0.3, 1]) }] } } };
  const rampPx = draw(sceneFor(ramp, S)).px;
  // The threshold program alone (weight 1), its additive light composited
  // with plus over transparent so its rgb is readable.
  const out = runFilter("skia-bloom", { threshold: 0.4, soft_knee: 0.5, intensity: 1, levels: 1 }, ramp);
  const glow = (out.node as any).children[1];
  const prog = glow.layer.imageFilters[0] as Extract<ImageFilterIR, { k: "runtime" }>;
  const probe: SkiaNode = { k: "group", layer: { imageFilters: [prog], blendMode: "plus" }, children: [ramp] };
  const got = draw(sceneFor(probe, S)).px;
  const brighten = (c: number[], thr: number, k: number) => {
    const br = Math.max(...c);
    const knee = Math.max(k * thr, 1e-4);
    const t = thr - knee;
    const c2 = Math.max(knee * 2, 1e-4);
    let rq = Math.max(0, Math.min(c2, br - t));
    rq = rq * rq * (0.25 / c2);
    const gain = Math.max(rq, br - thr) / Math.max(br, 1e-5);
    return c.map((x) => x * Math.max(gain, 0));
  };
  let worst = 0;
  for (let x = 0; x < S; x++) {
    const i = ((S >> 1) * S + x) * 4;
    const b = brighten([0, 1, 2].map((c) => rampPx[i + c] / 255), 0.4, 0.5);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[i + c] - Math.round(b[c] * 255)));
  }
  check("Bloom (Skia)'s bright pass is Bloom's soft-knee threshold (additive light, alpha 0)", worst <= 1 && got[((S >> 1) * S + S - 1) * 4 + 3] === 0, `max ${worst}/255`);
}

// ---- 4. Bloom (Skia): the mip chain -----------------------------------------------------------
{
  // Bloom's GL chain in one dimension (its marginal along x), exact taps:
  // texel centres at (i + ½)·s, bilinear between them, clamp to the edge.
  type Tex = { s: number; v: Float64Array };
  const sample = (t: Tex, x: number) => {
    // x in full-res px; texel i covers [i·s, (i+1)·s).
    const u = x / t.s - 0.5;
    const i0 = Math.floor(u);
    const f = u - i0;
    const n = t.v.length;
    const g = (i: number) => t.v[Math.max(0, Math.min(n - 1, i))];
    return g(i0) * (1 - f) + g(i0 + 1) * f;
  };
  const N = 2048;
  // Level j's PHASE-AVERAGED impulse response: the mip chain decimates, so
  // what a pixel receives depends on where it sits in each texel; a blur
  // stands in for the average over every phase (an impulse at each offset
  // within the coarsest texel), measured about the impulse itself.
  const simulate = (levels: number, div: number, karis: boolean, a: number) => {
    const sx = a < 0 ? 1 + (0.15 - 1) * -a : 1;
    const P = div * 2 ** (levels - 1);
    const h = Array.from({ length: levels }, () => new Float64Array(2 * N));
    for (let phase = 0; phase < P; phase++) {
      const x0 = N / 2 + phase;
      const src: Tex = { s: 1, v: new Float64Array(N) };
      src.v[x0] = 1;
      // Bright pass at 1/div: 2 taps at ±div/4 px (×0.5 each).
      const base: Tex = { s: div, v: new Float64Array(Math.floor(N / div)) };
      for (let i = 0; i < base.v.length; i++) {
        const c = (i + 0.5) * div;
        base.v[i] = 0.5 * (sample(src, c - div / 4) + sample(src, c + div / 4));
      }
      const down: Tex[] = [base];
      for (let j = 1; j < levels; j++) {
        const p = down[j - 1];
        const t: Tex = { s: p.s * 2, v: new Float64Array(Math.max(2, Math.floor(p.v.length / 2))) };
        for (let i = 0; i < t.v.length; i++) {
          const c = (i + 0.5) * t.s;
          const o = (k: number) => sample(p, c + k * p.s);
          // x-marginals of COD's 13 taps, and of Karis's five equal groups
          // (its weights ≈ 1 in the linear regime of a faint impulse).
          t.v[i] = karis && j === 1 ? 0.2 * (o(-2) + o(2)) + 0.4 * o(0) + 0.1 * (o(-1) + o(1)) : 0.125 * (o(-2) + o(2)) + 0.25 * (o(-1) + o(0) + o(1));
        }
        down.push(t);
      }
      for (let j = 0; j < levels; j++) {
        let cur: Tex = down[j];
        for (let i = j - 1; i >= 0; i--) {
          const dst: Tex = { s: down[i].s, v: new Float64Array(down[i].v.length) };
          for (let k = 0; k < dst.v.length; k++) {
            const c = (k + 0.5) * dst.s;
            const r = dst.s * sx;
            dst.v[k] = (sample(cur, c - r) + 2 * sample(cur, c) + sample(cur, c + r)) / 4;
          }
          cur = dst;
        }
        // Final bilinear upsample to full res, aligned on the impulse.
        for (let x = 0; x < N; x++) h[j][x - x0 + N] += sample(cur, x + 0.5);
      }
    }
    return h.map((hj) => {
      let sw = 0;
      let sv = 0;
      for (let d = -N; d < N; d++) {
        sw += hj[d + N];
        sv += hj[d + N] * d * d;
      }
      return Math.sqrt(sv / sw);
    });
  };
  for (const [label, params] of [
    ["high, Karis", { quality: "high", karis_average: true }],
    ["high, no Karis", { quality: "high", karis_average: false }],
    ["balanced", { quality: "balanced", karis_average: false }],
    ["performance", { quality: "performance", karis_average: false }],
    ["anamorphic −0.6 (x)", { quality: "high", karis_average: false, anamorphic: -0.6 }],
  ] as [string, Record<string, unknown>][]) {
    const p: Record<string, unknown> = { levels: 6, ...params };
    const want = bloomMod.bloomLevelSigmas(p, 512, 512).map((s) => s[0]);
    const { div } = bloomMod.bloomChain(p, 512, 512);
    const sim = simulate(want.length, div, p.karis_average === true, (p.anamorphic as number) ?? 0);
    const rel = Math.max(...want.map((w, j) => Math.abs(w - sim[j]) / sim[j]));
    check(
      `bloomLevelSigmas (${label}) = the spread of each level through Bloom's GL chain`,
      rel < 0.06,
      `σ ${want.map((w) => w.toFixed(1)).join(" ")} vs simulated ${sim.map((w) => w.toFixed(1)).join(" ")} (worst ${(rel * 100).toFixed(1)}%)`
    );
  }
  // Levels: Bloom's own clamps.
  check("bloomChain clamps levels like Bloom (smallest mip ≥ 4 px, quality skips octaves)", bloomMod.bloomChain({ levels: 8 }, 512, 512).levels === 7 && bloomMod.bloomChain({ levels: 6, quality: "balanced" }, 512, 512).levels === 5 && bloomMod.bloomChain({ levels: 6 }, 64, 64).levels === 4);
  // Weights: Bloom's upsample loop, transcribed.
  {
    const p = { intensity: 1.5, tint_amount: 0.7, tint_low: "#ffcc66", tint_high: "#3366ff" };
    const L = 5;
    const lo = [1, 0xcc / 255, 0x66 / 255];
    const hi = [0x33 / 255, 0x66 / 255, 1];
    // up[i] = down[i] + t_i·T(up[i+1]): level j carries Π_{i<j} t_i.
    const tint = (i: number) => {
      const t = 1 - i / (L - 1);
      return [0, 1, 2].map((k) => 1 - 0.7 + 0.7 * (hi[k] + (lo[k] - hi[k]) * t));
    };
    const want: number[][] = [];
    for (let j = 0; j < L; j++) {
      let w = [1, 1, 1];
      for (let i = 0; i < j; i++) w = w.map((x, k) => x * tint(i)[k]);
      want.push(w.map((x) => x * 1.5));
    }
    const got = bloomMod.bloomLevelWeights(p, L);
    check("bloomLevelWeights = intensity × the tints on each level's way up", got.every((w, j) => w.every((x, k) => Math.abs(x - want[j][k]) < 1e-12)));
  }
  // The composite: glow only where the content is, alpha untouched.
  {
    const out = runFilter("skia-bloom", { threshold: 0.3, intensity: 1.5, levels: 3 }, content);
    const got = draw(sceneFor(out.node, S)).px;
    let alphaSame = true;
    let glowOnTransparent = 0;
    let brighter = 0;
    for (let i = 0; i < got.length; i += 4) {
      if (Math.abs(got[i + 3] - contentPx[i + 3]) > 0) alphaSame = false;
      if (contentPx[i + 3] === 0 && (got[i] || got[i + 1] || got[i + 2])) glowOnTransparent++;
      if (got[i] + got[i + 1] + got[i + 2] > contentPx[i] + contentPx[i + 1] + contentPx[i + 2]) brighter++;
    }
    check("Bloom (Skia) composites srcATop additive light: alpha unchanged, no glow on transparency, brighter elsewhere", alphaSame && glowOnTransparent === 0 && brighter > 50, `${glowOnTransparent} transparent px lit, ${brighter} px brighter`);
    const n = out.node as any;
    check("…structure: an isolating layer, the content, one srcATop glow layer per level [bright pass, blur]", n.layer && Object.keys(n.layer).length === 0 && n.children.length === 4 && n.children.slice(1).every((c: any) => c.layer.blendMode === "srcATop" && c.layer.imageFilters[0].k === "runtime" && c.layer.imageFilters[1].k === "blur"));
  }
}

// ---- 5. the renderer -----------------------------------------------------------------------------
{
  const red: SkiaNode = { k: "fill", paint: { style: "fill", color: bindStatic([0.6, 0.1, 0.1, 1]) } };
  const blue: SkiaNode = { k: "shape", geom: { k: "rect", x: bindStatic(0), y: bindStatic(0), w: bindStatic(S / 2), h: bindStatic(S) }, paint: { style: "fill", color: bindStatic([0.1, 0.2, 0.5, 1]) } };
  // layer.blendMode: a plus layer adds; the same mode on the group itself
  // reaches the draws INSIDE the layer (onto transparency), not the layer.
  for (const emulated of [false, true]) {
    const identity: SkslProgramIR = { sksl: "uniform shader content;\nhalf4 main(float2 p) { return content.eval(p); }", uniforms: {}, children: [] };
    const filters: ImageFilterIR[] = emulated ? [{ k: "runtime", program: identity, content: "content" }] : [];
    const plus = draw(sceneFor({ k: "group", children: [red, { k: "group", layer: { imageFilters: filters, blendMode: "plus" }, children: [blue] }] }, S)).px;
    const inner = draw(sceneFor({ k: "group", children: [red, { k: "group", blendMode: "plus", layer: { imageFilters: filters }, children: [blue] }] }, S)).px;
    const i = ((S >> 1) * S + 2) * 4;
    check(
      `layer.blendMode composites the whole layer (${emulated ? "emulated runtime" : "native"} layer); a group blendMode doesn't`,
      Math.abs(plus[i] - 179) <= 1 && Math.abs(plus[i + 2] - 153) <= 1 && Math.abs(inner[i] - 26) <= 1 && Math.abs(inner[i + 2] - 128) <= 1,
      `plus [${plus.slice(i, i + 4)}], group blendMode [${inner.slice(i, i + 4)}]`
    );
  }
  // The emulated layer's margin: a runtime stage then a blur over a fill
  // (unbounded content) stays opaque at the canvas edge, as native Skia
  // evaluates the runtime stage past it; a half-off-canvas rect blurs in.
  {
    const identity: SkslProgramIR = { sksl: "uniform shader content;\nhalf4 main(float2 p) { return content.eval(p); }", uniforms: {}, children: [] };
    const rt: ImageFilterIR = { k: "runtime", program: identity, content: "content" };
    const bl: ImageFilterIR = { k: "blur", sx: bindStatic(4), sy: bindStatic(4), tile: "decal" };
    const off: SkiaNode = { k: "shape", geom: { k: "rect", x: bindStatic(-S / 2), y: bindStatic(S / 4), w: bindStatic(S), h: bindStatic(S / 2) }, paint: { style: "fill", color: bindStatic([1, 1, 1, 1]) } };
    for (const [label, body] of [["a fill", red], ["a rect half off the canvas", off]] as const) {
      const em = draw(sceneFor({ k: "group", layer: { imageFilters: [rt, bl] }, children: [body] }, S)).px;
      const na = draw(sceneFor({ k: "group", layer: { imageFilters: [bl] }, children: [body] }, S)).px;
      const d = diff(em, na);
      check(`emulated runtime → blur ≡ native blur over ${label} (the margin)`, d.max <= 1, fmt(d));
    }
  }
  // Filters scale with the CTM: a 2× render under canvas.scale(2), box-
  // downsampled, ≡ the 1× render (the exported root group's scale on device).
  {
    const bg = shapes(S, true);
    const cases: [string, string, Record<string, unknown>][] = [
      ["Blur", "skia-blur", { radius: 8, linearize: false }],
      ["Drop Shadow", "skia-drop-shadow", { dx: 3, dy: 2, blur: 6 }],
      ["Morphology", "skia-morphology", { op: "dilate", radius: 2 }],
      ["Grain", "skia-grain", { scale: 2, luminance: 0.3 }],
      ["Bloom", "skia-bloom", { threshold: 0.3, levels: 3 }],
      ["Lens Flare", "skia-lens-flare", { threshold: 0.3 }],
    ];
    for (const [label, type, params] of cases) {
      const out = runFilter(type, params, bg);
      const one = draw(sceneFor(out.node, S)).px;
      const two = draw(sceneFor(out.node, S), 2 * S, 2 * S, 2).px;
      const down = new Uint8Array(one.length);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) acc += two[((2 * y + dy) * 2 * S + 2 * x + dx) * 4 + c];
        down[(y * S + x) * 4 + c] = Math.round(acc / 4);
      }
      const d = diff(down, one);
      // Edges resample; a scaled blur is the same Gaussian.
      check(`${label} (Skia) scales with the CTM (2× under scale(2), downsampled ≡ 1×)`, d.mean * 255 < 2.5, fmt(d));
    }
  }
}

// ---- 6. colour management of the runtime filter programs -----------------------------------------
// Each program drawn as a shader with a colourful, partly translucent image
// as its `content`, on an sRGB F32 surface and a Display P3 F32 one; the P3
// pixels converted back to sRGB here (Display P3 shares sRGB's transfer
// curve; its primaries map through the standard matrix). Premultiplied
// pixels convert unpremultiplied, and alpha-0 additive light (Bloom's glow)
// converts as it is, as tbx_cm_premul_out writes it.
{
  const n = 16;
  const tex = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    tex[i] = Math.round((255 * x) / (n - 1));
    tex[i + 1] = Math.round((255 * y) / (n - 1));
    tex[i + 2] = (x * 37 + y * 11) % 256;
    tex[i + 3] = y < n / 2 ? 255 : 96 + x * 8;
  }
  const img = CK.MakeImage({ width: n, height: n, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, tex, n * 4);
  const programs: [string, SkslProgramIR][] = [];
  const grab = (label: string, node: SkiaNode) => {
    const walk = (x: SkiaNode) => {
      if (x.k !== "group") return;
      for (const f of x.layer?.imageFilters ?? []) if (f.k === "runtime" && !programs.some(([, p]) => p.sksl === f.program.sksl)) programs.push([`${label} ${programs.length}`, f.program]);
      x.children.forEach(walk);
    };
    walk(node);
  };
  const bg = shapes(n, true);
  grab("grain", runFilter("skia-grain", { luminance: 0.3, chromatic: 0.1, mix_mode: "overlay" }, bg, n).node);
  grab("bloom", runFilter("skia-bloom", { threshold: 0.2, levels: 1 }, bg, n).node);
  grab("flare", runFilter("skia-lens-flare", { threshold: 0.2 }, bg, n).node);
  grab("sksl filter", runFilter("skia-sksl-filter", { expression: fx.SKSL_FILTER_SOURCE, inputs: fx.SKSL_FILTER_CHANNELS }, bg, n).node);
  check("every runtime filter program is colour-managed (tbx.color.cm)", programs.length === 6 && programs.every(([, p]) => isColorManagedSksl(p.sksl)), programs.map(([l]) => l).join(", "));
  const CM_OFF = /bool tbx_cm_active\(\) \{[\s\S]*?\n\}/;
  // Raw premultiplied F32 pixels in the surface's own colour space.
  const render = (p: SkslProgramIR, cs: any, cmOff = false): Float32Array => {
    const sksl = cmOff ? p.sksl.replace(CM_OFF, "bool tbx_cm_active() {\n  return false;\n}") : p.sksl;
    const eff = compileSksl(CK, sksl).effect!;
    const vals = new Float32Array(eff.getUniformFloatCount());
    for (let i = 0; i < eff.getUniformCount(); i++) {
      const u = eff.getUniform(i);
      const name = eff.getUniformName(i);
      const v = name === "iResolution" ? [n, n, 1] : p.uniforms[name]?.v;
      if (typeof v === "number") vals[u.slot] = v;
      else if (Array.isArray(v)) v.forEach((x, k) => (vals[u.slot + k] = x));
    }
    const child = img.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Nearest, CK.MipmapMode.None);
    const sh = eff.makeShaderWithChildren(vals, [child]);
    const surf = CK.MakeSurface(1, 1).makeSurface({ width: n, height: n, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: cs });
    const paint = new CK.Paint();
    paint.setShader(sh);
    paint.setBlendMode(CK.BlendMode.Src);
    surf.getCanvas().drawPaint(paint);
    surf.flush();
    const snap = surf.makeImageSnapshot();
    const f = (snap.readPixels(0, 0, { width: n, height: n, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: cs }) as Float32Array).slice(0, n * n * 4);
    for (const o of [snap, surf, paint, sh, child]) o.delete();
    return f;
  };
  const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toEnc = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  // Display P3 linear → sRGB linear.
  const P3_TO_SRGB = [1.2249401, -0.2249404, 0, -0.0420569, 1.0420571, 0, -0.0196376, -0.0786361, 1.0982735];
  const p3ToSrgb = (f: Float32Array): Float32Array => {
    const out = new Float32Array(f.length);
    for (let i = 0; i < f.length; i += 4) {
      const a = f[i + 3];
      const s = a > 0 ? 1 / a : 1;
      const lin = [0, 1, 2].map((c) => Math.sign(f[i + c]) * toLin(Math.abs(f[i + c] * s)));
      for (let r = 0; r < 3; r++) {
        const v = P3_TO_SRGB[r * 3] * lin[0] + P3_TO_SRGB[r * 3 + 1] * lin[1] + P3_TO_SRGB[r * 3 + 2] * lin[2];
        out[i + r] = Math.sign(v) * toEnc(Math.abs(v)) * (a > 0 ? a : 1);
      }
      out[i + 3] = a;
    }
    return out;
  };
  // Both clipped to 0..1 as an 8-bit canvas stores them (an F32 surface
  // keeps an out-of-range ghost sum that only the managed path clips).
  const maxDiff = (a: Float32Array, b: Float32Array) => {
    let m = 0;
    const c01 = (x: number) => Math.max(0, Math.min(1, x));
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(c01(a[i]) - c01(b[i])));
    return m * 255;
  };
  let worst = 0;
  let neg = 0;
  for (const [label, p] of programs) {
    const ref = render(p, CK.ColorSpace.SRGB);
    const d = maxDiff(p3ToSrgb(render(p, CK.ColorSpace.DISPLAY_P3)), ref);
    worst = Math.max(worst, d);
    neg = Math.max(neg, maxDiff(p3ToSrgb(render(p, CK.ColorSpace.DISPLAY_P3, true)), ref));
    if (d > 1) info(`${label}: P3 vs sRGB ${d.toFixed(2)}/255`);
  }
  check("runtime filter programs: Display P3 F32 ≡ sRGB within 1/255 (alpha-0 glow included)", worst <= 1, `worst ${worst.toFixed(3)}/255`);
  check("NEGATIVE: with colour management forced off they differ on P3", neg >= 8, `${neg.toFixed(1)}/255`);
  // Bloom's glow ADDS in the canvas's working space (the srcATop composite
  // is native drawing): on P3 a saturated glow over a saturated colour sums
  // P3-encoded numbers. Reported, not held (spec §5.5: native blends).
  {
    const out = runFilter("skia-bloom", { threshold: 0.3, intensity: 1.2, levels: 2 }, shapes(n, true), n);
    const sc = sceneFor(out.node, n);
    const s8 = draw(sc, n, n, 1, CK.ColorSpace.SRGB, true).px;
    const p3 = draw(sc, n, n, 1, CK.ColorSpace.DISPLAY_P3, true).px;
    info(`Bloom (Skia) whole scene, Display P3 F32 vs sRGB: ${fmt(diff(p3, s8))} — the glow's native srcATop add runs in the working space`);
  }
  img.delete();
}

// ---- 7. export ------------------------------------------------------------------------------------
const g = fx.filtersGraph();
const canvas = { width: S, height: S };
{
  // Every fixture canvas exports (the native sides are GL nodes, skipped).
  const canvases = g.nodes.filter((n) => n.type === "skia-canvas" && n.id !== "src");
  const bad: string[] = [];
  for (const c of canvases) {
    const x = quietly(() => exportSkia({ nodes: g.nodes, edges: g.edges, targetId: c.id, name: c.id, canvas, timeline, runtimeSource }));
    if (!x.files || x.problems.length) bad.push(`${c.id}: ${x.problems[0]}`);
  }
  check(`every filter canvas of the fixture exports (${canvases.length})`, bad.length === 0, bad.slice(0, 2).join(" | "));

  const manifest = (id: string, animation?: "worklet" | "baked" | "native") => {
    const x = quietly(() => exportSkia({ nodes: g.nodes, edges: g.edges, targetId: id, name: id, canvas, timeline: { ...timeline, markers: fx.FILTERS_MARKERS }, runtimeSource, animation }));
    return { x, m: x.files ? JSON.parse(x.files["manifest.json"]) : null, tsx: x.files?.["ToolboxScene.tsx"] ?? "" };
  };
  const ba = manifest("blur_anim_s");
  const radiusTrack = ba.m?.binds.find((b: any) => b.kind === "track" && /imageFilters\.0\.sx$/.test(b.path));
  check("a keyframed Blur (Skia) radius plans as the radius track × 0.5", radiusTrack?.scale === 0.5, JSON.stringify(radiusTrack));
  const ga = manifest("grain_anim_s");
  check("a keyframed Grain (Skia) seed plans as a track (program uniform g_seed)", ga.m?.binds.some((b: any) => b.kind === "track" && /uniforms\.g_seed$/.test(b.path)));
  const ra = manifest("runtime_all_s");
  check("an SkSL Filter channel's keyframes plan as a track (ch:amount)", ra.m?.binds.some((b: any) => b.kind === "track" && /uniforms\.amount$/.test(b.path) && /channel keyframes/.test(b.from)), "");
  check("runtime filters are flagged: not web-playable, with the reason", ra.m?.webPlayable === false && ra.x.warnings.some((w) => w.includes("not playable on React Native Skia web")));
  check("the bloom's glow layers emit <Paint blendMode=\"srcATop\"> with a <RuntimeShader> and a <Blur>", /layer=\{<Paint blendMode="srcATop">/.test(ra.tsx) && /<RuntimeShader source=\{EFFECT_\d+\}/.test(ra.tsx) && /<Blur blur=/.test(ra.tsx));
  check("…and the manifest says colorManaged", ra.m?.colorManaged === true);
  const na = manifest(fx.FILTERS_HARNESS_CANVAS);
  check("the native stack is web-playable (Blur, Shadow, Morphology, ColorMatrix)", na.m?.webPlayable === true && /<Morphology operator="dilate"/.test(na.tsx) && /<Shadow /.test(na.tsx) && /<ColorMatrix matrix=/.test(na.tsx) && /<Blur blur=/.test(na.tsx));
  const lin = manifest("blur_lin_s");
  check("linear-light Blur emits the gamma colour filters around the blur", /<SRGBToLinearGamma \/>/.test(lin.tsx) && /<LinearToSRGBGamma \/>/.test(lin.tsx));

  // checkExportable: programs compile with exactly their uniforms, the
  // bundle type-checks in skia-harness — every mode.
  for (const [id, animation] of [
    [fx.FILTERS_HARNESS_CANVAS, "worklet"],
    ["runtime_all_s", "worklet"],
    ["runtime_all_s", "baked"],
    ["runtime_all_s", "native"],
    [fx.FILTERS_HARNESS_CANVAS, "native"],
    ["flare_over_s", "worklet"],
    ["bloom_tint_s", "worklet"],
    ["shadow_inner_s", "worklet"],
    ["matrix_custom_s", "worklet"],
  ] as const) {
    const r = await quietly(() =>
      checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: id, canvas, timeline: { ...timeline, markers: fx.FILTERS_MARKERS }, typecheck: true, slot: `filters_${id}_${animation}`, animation })
    );
    const badProg = r.programs.filter((p) => !p.ok);
    check(
      `checkExportable ${id} (${animation}): no problems, ${r.programs.length} programs compile with exact uniforms, ${r.typecheck.ran ? "type-checks" : "type-check skipped"}`,
      r.problems.length === 0 && badProg.length === 0 && r.typecheck.ok,
      [...r.problems, ...badProg.map((p) => `${p.where}: ${p.detail}`), r.typecheck.output].filter(Boolean).slice(0, 3).join(" | ")
    );
  }

  // The harness slot is today's export.
  const slot = path.join(ROOT, "skia-harness", "src", "bundle-filters");
  const fresh = quietly(() =>
    exportSkia({
      nodes: g.nodes,
      edges: g.edges,
      targetId: fx.FILTERS_HARNESS_CANVAS,
      name: "Skia filters",
      canvas: { width: fx.FILTERS_SIZE, height: fx.FILTERS_SIZE },
      timeline: { ...timeline, markers: fx.FILTERS_MARKERS },
      runtimeSource,
    })
  );
  const stale = Object.entries(fresh.files ?? {}).filter(([f, text]) => !f.endsWith(".b64") && (!fs.existsSync(path.join(slot, f)) || fs.readFileSync(path.join(slot, f), "utf8") !== text)).map(([f]) => f);
  check("skia-harness/src/bundle-filters is today's export (npx tsx scripts/export-skia.mts --fixture filters --out skia-harness/src/bundle-filters)", !!fresh.files && stale.length === 0, stale.join(", "));
}

// ---- 8. assets and atlas instances through filters -----------------------------------------------
// Assets travel on the drawing values (SkiaDrawValue.assets, lane I): every
// filter node must carry its content's — Bloom's repeated content draws
// included — so the export's asset pre-pass finds them and ships the bytes.
// And a filter inside a Copy to Points (Skia) instance (lane A): the atlas
// strategy rasterises the instance into a sprite sheet through the same
// renderer, so the filtered layer must draw there as it does in groups.
{
  const { exportSkiaWithAssets, collectSkiaExportAssets } = await import("@/lib/skia-export");
  const { nodeResolveAsset } = await import("./skia/node-assets.ts");
  const fxi = await import("./fixtures/skia/image-graph.ts");
  const { gridNode } = await import("@/nodes/source/grid");
  const e = (source: string, target: string, targetHandle: string, sourceHandle = "out:primary"): GraphEdge => ({
    id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  });
  const defaultsOf = (type: string) => Object.fromEntries(getNodeDef(type)!.params.map((p) => [p.name, p.default]));

  // An Image (Skia) behind a Blur, then a Bloom (content drawn levels + 1 times).
  const PNG = fxi.imageFixturePng();
  const BMP = fxi.imageFixtureStandIn(PNG);
  const nodes: GraphNode[] = [
    { id: "img", type: "skia-image", params: { ...defaultsOf("skia-image"), opacity: 1, file: BMP } },
    { id: "blur", type: "skia-blur", params: { ...defaultsOf("skia-blur"), radius: 6 } },
    { id: "bloom", type: "skia-bloom", params: { ...defaultsOf("skia-bloom"), levels: 3 } },
    { id: "cv", type: "skia-canvas", params: {} },
  ];
  const edges = [e("img", "blur", "in:content"), e("blur", "bloom", "in:content"), e("bloom", "cv", "in:scene")];
  const req = { nodes, edges, targetId: "cv", name: "image through filters", canvas: { width: 128, height: 128 }, timeline, runtimeSource };
  const uses = collectSkiaExportAssets(req);
  check(
    "an Image (Skia) behind Blur → Bloom: the export's asset pre-pass finds it, drawn by skia-image",
    uses.length === 1 && uses[0].asset.kind === "image" && uses[0].owners.includes(`skia-image "img"`),
    JSON.stringify(uses.map((u) => [u.asset.id, u.owners]))
  );
  const r = await quietly(() => exportSkiaWithAssets(req, nodeResolveAsset()));
  const m = r.files?.["manifest.json"] ? JSON.parse(r.files["manifest.json"]) : null;
  const a = m?.assets?.[0];
  const bytes = a ? r.files?.[`${a.file}.b64`] : undefined;
  const same = !!bytes && Buffer.from(bytes, "base64").equals(Buffer.from(PNG));
  check(
    "…and the bundle ships its bytes (assets/ + manifest bundled), no asset warnings",
    !!r.files && r.problems.length === 0 && a?.bundled === true && same && !r.warnings.some((w) => w.startsWith("Asset ")),
    [...r.problems, ...r.warnings].slice(0, 2).join(" | ") || JSON.stringify(a)
  );

  // Copy to Points (Skia) of a filtered instance, both strategies.
  const S2 = 128;
  const grid = { ...defaultsOf(gridNode.type), countX: 3, countY: 3, width: 0.6, height: 0.6 };
  const cg: GraphNode[] = [
    { id: "grid", type: gridNode.type, params: grid },
    { id: "dot", type: "skia-circle", params: { ...defaultsOf("skia-circle"), centerX: 0.5, centerY: 0.5, radiusX: 0.06, radiusY: 0.06, fill_enabled: true, fill_color: "#ffd060", stroke_enabled: false } },
    { id: "dblur", type: "skia-blur", params: { ...defaultsOf("skia-blur"), radius: 4, linearize: false } },
    { id: "dgrain", type: "skia-grain", params: { ...defaultsOf("skia-grain"), luminance: 0.3, scale: 2 } },
  ];
  const ce: GraphEdge[] = [e("dot", "dblur", "in:content"), e("dot", "dgrain", "in:content")];
  for (const inst of ["dblur", "dgrain"]) {
    for (const strategy of ["groups", "atlas"]) {
      const id = `${inst}_${strategy}`;
      cg.push({ id, type: "skia-copy-to-points", params: { ...defaultsOf("skia-copy-to-points"), mode: "image", anchor: "content center", strategy, scale_mul_default: 0.8 } });
      cg.push({ id: `${id}_cv`, type: "skia-canvas", params: {} });
      ce.push(e("grid", id, "in:points"), e(inst, id, "in:instance"), e(id, `${id}_cv`, "in:scene"));
    }
  }
  const sceneAt = (canvasId: string): SkiaScene => {
    const sampler = makeSceneSampler(cg, ce, canvasId, { width: S2, height: S2 }, timeline);
    if ("problem" in sampler) throw new Error(sampler.problem);
    const s = quietly(() => sampler.sampleAt(0));
    if (!s) throw new Error(`${canvasId}: ${sampler.lastProblem()}`);
    return s;
  };
  for (const inst of ["dblur", "dgrain"]) {
    const groups = sceneAt(`${inst}_groups_cv`);
    const atlas = sceneAt(`${inst}_atlas_cv`);
    const hasAtlas = JSON.stringify(atlas.root).includes('"k":"atlas"') && JSON.stringify(atlas.root).includes('"texture"');
    const g1 = draw(groups);
    const a1 = draw(atlas);
    const d = diff(a1.px, g1.px);
    check(
      `Copy to Points (Skia) of ${inst === "dblur" ? "a Blur (native filter)" : "a Grain (runtime filter)"}: the atlas's sprite sheet draws the filtered layer as the groups do`,
      hasAtlas && g1.problems.length === 0 && a1.problems.length === 0 && d.mean * 255 < 2.5,
      `${a1.problems.concat(g1.problems).join(" | ") || fmt(d)}`
    );
  }
  for (const id of ["dblur_atlas_cv", "dgrain_atlas_cv"]) {
    const r2 = await quietly(() => checkExportable({ nodes: cg, edges: ce, canvasId: id, canvas: { width: S2, height: S2 }, timeline, typecheck: true, slot: `filters_${id}` }));
    check(`checkExportable ${id} (a filter inside a useTexture sprite sheet)`, r2.problems.length === 0 && r2.programs.every((p) => p.ok) && r2.typecheck.ok, [...r2.problems, r2.typecheck.output].filter(Boolean).slice(0, 2).join(" | "));
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\ncheck-skia-filters: all checks passed");
process.exit(failures ? 1 : 0);
