// check-skia-baked: the `animation: "baked"` export gate — the timeline
// compiled into the SkSL (specdocs/101326_skia-target.md §3.5b, M3 lane A,
// src/lib/skia-export/emit-baked.ts). No GPU, no device:
//
//   1. numerics: every easing preset (+ the legacy aliases), cubicBezier,
//      customBezier (explicit and default handles), hold, sub-frame and
//      same-tick keys, a BindRef scale, int hold tracks, OKLab / RGB colors
//      raw and through quantize8 (node alpha and quantizeAlpha), and the
//      Aurora / synthetic fixtures' own tracks: the baked track functions run
//      in CanvasKit (CPU, an F32 surface) at every frame and at fractional
//      times, against evaluateKeyframesAt (raw) and the worklet runtime's
//      evaluateTrack (what the uniform receives). Values at keys, clamps and
//      holds are bit-identical (fp32 of the double); interpolated values are
//      within a relative bound; every 8-bit flip is one step at a double
//      within ε of a .5 boundary;
//   2. Aurora (SkSL Shader node), 3. Aurora (Skia-layer scene, two sampled
//      ramp series) and 4. a synthetic SkSL node whose channels carry every
//      easing: the baked bundle vs the worklet bundle rendered on CanvasKit
//      CPU surfaces at EVERY frame — max per-channel error ≤ 1/255;
//   5. what bakes and what stays: per frame the baked programs need only
//      iTime and their static uniforms; a scene's binds outside programs stay
//      on the worklet (manifest + warning); the worklet export is unchanged;
//      the output is deterministic; the dispatch (exportSkia / CLI) matches;
//   6. refusals: spring segments, series over the caps, scenes ≥ 2^24 ticks,
//      a program whose iTime isn't the clock, the reserved tbk_ prefix;
//   7. checkExportable(…, typecheck) on baked scene exports, and the baked
//      SkSL Shader bundle type-checks in skia-harness.
//
//   npx tsx scripts/check-skia-baked.mts      (BAKED_SIZE=<px> for section 2–4 renders)

/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Keyframe, KeyframeAnimationBlock } from "@/engine/keyframes";
import type { SkslProgramIR } from "@/engine/skia/scene-ir";
import type { TimelineTrack } from "@/lib/skia-export/runtime/toolbox-timeline";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { evaluateKeyframesAt, EASING_PRESET_ORDER } = await import("@/engine/keyframes");
const { exportSkia, makeSceneSampler, planSceneExport, planSkiaExport, emitSkiaBundle, emitSceneBundle } = await import("@/lib/skia-export");
const { sampleKeys } = await import("@/lib/skia-export/scene-emit");
const { hexToTuple, toTimelineKey } = await import("@/lib/skia-export/drivers");
const bk = await import("@/lib/skia-export/emit-baked");
const rt = await import("@/lib/skia-export/runtime/toolbox-timeline");
const { checkExportable } = await import("./skia/export-check.ts");
const fx = await import("./fixtures/skia/aurora.ts");
const { auroraSceneGraph } = await import("./fixtures/skia/aurora-scene-graph.ts");
const bfx = await import("./fixtures/skia/baked-graph.ts");
const sfx = await import("./fixtures/skia/scene-fixture.ts");
import type { ScenePlan } from "@/lib/skia-export/scene-plan";

