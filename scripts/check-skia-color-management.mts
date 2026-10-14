// check-skia-color-management: every toolbox runtime program looks the same
// on an sRGB canvas and on a Display P3 one (specdocs/101326_skia-target.md
// §5 decision 5, engine/skia/library/color-management.ts). React Native
// Skia renders iOS canvases in Display P3 on P3 screens (no option), Android
// and the web in sRGB, toolbox in sRGB; Skia runs runtime effects in the
// destination's working space, so the generators convert at each program's
// boundaries. CanvasKit 0.41.0 in Node, CPU raster surfaces:
//
//   0. the intrinsics: toLinearSrgb / fromLinearSrgb exist and do what the
//      helper assumes on sRGB, Display P3 and Adobe RGB surfaces, and the
//      helper's probe tells them apart;
//   1. every registered library function in a minimal fused program;
//   2. every runtime program of every Skia family fixture (scripts/fixtures/
//      skia/*-graph.ts: fused chains with leaf and program children, the SDF
//      programs, the SkSL Shader node in a scene);
//   3. the SkSL Shader node: its default source, a user shader that samples
//      iImage1, plus the source rewrite (main / iImageN.eval renamed, no
//      line moves) and the error mapping;
//   4. baked programs (animation: "baked", emit-baked.ts) of Aurora (SkSL
//      Shader) and Aurora (scene);
//   5. an explicit chain: noise → ramp, mixed with a gradient leaf and with
//      an SDF program child;
//
// each rendered on an sRGB 8-bit surface (the reference), a Display P3 F32
// surface and a Display P3 8-bit surface, read back as sRGB:
//   math    P3 F32 → sRGB 8-bit ≡ sRGB 8-bit within 1/255 (premultiplied);
//   storage P3 8-bit raw bytes ≡ Skia's own P3 encoding of the exact sRGB
//           result (the sRGB F32 render drawn onto a P3 F32 surface) within
//           1/255 — the device's 8-bit P3 surface quantizes like native
//           drawing does, nothing more;
//   drift   on sRGB the program equals itself with color management forced
//           off, byte for byte (the conversions are skipped, not near-
//           identity), so toolbox's preview and every sRGB device are
//           unchanged;
//   unmanaged  with the intrinsics stubbed to identities (Skia's behaviour
//           on a surface with no color space: RN Skia's snapshot / offscreen
//           surfaces) it equals the sRGB render byte for byte;
//   NEGATIVE the same program with color management forced off differs on
//           P3 by a large amount (as do a literal color and the old
//           layout(color) style).
//   6. native drawing (paint colors, images, gradients) is Skia's to
//      convert: solids / images match; gradients and translucent overlaps
//      are reported (Skia interpolates and blends in the working space);
//   7. no generator emits layout(color); every program is color-managed;
//      manifests say `colorManaged: true`.
//
//   npx tsx scripts/check-skia-color-management.mts    (CM_SIZE=<px>, default 32)

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { ShaderIR, SkiaNode, SkiaScene, SkslProgramIR } from "@/engine/skia/scene-ir";
import type { SkiaGraphFixture } from "./skia/fixture";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const lib = await import("@/engine/skia/library");
const { fuseShader } = await import("@/engine/skia/fuse");
const { buildSkslProgram, compileSksl, lintSksl, rewriteSkslSource, userLineError, channelUniformValues } = await import("@/engine/skia/sksl-program");
const { readChannelValues, syncChannelInputs } = await import("@/engine/expr-channels");
const { renderScene } = await import("@/engine/skia/scene-render");
const { SKIA_IR_VERSION, bindParam, bindStatic } = await import("@/engine/skia/scene-ir");
const { makeSceneSampler, dataOnlyContext } = await import("@/lib/skia-export/scene-sample");
const { exportSkia, planSkiaExport } = await import("@/lib/skia-export");
const { planSceneExport } = await import("@/lib/skia-export/scene-plan");
const bk = await import("@/lib/skia-export/emit-baked");
const { SKIA_FONTS } = await import("@/nodes/skia/fonts");
const fx = await import("./fixtures/skia/aurora.ts");
const { auroraSceneGraph } = await import("./fixtures/skia/aurora-scene-graph.ts");

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");

