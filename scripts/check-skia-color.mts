// check-skia-color: the color family's Skia ports (specdocs/101326_skia-target.md
// §7 Wave 2, family 2). CanvasKit in Node, CPU raster surfaces, no GPU:
//
//   1. node defs: every port is `sksl`, mirrors its node with the mirror's
//      own ParamDefs, feeds every library param from a same-named param or
//      a declared derived bind, reports what it does not port, and emits
//      what its mirror emits while unwired;
//   2. Color Ramp (Skia) against makeColorRampSampler for EVERY
//      interpolation × space (two stop sets, two offsets): the JS model the
//      shader is fed (rampModel — tangents, OKLCH unwrap, the smooth table)
//      replayed in double precision, then the rendered shader;
//   3. RGB Curves (Skia) against the GL node's 256-entry RGBA8 LUT
//      (buildLut256 + LINEAR filtering, replayed in JS) and the exact
//      float curve (sampleFloatCurve);
//   4. Dither (Skia) against the CPU algorithms it ports
//      (ditherOrderedBW / ditherOrderedColor / ditherThresholdBW /
//      ditherThresholdColor) on an exact 8-bit test image, at pixel scales
//      1 and 3;
//   5. Color Space (Skia): its copy of the gamut matrices still matches the
//      GL node's source;
//   6. export coverage: each port's Skia Canvas graph from the compare
//      fixture (scripts/fixtures/skia/color-graph.ts, animated params and
//      keyframed ramp stops / gradient points included) exports through
//      exportSkia with every program compiling and declaring exactly its
//      uniforms, animated binds landing as tracks / sampled binds; all of
//      them in one scene type-check against react-native-skia 3.4.0 +
//      Reanimated 4.7 (skipped without skia-harness/node_modules).
//
// Pixel parity with the GL nodes is compare:skia's job (Electron + GL):
//   npm run compare:skia -- --a color:<id>_n --b color:<id>_c
//
//   npx tsx scripts/check-skia-color.mts

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { EvalCache, GraphEdge, GraphNode } from "@/engine/evaluator";
import type { ShaderExpr } from "@/engine/skia/shader-expr";
import type { SkslProgramIR } from "@/engine/skia/scene-ir";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { registerAllNodes } = await import("@/nodes/index");
registerAllNodes();
const { getNodeDef } = await import("@/engine/registry");
const { evaluateGraph } = await import("@/engine/evaluator");
const lib = await import("@/engine/skia/library");
const { fuseShader, skslUniformName } = await import("@/engine/skia/fuse");
const { compileSksl, packUniforms } = await import("@/engine/skia/sksl-program");
const { makeColorRampSampler, COLOR_RAMP_INTERP_OPTIONS, COLOR_RAMP_SPACE_OPTIONS } = await import("@/engine/color-ramp");
const { linearToSrgb, oklabToLinear, oklchToSrgbGamutMapped, srgbToLinear, linearToOklab, oklabToOklch } = await import("@/engine/color-space");
const { computeMonotoneTangents, evalMonotoneCubic, sampleFloatCurve } = await import("@/engine/float-curve");
const dith = await import("@/nodes/effect/dither-algorithms");
const ramp = await import("@/nodes/skia/color-ramp");
const curvesPort = await import("@/nodes/skia/rgb-curves");
const csp = await import("@/nodes/skia/color-space-transform");
const fx = await import("./fixtures/skia/color-graph.ts");
const { checkExportable } = await import("./skia/export-check.ts");

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

// ---- rendering on CanvasKit CPU surfaces ---------------------------------------------

function renderProgram(p: SkslProgramIR, w: number, h: number): Uint8Array {
  const r = compileSksl(CK, p.sksl);
  if (!r.effect) throw new Error(r.error);
  const values: Record<string, number | number[]> = {};
  for (const [k, b] of Object.entries(p.uniforms)) values[k] = b.v;
  if (p.children.length) throw new Error("gate renders childless programs only");
  const shader = r.effect.makeShader(packUniforms(r.effect, values));
  const surf = CK.MakeSurface(w, h);
  const canvas = surf.getCanvas();
  canvas.clear(CK.TRANSPARENT);
  const paint = new CK.Paint();
  paint.setShader(shader);
  paint.setBlendMode(CK.BlendMode.Src);
  canvas.drawPaint(paint);
  surf.flush();
  const img = surf.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }) as Uint8Array;
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

const ctxFor = (w: number, h: number): any => ({
  gl: {}, width: w, height: h, time: 0, frame: 0, tick: 0, ticksPerFrame: 1000, fps: 60,
  playing: false, offline: false, cursor: { x: 0, y: 0, active: false }, state: {},
});