const require = createRequire(path.join(ROOT, "package.json"));
const CK = await require("canvaskit-wasm")();
const runtimeSource = fs.readFileSync(path.join(ROOT, "src/lib/skia-export/runtime/toolbox-timeline.ts"), "utf8");
// Every-frame renders run at SIZE² (Skia's CPU backend runs both sides of every
// branch, so a baked program costs far more per pixel there than on a GPU);
// a few frames also run at FULL².
const SIZE = Number(process.env.BAKED_SIZE ?? 32);
const FULL = 128;
let t0 = Date.now();
function lap(what: string) {
  info(`${what}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  t0 = Date.now();
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function info(msg: string) {
  console.log(`info ${msg}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skia-baked-"));
async function load(files: Record<string, string>, slot: string): Promise<any> {
  const dir = path.join(tmp, slot);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return import(pathToFileURL(path.join(dir, "timeline.ts")).href);
}

// ---- CanvasKit (CPU) ----------------------------------------------------------------

const effects = new Map<string, any>();
function effectOf(sksl: string): any {
  let e = effects.get(sksl);
  if (e === undefined) {
    let err = "";
    e = CK.RuntimeEffect.Make(sksl, (m: string) => (err = m)) ?? null;
    if (!e) console.log(`     compile error: ${err.split("\n").slice(0, 6).join(" | ")}`);
    effects.set(sksl, e);
  }
  return e;
}
function declared(sksl: string): string[] {
  const e = effectOf(sksl);
  const out: string[] = [];
  if (e) for (let i = 0; i < e.getUniformCount(); i++) out.push(e.getUniformName(i));
  return out;
}
function pack(effect: any, values: Record<string, number | number[]>): Float32Array {
  const out = new Float32Array(effect.getUniformFloatCount());
  for (let i = 0; i < effect.getUniformCount(); i++) {
    const name = effect.getUniformName(i);
    const u = effect.getUniform(i);
    const v = values[name];
    if (v === undefined) throw new Error(`no value for uniform ${name}`);
    const vs = typeof v === "number" ? [v] : v;
    const n = i + 1 < effect.getUniformCount() ? effect.getUniform(i + 1).slot - u.slot : out.length - u.slot;
    for (let k = 0; k < n && k < vs.length; k++) out[u.slot + k] = vs[k];
  }
  return out;
}
// Straight-alpha RGBA8, row 0 = top (check-skia-library's renderShader).
function render(sksl: string, values: Record<string, number | number[]>, w: number, h: number): Uint8Array {
  const e = effectOf(sksl);
  const surf = CK.MakeSurface(w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const paint = new CK.Paint();
  const shader = e.makeShader(pack(e, values));
  paint.setShader(shader);
  paint.setBlendMode(CK.BlendMode.Src);
  canvas.drawPaint(paint);
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
  img.delete();
  shader.delete();
  paint.delete();
  surf.delete();
  return px;
}
interface PixelStats {
  max: number;
  maxPerChannel: number[];
  differing: number;
  pixels: number;
  framesDiffering: number;
}
function newStats(): PixelStats {
  return { max: 0, maxPerChannel: [0, 0, 0, 0], differing: 0, pixels: 0, framesDiffering: 0 };
}
function accumulate(s: PixelStats, a: Uint8Array, b: Uint8Array) {
  let frameDiff = 0;
  for (let i = 0; i < a.length; i += 4) {
    let px = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      if (d > s.maxPerChannel[c]) s.maxPerChannel[c] = d;
      if (d > px) px = d;
    }
    if (px) frameDiff++;
    if (px > s.max) s.max = px;
  }
  s.differing += frameDiff;
  s.pixels += a.length / 4;
  if (frameDiff) s.framesDiffering++;
}
const statsText = (s: PixelStats) =>
  `max ${s.max}/255 (r ${s.maxPerChannel[0]} g ${s.maxPerChannel[1]} b ${s.maxPerChannel[2]} a ${s.maxPerChannel[3]}), ${s.differing} of ${s.pixels} px differ (${((100 * s.differing) / Math.max(1, s.pixels)).toFixed(3)}%) in ${s.framesDiffering} frames`;

// The baked track functions at `seconds`, read back from an F32 surface
// (bakedProbeProgram: component k of value j at pixel x = j·4 + k, in r).
function probe(sksl: string, widths: number[]) {
  const e = effectOf(sksl);
  const W = widths.length * 4;
  const mem = CK.Malloc(Float32Array, W * 4);
  const surf = CK.MakeRasterDirectSurface(
    { width: W, height: 1, colorType: CK.ColorType.RGBA_F32, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB },
    mem,
    W * 16
  );
  const paint = new CK.Paint();
  paint.setBlendMode(CK.BlendMode.Src);
  const raw = (seconds: number): Float32Array => {
    const shader = e.makeShader(new Float32Array([seconds]));
    paint.setShader(shader);
    surf.getCanvas().drawPaint(paint);
    surf.flush();
    shader.delete();
    return mem.toTypedArray() as Float32Array;
  };
  return {
    raw,
    at(seconds: number): number[][] {
      const px = raw(seconds);
      return widths.map((w, j) => Array.from({ length: w }, (_, k) => px[(j * 4 + k) * 4]));
    },
    done() {
      paint.delete();
      surf.delete();
      CK.Free(mem);
    },
  };
}

// ---- 1. numerics -----------------------------------------------------------------------
{
  // The polynomial transcendentals the baked code calls instead of Skia's
  // builtins, over the ranges the easings and OKLab use.
  const N = 2048;
  const fns: [string, (x: number) => number, string, number, number, "abs" | "rel", number][] = [
    ["tbk_sin", Math.sin, "tbk_sin(x)", -2, 20, "abs", 5e-7],
    ["tbk_cos", Math.cos, "tbk_cos(x)", 0, 3.2, "abs", 5e-7],
    ["tbk_exp2", (x) => Math.pow(2, x), "tbk_exp2(x)", -10, 1, "rel", 3e-7],
    ["tbk_pow(·, 1/2.4)", (x) => Math.pow(x, 1 / 2.4), `tbk_pow(x, ${bk.skslFloat(1 / 2.4)})`, 0.003, 1.5, "rel", 5e-7],
    ["builtin sin (for comparison)", Math.sin, "sin(x)", -2, 20, "abs", Infinity],
    ["builtin pow (for comparison)", (x) => Math.pow(x, 1 / 2.4), `pow(x, ${bk.skslFloat(1 / 2.4)})`, 0.003, 1.5, "rel", Infinity],
  ];
  for (const [name, ref, expr, lo, hi, mode, bound] of fns) {
    const sksl = `uniform float iTime;\n${bk.BAKED_HELPERS.math}\nhalf4 main(float2 p) { float x = ${bk.skslFloat(lo)} + ${bk.skslFloat(hi - lo)} * (floor(p.x) / ${N - 1}.0); return half4(${expr}, x, 0.0, 1.0); }`;
    // (r, g) = (f(x), x) per pixel.
    const p = probe(sksl, Array.from({ length: N / 4 }, () => 4));
    const out = Float32Array.from(p.raw(0));
    p.done();
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const x = out[i * 4 + 1];
      const r = ref(x);
      worst = Math.max(worst, Math.abs(out[i * 4] - r) / (mode === "rel" ? Math.abs(r) : 1));
    }
    if (Number.isFinite(bound)) check(`${name} on [${lo}, ${hi}] vs Math (CanvasKit CPU): max ${mode} error ${worst.toExponential(2)} (bound ${bound})`, worst <= bound);
    else info(`${name} on [${lo}, ${hi}]: max ${mode} error ${worst.toExponential(2)} — why the baked code doesn't call it`);
  }
}
{
  const FPS = 60;
  const TPF = 1000;
  const SPAN = 60_000;
  const blockOf = (keys: Keyframe[], colorSpace?: "oklab" | "rgb"): KeyframeAnimationBlock => ({ animated: true, trackVisible: true, keyframes: keys, ...(colorSpace ? { colorSpace } : {}) });
  interface Case {
    label: string;
    track: TimelineTrack;
    // The raw value the engine evaluates (before the uniform's quantize /
    // scale), null when the case compares through evaluateTrack only.
    raw: ((tick: number) => number | number[]) | null;
    // Values in raw (unquantized) space: compare with the relative bound.
    continuous: boolean;
  }
  const cases: Case[] = [];
  const scalarCase = (label: string, keys: Keyframe[], scale?: number) => {
    const track: TimelineTrack = { kind: "scalar", keys: keys.map((k) => toTimelineKey(k, "scalar")), ...(scale !== undefined ? { scale } : {}) };
    const block = blockOf(keys);
    cases.push({ label, track, raw: (t) => (evaluateKeyframesAt(block, "scalar", t) as number) * (scale ?? 1), continuous: true });
  };
  const presets = [...EASING_PRESET_ORDER.filter((p) => p !== "customBezier"), "easeIn", "easeOut", "easeInOut", "cubicBezier"] as Keyframe["easingOut"][];
  for (const p of presets) {
    scalarCase(p, [
      { tick: 0, value: -2, easingOut: p, ...(p === "cubicBezier" ? { bezier: { x1: 0.2, y1: 1.6, x2: 0.3, y2: -0.4 } } : {}) },
      { tick: SPAN, value: 5, easingOut: p, ...(p === "cubicBezier" ? { bezier: { x1: 0.9, y1: 0, x2: 0.1, y2: 1 } } : {}) },
      { tick: SPAN * 2, value: 1, easingOut: "linear" },
    ]);
  }
  scalarCase("customBezier (explicit + default handles)", [
    { tick: 0, value: 0, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 50_000, dy: 9 }, leftHandle: { dx: -1, dy: 0 } } },
    { tick: SPAN, value: 4, easingOut: "customBezier", bezierHandles: { rightHandle: { dx: 2_000, dy: -3 }, leftHandle: { dx: -70_000, dy: 2 } } },
    { tick: SPAN * 2, value: -1, easingOut: "customBezier" },
    { tick: SPAN * 3, value: 2, easingOut: "linear" },
  ]);
  scalarCase("sub-frame + same-tick keys", [
    { tick: 0, value: 0, easingOut: "easeOutCubic" },
    { tick: 1_500, value: 3, easingOut: "hold" },
    { tick: 30_250, value: 2, easingOut: "easeOutElastic" },
    { tick: 30_250, value: -1, easingOut: "easeInOutSine" },
    { tick: 90_000, value: 2.5, easingOut: "linear" },
    { tick: 90_000, value: 2.5, easingOut: "linear" },
  ]);
  scalarCase("BindRef scale (degrees → radians)", [
    { tick: 0, value: 0, easingOut: "easeOutBack" },
    { tick: SPAN, value: 270, easingOut: "easeInOutQuad" },
    { tick: SPAN * 2, value: -45, easingOut: "linear" },
  ], Math.PI / 180);
  scalarCase("single key", [{ tick: 7_000, value: 1.75, easingOut: "easeOutBack" }]);
  cases.push({
    label: "int hold track (toggle)",
    track: { kind: "scalar", keys: [{ tick: 0, value: 0, easing: "hold" }, { tick: 20_000, value: 1, easing: "hold" }, { tick: 90_000, value: 0, easing: "hold" }] },
    raw: null,
    continuous: false,
  });
  const hexKeys: Keyframe[] = [
    { tick: 0, value: "#ff7a45", easingOut: "easeInOutQuad" },
    { tick: SPAN, value: "#1b2cff80", easingOut: "easeOutBack" },
    { tick: SPAN * 2, value: "#00ffa2", easingOut: "cubicBezier", bezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } },
    { tick: SPAN * 3, value: "#ffe3c2", easingOut: "linear" },
  ];
  for (const space of ["oklab", "rgb"] as const) {
    const keys = hexKeys.map((k) => toTimelineKey(k, "color"));
    const block = blockOf(hexKeys, space);
    const raw = (t: number) => {
      const v = evaluateKeyframesAt(block, "color", t);
      return typeof v === "string" ? hexToTuple(v) : (v as number[]);
    };
    cases.push({ label: `color ${space}, raw`, track: { kind: "color", colorSpace: space, keys }, raw, continuous: true });
    cases.push({ label: `color ${space}, quantize8 + node alpha 0.75`, track: { kind: "color", colorSpace: space, quantize8: true, alpha: 0.75, keys }, raw: null, continuous: false });
    cases.push({ label: `color ${space}, quantize8 + quantizeAlpha`, track: { kind: "color", colorSpace: space, quantize8: true, quantizeAlpha: true, keys }, raw: null, continuous: false });
  }
  // The fixtures' own tracks.
  const aur = fx.auroraGraph();
  const aurPlan = planSkiaExport(aur.nodes, aur.edges, aur.targetId, { name: "Aurora", canvas: { width: 512, height: 512 }, timeline: fx.AURORA_TIMELINE }).plan!;
  const syn = bfx.bakedGraph();
  const synPlan = planSkiaExport(syn.nodes, syn.edges, syn.targetId, { name: "Baked", canvas: { width: 256, height: 64 }, timeline: bfx.BAKED_TIMELINE }).plan!;
  for (const [tag, p] of [["Aurora", aurPlan], ["synthetic", synPlan]] as const) {
    for (const u of p.uniforms) if (u.track) cases.push({ label: `${tag} ${u.name}`, track: u.track, raw: null, continuous: u.track.kind === "scalar" });
  }

  const pr = bk.bakedProbeProgram(cases.map((c) => ({ track: c.track, label: c.label })), { fps: FPS, ticksPerFrame: TPF });
  check("the probe program (every case's baked track) generates", pr.problems.length === 0, pr.problems.join(" | "));
  check("…and compiles in CanvasKit (strict ES2)", !!effectOf(pr.sksl));

  // Times: every frame, fractional frames, ±0.4 tick around every key, and
  // either side of the timeline.
  const seconds = new Set<number>();
  const lastTick = Math.max(...cases.map((c) => c.track.keys[c.track.keys.length - 1].tick));
  for (let f = 0; f * TPF <= lastTick + 2 * TPF; f++) {
    seconds.add(f / FPS);
    seconds.add((f + 0.37) / FPS);
  }
  for (const c of cases) for (const k of c.track.keys) for (const d of [-0.4, 0.4]) seconds.add((k.tick + d) / (FPS * TPF));
  seconds.add(-0.25);
  seconds.add(lastTick / (FPS * TPF) + 1.5);

  if (pr.problems.length === 0 && effectOf(pr.sksl)) {
    const p = probe(pr.sksl, pr.widths);
    // Worst |baked − evaluator| / track magnitude, scalars and colors apart:
    // against the evaluator at the shader's own tick (fp32 iTime × fps ×
    // ticksPerFrame, snapped — emulated below), i.e. the evaluation error;
    // and end to end, against the evaluator at the double clock, which adds
    // the fp32 clock's own resolution (≤ 1.2e-7 · tick).
    const worst = { scalar: { rel: 0, at: "" }, color: { rel: 0, at: "" } };
    const e2e = { scalar: 0, color: 0 };
    let tickErr = 0;
    const K = FPS * TPF;
    const shaderTick = (sec: number) => {
      const f = Math.fround;
      const tk = f(f(sec) * K);
      const r = Math.floor(f(tk + 0.5));
      return Math.abs(f(tk - r)) < f(1e-6 + f(2.5e-7 * Math.abs(tk))) ? r : tk;
    };
    let exactBad = "";
    let exactN = 0;
    let flips = 0;
    let flipBad = "";
    let flipWorstD = 0;
    let ulpWorst = 0;
    let quantN = 0;
    let rawBad = "";
    const scale = cases.map((c) => {
      let m = 1e-6;
      for (const k of c.track.keys) for (const x of ([] as number[]).concat(k.value as number | number[])) m = Math.max(m, Math.abs(x) * (c.track.scale ?? 1));
      return m;
    });
    for (const s of seconds) {
      const got = p.at(s);
      const tick = rt.ticksAt(s, FPS, TPF);
      cases.forEach((c, j) => {
        const want = ([] as number[]).concat(rt.evaluateTrack(c.track, tick) as number | number[]);
        const have = got[j];
        const keys = c.track.keys;
        // Clamps and exact key hits: constants in the baked function.
        const onKey = tick <= keys[0].tick || tick >= keys[keys.length - 1].tick || keys.some((k) => k.tick === tick);
        const inHold = (() => {
          if (tick <= keys[0].tick || tick >= keys[keys.length - 1].tick) return false;
          let lo = 0;
          for (let i = 0; i < keys.length; i++) if (keys[i].tick <= tick) lo = i;
          return keys[lo].easing === "hold";
        })();
        if (onKey || inHold) {
          // Constants: the worklet's double, rounded once to fp32.
          for (let k = 0; k < want.length; k++) {
            if (!Object.is(Math.fround(want[k]), have[k]) && !exactBad) exactBad = `${c.label} @${tick} [${k}]: worklet ${want[k]} baked ${have[k]}`;
          }
          exactN++;
          return;
        }
        if (!c.continuous) {
          // Quantized colors between keys: the same 8-bit level (its fp32
          // value within an ulp of k/255 — Skia compiles x / 255.0 as a
          // reciprocal multiply), or a one-step flip at a double within ε of
          // a .5 boundary. A pinned alpha is exact.
          quantN++;
          const qa = c.track.kind === "color" && c.track.quantize8;
          for (let k = 0; k < want.length; k++) {
            if (Object.is(Math.fround(want[k]), have[k])) continue;
            const pinned = k === 3 && qa && !c.track.quantizeAlpha;
            if (!qa || pinned) {
              if (!exactBad) exactBad = `${c.label} @${tick} [${k}]: worklet ${want[k]} baked ${have[k]}`;
              continue;
            }
            const lw = Math.round(want[k] * 255);
            const lh = Math.round(have[k] * 255);
            if (lw === lh) {
              ulpWorst = Math.max(ulpWorst, Math.abs(have[k] - Math.fround(want[k])) / (2 ** (Math.floor(Math.log2(Math.max(want[k], 1e-30))) - 23)));
              continue;
            }
            const rawV = (rt.evaluateTrackRaw(c.track, tick) as number[])[k];
            const x = rawV * 255;
            const d = Math.abs(x - (Math.floor(x) + 0.5));
            flips++;
            flipWorstD = Math.max(flipWorstD, d);
            if (Math.abs(lh - lw) !== 1 || d > 2e-3) {
              if (!flipBad) flipBad = `${c.label} @${tick} [${k}]: worklet ${lw}/255 baked ${lh}/255, raw×255 = ${x}`;
            }
          }
          return;
        }
        const evalAt = (t: number) => (c.raw ? ([] as number[]).concat(c.raw(t)) : ([] as number[]).concat(rt.evaluateTrack(c.track, t) as number | number[]));
        const ref0 = evalAt(tick);
        if (c.raw && !rawBad && ref0.some((x, k) => !Object.is(x, want[k]))) rawBad = `${c.label} @${tick}: evaluateKeyframesAt ${ref0} runtime ${want}`;
        const st = shaderTick(s);
        tickErr = Math.max(tickErr, Math.abs(st - tick));
        const ref = evalAt(st);
        for (let k = 0; k < ref.length; k++) {
          e2e[c.track.kind] = Math.max(e2e[c.track.kind], Math.abs(have[k] - ref0[k]) / scale[j]);
          const rel = Math.abs(have[k] - ref[k]) / scale[j];
          const w = worst[c.track.kind];
          if (rel > w.rel) {
            w.rel = rel;
            w.at = `${c.label} @tick ${tick} [${k}]: evaluator ${ref[k]} baked ${have[k]}`;
          }
        }
      });
    }
    p.done();
    check(`${cases.length} tracks × ${seconds.size} times: the runtime still equals evaluateKeyframesAt on the raw cases (the reference)`, !rawBad, rawBad);
    check(`values at keys, clamps and holds are the worklet's doubles rounded once to fp32 (${exactN} samples)`, !exactBad, exactBad);
    check(`interpolated scalars at the shader's tick: max error / track magnitude = ${worst.scalar.rel.toExponential(2)} (bound 2e-6)`, worst.scalar.rel <= 2e-6, worst.scalar.at);
    info(`worst scalar: ${worst.scalar.at}`);
    // OKLab → linear sRGB cancels near the gamut edge (r ≈ 0 from terms ≈ 2.3):
    // fp32 leaves ~1e-6 there, ×12.92 in the linear segment of the sRGB curve.
    check(`interpolated raw colors (0..1) at the shader's tick: max error ${worst.color.rel.toExponential(2)} (bound 2e-5 = 0.005/255)`, worst.color.rel <= 2e-5, worst.color.at);
    info(`worst color: ${worst.color.at}`);
    check(
      `end to end vs the double clock: scalars ${e2e.scalar.toExponential(2)}, colors ${e2e.color.toExponential(2)} of track magnitude (fp32 clock: ≤ ${tickErr.toFixed(4)} ticks off; bound 1e-5 / 2e-5)`,
      e2e.scalar <= 1e-5 && e2e.color <= 2e-5
    );
    check(
      `quantize8: ${flips} 8-bit flips in ${quantN} quantized samples, each one step at a double within ${flipWorstD.toExponential(2)} of a .5 boundary (allowed 2e-3); equal levels within ${ulpWorst.toFixed(1)} ulp of k/255`,
      !flipBad && ulpWorst <= 1,
      flipBad
    );
  }
}