const S = Number(process.env.CM_SIZE ?? 32);
let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}
let t0 = Date.now();
function lap(what: string) {
  info(`${what}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  t0 = Date.now();
}

// ---- surfaces ----------------------------------------------------------------------------------

const BASE = CK.MakeSurface(1, 1);
const SRGB = CK.ColorSpace.SRGB;
const P3 = CK.ColorSpace.DISPLAY_P3;
type Target = { name: string; cs: any; f32: boolean };
const SRGB8: Target = { name: "sRGB 8-bit", cs: SRGB, f32: false };
const SRGBF: Target = { name: "sRGB F32", cs: SRGB, f32: true };
const P3F: Target = { name: "Display P3 F32", cs: P3, f32: true };
const P3_8: Target = { name: "Display P3 8-bit", cs: P3, f32: false };

function surfaceFor(t: Target, w: number, h: number): any {
  const s = BASE.makeSurface({
    width: w,
    height: h,
    colorType: t.f32 ? CK.ColorType.RGBA_F32 : CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Premul,
    colorSpace: t.cs,
  });
  if (!s) throw new Error(`no ${t.name} surface`);
  return s;
}

// Premultiplied pixels of an image, converted to `cs` — copied out: an F32
// readPixels result is a view of WASM memory the next call may reuse.
function read8(img: any, cs: any): Uint8Array {
  return new Uint8Array(img.readPixels(0, 0, { width: img.width(), height: img.height(), colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: cs }) as Uint8Array);
}
function readF(img: any, cs: any): Float32Array {
  // (CanvasKit 0.41.0 sizes an F32 result in bytes, not floats: 4× too long.)
  const f = img.readPixels(0, 0, { width: img.width(), height: img.height(), colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: cs }) as Float32Array;
  return f.slice(0, img.width() * img.height() * 4);
}

// ---- assets ------------------------------------------------------------------------------------

const fontBytes: Record<string, Uint8Array> = {};
for (const f of Object.values(SKIA_FONTS) as any[]) {
  const file = path.join(ROOT, "public", f.asset.url);
  if (fs.existsSync(file)) fontBytes[f.asset.id] = new Uint8Array(fs.readFileSync(file));
}
const images = new Map<string, any>();
// A colorful, partly translucent sRGB image for child / image tests.
const TEX = "cm-tex";
{
  const n = 16;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      px[i] = Math.round((255 * x) / (n - 1));
      px[i + 1] = Math.round((255 * y) / (n - 1));
      px[i + 2] = (x * 37 + y * 11) % 256;
      px[i + 3] = y < n / 2 ? 255 : 96 + x * 8;
    }
  }
  images.set(TEX, CK.MakeImage({ width: n, height: n, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: SRGB }, px, n * 4));
}
function resolveAsset(id: string, kind: "image" | "font", asset: any): any {
  if (kind === "font") return fontBytes[id] ?? null;
  if (images.has(id)) return images.get(id);
  const url: string | undefined = asset?.url;
  const m = url && /^data:[^;]+;base64,(.*)$/.exec(url);
  if (!m) return null;
  const img = CK.MakeImageFromEncoded(Buffer.from(m[1], "base64"));
  images.set(id, img ?? null);
  return img ?? null;
}

// ---- drawing -----------------------------------------------------------------------------------

// A scene drawn on `t` at w × h (scaled from its own size), as an image.
function drawScene(t: Target, scene: SkiaScene, w: number, h: number): { img: any; problems: string[] } {
  const surf = surfaceFor(t, w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  canvas.save();
  canvas.scale(w / scene.width, h / scene.height);
  const r = renderScene(CK, canvas, scene, { assets: resolveAsset, surfaceSize: [w, h] });
  canvas.restore();
  surf.flush();
  const img = surf.makeImageSnapshot();
  r.release();
  surf.delete();
  return { img, problems: r.problems };
}

function fillScene(shader: ShaderIR, w: number, h: number): SkiaScene {
  return { version: SKIA_IR_VERSION, width: w, height: h, root: { k: "fill", paint: { style: "fill", shader } }, assets: {} };
}

// Every runtime program in a shader tree, transformed.
function mapPrograms(s: ShaderIR, f: (p: SkslProgramIR) => SkslProgramIR): ShaderIR {
  if (s.k !== "runtime") return s;
  const p = f(s.program);
  return { k: "runtime", program: { ...p, children: p.children.map((c) => ({ ...c, shader: mapPrograms(c.shader, f) })) } };
}
// iResolution = the render size, so the whole field lands in w × h.
const atSize = (w: number, h: number) => (p: SkslProgramIR): SkslProgramIR =>
  p.uniforms.iResolution ? { ...p, uniforms: { ...p.uniforms, iResolution: { ...p.uniforms.iResolution, v: [w, h, 1] } } } : p;
// Color management forced off: the probe answers "nothing to convert".
const CM_ACTIVE_RE = /bool tbx_cm_active\(\) \{[\s\S]*?\n\}/;
const cmOff = (p: SkslProgramIR): SkslProgramIR => ({ ...p, sksl: p.sksl.replace(CM_ACTIVE_RE, "bool tbx_cm_active() {\n  return false;\n}") });
// An unmanaged destination: Skia runs the intrinsics as identities.
const unmanaged = (p: SkslProgramIR): SkslProgramIR => ({
  ...p,
  sksl: `half3 tbx_sim_identity(half3 c) { return c; }\n${p.sksl.replace(/\b(?:toLinearSrgb|fromLinearSrgb)\s*\(/g, "tbx_sim_identity(")}`,
});

interface Diff {
  max: number;
  n: number;
}
function diff8(a: Uint8Array, b: Uint8Array): Diff {
  let max = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c++) px = Math.max(px, Math.abs(a[i + c] - b[i + c]));
    if (px) n++;
    max = Math.max(max, px);
  }
  return { max, n };
}
// Float error over pixels that are visible and in range on both sides (an
// unclipped F32 surface keeps a sharpen's overshoot and the color of an
// alpha-0 pixel, which a conversion un-premultiplies by 0; the 8-bit checks
// cover those).
function diffF(a: Float32Array, b: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    const px = [0, 1, 2, 3].map((c) => [a[i + c], b[i + c]]);
    if (px.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || y < 0 || y > 1) || a[i + 3] < 1 / 255 || b[i + 3] < 1 / 255) continue;
    for (const [x, y] of px) max = Math.max(max, Math.abs(x - y));
  }
  return max;
}
// Clips premultiplied channels to 0..1 in the working space it runs in.
const CLIP01 = CK.RuntimeEffect.Make("uniform shader img;\nhalf4 main(float2 p) { return clamp(img.eval(p), 0.0, 1.0); }");
function quant8(f: Float32Array): Uint8Array {
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
  return out;
}

interface Measure {
  label: string;
  math: Diff; // P3 F32 → sRGB vs sRGB 8-bit
  mathF: number; // P3 F32 → sRGB F32 vs sRGB F32
  storage: Diff; // P3 8-bit raw vs Skia's P3 encoding of the exact result
  quant: Diff; // P3 8-bit → sRGB vs sRGB 8-bit (info: the surface's own quantization)
  negative: Diff; // CM off, P3 F32 → sRGB vs sRGB 8-bit
  drift: Diff; // CM off vs on, sRGB 8-bit
  unmanaged: Diff; // intrinsics as identities vs on, sRGB 8-bit
  colorful: boolean;
  problems: string[];
}

// Render size for a program within a per-render time budget: Skia's CPU
// backend runs every branch and every loop to its cap, so a Kuwahara or a
// Flow Blur costs ~100× a noise per pixel there (a GPU early-outs).
const RENDER_BUDGET_MS = 10;
function sideFor(shader: ShaderIR): number {
  const n = 8;
  const t = Date.now();
  drawScene(SRGB8, fillScene(mapPrograms(shader, atSize(n, n)), n, n), n, n).img.delete();
  const perPx = Math.max(Date.now() - t, 0.5) / (n * n);
  return Math.max(n, Math.min(S, Math.floor(Math.sqrt(RENDER_BUDGET_MS / perPx))));
}

function measure(label: string, shader: ShaderIR, w = S, h = S): Measure {
  const sized = mapPrograms(shader, atSize(w, h));
  const scene = fillScene(sized, w, h);
  const off = fillScene(mapPrograms(sized, cmOff), w, h);
  const um = fillScene(mapPrograms(sized, unmanaged), w, h);
  const problems: string[] = [];
  const run = (t: Target, sc: SkiaScene) => {
    const r = drawScene(t, sc, w, h);
    problems.push(...r.problems);
    return r.img;
  };
  const iS8 = run(SRGB8, scene);
  const iSF = run(SRGBF, scene);
  const iPF = run(P3F, scene);
  const iP8 = run(P3_8, scene);
  const iOff = run(P3F, off);
  const iOffS = run(SRGB8, off);
  const iUm = run(SRGB8, um);
  // Skia's P3 encoding of the exact sRGB result: the sRGB F32 render,
  // clipped as an 8-bit sRGB canvas clips it (premultiplied channels to
  // 0..1, in sRGB), drawn onto a P3 F32 surface (native color management,
  // no 8-bit step) and rounded once.
  const ideal = (() => {
    const clipped = surfaceFor(SRGBF, w, h);
    const img0 = iSF.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Nearest, CK.MipmapMode.None);
    const clip = CLIP01.makeShaderWithChildren([], [img0]);
    const p = new CK.Paint();
    p.setBlendMode(CK.BlendMode.Src);
    p.setShader(clip);
    clipped.getCanvas().drawPaint(p);
    clipped.flush();
    const c01 = clipped.makeImageSnapshot();
    const s = surfaceFor(P3F, w, h);
    s.getCanvas().clear(CK.TRANSPARENT);
    const p2 = new CK.Paint();
    p2.setBlendMode(CK.BlendMode.Src);
    s.getCanvas().drawImage(c01, 0, 0, p2);
    s.flush();
    const img = s.makeImageSnapshot();
    const q = quant8(readF(img, P3));
    for (const o of [p, p2, clip, img0, c01, clipped, img, s]) o.delete();
    return q;
  })();
  const ref = read8(iS8, SRGB);
  let colorful = false;
  for (let i = 0; i < ref.length && !colorful; i += 4) {
    if (ref[i + 3] > 32 && Math.max(Math.abs(ref[i] - ref[i + 1]), Math.abs(ref[i + 1] - ref[i + 2]), Math.abs(ref[i] - ref[i + 2])) > 24) colorful = true;
  }
  const m: Measure = {
    label,
    math: diff8(read8(iPF, SRGB), ref),
    mathF: diffF(readF(iPF, SRGB), readF(iSF, SRGB)),
    storage: diff8(read8(iP8, P3), ideal),
    quant: diff8(read8(iP8, SRGB), ref),
    negative: diff8(read8(iOff, SRGB), ref),
    drift: diff8(read8(iOffS, SRGB), ref),
    unmanaged: diff8(read8(iUm, SRGB), ref),
    colorful,
    problems: [...new Set(problems)],
  };
  for (const i of [iS8, iSF, iPF, iP8, iOff, iOffS, iUm]) i.delete();
  return m;
}

const fmt = (d: Diff) => `${d.max}/255 (${d.n} px)`;
function summarize(section: string, ms: Measure[], opts: { negativeMin?: number } = {}) {
  const worst = <K extends "math" | "storage" | "quant" | "negative" | "drift" | "unmanaged">(k: K) =>
    ms.reduce((w, m) => (m[k].max > w[k].max ? m : w), ms[0]);
  const wm = worst("math");
  const ws = worst("storage");
  const wq = worst("quant");
  const wn = worst("negative");
  const wd = worst("drift");
  const wu = worst("unmanaged");
  const mathF = Math.max(...ms.map((m) => m.mathF));
  if (process.env.CM_PROFILE) for (const m of ms) if (m.mathF > 1e-3) console.log(`mathF ${m.mathF} ${m.label}`);
  const probs = ms.filter((m) => m.problems.length);
  check(`${section}: ${ms.length} program(s) render on every surface without problems`, ms.length > 0 && probs.length === 0, probs.slice(0, 3).map((m) => `${m.label}: ${m.problems[0]}`).join(" | "));
  check(`${section}: Display P3 (F32) read as sRGB ≡ sRGB within 1/255 — max ${fmt(wm.math)} at ${wm.label}; float max |Δ| ${mathF.toExponential(1)}`, wm.math.max <= 1);
  check(`${section}: Display P3 8-bit bytes ≡ Skia's P3 encoding of the exact sRGB result within 1/255 — max ${fmt(ws.storage)} at ${ws.label}`, ws.storage.max <= 1);
  check(`${section}: on sRGB, byte-identical to the program with color management off (no drift) — max ${fmt(wd.drift)}`, wd.drift.max === 0, wd.label);
  check(`${section}: with the intrinsics as identities (an unmanaged surface), byte-identical to sRGB — max ${fmt(wu.unmanaged)}`, wu.unmanaged.max === 0, wu.label);
  info(`${section}: an 8-bit P3 surface read back as sRGB (its own quantization, shared with native drawing): max ${fmt(wq.quant)} at ${wq.label}`);
  const colorful = ms.filter((m) => m.colorful);
  const big = colorful.filter((m) => m.negative.max >= 8);
  const nMin = opts.negativeMin ?? 20;
  check(
    `${section}: NEGATIVE control — color management off, the same programs on P3 differ by up to ${fmt(wn.negative)} (${wn.label}); ${big.length} of ${colorful.length} colorful programs by ≥ 8/255`,
    wn.negative.max >= nMin && (colorful.length === 0 || big.length >= Math.ceil(colorful.length / 2))
  );
}

// ---- 0. the intrinsics and the helper ----------------------------------------------------------
{
  const probe = (cs: any, body: string): number[] => {
    const e = compileSksl(CK, `half4 main(float2 p) { ${body} }`);
    if (!e.effect) throw new Error(e.error);
    const s = BASE.makeSurface({ width: 1, height: 1, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: cs });
    const paint = new CK.Paint();
    const sh = e.effect.makeShader([]);
    paint.setShader(sh);
    paint.setBlendMode(CK.BlendMode.Src);
    s.getCanvas().drawPaint(paint);
    s.flush();
    const img = s.makeImageSnapshot();
    const v = [...readF(img, cs)];
    for (const o of [img, paint, sh, s]) o.delete();
    return v;
  };
  const near = (a: number[], b: number[], eps: number) => a.every((x, i) => Math.abs(x - b[i]) <= eps);
  const fromRed = "return half4(fromLinearSrgb(half3(1.0, 0.0, 0.0)), 1.0);";
  const half = "return half4(fromLinearSrgb(half3(0.5, 0.0, 0.0)), 1.0);";
  check("CanvasKit 0.41.0 compiles toLinearSrgb / fromLinearSrgb in a runtime shader", !!compileSksl(CK, "half4 main(float2 p) { return half4(toLinearSrgb(fromLinearSrgb(half3(0.5))), 1.0); }").effect);
  check("sRGB surface: fromLinearSrgb(0.5, 0, 0) = (0.7354, 0, 0) — the sRGB encoding", near(probe(SRGB, half).slice(0, 3), [0.735357, 0, 0], 2e-4));
  check("sRGB surface: fromLinearSrgb(red) = red (no gamut change)", near(probe(SRGB, fromRed).slice(0, 3), [1, 0, 0], 2e-4));
  const p3red = probe(P3, fromRed);
  check("Display P3 surface: fromLinearSrgb(sRGB red) = P3 (0.9175, 0.2003, 0.1386)", near(p3red.slice(0, 3), [0.9175, 0.2003, 0.1386], 1e-3), p3red.map((x) => x.toFixed(4)).join());
  check("Display P3 surface: toLinearSrgb ∘ fromLinearSrgb = identity", near(probe(P3, "return half4(toLinearSrgb(fromLinearSrgb(half3(0.2, 0.5, 0.05))), 1.0);").slice(0, 3), [0.2, 0.5, 0.05], 1e-4));
  const cm = lib.colorManagementSksl();
  const activeOn = (cs: any) => {
    const e = compileSksl(CK, `${cm}\nhalf4 main(float2 p) { return tbx_cm_active() ? half4(1.0) : half4(0.0, 0.0, 0.0, 1.0); }`);
    if (!e.effect) throw new Error(e.error);
    const s = BASE.makeSurface({ width: 1, height: 1, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Premul, colorSpace: cs });
    const paint = new CK.Paint();
    paint.setShader(e.effect.makeShader([]));
    s.getCanvas().drawPaint(paint);
    s.flush();
    const img = s.makeImageSnapshot();
    const v = readF(img, cs)[0];
    img.delete();
    s.delete();
    return v;
  };
  check(
    "tbx_cm_active(): off on sRGB, on for Display P3 and Adobe RGB",
    activeOn(SRGB) === 0 && activeOn(P3) === 1 && activeOn(CK.ColorSpace.ADOBE_RGB) === 1
  );
  const unm = compileSksl(CK, `half3 tbx_sim_identity(half3 c) { return c; }\n${cm.replace(/\b(?:toLinearSrgb|fromLinearSrgb)\s*\(/g, "tbx_sim_identity(")}\nhalf4 main(float2 p) { return tbx_cm_active() ? half4(1.0) : half4(0.0, 0.0, 0.0, 1.0); }`);
  check("tbx_cm_active() with identity intrinsics (an unmanaged destination) compiles and is the gate's simulation", !!unm.effect);
  check("the helper is registered and resolves with tbx.color.srgb", lib.resolveHelpers([lib.SKSL_CM_HELPER]).order.map((h) => h.id).join() === "tbx.color.srgb,tbx.color.cm");
}
lap("0. intrinsics");

// Every program a shader tree holds (for the static checks in section 7).
const allPrograms: { where: string; sksl: string }[] = [];
function collect(where: string, s: ShaderIR) {
  if (s.k !== "runtime") return;
  allPrograms.push({ where, sksl: s.program.sksl });
  s.program.children.forEach((c) => collect(`${where} › ${c.name}`, c.shader));
}

// ---- 1. every library function, minimal ---------------------------------------------------------
lib.registerSkslFunction({
  id: "test.cm.uv@1",
  entry: "test_cm_uv",
  source: `float4 test_cm_uv(float2 uv, float2 res) { return float4(uv.x, uv.y, 1.0 - uv.x * uv.y, 0.6 + 0.4 * uv.x); }`,
  params: [],
  inputs: [],
});
lib.registerSkslFunction({
  id: "test.cm.mix@1",
  entry: "test_cm_mix",
  source: `float4 test_cm_mix(float2 uv, float2 res, float k, float4 tint, float4 a, float4 b) { return mix(mix(a, b, k), tint, 0.25); }`,
  params: [{ name: "k", type: "float" }, { name: "tint", type: "color" }],
  inputs: [{ name: "a", mode: "pure" }, { name: "b", mode: "pure" }],
});
const call = (fn: string, node: string, params: Record<string, any>, inputs: Record<string, ShaderExpr> = {}): ShaderExpr => ({
  k: "call",
  fn,
  node,
  params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, bindParam(v, node, k)])),
  inputs,
});
const COLORS = [
  [0.95, 0.35, 0.1, 1],
  [0.1, 0.75, 0.35, 1],
  [0.2, 0.3, 0.95, 1],
  [0.9, 0.85, 0.15, 0.8],
];
function fusedIR(expr: ShaderExpr, w = S, h = S): ShaderIR {
  const r = fuseShader(expr, { resolution: [w, h], time: 0.75 });
  if (!r.shader) throw new Error(r.problems.join(" | "));
  return r.shader;
}
{
  const ms: Measure[] = [];
  const failed: string[] = [];
  const fns = lib.allSkslFunctions().filter((f) => !f.id.startsWith("test."));
  for (const f of fns) {
    const params: Record<string, any> = {};
    let ci = 0;
    for (const p of f.params) {
      const n = p.count ?? 1;
      const one = (): number[] =>
        p.type === "color" ? COLORS[ci++ % COLORS.length] : p.type === "float4" ? [0.25, 0.5, 0.75, 1] : p.type === "float3" ? [0.3, 0.6, 0.9] : p.type === "float2" ? [0.3, 0.6] : [p.type === "int" ? 1 : 0.5];
      const vals = Array.from({ length: n }, one).flat();
      params[p.name] = p.count === undefined && vals.length === 1 ? vals[0] : vals;
    }
    const inputs = Object.fromEntries(f.inputs.map((i) => [i.name, call("test.cm.uv@1", `in-${i.name}`, {})]));
    try {
      const ir = fusedIR(call(f.id, "probe", params, inputs));
      collect(f.id, ir);
      ms.push(measure(f.id, ir));
    } catch (e) {
      failed.push(`${f.id}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  check(`every registered library function fuses into a minimal program (${fns.length})`, failed.length === 0, failed.slice(0, 3).join(" | "));
  summarize(`library functions (${S}²)`, ms);
}
lap("1. library functions");

// ---- 2. every program of every family fixture -------------------------------------------------
const FIXTURES = ["aurora-scene", "noise", "color", "warp", "gather", "merge", "sdf", "paint", "shapes"];
const fixtureText = (file: string) => fs.readFileSync(path.join(ROOT, "scripts/fixtures/skia", file), "utf8");
interface Found {
  where: string;
  shader: ShaderIR;
}
function scenePrograms(node: SkiaNode, where: string, out: Found[]) {
  const paint = (p: any, at: string) => {
    if (p?.shader) out.push({ where: `${at}.paint`, shader: p.shader });
  };
  switch (node.k) {
    case "group":
      node.children.forEach((c, i) => scenePrograms(c, `${where}/${c.id ?? i}`, out));
      for (const f of node.layer?.imageFilters ?? []) if (f.k === "runtime") out.push({ where: `${where}.filter`, shader: { k: "runtime", program: f.program } });
      break;
    case "fill":
    case "shape":
    case "text":
      paint(node.paint, where);
      break;
    default:
      break;
  }
}
// Does the scene draw anything Skia composites itself (beyond one shader
// fill over transparency)?
function compositesNatively(node: SkiaNode): boolean {
  switch (node.k) {
    case "group":
      return !!node.blendMode || !!node.opacity || !!node.layer || node.children.length > 1 || node.children.some(compositesNatively);
    case "fill":
      return !node.paint.shader || node.paint.shader.k !== "runtime" || !!node.paint.blendMode;
    default:
      return true;
  }
}
const sdfPrograms: ShaderIR[] = [];
{
  const ms: Measure[] = [];
  let leafChildren = 0;
  let programChildren = 0;
  let sdf = 0;
  let sksl = 0;
  const seen = new Set<string>();
  const sides: number[] = [];
  const sceneNotes: string[] = [];
  for (const name of FIXTURES) {
    const mod = (await import(`./fixtures/skia/${name}-graph.ts`)) as { fixture: SkiaGraphFixture };
    const g = mod.fixture.build({ text: fixtureText });
    const size = mod.fixture.size ?? 512;
    const canvas = Array.isArray(size) ? { width: size[0], height: size[1] } : { width: size as number, height: size as number };
    const canvases = g.nodes.filter((n: GraphNode) => n.type === "skia-canvas");
    let nativeWorst = { max: 0, at: "" };
    for (const c of canvases) {
      const sampler = makeSceneSampler(g.nodes, g.edges, c.id, canvas, mod.fixture.timeline);
      if ("problem" in sampler) continue;
      const frame = (mod.fixture.frames ?? [0])[Math.min(1, (mod.fixture.frames ?? [0]).length - 1)];
      // Native GL nodes in a fixture's closure (its native side) log and
      // stub out on the data-only context; the Skia nodes don't care.
      const quiet = console.error;
      console.error = () => {};
      let scene: SkiaScene | null;
      try {
        scene = sampler.sampleAt(frame * mod.fixture.timeline.ticksPerFrame);
      } finally {
        console.error = quiet;
      }
      if (!scene) continue;
      const found: Found[] = [];
      scenePrograms(scene.root, `${name}:${c.id}`, found);
      for (const f of found) {
        if (f.shader.k !== "runtime") continue;
        const key = JSON.stringify(f.shader);
        if (seen.has(key)) continue;
        seen.add(key);
        collect(f.where, f.shader);
        const p = f.shader.program;
        for (const ch of p.children) {
          if (ch.shader.k === "runtime") programChildren++;
          else leafChildren++;
          if (ch.shader.k === "runtime" && /Generated by toolbox \(engine\/skia\/sdf\/sksl\.ts\)/.test(ch.shader.program.sksl)) {
            sdf++;
            sdfPrograms.push(ch.shader);
          }
        }
        if (/Generated by toolbox \(engine\/skia\/sdf\/sksl\.ts\)/.test(p.sksl)) {
          sdf++;
          sdfPrograms.push(f.shader);
        }
        if (/Prelude owned by the toolbox SkSL Shader node/.test(p.sksl)) sksl++;
        const tm = Date.now();
        const side = sideFor(f.shader);
        sides.push(side);
        ms.push(measure(f.where, f.shader, side, side));
        if (process.env.CM_PROFILE) console.log(`time ${Date.now() - tm}ms ${side}² ${f.where}`);
      }
      // The whole scene when it composites natively (shapes, text, group
      // blend / opacity): info — Skia converts native drawing itself, and
      // its gradients / blends run in the working space. A plain shader fill
      // is the program measured above.
      if (!compositesNatively(scene.root)) continue;
      const sw = Math.min(S, Math.min(...found.filter((f) => f.shader.k === "runtime").map((f) => sideFor(f.shader)), S));
      const sh = Math.max(1, Math.round((sw * scene.height) / scene.width));
      const ia = drawScene(SRGB8, scene, sw, sh).img;
      const ib = drawScene(P3F, scene, sw, sh).img;
      const d = diff8(read8(ib, SRGB), read8(ia, SRGB));
      ia.delete();
      ib.delete();
      if (d.max > nativeWorst.max) nativeWorst = { max: d.max, at: c.id };
    }
    sceneNotes.push(`${name} ${nativeWorst.max}/255${nativeWorst.at ? ` (${nativeWorst.at})` : ""}`);
  }
  info(`fixture programs: ${ms.length} distinct (${leafChildren} leaf children, ${programChildren} program children, ${sdf} SDF programs, ${sksl} SkSL Shader programs)`);
  check("the fixture corpus covers fused chains, program children and SDF programs (leaf children: section 5)", ms.length >= 50 && programChildren > 0 && sdf > 0, `${ms.length} programs, ${programChildren} program children, ${sdf} SDF`);
  summarize(`family fixtures (${Math.min(...sides)}–${Math.max(...sides)}² by cost)`, ms);
  info(`whole scenes incl. native drawing, P3 vs sRGB (Skia's own conversion; native gradients and blends run in the working space): ${sceneNotes.join(", ")}`);
}
lap("2. family fixtures");

// ---- 3. the SkSL Shader node --------------------------------------------------------------------
function skslNodeShader(params: Record<string, unknown>, w = S, h = S, time = 0.75, children: Record<string, ShaderIR> = {}): ShaderIR {
  const prog = buildSkslProgram(params);
  const values = channelUniformValues(prog.channels, readChannelValues(prog.channels, {}));
  const uniforms: Record<string, any> = { iResolution: bindStatic([w, h, 1]), iTime: bindStatic(time) };
  for (const [k, v] of Object.entries(values)) uniforms[k] = bindStatic(v);
  return {
    k: "runtime",
    program: { sksl: prog.sksl, uniforms, children: prog.children.map((name) => ({ name, shader: children[name] ?? { k: "color", color: bindStatic([0, 0, 0, 0]) } })) },
  };
}
{
  const def = getNodeDef("sksl-shader")!;
  const defaults = Object.fromEntries(def.params.map((p) => [p.name, p.default]));
  const ms: Measure[] = [];
  const dflt = skslNodeShader(defaults);
  collect("sksl-shader default", dflt);
  ms.push(measure("SkSL Shader default source", dflt));
  const userSrc = `// color("tint", "#ff5a1f")
// ch("k", 0.6, 0, 1)
// A user shader that samples its wired image: iImage1.eval(p) in a comment stays as written.
half4 main(float2 p) {
  half4 s = iImage1
    .eval(p);
  float3 c = mix(float3(s.rgb), tint.rgb * float(s.a), k);
  return half4(c, s.a);
}`;
  const user = { expression: userSrc, inputs: syncChannelInputs([], userSrc) };
  const tex: ShaderIR = { k: "image", asset: TEX, fit: "fill", rect: [bindStatic(0), bindStatic(0), bindStatic(S), bindStatic(S)] };
  const userIR = skslNodeShader(user, S, S, 0, { iImage1: tex });
  collect("sksl-shader iImage1", userIR);
  ms.push(measure("SkSL Shader sampling iImage1 (+ color channel)", userIR));
  const aurora = { expression: fx.AURORA_SKSL, inputs: syncChannelInputs([], fx.AURORA_SKSL) };
  const auroraIR = skslNodeShader(aurora);
  collect("aurora.sksl", auroraIR);
  ms.push(measure("Aurora (aurora.sksl)", auroraIR));
  summarize("SkSL Shader node", ms, { negativeMin: 10 });

  const prog = buildSkslProgram(user);
  const rw = rewriteSkslSource(userSrc);
  check("rewrite keeps every line: the user's source spans the same lines", rw.code.split("\n").length === userSrc.split("\n").length && prog.sourceLines === userSrc.split("\n").length);
  check(
    "rewrite renames main and iImage1.eval in code only (comments untouched, a split `iImage1\\n.eval(` keeps its line break)",
    rw.hasMain && /half4 tbx_user_main\(float2 p\)/.test(rw.code) && /tbx_eval_iImage1\n\(p\)/.test(rw.code) && rw.code.includes("// A user shader that samples its wired image: iImage1.eval(p) in a comment")
  );
  check("prelude: plain float4 color channel, the cm helper, one sampler per referenced child; wrapper main after the source", /^uniform float4 tint;/m.test(prog.sksl) && !prog.sksl.includes("layout(color)") && /half4 tbx_eval_iImage1\(float2 p\)/.test(prog.sksl) && !/tbx_eval_iImage2/.test(prog.sksl) && /tbx_cm_premul_out\(float4\(tbx_user_main\(tbx_p\)\)\)/.test(prog.sksl.split("// ---- shader source ----")[1] ?? ""));
  const lines = prog.sksl.split("\n");
  check("the user's line N is program line preludeLines + N", lines[prog.preludeLines + 4 - 1] === "half4 tbx_user_main(float2 p) {" && lines[prog.preludeLines + 1 - 1] === userSrc.split("\n")[0]);
  const bad = `// ch("k", 0.5, 0, 1)\nhalf4 main(float2 p) {\n  return half4(nope);\n}`;
  const bp = buildSkslProgram({ expression: bad, inputs: syncChannelInputs([], bad) });
  const be = compileSksl(CK, bp.sksl).error ?? "";
  const mapped = userLineError(be, bp.preludeLines, bp.sourceLines);
  check("a compile error maps to the user's line, with their names", /line 3:/.test(mapped) && !/tbx_/.test(mapped), mapped);
  const wrongType = `half3 main(float2 p) { return half3(1.0); }`;
  const wp = buildSkslProgram({ expression: wrongType, inputs: [] });
  const we = userLineError(compileSksl(CK, wp.sksl).error ?? "", wp.preludeLines, wp.sourceLines);
  check("an error inside the appended wrapper says so instead of naming a line past the source", /color-management wrapper|line 1:/.test(we) && !/tbx_user_main/.test(we), we);
  check("no main → no wrapper (Skia's and the lint's own missing-main error)", !/tbx_cm_premul_out\(float4\(tbx_user_main/.test(buildSkslProgram({ expression: "float f() { return 1.0; }", inputs: [] }).sksl));
  check("lint warns on toLinearSrgb / fromLinearSrgb and on the reserved tbx_ prefix", lintSksl("half4 main(float2 p) { return half4(fromLinearSrgb(half3(1.0)), 1.0); }").warnings.some((w) => w.includes("already converts")) && lintSksl("float tbx_x;\nhalf4 main(float2 p) { return half4(1.0); }").warnings.some((w) => w.includes("tbx_")));
}
lap("3. SkSL Shader node");

// ---- 4. baked programs -------------------------------------------------------------------------
{
  const ms: Measure[] = [];
  // Aurora as the SkSL Shader node, baked: iTime drives the program.
  const a = fx.auroraGraph();
  const plan = planSkiaExport(a.nodes, a.edges, a.targetId, { name: "Aurora", canvas: { width: 512, height: 512 }, timeline: fx.AURORA_TIMELINE }).plan!;
  const baked = bk.bakeSkiaPlan(plan);
  check("Aurora (SkSL Shader) bakes", !!baked.plan && baked.problems.length === 0, baked.problems.join(" | "));
  if (baked.plan) {
    check("…the baked program keeps the color-managed main inside tbk_main", lib.isColorManagedSksl(baked.plan.sksl) && /half4 tbk_main\(float2 tbx_p\)/.test(baked.plan.sksl) && /tbk_bake\(\);\s*return tbk_main\(/.test(baked.plan.sksl));
    for (const sec of [0.75, 2.5]) {
      const uniforms: Record<string, any> = { iResolution: bindStatic([S, S, 1]), iTime: bindStatic(sec) };
      for (const u of baked.plan.uniforms) uniforms[u.name] = bindStatic(u.value as number | number[]);
      const ir: ShaderIR = { k: "runtime", program: { sksl: baked.plan.sksl, uniforms, children: [] } };
      collect("aurora baked", ir);
      ms.push(measure(`Aurora (SkSL Shader) baked @ ${sec}s`, ir));
    }
  }
  // Aurora as a Skia-layer scene, baked.
  const g = auroraSceneGraph(fx.AURORA_SKSL);
  const sampler = makeSceneSampler(g.nodes, g.edges, "skc", { width: 512, height: 512 }, fx.AURORA_TIMELINE);
  const scene0 = "problem" in sampler ? null : sampler.sampleAt(0);
  const sp = scene0 && !("problem" in sampler) ? planSceneExport(scene0, g.nodes, g.edges, { name: "Aurora scene", timeline: fx.AURORA_TIMELINE, sampleAt: (t) => sampler.sampleAt(t) }) : null;
  const scenePlan = sp?.plan ?? null;
  if (!scenePlan) info(`scene plan unavailable: ${sp?.problems.join(" | ")}`);
  const sb = scenePlan ? bk.bakeScenePlan(scenePlan) : null;
  check("Aurora (scene) bakes", !!sb?.plan && sb.problems.length === 0, sb?.problems.join(" | "));
  if (sb?.plan) {
    const found: Found[] = [];
    scenePrograms(sb.plan.scene.root, "aurora-scene baked", found);
    const runtime = found.filter((f) => f.shader.k === "runtime");
    check("…its programs keep the color-managed main inside tbk_main", runtime.length > 0 && runtime.every((f) => lib.isColorManagedSksl((f.shader as any).program.sksl) && /tbk_main/.test((f.shader as any).program.sksl)));
    for (const f of runtime) {
      for (const sec of [0.75, 2.5]) {
        const ir = mapPrograms(f.shader, (p) => (p.uniforms.iTime ? { ...p, uniforms: { ...p.uniforms, iTime: bindStatic(sec) } } : p));
        collect(f.where, ir);
        ms.push(measure(`${f.where} @ ${sec}s`, ir));
      }
    }
  }
  summarize("baked programs (animation: \"baked\")", ms);
}
lap("4. baked");

// ---- 5. an explicit chain: leaf child + program child ------------------------------------------
{
  const exprs = (() => {
    const nodes: GraphNode[] = [
      { id: "nz", type: "skia-noise", params: { ...Object.fromEntries(getNodeDef("skia-noise")!.params.map((p) => [p.name, p.default])), scale: 3 } },
      {
        id: "rp",
        type: "skia-color-ramp",
        params: {
          ...Object.fromEntries(getNodeDef("skia-color-ramp")!.params.map((p) => [p.name, p.default])),
          stops: [
            { id: "a", position: 0, color: "#0a0f2c" },
            { id: "b", position: 0.45, color: "#3d5afe" },
            { id: "c", position: 0.75, color: "#ff7a45" },
            { id: "d", position: 1, color: "#ffe3c2" },
          ],
          space: "oklab",
        },
      },
    ];
    const edges: GraphEdge[] = [{ id: "e", source: "nz", sourceHandle: "out:primary", target: "rp", targetHandle: "in:image" }];
    const r = evaluateGraph(nodes, edges, dataOnlyContext({ width: S, height: S }, { fps: 60, ticksPerFrame: 1000 }), new Map(), null, undefined, null, { extraTargets: ["rp"] });
    return (r.outputs.get("rp")?.primary as any)?.expr as ShaderExpr;
  })();
  const imageLeaf: ShaderExpr = { k: "leaf", shader: { k: "image", asset: TEX, fit: "fill", rect: [bindStatic(0), bindStatic(0), bindStatic(S), bindStatic(S)] } };
  const colorLeaf: ShaderExpr = { k: "leaf", shader: { k: "color", color: bindStatic([0.95, 0.3, 0.55, 0.8]) } };
  const gradientLeaf: ShaderExpr = {
    k: "leaf",
    shader: {
      k: "linear",
      start: [bindStatic(0), bindStatic(0)],
      end: [bindStatic(S), bindStatic(S)],
      stops: [
        { pos: bindStatic(0), color: bindStatic([0.95, 0.2, 0.1, 1]) },
        { pos: bindStatic(1), color: bindStatic([0.1, 0.4, 0.95, 0.7]) },
      ],
    },
  };
  const sdfChild: ShaderExpr | null = sdfPrograms.length ? { k: "program", node: "sdf-child", program: (sdfPrograms[0] as any).program } : null;
  check("the chain has its parts: a fused noise → ramp call, image / color / gradient leaves, an SDF program child", exprs?.k === "call" && !!sdfChild);
  if (exprs && sdfChild) {
    const chainOf = (leaf: ShaderExpr, leaf2: ShaderExpr) =>
      call("test.cm.mix@1", "mx3", { k: 0.3, tint: [0.1, 0.5, 0.9, 1] }, {
        a: call("test.cm.mix@1", "mx2", { k: 0.5, tint: [0.2, 0.9, 0.4, 1] }, { a: call("test.cm.mix@1", "mx1", { k: 0.4, tint: [0.9, 0.2, 0.6, 1] }, { a: exprs, b: leaf }), b: sdfChild }),
        b: leaf2,
      });
    const ir = fusedIR(chainOf(imageLeaf, colorLeaf));
    const p = (ir as any).program as SkslProgramIR;
    check(
      "…fuses to one program with an image leaf, a color leaf and a program child",
      p.children.length === 3 && p.children.some((c) => c.shader.k === "image") && p.children.some((c) => c.shader.k === "color") && p.children.some((c) => c.shader.k === "runtime")
    );
    collect("chain", ir);
    summarize("chain: noise → ramp × image leaf × SDF program child × color leaf", [measure("chain", ir)], { negativeMin: 5 });
    // A native gradient leaf is sampled correctly, but Skia interpolates its
    // stops in the working space, so on P3 its in-between colors differ.
    const g = measure("chain with a gradient leaf", fusedIR(chainOf(gradientLeaf, colorLeaf)));
    info(`…the same chain with a native gradient leaf: P3 vs sRGB max ${fmt(g.math)} (Skia interpolates a gradient leaf in the working space — section 6)`);
  }
}
lap("5. chain");

// ---- 6. native drawing, and negative controls ---------------------------------------------------
{
  const scene = (root: SkiaNode, assets: Record<string, any> = {}): SkiaScene => ({ version: SKIA_IR_VERSION, width: S, height: S, root, assets });
  const nat = (sc: SkiaScene) => diff8(read8(drawScene(P3F, sc, S, S).img, SRGB), read8(drawScene(SRGB8, sc, S, S).img, SRGB));
  const solid = nat(scene({ k: "fill", paint: { style: "fill", color: bindStatic([0.95, 0.35, 0.1, 1]) } }));
  const leafColor = nat(scene({ k: "fill", paint: { style: "fill", shader: { k: "color", color: bindStatic([0.1, 0.75, 0.35, 0.6]) } } }));
  const image = nat(scene({ k: "image", asset: TEX, x: bindStatic(0), y: bindStatic(0), w: bindStatic(S), h: bindStatic(S), fit: "fill" }, { [TEX]: { id: TEX, kind: "image", mime: "image/png", url: "" } }));
  check(`native: a solid paint color, a color shader and an sRGB image match on P3 (Skia converts them) — max ${Math.max(solid.max, leafColor.max, image.max)}/255`, solid.max <= 1 && leafColor.max <= 1 && image.max <= 1);
  const grad = nat(
    scene({
      k: "fill",
      paint: {
        style: "fill",
        shader: {
          k: "linear",
          start: [bindStatic(0), bindStatic(0)],
          end: [bindStatic(S), bindStatic(0)],
          stops: [
            { pos: bindStatic(0), color: bindStatic([1, 0, 0, 1]) },
            { pos: bindStatic(1), color: bindStatic([0, 0, 1, 1]) },
          ],
        },
      },
    })
  );
  const over = nat(
    scene({
      k: "group",
      children: [
        { k: "fill", paint: { style: "fill", color: bindStatic([0.1, 0.75, 0.35, 1]) } },
        { k: "fill", paint: { style: "fill", color: bindStatic([0.95, 0.2, 0.6, 0.5]) } },
      ],
    })
  );
  info(`native (not shader) residuals on P3: a red → blue linear gradient max ${fmt(grad)}, a 50 % pink over green max ${fmt(over)} — Skia interpolates gradients and blends in the working space; not ours to convert (spec §4)`);

  // Negative controls the corrected programs are measured against.
  const lit = compileSksl(CK, "half4 main(float2 p) { return half4(0.9, 0.5, 0.2, 1.0); }");
  const old = compileSksl(CK, "layout(color) uniform float4 a;\nlayout(color) uniform float4 b;\nhalf4 main(float2 p) { float3 c = mix(a.rgb, b.rgb, p.x / 32.0); c = c * c; return half4(half3(c), 1.0); }");
  const drawRaw = (t: Target, effect: any, u: number[]) => {
    const s = surfaceFor(t, S, S);
    const paint = new CK.Paint();
    const sh = effect.makeShader(u);
    paint.setShader(sh);
    paint.setBlendMode(CK.BlendMode.Src);
    s.getCanvas().drawPaint(paint);
    s.flush();
    const img = s.makeImageSnapshot();
    const px = read8(img, SRGB);
    for (const o of [img, sh, paint, s]) o.delete();
    return px;
  };
  const dLit = diff8(drawRaw(P3F, lit.effect, []), drawRaw(SRGB8, lit.effect, []));
  const ab = [0.95, 0.35, 0.1, 1, 0.1, 0.75, 0.35, 1];
  const dOld = diff8(drawRaw(P3F, old.effect, ab), drawRaw(SRGB8, old.effect, ab));
  check(`NEGATIVE: an unconverted literal float3(0.9, 0.5, 0.2) differs on P3 by ${fmt(dLit)}`, dLit.max >= 20);
  check(`NEGATIVE: the old style — layout(color) uniforms mixed and squared by sRGB math — differs on P3 by ${fmt(dOld)}`, dOld.max >= 8);
}
lap("6. native + controls");

// ---- 7. static: no layout(color), every program color-managed, manifests -------------------------
{
  const withLayout = allPrograms.filter((p) => /\blayout\s*\(\s*color\s*\)/.test(p.sksl.replace(/\/\/[^\n]*/g, "")));
  check(`no program any generator emitted declares layout(color) (${allPrograms.length} programs)`, allPrograms.length > 0 && withLayout.length === 0, withLayout.slice(0, 3).map((p) => p.where).join(" | "));
  const unmanagedProgs = allPrograms.filter((p) => !lib.isColorManagedSksl(p.sksl));
  check("every one is color-managed (main converts through tbx.color.cm)", unmanagedProgs.length === 0, unmanagedProgs.slice(0, 3).map((p) => p.where).join(" | "));
  const a = fx.auroraGraph();
  const req = { nodes: a.nodes, edges: a.edges, targetId: a.targetId, name: "Aurora", canvas: { width: 512, height: 512 }, timeline: fx.AURORA_TIMELINE, runtimeSource };
  const g = auroraSceneGraph(fx.AURORA_SKSL);
  const sreq = { nodes: g.nodes, edges: g.edges, targetId: "skc", name: "Aurora scene", canvas: { width: 512, height: 512 }, timeline: fx.AURORA_TIMELINE, runtimeSource };
  const out: string[] = [];
  for (const [label, r] of [
    ["SkSL Shader, worklet", exportSkia(req)],
    ["SkSL Shader, baked", exportSkia({ ...req, animation: "baked" })],
    ["scene, worklet", exportSkia(sreq)],
    ["scene, baked", exportSkia({ ...sreq, animation: "baked" })],
  ] as const) {
    const m = r.files ? JSON.parse(r.files["manifest.json"]) : null;
    if (!m || m.colorManaged !== true || m.baked?.color !== undefined || (m.warnings ?? []).some((w: string) => /P3/.test(w))) out.push(`${label}: ${r.problems.join(" ") || JSON.stringify({ colorManaged: m?.colorManaged, color: m?.baked?.color })}`);
  }
  check("manifests (SkSL Shader + scene, worklet + baked) say colorManaged: true and carry no P3 caveat", out.length === 0, out.join(" | "));
}
lap("7. static");

console.log(`\ncheck-skia-color-management: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