const defaults = (type: string): Record<string, unknown> => Object.fromEntries(getNodeDef(type)!.params.map((p) => [p.name, p.default]));

// A port's shader expression with `input` wired into `socket` (data-only
// compute: no GL, no preview).
function portExpr(type: string, params: Record<string, unknown>, w: number, h: number, input?: ShaderExpr, socket = "image"): { expr: ShaderExpr; problems: string[] } {
  const def = getNodeDef(type)!;
  const out = def.compute({
    inputs: (input ? { [socket]: { kind: "skia_shader", expr: input } } : {}) as any,
    auxIn: {},
    params: { ...defaults(type), ...params },
    ctx: ctxFor(w, h),
    nodeId: "p",
    consumedOutputs: new Set(["primary"]),
  }) as any;
  return { expr: out.primary.expr, problems: out.primary.problems ?? [] };
}

// Gate-only inputs: t along x (grey), and an exact 8-bit test image.
lib.registerSkslFunction({
  id: "test.cf.ramp@1",
  entry: "test_cf_ramp",
  source: `float4 test_cf_ramp(float2 uv, float2 res) { return float4(uv.x, uv.x, uv.x, 1.0); }`,
  params: [],
  inputs: [],
});
// Bytes per texel (x, y): r = x mod 256, g = (3y + x / 2) mod 256,
// b = (7x + 5y) mod 256, a = 255 — so every texel is exactly k/255.
lib.registerSkslFunction({
  id: "test.cf.bytes@1",
  entry: "test_cf_bytes",
  source: `float4 test_cf_bytes(float2 uv, float2 res) {
  float2 p = floor(uv * res);
  float r = mod(p.x, 256.0);
  float g = mod(3.0 * p.y + floor(p.x * 0.5), 256.0);
  float b = mod(7.0 * p.x + 5.0 * p.y, 256.0);
  return float4(float3(r, g, b) / 255.0, 1.0);
}`,
  params: [],
  inputs: [],
});
const call = (fn: string): ShaderExpr => ({ k: "call", fn, node: `in-${fn}`, params: {}, inputs: {} });
// The same bytes, Y-up rows (row 0 = bottom), as the CPU pass reads them.
function testBytes(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = x % 256;
      out[i + 1] = (3 * y + Math.floor(x / 2)) % 256;
      out[i + 2] = (7 * x + 5 * y) % 256;
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---- 1. node defs ----------------------------------------------------------------------------
const PORTS: { type: string; mirror: string; fn: string; derived: string[]; unwired: number[]; params?: Record<string, unknown> }[] = [
  { type: "skia-solid-color", mirror: "solid-color", fn: "tbx.solid_color@1", derived: [], unwired: [] },
  { type: "skia-gradient", mirror: "gradient", fn: "tbx.gradient@1", derived: ["points_pos", "points_color", "points_count"], unwired: [] },
  { type: "skia-color-ramp", mirror: "color-ramp", fn: "tbx.color_ramp@1", derived: ["stops_pos", "stops_color", "stops_count", "stops_work", "stops_tan"], unwired: [0, 0, 0, 1] },
  { type: "skia-color-correction", mirror: "color-correction", fn: "tbx.color_correction@1", derived: ["curves_rgb", "curves_r", "curves_g", "curves_b", "curves_count"], unwired: [0, 0, 0, 1] },
  { type: "skia-rgb-curves", mirror: "rgb-curves", fn: "tbx.rgb_curves@1", derived: ["curves_rgb", "curves_r", "curves_g", "curves_b", "curves_count"], unwired: [0, 0, 0, 1] },
  { type: "skia-posterize", mirror: "posterize", fn: "tbx.posterize@1", derived: [], unwired: [0, 0, 0, 0] },
  { type: "skia-threshold", mirror: "threshold", fn: "tbx.threshold@1", derived: [], unwired: [0, 0, 0, 0] },
  { type: "skia-color-space-transform", mirror: "color-space-transform", fn: "tbx.color_space@1", derived: ["from_to_lin", "from_transfer", "to_from_lin", "to_transfer"], unwired: [0, 0, 0, 0] },
  { type: "skia-keyer", mirror: "keyer", fn: "tbx.keyer@1", derived: ["sample_colors", "sample_count", "sample_mean"], unwired: [0, 0, 0, 0] },
  // (the default floyd-steinberg is refused, so the unwired check runs ordered)
  { type: "skia-dither", mirror: "dither", fn: "tbx.dither@1", derived: ["cells"], unwired: [0, 0, 0, 1], params: { algorithm: "ordered" } },
];
{
  for (const p of PORTS) {
    const def = getNodeDef(p.type);
    const orig = getNodeDef(p.mirror);
    if (!def || !orig) {
      check(`${p.type} is registered`, false);
      continue;
    }
    check(
      `${p.type}: skia { class: "sksl", mirrors: "${p.mirror}" }, shader primary + gated image preview`,
      def.skia?.class === "sksl" && def.skia.mirrors === p.mirror && def.primaryOutput === "skia_shader" && def.auxOutputs.some((a) => a.name === "preview" && a.type === "image") && def.gatesOutputs === true
    );
    const drift = def.params.filter((d) => orig.params.find((o) => o.name === d.name) !== d).map((d) => d.name);
    check(`${p.type}: every param is the mirror's own ParamDef`, drift.length === 0, drift.join());
    const fn = lib.getSkslFunction(p.fn);
    const unfed = (fn?.params ?? []).filter((lp) => !def.params.some((d) => d.name === lp.name) && !p.derived.includes(lp.name)).map((lp) => lp.name);
    check(`${p.type}: every lib param is a same-named param or a declared derived bind`, !!fn && unfed.length === 0, unfed.join());
    const imageInputs = orig.inputs.filter((i) => i.type === "image").map((i) => i.name);
    const missingSockets = imageInputs.filter((n) => !def.inputs.some((i) => i.name === n && i.type === "skia_shader"));
    check(`${p.type}: the mirror's image sockets are skia_shader sockets of the same name`, missingSockets.length === 0, missingSockets.join());
    const out = portExpr(p.type, p.params ?? {}, 8, 8);
    const e = out.expr as any;
    if (p.unwired.length) {
      check(`${p.type}: unwired, emits ${p.unwired.join(",")} like ${p.mirror}`, e.k === "call" && e.fn === "tbx.const@1" && e.params.color.v.join() === p.unwired.join(), JSON.stringify(e.params?.color?.v));
    }
  }
  const unsupported = (type: string, params: Record<string, unknown>) => getNodeDef(type)!.validateParams!({ ...defaults(type), ...params }).length;
  check("skia-gradient refuses phase_animate in wave mode only", unsupported("skia-gradient", { mode: "wave", phase_animate: true }) === 1 && unsupported("skia-gradient", { mode: "linear", phase_animate: true }) === 0);
  const algos = getNodeDef("dither")!.params.find((p) => p.name === "algorithm")!.options!;
  const refused = algos.filter((a) => unsupported("skia-dither", { algorithm: a }) > 0);
  check("skia-dither ports ordered + threshold and refuses every error-diffusion algorithm", refused.join() === algos.filter((a) => a !== "ordered" && a !== "threshold").join(), refused.join());
  const many = Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, x: i / 16, y: i / 16 }));
  check("curve ports refuse more than 16 points per curve", unsupported("skia-rgb-curves", { curves: { rgb: many } }) === 1 && unsupported("skia-color-correction", { curves: { r: many } }) === 1 && unsupported("skia-rgb-curves", {}) === 0);
  const allRamp = [...COLOR_RAMP_INTERP_OPTIONS.map((o) => ({ interpolation: o })), ...COLOR_RAMP_SPACE_OPTIONS.map((o) => ({ space: o }))];
  check("skia-color-ramp accepts every interpolation and space", allRamp.every((p) => unsupported("skia-color-ramp", p) === 0));
  const warn = console.warn;
  console.warn = () => {};
  const bad = portExpr("skia-dither", { algorithm: "atkinson" }, 8, 8, call("test.cf.ramp@1"));
  console.warn = warn;
  check("an unsupported setting emits transparent and says why", (bad.expr as any).fn === "tbx.const@1" && (bad.expr as any).params.color.v.join() === "0,0,0,0" && bad.problems.length === 1);
}