// ---- helpers for the bundle comparisons --------------------------------------------------

function skslOfEffect(files: Record<string, string>): string {
  return JSON.parse(/export const SKSL = (".*");/.exec(files["effect.ts"])![1]);
}
function skslsOfScene(files: Record<string, string>): string[] {
  return [...files["effects.ts"].matchAll(/export const SKSL_\d+ = (".*");/g)].map((m) => JSON.parse(m[1]));
}

lap("1. numerics");
// ---- 2. Aurora (SkSL Shader node): every frame, baked vs worklet ---------------------------
const aurora = fx.auroraGraph();
const auroraReq = {
  nodes: aurora.nodes,
  edges: aurora.edges,
  targetId: aurora.targetId,
  name: "Aurora",
  canvas: { width: 512, height: 512 },
  timeline: fx.AURORA_TIMELINE,
  runtimeSource,
};
const auroraW = exportSkia(auroraReq);
const auroraB = exportSkia({ ...auroraReq, animation: "baked" });
check("Aurora exports baked without problems", !!auroraB.files && auroraB.problems.length === 0, auroraB.problems.join(" | "));
async function effectParity(label: string, w: Record<string, string>, b: Record<string, string>, frames: number, fps: number, size: [number, number], fullFrames: number[] = []) {
  const W = await load(w, `${label}-w`);
  const B = await load(b, `${label}-b`);
  const sw = skslOfEffect(w);
  const sb = skslOfEffect(b);
  check(`${label}: the baked program compiles in CanvasKit`, !!effectOf(sb));
  const decl = declared(sb);
  const supplied = Object.keys(B.sampleUniforms(0, size[0], size[1]));
  check(
    `${label}: the baked program declares exactly what sampleUniforms supplies (${decl.length}: iResolution, iTime + static)`,
    decl.length === supplied.length && supplied.every((n) => decl.includes(n)),
    `declared ${decl} supplied ${supplied}`
  );
  if (!effectOf(sb)) return;
  const s = newStats();
  const motion = newStats();
  const t0 = Date.now();
  let first: Uint8Array | null = null;
  for (let f = 0; f < frames; f++) {
    const a = render(sw, W.sampleUniforms(f / fps, size[0], size[1]), size[0], size[1]);
    const c = render(sb, B.sampleUniforms(f / fps, size[0], size[1]), size[0], size[1]);
    accumulate(s, a, c);
    if (!first) first = c;
    else accumulate(motion, first, c);
  }
  check(`${label}: baked vs worklet, every frame (${frames} × ${size[0]}×${size[1]}, CPU): ${statsText(s)} (bound 1/255)`, s.max <= 1);
  // …and the baked program really animates from iTime alone.
  check(`${label}: the baked frames move (${motion.framesDiffering} of ${frames - 1} differ from frame 0, max ${motion.max}/255)`, motion.framesDiffering > frames / 2 && motion.max > 16);
  info(`${label}: ${frames * 2} renders in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (fullFrames.length) {
    const sf = newStats();
    for (const f of fullFrames) accumulate(sf, render(sw, W.sampleUniforms(f / fps, FULL, FULL), FULL, FULL), render(sb, B.sampleUniforms(f / fps, FULL, FULL), FULL, FULL));
    check(`${label}: frames ${fullFrames.join("/")} at ${FULL}²: ${statsText(sf)} (bound 1/255)`, sf.max <= 1);
  }
}
if (auroraW.files && auroraB.files) {
  const frames = fx.AURORA_TIMELINE.sceneDurationTicks / fx.AURORA_TIMELINE.ticksPerFrame + 1;
  await effectParity("Aurora (SkSL Shader)", auroraW.files, auroraB.files, frames, fx.AURORA_TIMELINE.fps, [SIZE, SIZE], [45, 150, 240]);
}

lap("2. Aurora (SkSL Shader)");
// ---- 3. Aurora (Skia-layer scene): every frame, baked vs worklet ------------------------------
function scenePlanOf(nodes: any[], edges: any[], canvasId: string, canvas: { width: number; height: number }, timeline: { fps: number; ticksPerFrame: number; sceneDurationTicks: number }): ScenePlan {
  const sampler = makeSceneSampler(nodes, edges, canvasId, canvas, timeline);
  if ("problem" in sampler) throw new Error(sampler.problem);
  const scene = sampler.sampleAt(0)!;
  const r = planSceneExport(scene, nodes, edges, { name: canvasId, timeline, sampleAt: (t) => sampler.sampleAt(t) });
  if (!r.plan) throw new Error(r.problems.join(" | "));
  return r.plan;
}
function programAt(plan: ScenePlan, where: string): SkslProgramIR {
  return where.split(".").slice(1).reduce<any>((o, k) => o[k], plan.scene.root) as SkslProgramIR;
}
// A program's uniform values at `seconds`, as the emitted component feeds
// them: animated binds from sampleBinds (by the key it reads), the rest
// static.
function programUniforms(plan: ScenePlan, mod: any, p: SkslProgramIR, sec: number): Record<string, number | number[]> {
  const keys = sampleKeys(plan);
  const B = mod.sampleBinds(sec);
  const out: Record<string, number | number[]> = {};
  for (const [name, b] of Object.entries(p.uniforms)) {
    const pb = plan.bindFor.get(b as any);
    const k = pb?.plan.kind;
    out[name] = k === "track" || k === "clock" || k === "sampled" ? B[keys.get(pb!.id)!] : k === "static" ? (pb!.plan as any).value : (b as any).v;
  }
  return out;
}
const sceneG = auroraSceneGraph(fx.AURORA_SKSL);
const scenePlan = scenePlanOf(sceneG.nodes, sceneG.edges, "skc", { width: 512, height: 512 }, fx.AURORA_TIMELINE);
const sceneBake = bk.bakeScenePlan(scenePlan);
check("Aurora scene bakes without problems", !!sceneBake.plan && sceneBake.problems.length === 0, sceneBake.problems.join(" | "));
if (sceneBake.plan) {
  const where = "root.paint.shader.program";
  const pb = sceneBake.programs.find((p) => p.where === where);
  check(
    "Aurora scene: the noise's 3 tracks and the ramp's 2 sampled series bake; nothing animated stays on the worklet but the clock",
    !!pb &&
      pb.baked.filter((b) => b.kind === "track").map((b) => b.name).sort().join() === "nskn_contrast,nskn_offset_x,nskn_scale" &&
      pb.baked.filter((b) => b.kind === "sampled").map((b) => b.name).sort().join() === "nskr_stops_color,nskr_stops_work" &&
      sceneBake.worklet.every((b) => b.plan.kind === "clock"),
    JSON.stringify(pb?.baked.map((b) => `${b.name}:${b.kind}`))
  );
  info(`Aurora scene: series kept frames ${pb?.baked.filter((b) => b.kind === "sampled").map((b) => `${b.name} ${b.points}`).join(", ")}`);
  const wFiles = emitSceneBundle(scenePlan, runtimeSource);
  const bRes = bk.emitBakedSceneBundle(scenePlan, runtimeSource);
  const viaApi = exportSkia({ nodes: sceneG.nodes, edges: sceneG.edges, targetId: "skc", name: "skc", canvas: { width: 512, height: 512 }, timeline: fx.AURORA_TIMELINE, runtimeSource, animation: "baked" });
  check("exportSkia({ animation: \"baked\" }) on a Skia Canvas == emitBakedSceneBundle(plan)", !!viaApi.files && JSON.stringify(viaApi.files) === JSON.stringify(bRes.files), viaApi.problems.join(" | "));
  const W = await load(wFiles, "scene-w");
  const B = await load(bRes.files!, "scene-b");
  const pw = programAt(scenePlan, where);
  const pbk = programAt(sceneBake.plan, where);
  check("Aurora scene: effects.ts ships the baked program", skslsOfScene(bRes.files!).includes(pbk.sksl) && !skslsOfScene(bRes.files!).includes(pw.sksl));
  const decl = declared(pbk.sksl);
  const sup = Object.keys(pbk.uniforms);
  check(
    `Aurora scene: the baked program declares exactly the uniforms the component supplies (${decl.length} of ${declared(pw.sksl).length})`,
    decl.length === sup.length && sup.every((n) => decl.includes(n)),
    `declared ${decl} supplied ${sup}`
  );
  const frames = fx.AURORA_TIMELINE.sceneDurationTicks / fx.AURORA_TIMELINE.ticksPerFrame + 1;
  const t0 = Date.now();
  // iResolution is the canvas (512); render the whole field at n² by feeding
  // iResolution = n to both sides (it's a static uniform). The baked series
  // is a 250-leaf if-tree that Skia's CPU backend runs in full for every
  // pixel (a GPU takes the one uniform branch), hence the smaller size.
  const n = Math.max(8, SIZE / 2);
  const pair = (sec: number, px: number) => {
    const sized = (u: Record<string, number | number[]>) => ({ ...u, iResolution: [px, px, 1] });
    return [render(pw.sksl, sized(programUniforms(scenePlan, W, pw, sec)), px, px), render(pbk.sksl, sized(programUniforms(sceneBake.plan!, B, pbk, sec)), px, px)] as const;
  };
  const s = newStats();
  for (let f = 0; f < frames; f++) accumulate(s, ...pair(f / fx.AURORA_TIMELINE.fps, n));
  check(`Aurora scene: baked vs worklet, every frame (${frames} × ${n}², CPU): ${statsText(s)} (bound 1/255)`, s.max <= 1);
  const sf = newStats();
  for (const f of [45, 150, 240]) accumulate(sf, ...pair(f / fx.AURORA_TIMELINE.fps, FULL / 2));
  check(`Aurora scene: frames 45/150/240 at ${FULL / 2}²: ${statsText(sf)} (bound 1/255)`, sf.max <= 1);
  info(`Aurora scene: ${frames * 2 + 6} renders in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const bm = JSON.parse(bRes.files!["manifest.json"]);
  check(
    "Aurora scene manifest: animation \"baked\", the baked uniforms by program, an empty worklet list",
    bm.animation === "baked" && bm.baked.programs[0].program === "SKSL_0" && bm.baked.programs[0].baked.length === 5 && bm.baked.worklet.binds === 0 && !!bm.baked.color
  );
  check("Aurora scene: timeline.ts carries only the clock", !/S_b18|S_b20|T_b4|T_b8|T_b12/.test(bRes.files!["timeline.ts"]) && /b3: seconds/.test(bRes.files!["timeline.ts"]));
}

lap("3. Aurora (scene)");
// ---- 4. synthetic: every easing on SkSL channels, every frame ----------------------------------
const syn = bfx.bakedGraph();
const synReq = { nodes: syn.nodes, edges: syn.edges, targetId: syn.targetId, name: "Baked easings", canvas: { width: 256, height: 64 }, timeline: bfx.BAKED_TIMELINE, runtimeSource };
const synW = exportSkia(synReq);
const synB = exportSkia({ ...synReq, animation: "baked" });
check("synthetic fixture exports baked without problems", !!synB.files && synB.problems.length === 0, synB.problems.join(" | "));
if (synW.files && synB.files) {
  const frames = bfx.BAKED_TIMELINE.sceneDurationTicks / bfx.BAKED_TIMELINE.ticksPerFrame + 1;
  const m = JSON.parse(synB.files["manifest.json"]);
  check(
    `synthetic: all ${m.uniforms.filter((u: any) => u.animated).length} animated uniforms bake (every easing, colors, toggle, pick, Color + Animated Value drivers)`,
    m.uniforms.every((u: any) => u.animated === !!u.baked) && m.uniforms.filter((u: any) => u.baked).length === bfx.BAKED_EASINGS.length + 6
  );
  await effectParity("synthetic easings", synW.files, synB.files, frames, bfx.BAKED_TIMELINE.fps, [SIZE * 2, SIZE / 2]);
}

lap("4. synthetic");
// ---- 5. what bakes and what stays --------------------------------------------------------------
if (auroraB.files && auroraW.files) {
  const f = auroraB.files;
  check(
    "baked SkSL Shader bundle: effect / timeline / component / manifest / index, no toolbox-timeline.ts",
    ["effect.ts", "timeline.ts", "ToolboxEffect.tsx", "manifest.json", "index.ts"].every((n) => n in f) && !("toolbox-timeline.ts" in f)
  );
  check("…timeline.ts imports nothing and evaluates no track", !/import|evaluateTrack|ticksAt/.test(f["timeline.ts"]));
  check("…the component and barrel are the worklet bundle's", f["ToolboxEffect.tsx"] === auroraW.files["ToolboxEffect.tsx"] && f["index.ts"] === auroraW.files["index.ts"]);
  check("…effect.ts says the program carries its timeline", /animation: "baked"/.test(f["effect.ts"]) && /Checked with CanvasKit 0\.41\.0/.test(f["effect.ts"]));
  const m = JSON.parse(f["manifest.json"]);
  check(
    "…manifest: animation \"baked\", scale/drift_x/contrast/c2 baked, the 7 static uniforms not, the color note",
    m.animation === "baked" &&
      m.uniforms.filter((u: any) => u.baked).map((u: any) => u.name).join() === "scale,drift_x,contrast,c2" &&
      m.uniforms.filter((u: any) => !u.baked).length === 7 &&
      m.baked.programs[0].baked.find((b: any) => b.name === "c2")?.color === true &&
      !!m.baked.color &&
      m.usesTime === true
  );
  const block = (skslOfEffect(f).split("// ---- toolbox: the animation, baked into the shader")[1] ?? "").replace(/\/\/[^\n]*/g, "");
  check(
    "…the generated block is strict ES2 by construction: no round / while / uint / bitwise / array constructors, no builtin sin / cos / exp2 / pow",
    !!block && !/\bround\s*\(|\bwhile\b|\buint\b|[&|^]|<<|>>|float\[\d+\]\s*\(|(?<!tbk_)\b(sin|cos|exp2|pow)\s*\(/.test(block)
  );
}
{
  const again = exportSkia({ ...auroraReq, animation: "baked" });
  check("baked export is deterministic (byte-identical twice)", JSON.stringify(again.files) === JSON.stringify(auroraB.files));
  const w2 = exportSkia({ ...auroraReq, animation: "worklet" });
  const plan = planSkiaExport(aurora.nodes, aurora.edges, aurora.targetId, { name: "Aurora", canvas: { width: 512, height: 512 }, timeline: fx.AURORA_TIMELINE }).plan!;
  check(
    "animation \"worklet\" and the default are the unchanged worklet export",
    JSON.stringify(w2.files) === JSON.stringify(auroraW.files) && JSON.stringify(auroraW.files) === JSON.stringify(emitSkiaBundle(plan, runtimeSource))
  );
}
{
  // The scene fixture: a fused-style program's keyframed tint bakes; the
  // gradient child, transforms, paths and paint stay on the worklet.
  const g = sfx.sceneFixtureGraph();
  const plan = scenePlanOf(g.nodes, g.edges, g.canvasId, sfx.SCENE_CANVAS, sfx.SCENE_TIMELINE);
  const b = bk.bakeScenePlan(plan);
  const prog = b.programs.find((p) => p.where === "root.children.0.paint.shader.program");
  check(
    "scene fixture: the program's keyframed tint bakes, its iTime stays the clock, k and iResolution stay uniforms",
    !!b.plan && prog?.baked.map((x) => `${x.name}:${x.kind}`).join() === "tint:track" && prog.uniforms.join() === "iResolution,iTime,k",
    b.problems.join(" | ") || JSON.stringify(prog)
  );
  const left = b.worklet.filter((x) => x.plan.kind !== "clock");
  check(
    `scene fixture: ${left.length} animated binds outside programs stay on the worklet (gradient stop, transforms, paths, …) and a warning says so`,
    left.length > 5 && left.some((x) => x.path.endsWith("children.0.shader.stops.0.color")) && b.warnings.some((w) => w.includes("stay on the worklet timeline"))
  );
  const files = bk.emitBakedSceneBundle(plan, runtimeSource).files!;
  const mod = await load(files, "fixture-b");
  const keys = sampleKeys(b.plan!);
  const sb = mod.sampleBinds(0.5);
  // (Animated path geometry is read from its PATH_* series, not sampleBinds.)
  const viaB = left.filter((x) => x.role !== "path");
  check(
    `scene fixture: sampleBinds still evaluates every worklet bind (${viaB.length} + ${left.length - viaB.length} path series), and none of the baked ones`,
    viaB.every((x) => keys.get(x.id)! in sb) && !Object.keys(sb).includes(plan.binds.find((x) => x.path.endsWith("program.uniforms.tint"))!.id),
    viaB.filter((x) => !(keys.get(x.id)! in sb)).map((x) => x.path).join(", ")
  );
  const m = JSON.parse(files["manifest.json"]);
  check("scene fixture manifest lists the worklet binds", m.baked.worklet.binds === left.length && m.baked.worklet.paths.length === left.length);
  const rp = b.plan ? programAt(b.plan, "root.children.0.paint.shader.program") : null;
  check("scene fixture: the baked program compiles and declares iResolution, iTime, k + its child", !!rp && declared(rp.sksl).join() === "iResolution,iTime,k");
}

// ---- 6. refusals ---------------------------------------------------------------------------------
{
  const plan = planSkiaExport(aurora.nodes, aurora.edges, aurora.targetId, { name: "x", canvas: { width: 8, height: 8 }, timeline: fx.AURORA_TIMELINE }).plan!;
  const withKey = (easing: string) => ({
    ...plan,
    uniforms: plan.uniforms.map((u) => (u.name === "scale" ? { ...u, track: { ...u.track!, keys: u.track!.keys.map((k, i) => (i === 0 ? { ...k, easing } : k)) } } : u)),
  });
  const spring = bk.emitBakedSkiaBundle(withKey("spring"), runtimeSource);
  check("refuses a spring segment (springSksl not wired yet) with a clear problem", !spring.files && spring.problems.some((p) => p.includes("spring") && p.includes("worklet")), spring.problems.join(" | "));
  const unknown = bk.emitBakedSkiaBundle(withKey("easeInOutMystery"), runtimeSource);
  check("an easing this build doesn't know bakes as linear, as the runtime plays it, with a warning", !!unknown.files && unknown.warnings.some((w) => w.includes("easeInOutMystery")));
  const long = bk.emitBakedSkiaBundle({ ...plan, timeline: { ...plan.timeline, durationTicks: 2 ** 24 } }, runtimeSource);
  check("refuses a scene of 2^24 ticks or more (fp32 time)", !long.files && long.problems.some((p) => p.includes("2^24")));
  const g = fx.auroraGraph();
  const sk = g.nodes.find((n) => n.id === "aurora")!;
  sk.params = { ...sk.params, expression: `${sk.params.expression}\nfloat tbk_mine(float x) { return x; }` };
  const collide = exportSkia({ ...auroraReq, nodes: g.nodes, edges: g.edges, animation: "baked" });
  check("refuses a program that already uses the tbk_ prefix", !collide.files && collide.problems.some((p) => p.includes("tbk_")));
  const tooManyKeys = bk.emitBakedSkiaBundle(
    {
      ...plan,
      uniforms: plan.uniforms.map((u) =>
        u.name === "scale" ? { ...u, track: { kind: "scalar" as const, keys: Array.from({ length: bk.BAKED_LIMITS.trackKeys + 1 }, (_, i) => ({ tick: i * 10, value: i % 7, easing: "linear" })) } } : u
      ),
    },
    runtimeSource
  );
  check(`refuses a track over ${bk.BAKED_LIMITS.trackKeys} keys`, !tooManyKeys.files && tooManyKeys.problems.some((p) => p.includes("capped")));
  // A worklet export of the same keys still works: the refusals are baked-only.
  check("…while the worklet export of the spring key still ships", !!emitSkiaBundle(withKey("spring"), runtimeSource)["timeline.ts"]);

  if (sceneBake.plan) {
    // Series caps, on the Aurora scene plan with its sampled stops swapped.
    const swap = (values: (n: number) => unknown[]) => {
      const binds = scenePlan.binds.map((b) => (b.path.endsWith("nskr_stops_color") && b.plan.kind === "sampled" ? { ...b, plan: { ...b.plan, values: values(b.plan.values.length) as any } } : b));
      const bindFor = new Map([...scenePlan.bindFor].map(([k, v]) => [k, binds.find((b) => b.id === v.id)!]));
      return bk.bakeScenePlan({ ...scenePlan, binds, bindFor });
    };
    const base = (scenePlan.binds.find((b) => b.path.endsWith("nskr_stops_color"))!.plan as any).values[0] as number[];
    const frames = bk.BAKED_LIMITS.seriesFrames + 10;
    const many = swap(() => Array.from({ length: frames }, (_, f) => base.map((x, i) => (i === 9 ? (f % 97) / 97 : x))));
    check(`refuses a sampled series over ${bk.BAKED_LIMITS.seriesFrames} kept frames`, !many.plan && many.problems.some((p) => p.includes("capped at")), many.problems.join(" | "));
    const wide = swap((n) => Array.from({ length: n }, (_, f) => base.map((x, i) => (i < 60 ? ((f * (i + 1)) % 89) / 89 : x))));
    check(`refuses series over ${bk.BAKED_LIMITS.seriesLiterals} constants per program`, !wide.plan && wide.problems.some((p) => p.includes("constants")), wide.problems.join(" | "));
    // iTime that isn't the clock.
    const tBind = scenePlan.binds.find((b) => b.path.endsWith("uniforms.iTime"))!;
    const binds = scenePlan.binds.map((b) => (b === tBind ? { ...b, plan: { kind: "static" as const, value: 0, from: "static" } } : b));
    const bindFor = new Map([...scenePlan.bindFor].map(([k, v]) => [k, binds.find((b) => b.id === v.id)!]));
    const st = bk.bakeScenePlan({ ...scenePlan, binds, bindFor });
    check("refuses a baked program whose iTime isn't the master clock", !st.plan && st.problems.some((p) => p.includes("iTime")), st.problems.join(" | "));
  }
}

lap("5–6. structure + refusals");
// ---- 7. checkExportable + type-check ------------------------------------------------------------
{
  const r = await checkExportable({
    nodes: sceneG.nodes,
    edges: sceneG.edges,
    canvasId: "skc",
    canvas: { width: 512, height: 512 },
    timeline: fx.AURORA_TIMELINE,
    slot: "baked-aurora-scene",
    animation: "baked",
    typecheck: true,
  });
  check("checkExportable(Aurora scene, baked): no problems", r.problems.length === 0, r.problems.join(" | "));
  check(
    `checkExportable(Aurora scene, baked): ${r.programs.length} program(s) compile with exactly their uniforms`,
    r.programs.length > 0 && r.programs.every((p) => p.ok),
    r.programs.map((p) => `${p.where}: ${p.detail}`).join(" | ")
  );
  check(`checkExportable(Aurora scene, baked): the bundle type-checks in skia-harness${r.typecheck.ran ? "" : " (skipped)"}`, r.typecheck.ok, r.typecheck.output);
  const g = sfx.sceneFixtureGraph();
  const r2 = await checkExportable({ nodes: g.nodes, edges: g.edges, canvasId: g.canvasId, canvas: sfx.SCENE_CANVAS, timeline: sfx.SCENE_TIMELINE, slot: "baked-scene-fixture", animation: "baked", typecheck: true });
  check("checkExportable(scene fixture, baked): no problems, programs exact", r2.problems.length === 0 && r2.programs.every((p) => p.ok), [...r2.problems, ...r2.programs.filter((p) => !p.ok).map((p) => p.detail)].join(" | "));
  check(`checkExportable(scene fixture, baked): the bundle (baked program + worklet binds) type-checks${r2.typecheck.ran ? "" : " (skipped)"}`, r2.typecheck.ok, r2.typecheck.output);

  // The baked SkSL Shader bundles (checkExportable reads Skia Canvas scenes).
  const harness = path.join(ROOT, "skia-harness");
  if (!fs.existsSync(path.join(harness, "node_modules", "react-native-skia"))) {
    if (process.env.SKIA_HARNESS_REQUIRED) check("skia-harness has node_modules (npm --prefix skia-harness install)", false);
    else console.log("skip baked SkSL Shader bundles type-check — skia-harness/node_modules is not installed (SKIA_HARNESS_REQUIRED=1 makes this a failure)");
  } else if (auroraB.files && synB.files) {
    const dir = path.join(harness, "src", "__family_check__", "baked-effect");
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      for (const [slot, files] of [["aurora", auroraB.files], ["synthetic", synB.files]] as const) {
        for (const [f, text] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(dir, slot, f)), { recursive: true });
          fs.writeFileSync(path.join(dir, slot, f), text);
        }
      }
      const own = path.join(harness, "node_modules", ".bin", "tsc");
      const [cmd, args] = fs.existsSync(own) ? [own, ["--noEmit", "-p", harness]] : ["npx", ["tsc", "--noEmit", "-p", harness]];
      let output = "";
      let ok = true;
      try {
        execFileSync(cmd, args, { cwd: ROOT, stdio: "pipe" });
      } catch (e) {
        ok = false;
        output = String((e as { stdout?: Buffer }).stdout ?? e);
      }
      check("the baked SkSL Shader bundles (Aurora, synthetic) type-check in skia-harness", ok, output.split("\n").filter((l) => l.includes("baked-effect") || l.includes("error")).slice(0, 12).join("\n       "));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.rmdirSync(path.join(harness, "src", "__family_check__"));
      } catch {
        /* other slots still present */
      }
    }
  }
}

lap("7. checkExportable + type-check");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "check-skia-baked: all checks passed" : `check-skia-baked: ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