// ---- 2. Color Ramp (Skia) vs makeColorRampSampler --------------------------------------------
{
  const STOP_SETS = {
    // Unsorted, translucent, inside 0..1.
    vivid: [
      { id: "a", position: 0.08, color: "#1b2cff" },
      { id: "c", position: 0.62, color: "#ffe3c2", alpha: 0.6 },
      { id: "b", position: 0.3, color: "#ff3d8b" },
      { id: "d", position: 0.91, color: "#00a37a" },
    ],
    // A grey stop (no OKLCH hue), duplicate positions, ends at 0 and 1.
    greys: [
      { id: "a", position: 0, color: "#000000" },
      { id: "b", position: 0.4, color: "#808080" },
      { id: "c", position: 0.4, color: "#ff8800" },
      { id: "d", position: 0.7, color: "#00ccff", alpha: 0.75 },
      { id: "e", position: 1, color: "#ffffff" },
    ],
  };
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const SPACE = (s: string) => (COLOR_RAMP_SPACE_OPTIONS as readonly string[]).indexOf(s);

  // The shader's evaluation, in doubles, from the exact arrays it is fed.
  function replay(stops: unknown, interp: string, space: string, t: number): number[] {
    const { pos, color, count } = ramp.packRampStops(stops);
    const { work, tan } = ramp.rampModel(stops, interp, space);
    if (count === 0) return [t, t, t, 1];
    const knot = (i: number) => {
      const c: [number, number, number] = [color[i * 4], color[i * 4 + 1], color[i * 4 + 2]];
      let w: number[] = c;
      if (space === "linear") w = c.map(srgbToLinear);
      else if (space !== "srgb") {
        const lab = linearToOklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
        w = space === "oklab" ? lab : oklabToOklch(lab[0], lab[1], lab[2]).map((v, k) => (k === 2 && !Number.isFinite(v) ? 0 : v));
      }
      return [w[0], w[1], w[2], clamp01(color[i * 4 + 3])];
    };
    const at = (arr: number[], i: number) => arr.slice(i * 4, i * 4 + 4);
    const from = (v: number[]): number[] => {
      if (space === "srgb") return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2]), clamp01(v[3])];
      if (space === "linear") return [linearToSrgb(clamp01(v[0])), linearToSrgb(clamp01(v[1])), linearToSrgb(clamp01(v[2])), clamp01(v[3])];
      if (space === "oklab") {
        const l = oklabToLinear(v[0], v[1], v[2]);
        return [linearToSrgb(clamp01(l[0])), linearToSrgb(clamp01(l[1])), linearToSrgb(clamp01(l[2])), clamp01(v[3])];
      }
      return [...oklchToSrgbGamutMapped(v[0], Math.max(0, v[1]), v[2]), clamp01(v[3])];
    };
    const hermite = (a: number[], b: number[], ma: number[], mb: number[], pa: number, pb: number) => {
      const h = Math.max(pb - pa, 1e-4);
      const f = (t - pa) / h;
      const f2 = f * f;
      const f3 = f2 * f;
      return a.map((_, c) => (2 * f3 - 3 * f2 + 1) * a[c] + (f3 - 2 * f2 + f) * h * ma[c] + (-2 * f3 + 3 * f2) * b[c] + (f3 - f2) * h * mb[c]);
    };
    if (t <= pos[0]) return from(knot(0));
    if (t >= pos[count - 1]) return from(knot(count - 1));
    let i = 0;
    while (i < count - 2 && !(t <= pos[i + 1])) i++;
    const spline = interp === "cardinal" || interp === "monotone" || interp === "bspline";
    const fitted = spline || space === "oklch" || space === "oklch_long";
    if (interp === "smooth") {
      const T = ramp.SMOOTH_TABLE - 1;
      const k = Math.min(Math.floor(t * T), T - 1);
      return from(hermite(at(work, k), at(work, k + 1), at(tan, k), at(tan, k + 1), k / T, (k + 1) / T));
    }
    const wa = fitted ? at(work, i) : knot(i);
    const wb = fitted ? at(work, i + 1) : knot(i + 1);
    if (interp === "constant") return from(wa);
    if (spline) return from(hermite(wa, wb, at(tan, i), at(tan, i + 1), pos[i], pos[i + 1]));
    let f = (t - pos[i]) / Math.max(pos[i + 1] - pos[i], 1e-4);
    if (interp === "ease") f = f * f * (3 - 2 * f);
    else if (interp === "smoother") f = f * f * f * (f * (f * 6 - 15) + 10);
    else if (interp === "sine") f = 0.5 - 0.5 * Math.cos(Math.PI * f);
    else if (interp === "ease_in") f = f * f;
    else if (interp === "ease_out") f = 1 - (1 - f) * (1 - f);
    return from(wa.map((v, c) => v + (wb[c] - v) * f));
  }
  void SPACE;

  const RW = 512;
  const modelWorst: Record<string, number> = {};
  let modelAt = "";
  // Rendered error, split: OKLCH gamut-maps by bisection in fp32, where a
  // step decided the other way near the gamut boundary moves a channel.
  const shaderWorst = { closed: 0, oklch: 0 };
  const shaderAt = { closed: "", oklch: "" };
  for (const [setName, stops] of Object.entries(STOP_SETS)) {
    for (const interpolation of COLOR_RAMP_INTERP_OPTIONS) {
      for (const space of COLOR_RAMP_SPACE_OPTIONS) {
        const sample = makeColorRampSampler(stops as any, { interp: interpolation, space });
        // (a) the model, in doubles, on a dense t grid (constant on the LUT grid).
        let mw = 0;
        let mwAt = "";
        for (let k = 0; k <= 2000; k++) {
          let t = k / 2000;
          if (interpolation === "constant") t = (Math.floor(t * 1024) + 0.5) / 1024;
          const want = sample(t);
          const got = replay(stops, interpolation, space, t);
          for (let c = 0; c < 4; c++) {
            const d = Math.abs(got[c] - want[c]) * 255;
            if (d > mw) {
              mw = d;
              mwAt = `${setName} ${interpolation}/${space} t=${t}`;
            }
          }
        }
        const key = interpolation === "smooth" ? `smooth/${space}` : "others";
        if (key === "others" && mw > (modelWorst.others ?? 0)) modelAt = mwAt;
        modelWorst[key] = Math.max(modelWorst[key] ?? 0, mw);
        // (b) the rendered shader, with and without an offset.
        for (const offset of [0, 0.35]) {
          const { expr } = portExpr("skia-color-ramp", { stops, offset, interpolation, space }, RW, 1, call("test.cf.ramp@1"));
          const img = renderProgram(fused(expr, RW, 1), RW, 1);
          for (let x = 0; x < RW; x++) {
            let t = (x + 0.5) / RW;
            if (Math.abs(offset) > 1e-8) t = t + offset - Math.floor(t + offset);
            if (interpolation === "constant") t = (Math.floor(t * 1024) + 0.5) / 1024;
            const want = sample(t);
            const bucket = space === "oklch" || space === "oklch_long" ? "oklch" : "closed";
            for (let c = 0; c < 4; c++) {
              const d = Math.abs(img[x * 4 + c] - want[c] * 255);
              if (d > shaderWorst[bucket]) {
                shaderWorst[bucket] = d;
                shaderAt[bucket] = `${setName} ${interpolation}/${space}/offset ${offset} x=${x} ch${c}: ${img[x * 4 + c]} vs ${(want[c] * 255).toFixed(2)}`;
              }
            }
          }
        }
      }
    }
  }
  const smoothKeys = Object.keys(modelWorst).filter((k) => k.startsWith("smooth/"));
  const smoothWorst = Math.max(...smoothKeys.map((k) => modelWorst[k]));
  // Not bit-exact in doubles: the end stops are re-derived from their colors
  // (the shader's path) where the sampler keeps the hue-unwrapped knot, so
  // an achromatic end stop's borrowed OKLCH hue moves the last digits.
  check("Color Ramp model (fitted tangents, OKLCH unwrap, B-spline knots) replays makeColorRampSampler for every non-smooth mode", modelWorst.others < 1e-3, `max |Δ| ${modelWorst.others.toExponential(2)}/255 (${modelAt})`);
  // The worst case is a hard step (two stops at one position) blurred into
  // a steep sigmoid; ordinary ramps stay near 0.1/255.
  check(`Color Ramp model: smooth's ${ramp.SMOOTH_TABLE}-sample Hermite table stays within 1/255 of the 512-sample blur`, smoothWorst <= 1, smoothKeys.map((k) => `${k} ${modelWorst[k].toFixed(3)}`).join(", "));
  info(`smooth table error vs makeColorRampSampler (double precision, 2 stop sets): max ${smoothWorst.toFixed(3)}/255`);
  check(
    `Color Ramp (Skia) renders makeColorRampSampler: ${COLOR_RAMP_INTERP_OPTIONS.length} interpolations × srgb/linear/oklab × 2 stop sets × 2 offsets`,
    shaderWorst.closed <= 1.5,
    `max |Δ| ${shaderWorst.closed.toFixed(2)}/255${shaderWorst.closed > 0 ? ` at ${shaderAt.closed}` : ""}`
  );
  check(
    `Color Ramp (Skia) renders makeColorRampSampler: ${COLOR_RAMP_INTERP_OPTIONS.length} interpolations × oklch/oklch_long (fp32 gamut map) × 2 stop sets × 2 offsets`,
    shaderWorst.oklch <= 2.5,
    `max |Δ| ${shaderWorst.oklch.toFixed(2)}/255${shaderWorst.oklch > 0 ? ` at ${shaderAt.oklch}` : ""}`
  );
}

// ---- 3. RGB Curves (Skia) vs the GL node's LUT -----------------------------------------------
{
  const curves = {
    rgb: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 0.25, y: 0.12 }, { id: "c", x: 0.7, y: 0.88 }, { id: "d", x: 1, y: 1 }],
    r: [{ id: "a", x: 0, y: 0.1 }, { id: "b", x: 0.5, y: 0.62 }, { id: "c", x: 1, y: 0.9 }],
    g: [{ id: "a", x: 0, y: 0.3 }, { id: "b", x: 0.3, y: 0.3 }, { id: "c", x: 0.6, y: 0.75 }, { id: "d", x: 0.6, y: 0.8 }, { id: "e", x: 1, y: 0.95 }],
    b: [{ id: "a", x: 0.2, y: 0 }, { id: "b", x: 0.8, y: 1 }],
  };
  const lut = (pts: { x: number; y: number; id: string }[]) => {
    const m = computeMonotoneTangents(pts);
    return Array.from({ length: 256 }, (_, i) => Math.max(0, Math.min(255, Math.round(evalMonotoneCubic(pts, m, i / 255) * 255))) / 255);
  };
  const sampleLut = (L: number[], v: number) => {
    const f = Math.min(1, Math.max(0, v)) * 256 - 0.5;
    const i0 = Math.floor(f);
    const w = f - i0;
    const a = L[Math.min(255, Math.max(0, i0))];
    const b = L[Math.min(255, Math.max(0, i0 + 1))];
    return a + (b - a) * w;
  };
  const L = { rgb: lut(curves.rgb), r: lut(curves.r), g: lut(curves.g), b: lut(curves.b) };
  const W = 256;
  for (const type of ["skia-rgb-curves", "skia-color-correction"]) {
    const { expr } = portExpr(type, { curves }, W, 1, call("test.cf.ramp@1"));
    const img = renderProgram(fused(expr, W, 1), W, 1);
    let worst = 0;
    let exactWorst = 0;
    for (let x = 0; x < W; x++) {
      const v = (x + 0.5) / W;
      const m = sampleLut(L.rgb, v);
      const want = [sampleLut(L.r, m), sampleLut(L.g, m), sampleLut(L.b, m)];
      const exact = [sampleFloatCurve(curves.r, sampleFloatCurve(curves.rgb, v)), sampleFloatCurve(curves.g, sampleFloatCurve(curves.rgb, v)), sampleFloatCurve(curves.b, sampleFloatCurve(curves.rgb, v))];
      for (let c = 0; c < 3; c++) {
        worst = Math.max(worst, Math.abs(img[x * 4 + c] - want[c] * 255));
        exactWorst = Math.max(exactWorst, Math.abs(want[c] - exact[c]) * 255);
      }
    }
    check(`${type}: curves match the GL node's 256-entry RGBA8 LUT + LINEAR filtering (master, then r / g / b)`, worst <= 1, `max |Δ| ${worst.toFixed(2)}/255`);
    if (type === "skia-rgb-curves") info(`the GL LUT itself vs the exact monotone curve on this input: max ${exactWorst.toFixed(2)}/255 (what the port reproduces instead of fixing)`);
  }
  const packed = curvesPort.packCurves(curves);
  check("packCurves: sanitized points (sorted, clamped), Fritsch–Carlson tangents, counts", packed.count.join() === "4,3,5,2" && packed.rgb[4] === 0.25 && packed.rgb[6] === computeMonotoneTangents(curves.rgb)[1]);
}

// ---- 4. Dither (Skia) vs the CPU algorithms ---------------------------------------------------
{
  // 96 × 72 divides by 3: at pixel scale 3 every cell centre lands on a
  // texel, so the downsample's LINEAR fetch blends nothing (no rounding
  // ties between the GPU-free reference and the shader).
  const W = 96;
  const H = 72;
  const cases: { name: string; params: Record<string, unknown>; ref: (d: Uint8Array, w: number, h: number) => void }[] = [
    { name: "ordered BW", params: { algorithm: "ordered", threshold: 128 }, ref: (d, w, h) => dith.ditherOrderedBW(d, w, h, 128) },
    { name: "ordered BW, threshold 70", params: { algorithm: "ordered", threshold: 70 }, ref: (d, w, h) => dith.ditherOrderedBW(d, w, h, 70) },
    { name: "ordered color, 3 levels", params: { algorithm: "ordered", color_mode: true, levels: 3 }, ref: (d, w, h) => dith.ditherOrderedColor(d, w, h, 3) },
    { name: "ordered color, 6 levels", params: { algorithm: "ordered", color_mode: true, levels: 6 }, ref: (d, w, h) => dith.ditherOrderedColor(d, w, h, 6) },
    { name: "threshold BW", params: { algorithm: "threshold", threshold: 100 }, ref: (d, w, h) => dith.ditherThresholdBW(d, w, h, 100) },
    { name: "threshold color, 4 levels", params: { algorithm: "threshold", color_mode: true, levels: 4 }, ref: (d, w, h) => dith.ditherThresholdColor(d, w, h, 4) },
  ];
  for (const ps of [1, 3]) {
    for (const c of cases) {
      const { expr } = portExpr("skia-dither", { ...c.params, pixel_scale: ps }, W, H, call("test.cf.bytes@1"));
      const img = renderProgram(fused(expr, W, H), W, H);
      // The CPU pass: the source sampled bilinearly at each cell centre
      // (CLAMP_TO_EDGE), rounded to the RGBA8 target, dithered, shown nearest.
      const dw = Math.max(1, Math.round(W / ps));
      const dh = Math.max(1, Math.round(H / ps));
      const full = testBytes(W, H);
      const texel = (x: number, y: number, k: number) => full[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + k];
      const cells = new Uint8Array(dw * dh * 4);
      for (let cy = 0; cy < dh; cy++) {
        for (let cx = 0; cx < dw; cx++) {
          const sx = ((cx + 0.5) * W) / dw - 0.5;
          const sy = ((cy + 0.5) * H) / dh - 0.5;
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const fx0 = sx - x0;
          const fy0 = sy - y0;
          for (let k = 0; k < 4; k++) {
            const a = texel(x0, y0, k) * (1 - fx0) + texel(x0 + 1, y0, k) * fx0;
            const b = texel(x0, y0 + 1, k) * (1 - fx0) + texel(x0 + 1, y0 + 1, k) * fx0;
            cells[(cy * dw + cx) * 4 + k] = Math.round(a * (1 - fy0) + b * fy0);
          }
        }
      }
      c.ref(cells, dw, dh);
      let wrong = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cx = Math.min(dw - 1, Math.floor(((x + 0.5) / W) * dw));
          const cyUp = Math.min(dh - 1, Math.floor(((H - 1 - y + 0.5) / H) * dh));
          const ref = (cyUp * dw + cx) * 4;
          const got = (y * W + x) * 4;
          if ([0, 1, 2, 3].some((k) => img[got + k] !== cells[ref + k])) wrong++;
        }
      }
      check(`Dither (Skia) ${c.name}, pixel_scale ${ps}: identical to dither-algorithms.ts on an exact 8-bit image`, wrong === 0, `${wrong} of ${W * H} pixels differ`);
    }
  }
}

// ---- 5. Color Space constants ------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(ROOT, "src/nodes/effect/color-space-transform.ts"), "utf8").replace(/\s+/g, " ");
  const drift = Object.entries(csp.COLOR_SPACE_TABLE_CONSTANTS).filter(([name, m]) => {
    const rows = [0, 1, 2].map((r) => m.slice(r * 3, r * 3 + 3).map((v) => (Object.is(v, 0) ? "0.0" : String(v))).join(", "));
    return !src.includes(`const ${name}: Mat3 = [`) || rows.some((row) => !src.includes(row));
  });
  check("Color Space (Skia)'s gamut matrices are the GL node's, digit for digit", drift.length === 0, drift.map(([n]) => n).join());
  const spaces = getNodeDef("color-space-transform")!.params.find((p) => p.name === "from")!.options!;
  check("Color Space (Skia) knows every space the GL node offers", spaces.every((s) => s in csp.COLOR_SPACES) && Object.keys(csp.COLOR_SPACES).length === spaces.length);
}

// ---- 6. export coverage ---------------------------------------------------------------------------
{
  const full = fx.colorGraph();
  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  const sourceOf = (s: string) => byId.get(`src_${s}_s`)!;
  const parsePlan = (files: Record<string, string> | null) => {
    const m = files?.["manifest.json"];
    return m ? (JSON.parse(m) as { bindCounts: Record<string, number>; binds: { path: string; kind: string; from: string }[] }) : null;
  };
  const exportable: { nodes: GraphNode[]; edges: GraphEdge[]; fill: string }[] = [];
  let programs = 0;
  for (const p of fx.COLOR_PAIRS) {
    const chain = fx.portChain(p, (s) => `src_${s}_s`);
    const srcs = [p.src, p.extra?.src].filter((s): s is "noise" | "rainbow" | "ramp" => !!s);
    const nodes: GraphNode[] = [...new Set(srcs)].map((s) => ({ ...sourceOf(s) }));
    nodes.push(...chain.nodes);
    const r = await checkExportable({ nodes, edges: chain.edges, canvasId: `${p.id}_c`, slot: "color", name: p.id });
    const bad = r.programs.filter((x) => !x.ok);
    programs += r.programs.length;
    const untagged = r.warnings.filter((w) => /tags|does not reproduce/.test(w));
    check(`export ${p.id} (skia-${p.type}): no problems, programs compile with exactly their uniforms, no untagged animation`, r.problems.length === 0 && r.programs.length > 0 && bad.length === 0 && untagged.length === 0, [...r.problems, ...bad.map((b) => `${b.where}: ${b.detail}`), ...untagged].join(" | "));
    if (p.animation) {
      const plan = parsePlan(r.files);
      const moving = (plan?.binds ?? []).filter((b) => b.kind === "track" || b.kind === "sampled");
      const keys = Object.keys(p.animation);
      const virtual = keys.some((k) => k.includes(":"));
      const want = virtual ? "sampled" : "track";
      const uniformPrefix = skslUniformName(`${p.id}_s`, "");
      const hit = moving.filter((b) => b.kind === want && (b.path.split(".").pop() ?? "").startsWith(uniformPrefix));
      check(`export ${p.id}: the keyframed ${keys.join(", ")} ship as ${want} binds`, hit.length > 0, moving.map((b) => `${b.kind} ${b.path.split(".").pop()}`).join(", ") || "nothing moves");
    }
    exportable.push({ nodes, edges: chain.edges, fill: `${p.id}_f` });
  }
  info(`${fx.COLOR_PAIRS.length} port graphs exported, ${programs} runtime programs compiled in CanvasKit`);

  // Every port in ONE scene (fills in nested Skia Groups), type-checked once.
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const g of exportable) {
    for (const n of g.nodes) if (!n.id.endsWith("_c")) nodes.set(n.id, n);
    edges.push(...g.edges.filter((e) => !e.target.endsWith("_c")));
  }
  let level = exportable.map((g) => g.fill);
  let gid = 0;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 4) {
      const id = `grp${gid++}`;
      nodes.set(id, { id, type: "skia-group", params: {} });
      level.slice(i, i + 4).forEach((child, k) => edges.push({ id: `${child}->${id}`, source: child, sourceHandle: "out:primary", target: id, targetHandle: `in:child${k + 1}` }));
      next.push(id);
    }
    level = next;
  }
  nodes.set("all_c", { id: "all_c", type: "skia-canvas", params: { background_on: false } });
  edges.push({ id: `${level[0]}->all_c`, source: level[0], sourceHandle: "out:primary", target: "all_c", targetHandle: "in:scene" });
  const r = await checkExportable({ nodes: [...nodes.values()], edges, canvasId: "all_c", slot: "color", name: "Color family", typecheck: true });
  const bad = r.programs.filter((x) => !x.ok);
  const plan = parsePlan(r.files);
  check(`export: all ${exportable.length} ports in one scene (${r.programs.length} programs) export cleanly`, r.problems.length === 0 && bad.length === 0, [...r.problems, ...bad.map((b) => b.detail)].join(" | "));
  if (plan) info(`one-scene bundle binds: ${JSON.stringify(plan.bindCounts)}`);
  if (r.typecheck.ran) check("export: the one-scene bundle type-checks against react-native-skia 3.4.0 + Reanimated 4.7", r.typecheck.ok, r.typecheck.output);
  else {
    info(r.typecheck.output);
    check("export: type-check skipped only when allowed", r.typecheck.ok, r.typecheck.output);
  }
}

// The evaluator path (real wiring, a Color Ramp downstream of a Gradient)
// fuses to one program: what a Skia layer built from these ports ships.
{
  const nodes: GraphNode[] = [
    { id: "g", type: "skia-gradient", params: { ...defaults("skia-gradient"), mode: "radial" } },
    { id: "cc", type: "skia-color-correction", params: { ...defaults("skia-color-correction"), hue: 30 } },
    { id: "r", type: "skia-color-ramp", params: { ...defaults("skia-color-ramp"), interpolation: "monotone", space: "oklch" } },
    { id: "d", type: "skia-dither", params: { ...defaults("skia-dither"), algorithm: "ordered", pixel_scale: 2 } },
  ];
  const wire = (s: string, t: string): GraphEdge => ({ id: `${s}->${t}`, source: s, sourceHandle: "out:primary", target: t, targetHandle: "in:image" });
  const res = evaluateGraph(nodes, [wire("g", "cc"), wire("cc", "r"), wire("r", "d")], ctxFor(64, 48), new Map() as EvalCache, null, undefined, null, { extraTargets: ["d"] });
  const v = res.outputs.get("d")?.primary as any;
  const p = fused(v.expr, 64, 48);
  const chain = ["tbx.gradient@1", "tbx.color_correction@1", "tbx.color_ramp@1", "tbx.dither@1"];
  check("a gradient → color correction → ramp → dither chain fuses to ONE program and compiles", p.children.length === 0 && chain.every((f) => p.fused?.includes(f)) && !!compileSksl(CK, p.sksl).effect, p.fused?.join());
}

console.log(`\ncheck-skia-color: ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
